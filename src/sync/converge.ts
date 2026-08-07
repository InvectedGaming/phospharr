import { sqlite } from "../db/index.ts";
import { getSetting, type DownstreamServer } from "../settings.ts";
import { groupSlug, playlistNamesFor, tunerGroups } from "../tuner/hdhr.ts";
import { currentFingerprint } from "./fingerprint.ts";
import * as embyClient from "./embyClient.ts";
import type { TunerHost, TunerHostInput } from "./embyClient.ts";

export type { TunerHost, TunerHostInput };

/**
 * The convergence ladder: keep Emby's cached copy of our lineup in step with
 * ours, escalating only as far as it has to.
 *
 *   1. fingerprint unchanged since we last verified → do nothing
 *   2. changed                                      → ask Emby to refresh its guide
 *   3. still unverified 10 min later                → compare Emby's channel list to ours
 *   4. comparison fails                             → delete + re-add our tuner hosts
 *
 * Rung 4 is destructive: for the seconds between the delete and the add, the
 * household has no tuner. Five things keep that safe:
 *
 *   - **Intent is persisted first.** `pending_readd` holds the captured host
 *     objects before the first delete and is cleared only once every host is
 *     confirmed back. A crash (or an Emby that rejects the POST) leaves it set,
 *     and the *first* thing the next run does is finish the repair. Without
 *     that, a process death between the two calls would take the household's
 *     TV off the air until somebody noticed by hand.
 *   - **One host at a time.** Delete → add → next host, so at most one of the
 *     tuner hosts is ever missing, and a same-URL re-add is retried before we
 *     move on.
 *   - **The add must complete or scream.** If Emby rejects the captured record
 *     we retry with a bare `{Url, Type}` — losing per-host settings is bad,
 *     losing the tuner is worse — and if even that fails we stop escalating,
 *     keep `pending_readd`, and surface a loud error.
 *   - **A circuit breaker.** After `MAX_READD_FAILURES` consecutive rebuilds
 *     that didn't produce a verified lineup we stop escalating entirely rather
 *     than tear the tuner down hourly forever.
 *   - **Guards.** At most one rebuild per hour, never while somebody is
 *     watching live TV, never when we can't prove which hosts are ours, and
 *     never on an inconclusive comparison (a `listChannels` that errors is not
 *     evidence of drift).
 *
 * Everything here is best-effort: `convergeServer` and `convergeAll` never
 * throw, and no path blocks Phospharr's own serving.
 */

const VERIFY_DELAY_MS = 10 * 60_000; // give Emby's guide-refresh task time to finish before judging it
const READD_COOLDOWN_MS = 60 * 60_000;
const ADD_ATTEMPTS = 3; // a re-add is the step that must not be left half-done
const ADD_RETRY_MS = 250;

/**
 * Consecutive rebuilds that didn't end in a verified lineup before we stop
 * escalating. Three, because: the rate limit spaces rebuilds an hour apart, so
 * three of them span >2 h — long enough to rule out a transient cause (an Emby
 * restart, a guide task that was already running, a provider outage that made
 * the lineup look wrong), and short enough that we give up long before the 24
 * teardowns a day an unbounded loop would perform. One failure proves nothing;
 * two could still be the same transient; a third says the rebuild is not the
 * fix and a human has to look.
 */
const MAX_READD_FAILURES = 3;

/**
 * Consecutive failing verifies ONE playlist must post before it may escalate.
 *
 * Per-scope tolerance is what makes a small playlist observable at all, but it
 * also makes it twitchy: a fast-churning event/PPV group of a few dozen
 * channels on a short sync cadence gets a tolerance of `max(10, 10 %)` = 10,
 * so a handful of event channels attaching or detaching between our read and
 * Emby's already reads as drift. On its own that would rebuild the tuners once an hour
 * indefinitely, and `MAX_READD_FAILURES` would never catch it, because any
 * single passing verify resets that counter.
 *
 * Requiring the same scope to fail twice IN A ROW makes churn caught mid-flight
 * (fail, pass, fail — the streak resets on the pass) a no-op, while a genuinely
 * stale playlist, which stays wrong until something fixes it, clears the bar on
 * its second look. A confirming read costs two GETs.
 */
const MIN_SCOPE_FAILURES = 2;

/** Wall-clock budget for one `convergeAll` pass. The EPG scheduler awaits it
 *  before re-arming its 5-minute tick and the loop is watchdogged on a 15-minute
 *  staleness budget (src/epg/scheduler.ts), so a slow/hanging Emby must not be
 *  able to eat that. Checked BETWEEN servers only — never mid-rebuild, because
 *  abandoning a delete→add sequence is exactly the outage this module exists to
 *  prevent. Worst case is therefore the budget plus one server's work, which the
 *  client's own 15 s per-call timeout bounds. */
const PASS_DEADLINE_MS = 2 * 60_000;

export interface ConvergeClient {
  refreshGuide(s: DownstreamServer): Promise<void>;
  hasLiveSession(s: DownstreamServer): Promise<boolean>;
  listTunerHosts(s: DownstreamServer): Promise<TunerHost[]>;
  deleteTunerHost(s: DownstreamServer, id: string): Promise<void>;
  addTunerHost(s: DownstreamServer, host: TunerHostInput): Promise<void>;
  listChannels(s: DownstreamServer): Promise<{ Number?: string; Name: string }[]>;
}

export interface ConvergeDeps {
  fingerprint: () => string;
  client: ConvergeClient; // the real `embyClient` module satisfies this; tests inject a fake
  now: () => number;
  tunerUrl: string; // our own public base as Emby sees it ("" = unknown → no verify, no re-add)
  verify: (s: DownstreamServer) => Promise<VerifyOutcome>;
  /**
   * When true, the ladder may run rungs 0-3 (finish an owed re-add, refresh
   * the guide, verify, bank the per-scope streak) but MUST NOT enter rung 4
   * (the destructive delete+re-add). Set by Task 9's reconciler, which calls
   * `convergeServer` every 5 minutes instead of `convergeAll`'s own 6-12h
   * cadence — at that frequency, `MIN_SCOPE_FAILURES`' "two consecutive
   * failing verifies" would be satisfied by two reads 5 minutes apart on a
   * churny scope instead of two EPG cycles apart, defeating the exact
   * protection documented above (see MIN_SCOPE_FAILURES). Rung 4 stays
   * reserved for the slower, unflagged caller (`convergeAll`, still on its
   * original cadence), so the household's actual rebuild rate is unaffected
   * by how often the reconciler polls. Rungs 0-3 are safe to run at any
   * frequency: 0 only ever adds hosts back, 2 is a cheap idempotent refresh,
   * and 3 is read-only (its streak write is inert until something acts on it).
   */
  noEscalate?: boolean;
}

export interface SyncState {
  serverId: string;
  state: "converged" | "drifted" | "converging" | "unknown";
  fingerprint: string;
  lastReaddAt: number | null;
  lastAction: string;
  lastActionAt: number;
  lastError: string | null;
  /** Consecutive rebuilds that didn't verify. */
  readdFailures: number;
  /** Breaker tripped: escalation is off until a verify passes or an operator resets. */
  needsAttention: boolean;
  /** A repair is owed — rung 0 has hosts still to re-add (tuner may be gone
   *  from Emby right now). True even while `needsAttention` is also true: the
   *  most common way the breaker trips is a rebuild whose re-add failed, which
   *  leaves this set — see `note(..., MAX_READD_FAILURES)` in `finishReadd`/
   *  `rebuildTuners`. A caller deciding whether an owed, add-only recovery is
   *  still worth attempting (never a new delete) should read this, not
   *  `needsAttention` alone. */
  pendingReadd: boolean;
  /** Per-playlist consecutive failing verifies — a scope needs 2 to escalate. */
  scopeFailures: Record<string, number>;
}

export type ConvergeResult = { action: "none" | "refreshed" | "readded" | "skipped"; reason?: string };

// ─── state ───────────────────────────────────────────────────────────────────

interface Row {
  serverId: string;
  fingerprint: string;
  refreshedAt: number | null;
  readdAt: number | null;
  lastAction: string;
  lastActionAt: number;
  lastError: string | null;
  pendingReadd: string | null;
  readdFailures: number;
  /** scope label → consecutive failing verifies. See MIN_SCOPE_FAILURES. */
  scopeFailures: Record<string, number>;
}

interface DbRow {
  server_id: string;
  fingerprint: string | null;
  refreshed_at: number | null;
  readd_at: number | null;
  last_action: string | null;
  last_action_at: number | null;
  last_error: string | null;
  pending_readd: string | null;
  readd_failures: number | null;
  scope_failures: string | null;
}

// Prepared lazily: the module is imported by the API server at boot, and a
// compile-time `prepare` would turn a not-yet-migrated DB into an import crash.
let stmts: {
  get: ReturnType<typeof sqlite.prepare>;
  all: ReturnType<typeof sqlite.prepare>;
  put: ReturnType<typeof sqlite.prepare>;
  clear: ReturnType<typeof sqlite.prepare>;
  del: ReturnType<typeof sqlite.prepare>;
} | null = null;

function q() {
  return (stmts ??= {
    get: sqlite.prepare("SELECT * FROM sync_state WHERE server_id = ?"),
    all: sqlite.prepare("SELECT * FROM sync_state ORDER BY server_id"),
    put: sqlite.prepare(
      `INSERT INTO sync_state (server_id, fingerprint, refreshed_at, readd_at, last_action, last_action_at, last_error, pending_readd, readd_failures, scope_failures)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         fingerprint = excluded.fingerprint, refreshed_at = excluded.refreshed_at, readd_at = excluded.readd_at,
         last_action = excluded.last_action, last_action_at = excluded.last_action_at,
         last_error = excluded.last_error, pending_readd = excluded.pending_readd,
         readd_failures = excluded.readd_failures, scope_failures = excluded.scope_failures`,
    ),
    clear: sqlite.prepare("DELETE FROM sync_state"),
    del: sqlite.prepare("DELETE FROM sync_state WHERE server_id = ?"),
  });
}

const cache = new Map<string, Row>();

function fromDb(r: DbRow): Row {
  return {
    serverId: r.server_id,
    fingerprint: r.fingerprint ?? "",
    refreshedAt: r.refreshed_at,
    readdAt: r.readd_at,
    lastAction: r.last_action ?? "",
    lastActionAt: r.last_action_at ?? 0,
    lastError: r.last_error,
    pendingReadd: r.pending_readd,
    readdFailures: r.readd_failures ?? 0,
    scopeFailures: parseScopeFailures(r.scope_failures),
  };
}

/** Never let a corrupt JSON blob wedge the ladder — an unreadable streak just
 *  means "no confirmed failures yet", which is the conservative reading. */
function parseScopeFailures(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === "number" && n > 0) out[k] = n;
    return out;
  } catch {
    return {};
  }
}

function load(serverId: string): Row {
  const hit = cache.get(serverId);
  if (hit) return hit;
  const row = q().get.get(serverId) as DbRow | null;
  const out: Row = row
    ? fromDb(row)
    : { serverId, fingerprint: "", refreshedAt: null, readdAt: null, lastAction: "", lastActionAt: 0, lastError: null, pendingReadd: null, readdFailures: 0, scopeFailures: {} };
  cache.set(serverId, out);
  return out;
}

function save(row: Row): Row {
  q().put.run(
    row.serverId, row.fingerprint, row.refreshedAt, row.readdAt,
    row.lastAction, row.lastActionAt, row.lastError, row.pendingReadd, row.readdFailures,
    Object.keys(row.scopeFailures).length ? JSON.stringify(row.scopeFailures) : null,
  );
  cache.set(row.serverId, row);
  return row;
}

/**
 * How Task 11's UI should read a row.
 *
 * Order matters: a repair we still owe outranks everything (report it as
 * in-flight, not settled), and a row we have never actually acted on is
 * `unknown` — calling that "converged" would paint a green light on a server
 * the ladder has not looked at yet.
 */
function deriveState(row: Row): SyncState["state"] {
  if (row.pendingReadd) return "converging";
  if (!row.lastAction || row.lastActionAt === 0) return "unknown";
  if (row.lastAction.startsWith("skipped")) return "drifted";
  if (row.refreshedAt == null) return "converged";
  return "converging";
}

export function syncStates(): SyncState[] {
  return (q().all.all() as DbRow[]).map(fromDb).map((r) => ({
    serverId: r.serverId,
    state: deriveState(r),
    fingerprint: r.fingerprint,
    lastReaddAt: r.readdAt,
    lastAction: r.lastAction,
    lastActionAt: r.lastActionAt,
    lastError: r.lastError,
    readdFailures: r.readdFailures,
    needsAttention: r.readdFailures >= MAX_READD_FAILURES,
    pendingReadd: r.pendingReadd != null,
    scopeFailures: r.scopeFailures,
  }));
}

/**
 * Test/ops hook: forget convergence state (table + cache).
 *
 * Pass the server ids to forget. Tests MUST do so: this suite can run against a
 * live DB, and wiping the whole table there would discard a `pending_readd`
 * record — i.e. the only trail back to a tuner host that was deleted and not
 * yet re-added. Omitting the argument clears everything and is for operators.
 */
export function _resetSyncState(serverIds?: string[]): void {
  if (!serverIds) {
    q().clear.run();
    cache.clear();
    return;
  }
  for (const id of serverIds) {
    q().del.run(id);
    cache.delete(id);
  }
}

/**
 * Operator "I've fixed it, try again" — re-arms the destructive rung for one
 * server after the circuit breaker tripped. Deliberately manual: the breaker
 * exists because something the ladder cannot fix is wrong, so it must not clear
 * itself on a timer.
 */
export function resetAttention(serverId: string): void {
  const row = load(serverId);
  save({ ...row, readdFailures: 0, scopeFailures: {}, lastError: null });
}

// ─── lineup comparison ───────────────────────────────────────────────────────

/**
 * Tolerance for "how many of ONE playlist's channels may Emby be missing".
 * `max(10, 10 %)`, applied **per registered playlist** — see `verifyLineup`.
 *
 * Measured on the live install (2026-08-07): the registered playlists emit 3274
 * distinct names, Emby lists 3205 — a steady-state ~2 % gap from event channels
 * attaching/detaching between the two reads, near-duplicate names Emby
 * collapses, and channels added since its last guide pull. The previous band
 * (`clamp(1 %, 5, 50)` = 50) sat *below* that noise floor, so verify failed
 * permanently and rung 4 would have rebuilt the household's tuner every hour it
 * was allowed to. 10 % leaves ~5× headroom over the observed noise while still
 * catching the failure this ladder exists for — Emby serving a stale or empty
 * playlist (zero channels short-circuits to drift regardless). The floor of 10
 * stops a small playlist from hair-triggering on rounding.
 *
 * The asymmetry is deliberate: a false negative is a slightly stale guide until
 * the next pass; a false positive is the family with no TV.
 */
const MISSING_FLOOR = 10; // a tiny lineup shouldn't hair-trigger on rounding
const MISSING_RATIO = 0.1;

const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export interface LineupComparison { ok: boolean; ours: number; theirs: number; missing: number; tolerance: number }

/**
 * Is Emby still showing the channels our registered playlists emit?
 *
 * The comparison is deliberately **one-directional and name-based**:
 *
 *  - *One-directional* — we count how many of OUR channels Emby is missing and
 *    ignore extras. Emby's channel list covers every tuner host it has, which
 *    on a real install can include a physical HDHomeRun or another IPTV source;
 *    counting those as drift would rebuild our tuner forever.
 *  - *Name-based* — channel NUMBER is not part of the verdict. Emby's own
 *    `PreferEpgChannelNumbers` / `AllowMappingByNumber` settings let it
 *    renumber channels server-side, so a number-strict check on a server
 *    configured that way would fail every hour, forever, and each failure
 *    deletes the household's tuner. Names come straight from the playlist and
 *    are the stable key. Our side is de-duplicated by name for the same reason:
 *    two channels sharing a name can only ever match once in Emby.
 *  - Two hard cases short-circuit: Emby reporting ZERO channels is always
 *    drift (that is the "Live TV is broken" state this whole ladder exists
 *    for), and an empty lineup on OUR side is never drift — that's our bug,
 *    and rebuilding Emby's tuner would not fix it.
 */
export function compareLineups(ours: string[], theirs: { Number?: string; Name: string }[]): LineupComparison {
  const want = new Set(ours.map(normName));
  const tolerance = Math.max(MISSING_FLOOR, Math.ceil(want.size * MISSING_RATIO));
  if (!want.size) return { ok: true, ours: 0, theirs: theirs.length, missing: 0, tolerance };
  if (!theirs.length) return { ok: false, ours: want.size, theirs: 0, missing: want.size, tolerance };
  const have = new Set(theirs.map((c) => normName(c.Name)));
  let missing = 0;
  for (const n of want) if (!have.has(n)) missing++;
  return { ok: missing <= tolerance, ours: want.size, theirs: theirs.length, missing, tolerance };
}

// ─── which playlist does each Emby tuner host serve? ─────────────────────────

const normUrl = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();

/** `/t/<key>[/g/<slug>]/…` under our own base. `null` = not ours. */
export type HostScope = { kind: "main" } | { kind: "group"; slug: string };

/**
 * Classify a tuner host by URL PREFIX (`<base>/t/`), so every per-group variant
 * is covered and a foreign tuner never is. Exact equality would miss
 * `/t/<key>/g/<slug>/playlist.m3u`; a bare host match would sweep in tuners that
 * merely live on the same machine.
 *
 * The `/g/<slug>` segment is what tells us WHICH playlist this host subscribed
 * to, and therefore which channels it is supposed to be showing.
 */
export function hostScope(url: string, base: string): HostScope | null {
  if (!base) return null; // unknown base ⇒ we own nothing ⇒ we touch nothing
  const b = normUrl(base);
  const u = normUrl(url);
  if (!u.startsWith(`${b}/t/`)) return null;
  const m = /^\/t\/[^/]+(?:\/g\/([^/?#]+))?(?:[/?#]|$)/.exec(u.slice(b.length));
  if (!m) return null;
  return m[1] ? { kind: "group", slug: m[1] } : { kind: "main" };
}

function isOwned(url: string, base: string): boolean {
  return hostScope(url, base) !== null;
}

/** The stable key a scope is reported and remembered under: `"main"` or
 *  `"group:<slug>"`. Same string in `ScopeComparison.scope`, in
 *  `sync_state.scope_failures`, and in the host filter for a scoped rebuild. */
export const scopeLabel = (sc: HostScope): string => (sc.kind === "main" ? "main" : `group:${sc.slug}`);

/** One registered playlist's verdict. `scope` is `"main"` or `"group:<slug>"`. */
export interface ScopeComparison extends LineupComparison { scope: string }

/** What `verify` learned. Richer than a boolean because two of its outcomes
 *  must NOT lead to a rebuild: nothing of ours registered at all, and a tuner
 *  group Emby has no host for (no rebuild can conjure a host into existence).
 *  The `LineupComparison` fields are the UNION rollup, for logging and Task 11;
 *  `ok` comes from `scopes`, not from the rollup. */
export interface VerifyOutcome extends LineupComparison {
  /** How many Phospharr-owned tuner hosts Emby has. 0 ⇒ nothing to rebuild. */
  ownedHosts: number;
  /** Configured tuner groups with no Emby tuner host — needs a human. */
  unregisteredGroups: string[];
  /** Per-registered-playlist verdicts. `ok` is true only if every one of these is. */
  scopes: ScopeComparison[];
}

/**
 * Production `verify`: the channels **the playlists Emby actually subscribed
 * to** emit, versus what Emby currently lists.
 *
 * Scoping matters more than the comparison itself. Emby's hosts each point at
 * one playlist — the main export (which EXCLUDES every grouped category) or a
 * single group's `/g/<slug>/playlist.m3u`. Groups Emby has no host for are left
 * out of the comparison entirely and reported separately, because deleting and
 * re-adding the hosts that DO exist cannot create the one that doesn't.
 *
 * **The comparison is PER SCOPE, each with its own `max(10, 10 %)` tolerance,
 * and a single failing scope fails the verify.** A union comparison would let a
 * small playlist hide inside a large one: a ~45-channel event group against a
 * ~3200-channel main export means losing the group host's entire lineup (45
 * missing) sits far under a union tolerance of 328 and would verify clean
 * forever — on precisely the host that churns fastest (a short `syncMinutes`,
 * typically PPV/sports), which is the drift this feature exists for.
 * Per scope, those same 45 missing are measured against a tolerance of 10.
 *
 * **Attribution limitation.** Emby's `/LiveTv/Channels` is a flat, server-wide
 * list with no tuner-host field, so we cannot ask "which channels came from
 * host X". Each scope is therefore checked as *expected set ⊆ the whole Emby
 * list*. In practice our scopes are disjoint by construction (the main export
 * excludes every grouped category), so a channel can only satisfy the scope it
 * belongs to — the residual blind spot is a FOREIGN tuner host that happens to
 * publish channels with the same names as one of our scopes, which would mask
 * that scope's absence. That is an acceptable, unlikely failure mode, and it
 * fails safe (no rebuild) rather than destructively.
 *
 * Throws if Emby can't be read — the caller treats that as inconclusive.
 */
export async function verifyLineup(s: DownstreamServer, client: ConvergeClient, baseUrl: string): Promise<VerifyOutcome> {
  const hostScopes = (await client.listTunerHosts(s))
    .map((h) => hostScope(h.Url, baseUrl))
    .filter((x): x is HostScope => x !== null);
  const groups = await tunerGroups();
  const bySlug = new Map(groups.map((g) => [groupSlug(g.name), g]));

  // One filter per DISTINCT registered playlist — two hosts on the same
  // playlist are one scope, not two.
  const wanted: { scope: string; filter: { include?: string[]; exclude?: string[] } }[] = [];
  const registered = new Set<string>();
  let main = false;
  for (const sc of hostScopes) {
    if (sc.kind === "main") {
      if (main) continue;
      main = true;
      wanted.push({ scope: scopeLabel(sc), filter: { exclude: groups.flatMap((g) => g.categories) } });
      continue;
    }
    if (registered.has(sc.slug)) continue;
    registered.add(sc.slug);
    const g = bySlug.get(sc.slug);
    if (!g) continue; // a host for a group we no longer define: not our channels to account for
    wanted.push({ scope: scopeLabel(sc), filter: { include: g.categories } });
  }

  const unregisteredGroups = groups.filter((g) => !registered.has(groupSlug(g.name))).map((g) => g.name);
  // One DB read for every scope (see playlistNamesFor) — verify runs on each
  // EPG tick and each read is a full channels scan.
  const nameSets = playlistNamesFor(wanted.map((w) => w.filter));
  const theirs = await client.listChannels(s);

  const scopes: ScopeComparison[] = wanted.map((w, i) => ({ scope: w.scope, ...compareLineups(nameSets[i] ?? [], theirs) }));
  const rollup = compareLineups(nameSets.flat(), theirs);
  const ok = scopes.every((c) => c.ok);

  if (!ok) {
    for (const c of scopes.filter((x) => !x.ok)) {
      console.warn(
        `[sync] ${s.name || s.url}: lineup drift on "${c.scope}" — ${c.missing}/${c.ours} of that playlist's channels are missing from Emby's ${c.theirs} (tolerance ${c.tolerance})`,
      );
    }
  }
  return { ...rollup, ok, ownedHosts: hostScopes.length, unregisteredGroups, scopes };
}

// ─── ladder ──────────────────────────────────────────────────────────────────

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withoutId(h: TunerHost): TunerHostInput {
  const { Id: _drop, ...rest } = h;
  return rest as TunerHostInput;
}

/**
 * Put a tuner host back. Retries the captured record, then — if Emby keeps
 * rejecting it — falls back ONCE to a bare `{Url, Type}`.
 *
 * The fallback is the difference between a degraded tuner and no tuner. Emby's
 * acceptance of a verbatim round-trip is an assumption we cannot test without
 * touching the live server; if it's wrong, the delete already happened and
 * refusing to post anything else leaves the household with nothing. Losing
 * `PreferEpgChannelNumbers` and friends scrambles guide images and numbering —
 * visible, annoying, and fixable in the Emby UI in a minute. Losing the tuner
 * is not. So we take the degraded tuner and shout about it.
 */
async function addWithRetry(s: DownstreamServer, deps: ConvergeDeps, host: TunerHostInput): Promise<{ degraded: boolean }> {
  let last: unknown;
  for (let i = 0; i < ADD_ATTEMPTS; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, ADD_RETRY_MS)); // sleep BETWEEN attempts, not after the last
    try {
      await deps.client.addTunerHost(s, host);
      return { degraded: false };
    } catch (e) {
      last = e;
    }
  }
  const minimal: TunerHostInput = { Url: host.Url, Type: host.Type };
  console.error(
    `[sync] ${s.name || s.url}: Emby rejected the captured tuner-host record for ${host.Url} (${errMsg(last)}) — retrying with a bare {Url,Type}. ` +
      "PER-HOST SETTINGS WILL BE LOST (guide images, channel numbering, tuner count); re-check them in Emby → Live TV → Tuners.",
  );
  try {
    await deps.client.addTunerHost(s, minimal);
    return { degraded: true };
  } catch (e) {
    throw new Error(`${errMsg(last)}; minimal {Url,Type} retry also failed: ${errMsg(e)}`);
  }
}

function note(row: Row, action: string, at: number, error: string | null, readdFailures = row.readdFailures): Row {
  return save({ ...row, lastAction: action, lastActionAt: at, lastError: error, readdFailures });
}

/**
 * Finish (or resume) a re-add: put back every captured host Emby is missing,
 * confirm it landed, then clear the pending record. Idempotent — a host that is
 * already there is left alone, so this is safe to run after a partial repair,
 * and safe to run while somebody is watching (it only ever ADDS).
 *
 * `rebuilt` says whether the caller already did the destructive half this pass,
 * and `degraded` carries forward whether any of ITS adds had to fall back to a
 * bare `{Url, Type}`. A resumed repair that finds nothing missing did no work
 * and must not report `readded` or re-stamp the rate-limit clock — that would
 * both mislead the UI and hand out a free hour of cooldown.
 */
async function finishReadd(
  s: DownstreamServer,
  deps: ConvergeDeps,
  pending: TunerHostInput[],
  opts: { rebuilt: boolean; degraded?: boolean },
): Promise<ConvergeResult> {
  const now = deps.now();
  const row = load(s.id);
  const present = async () => new Set((await deps.client.listTunerHosts(s)).map((h) => normUrl(h.Url)));

  let have = await present();
  const missing = pending.filter((h) => !have.has(normUrl(h.Url)));
  let degraded = opts.degraded ?? false;
  for (const h of missing) {
    try {
      degraded = (await addWithRetry(s, deps, h)).degraded || degraded;
    } catch (e) {
      // Leave `pending_readd` set: the tuner is still down and the next run —
      // reconciler tick, next EPG sync — retries before doing anything else.
      // Trip the breaker: Emby refused even a minimal record, so escalating
      // again (another delete) could only make things worse.
      console.error(`[sync] ${s.name || s.url}: TUNER HOST STILL MISSING — could not re-add ${h.Url}: ${errMsg(e)}`);
      note(row, "skipped:readd-failed", now, `re-add failed for ${h.Url}: ${errMsg(e)}`, MAX_READD_FAILURES);
      return { action: "skipped", reason: "re-add incomplete" };
    }
  }
  if (missing.length) {
    have = await present(); // trust Emby's own list, not the POST's 204
    const still = pending.filter((h) => !have.has(normUrl(h.Url)));
    if (still.length) {
      console.error(`[sync] ${s.name || s.url}: Emby accepted the re-add but still lists ${still.length} tuner host(s) as absent`);
      note(row, "skipped:readd-unconfirmed", now, `Emby is still missing ${still.length} tuner host(s) after re-add`, MAX_READD_FAILURES);
      return { action: "skipped", reason: "re-add unconfirmed" };
    }
  }

  if (!opts.rebuilt && !missing.length) {
    // A resumed repair that had nothing left to do. Clear the marker, change nothing else.
    save({ ...row, pendingReadd: null });
    return { action: "none", reason: "re-add already complete" };
  }

  let err: string | null = degraded
    ? "tuner host(s) were re-added with default settings — Emby rejected the captured record; re-check Live TV → Tuners"
    : null;
  try { await deps.client.refreshGuide(s); } catch (e) { err = `${err ? `${err}; ` : ""}guide refresh after re-add failed: ${errMsg(e)}`; }
  save({ ...row, refreshedAt: now, readdAt: now, lastAction: degraded ? "readded:degraded" : "readded", lastActionAt: now, lastError: err, pendingReadd: null });
  return { action: "readded", reason: degraded ? "settings lost" : undefined };
}

/**
 * Rung 4. Capture → persist intent → (delete, add) per host → confirm.
 *
 * `failedScopes` restricts the blast radius to the hosts that are actually
 * wrong. Losing eleven churned event channels off a 46-channel group playlist
 * must not delete and re-add the healthy 3230-channel main host alongside it —
 * that is a household-wide outage to fix a corner of the guide. An empty set is
 * treated as "everything we own", which only happens if a caller's `verify`
 * reports failure without per-scope detail.
 */
async function rebuildTuners(s: DownstreamServer, deps: ConvergeDeps, row: Row, failedScopes: Set<string>): Promise<ConvergeResult> {
  const now = deps.now();
  const all = (await deps.client.listTunerHosts(s)).filter((h) => isOwned(h.Url, deps.tunerUrl));
  const owned = failedScopes.size
    ? all.filter((h) => {
        const sc = hostScope(h.Url, deps.tunerUrl);
        return sc != null && failedScopes.has(scopeLabel(sc));
      })
    : all;
  if (!owned.length) {
    const why = all.length
      ? `no tuner host serves the drifted playlist(s) ${[...failedScopes].join(", ")} — nothing to rebuild`
      : `no Phospharr tuner host on this server under ${deps.tunerUrl}/t/ — add one, or set tuner.publicUrl to the URL Emby has stored`;
    note(row, "skipped:tuner-not-found", now, why);
    return { action: "skipped", reason: "tuner not found" };
  }
  const pending = owned.map(withoutId);
  // Persist BEFORE the first delete. `readd_at` moves now too, so a crash loop
  // can't out-run the once-an-hour rate limit. The failure counter increments
  // here as well: a rebuild is presumed failed until a later verify passes, so
  // an escalation that keeps not working walks the breaker down on its own.
  // The streaks are spent: we acted on them. The next escalation must earn two
  // fresh consecutive failures (on top of the hour-long rate limit).
  save({ ...row, readdAt: now, lastAction: "readding", lastActionAt: now, lastError: null, pendingReadd: JSON.stringify(pending), readdFailures: row.readdFailures + 1, scopeFailures: {} });
  let degraded = false;
  for (const h of owned) {
    await deps.client.deleteTunerHost(s, h.Id);
    try {
      degraded = (await addWithRetry(s, deps, withoutId(h))).degraded || degraded;
    } catch (e) {
      console.error(`[sync] ${s.name || s.url}: TUNER HOST DOWN — deleted ${h.Url} but could not add it back: ${errMsg(e)}`);
      note(load(s.id), "skipped:readd-failed", now, `re-add failed for ${h.Url}: ${errMsg(e)}`, MAX_READD_FAILURES);
      return { action: "skipped", reason: "re-add incomplete" }; // pending stays → next run finishes it
    }
  }
  return await finishReadd(s, deps, pending, { rebuilt: true, degraded });
}

async function ladder(s: DownstreamServer, deps: ConvergeDeps): Promise<ConvergeResult> {
  const row = load(s.id);
  const now = deps.now();

  // Rung 0 — an owed repair comes before anything else: the tuner may be gone.
  if (row.pendingReadd) {
    let pending: TunerHostInput[] = [];
    try { pending = JSON.parse(row.pendingReadd) as TunerHostInput[]; } catch { pending = []; }
    if (pending.length) return await finishReadd(s, deps, pending, { rebuilt: false });
    save({ ...row, pendingReadd: null }); // unparseable — drop it rather than loop
  }

  const fp = deps.fingerprint();

  // Rung 2 — our lineup moved: ask Emby to reload its guide.
  if (row.fingerprint !== fp) {
    try {
      await deps.client.refreshGuide(s);
    } catch (e) {
      // Don't bank the fingerprint: the next run retries the refresh rather
      // than counting down to a rebuild off a refresh that never happened.
      note(row, "skipped:refresh-failed", now, `guide refresh failed: ${errMsg(e)}`);
      return { action: "skipped", reason: "guide refresh failed" };
    }
    save({ ...load(s.id), fingerprint: fp, refreshedAt: now, lastAction: "refreshed", lastActionAt: now, lastError: null });
    return { action: "refreshed" };
  }

  // Rung 1 — verified converged and nothing changed.
  if (row.refreshedAt == null) return { action: "none" };

  // Rung 3 — still unverified; give the guide task its window first.
  if (now - row.refreshedAt <= VERIFY_DELAY_MS) return { action: "none", reason: "awaiting verify window" };

  // Verify needs the base URL too: without it we can't tell which of Emby's
  // tuner hosts are ours, and therefore can't tell which playlist to compare.
  if (!deps.tunerUrl) {
    note(row, "skipped:no-base-url", now, "cannot verify or repair: our public base URL is unknown — set tuner.publicUrl (or vod.publicUrl / BASE_URL) so we can tell our tuner hosts from anyone else's");
    return { action: "skipped", reason: "no tuner base URL" };
  }

  let v: VerifyOutcome;
  try {
    v = await deps.verify(s);
  } catch (e) {
    // Inconclusive ≠ drift. Never escalate on a read we couldn't complete.
    note(row, "skipped:verify-error", now, `verify failed: ${errMsg(e)}`);
    return { action: "skipped", reason: "verify error" };
  }

  // Nothing of ours is registered — a rebuild has nothing to capture or restore.
  if (v.ownedHosts === 0) {
    note(row, "skipped:tuner-not-found", now, `no Phospharr tuner host on this server under ${deps.tunerUrl}/t/ — add one, or set tuner.publicUrl to the URL Emby has stored`);
    return { action: "skipped", reason: "tuner not found" };
  }

  // Per-scope streaks: a scope that just verified is forgotten, a scope that
  // failed advances, and scopes that no longer exist are dropped.
  const streak: Record<string, number> = {};
  for (const c of v.scopes) {
    if (c.ok) continue;
    streak[c.scope] = (row.scopeFailures[c.scope] ?? 0) + 1;
  }

  if (v.ok) {
    // A tuner group with no Emby host is real drift that a rebuild CANNOT fix —
    // re-adding the hosts that exist would not create the missing one. Surface
    // it and stop; do not clear `refreshedAt`, so it stays visible and
    // re-checks (cheaply, read-only) until a human registers the host.
    if (v.unregisteredGroups.length) {
      const list = v.unregisteredGroups.map((g) => `"${g}"`).join(", ");
      save({ ...row, lastAction: "skipped:group-not-registered", lastActionAt: now, readdFailures: 0, scopeFailures: {},
        lastError: `tuner group ${list} has no tuner host in Emby — add its /t/<key>/g/<slug>/playlist.m3u as an M3U tuner (a tuner rebuild cannot create it)` });
      return { action: "skipped", reason: `tuner group not registered: ${list}` };
    }
    // Verified: the escalation counters are only meaningful while we're failing.
    save({ ...row, refreshedAt: null, lastAction: "converged", lastActionAt: now, lastError: null, readdFailures: 0, scopeFailures: {} });
    return { action: "none", reason: "verified" };
  }

  // Drift, but not yet confirmed. One bad read of a small, fast-rotating
  // playlist is churn far more often than it is breakage, and the destructive
  // rung is not something to spend on a maybe. Bank the streak and look again.
  //
  // DELIBERATE: this write (and the one below it) happens regardless of
  // `deps.noEscalate` — the reconciler's 5-minute verifies bank the SAME
  // persisted `scope_failures` a slow, unflagged `convergeAll` pass reads.
  // That means a scope failing on every reconciler pass for ~10-15 minutes
  // (two consecutive 5-minute-apart reads) reaches "confirmed" well before
  // the next EPG cycle, and when that EPG-driven call finally arrives, it can
  // escalate on ITS OWN FIRST failing verify — the two-in-a-row requirement
  // was already satisfied by the reconciler's pre-banked streak, not earned
  // fresh by convergeAll. This is intentional, not an oversight: the
  // alternative (gating the streak write itself behind noEscalate, so
  // reconciler verifies never persist) would mute exactly the fast detection
  // this task exists to provide, and would still let the same escalation
  // happen eventually, just later. It is also still safe against churn: `v.ok`
  // above unconditionally resets `scopeFailures` to `{}` on ANY passing
  // verify, from ANY caller, so an oscillating/churny scope reliably gets its
  // streak cleared by one of the many 5-minute-spaced reconciler reads long
  // before a rare EPG-cadence call arrives — only a scope that is FAILING
  // CONTINUOUSLY, with no pass in between, can carry a nonzero streak that
  // far, which is precisely the case rung 4 should fire on. See
  // tests/converge.test.ts's "noEscalate" suite, in particular "continuous
  // drift with no intervening pass" for the case this comment describes, and
  // task-9-report.md for the resulting latency accounting (EPG-cadence
  // repair now costs ~1 cycle instead of ~2-3, because confirmation already
  // happened between cycles).
  const confirmed = Object.keys(streak).filter((k) => streak[k]! >= MIN_SCOPE_FAILURES);
  if (!confirmed.length) {
    const detail = v.scopes.filter((c) => !c.ok).map((c) => `${c.scope} ${streak[c.scope]}/${MIN_SCOPE_FAILURES} (${c.missing}/${c.ours} missing)`).join(", ");
    save({ ...row, lastAction: "skipped:drift-unconfirmed", lastActionAt: now, scopeFailures: streak,
      lastError: `drift seen but not yet confirmed — ${detail || "no per-scope detail"}; will re-verify before touching any tuner` });
    return { action: "skipped", reason: "drift unconfirmed" };
  }
  save({ ...row, scopeFailures: streak });
  const failedScopes = new Set(confirmed);

  // A caller that may not escalate (the reconciler) stops here, confirmed
  // drift and all — rung 4 belongs exclusively to the slower cadence. See
  // ConvergeDeps.noEscalate. The streak just banked above is real information
  // (the operator's alerting reads it via syncStates()), it just isn't acted
  // on by THIS caller.
  //
  // note(load(s.id), ...) here, NOT the stale pre-verify `row` — `row` was
  // captured before this call's `save({...row, scopeFailures: streak})`
  // above, and note()'s own `{...row, ...}` spread would silently roll the
  // streak back to whatever it was at the top of this call, defeating the
  // entire point of pre-banking it (see the DELIBERATE comment above
  // `confirmed`). load() returns the just-cached fresh row.
  if (deps.noEscalate) {
    note(load(s.id), "skipped:deferred-to-scheduled-pass", now, `drift confirmed on ${[...failedScopes].join(", ")} — escalation is reserved for the scheduled convergence pass, not this check`);
    return { action: "skipped", reason: "escalation deferred" };
  }

  // Rung 4 — confirmed drift. Guards before the destructive part, most severe first.
  if (row.readdFailures >= MAX_READD_FAILURES) {
    note(row, "skipped:needs-attention", now, `${row.readdFailures} consecutive tuner rebuilds did not fix the lineup — escalation is OFF until this is resolved by hand (Emby → Live TV → Tuners), then reset the sync state for this server`);
    return { action: "skipped", reason: "needs attention" };
  }
  if (row.readdAt != null && now - row.readdAt < READD_COOLDOWN_MS) {
    note(row, "skipped:rate-limited", now, "drift persists but a tuner re-add ran within the hour");
    return { action: "skipped", reason: "rate-limited" };
  }
  if (await deps.client.hasLiveSession(s)) {
    note(row, "skipped:live-session", now, "drift detected but someone is watching live TV — will retry");
    return { action: "skipped", reason: "live session" };
  }
  return await rebuildTuners(s, deps, load(s.id), failedScopes);
}

/**
 * One server's ladder pass. **Never throws.**
 *
 * Serialized per server: every rung does load() → await → save(), so two
 * concurrent callers (Task 9's reconciler and the EPG scheduler landing
 * together) would interleave reads and writes and one could clobber
 * `pending_readd` with a stale spread — losing the record of a tuner host it
 * had just deleted. The second caller is told to go away instead.
 */
const inFlight = new Set<string>();

export async function convergeServer(s: DownstreamServer, deps: ConvergeDeps): Promise<ConvergeResult> {
  if (inFlight.has(s.id)) return { action: "skipped", reason: "already converging" };
  inFlight.add(s.id);
  try {
    return await ladder(s, deps);
  } catch (e) {
    const msg = errMsg(e);
    // The recovery path must not be able to throw either: `deps.now()` and the
    // state write are themselves fallible (a clock stub, a locked DB), and a
    // throw here would escape a function documented as never throwing.
    try {
      note(load(s.id), "skipped:error", deps.now(), msg);
    } catch (inner) {
      console.error(`[sync] ${s.name || s.url}: converge failed (${msg}) and its state could not be recorded: ${errMsg(inner)}`);
    }
    return { action: "skipped", reason: `error: ${msg}` };
  } finally {
    inFlight.delete(s.id);
  }
}

// ─── production wiring ───────────────────────────────────────────────────────

/**
 * Our own base URL as a downstream server reaches us: dedicated setting first,
 * then the VOD one (same job, older name), then `BASE_URL`. Request-less by
 * necessity — this runs from a scheduler, not a route.
 *
 * Returning "" is honest, not fatal: we still refresh, but verify and the
 * re-add rung refuse to run, because without the base we cannot tell OUR tuner
 * hosts from a physical HDHomeRun's — which makes both "is Emby showing our
 * lineup?" unanswerable and a repair built on a guess capable of deleting
 * somebody else's tuner.
 */
export async function tunerBaseUrl(): Promise<string> {
  const dedicated = String((await getSetting("tuner.publicUrl")) || "");
  const vod = String((await getSetting("vod.publicUrl")) || "");
  return (dedicated || vod || process.env.BASE_URL || "").trim().replace(/\/+$/, "");
}

let running = false;

/**
 * Converge every enabled Emby/Jellyfin server. Plex is excluded: it keeps the
 * guide-refresh path in `src/epg/downstream.ts` and has no equivalent
 * tuner-host API here.
 *
 * Serialized, deadline-bounded, and **never throws** — the EPG scheduler awaits
 * this before re-arming its watchdogged tick.
 */
export async function convergeAll(): Promise<void> {
  if (running) return;
  running = true;
  try {
    let servers: DownstreamServer[] = [];
    try { servers = (await getSetting("epg.downstream")) ?? []; } catch { return; }
    const targets = servers.filter((s) => s.enabled && s.url && s.apiKey && s.type !== "plex");
    if (!targets.length) return;

    const fp = currentFingerprint(); // one snapshot for the whole pass
    const base = await tunerBaseUrl();
    if (!base) console.warn("[sync] no public base URL (tuner.publicUrl / vod.publicUrl / BASE_URL) — guide refresh only, lineup verify and tuner re-add disabled");
    const deps: ConvergeDeps = {
      fingerprint: () => fp,
      client: embyClient,
      now: Date.now,
      tunerUrl: base,
      verify: (s) => verifyLineup(s, embyClient, base),
    };
    const deadline = Date.now() + PASS_DEADLINE_MS;
    for (const s of targets) {
      if (Date.now() > deadline) {
        console.warn(`[sync] converge pass hit its ${PASS_DEADLINE_MS / 1000}s budget — deferring the remaining server(s) to the next run`);
        break;
      }
      const r = await convergeServer(s, deps);
      if (r.action !== "none") console.log(`[sync] converge ${s.name || s.url}: ${r.action}${r.reason ? ` (${r.reason})` : ""}`);
    }
  } catch (e) {
    // `currentFingerprint()` and `tunerBaseUrl()` both hit the DB, and callers
    // await this on the EPG loop's critical path — a rejection here would stall
    // the tick that the watchdog measures.
    console.error("[sync] converge pass failed:", errMsg(e));
  } finally {
    running = false;
  }
}
