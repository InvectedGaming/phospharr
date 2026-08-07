import { accessSync, constants, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "../api/healthz.ts";
import { sendAlert } from "../alerts.ts";
import * as embyClient from "./embyClient.ts";
import {
  convergeServer,
  hostScope,
  syncStates,
  tunerBaseUrl,
  verifyLineup,
  type ConvergeDeps,
  type ConvergeResult,
  type SyncState,
} from "./converge.ts";
import { currentFingerprint } from "./fingerprint.ts";
import { getSetting, type DownstreamServer } from "../settings.ts";
import { registerLoop } from "../health/watchdog.ts";

/**
 * Integration reconciler — the 5-minute loop that notices a broken Emby link
 * FAST instead of waiting for the EPG scheduler's own 6-12h cadence
 * (src/epg/scheduler.ts calls convergeAll() only after a guide pull or a
 * provider re-sync). Task 6's convergence ladder already contains every
 * safety rail a repair needs (1 rebuild/hour/server, two consecutive failing
 * verifies per scope, a 3-strike circuit breaker) — this loop's only job is
 * to call it OFTEN ENOUGH that those rails actually get exercised in a
 * reasonable time, and to tell a human when they've all been exhausted.
 *
 * ─── `noEscalate`: rung 4 stays owned by the slow cadence ──────────────────
 *
 * Every `convergeServer` call this loop makes sets `ConvergeDeps.noEscalate`.
 * At 5-minute intervals, `MIN_SCOPE_FAILURES`' "two consecutive failing
 * verifies" (converge.ts) would otherwise be satisfied by two reads 5 minutes
 * apart instead of two EPG cycles apart — exactly the churn window that guard
 * was tuned against (event groups churn on a short sync cadence). `noEscalate`
 * lets the ladder still run rungs 0-3 (finish an owed re-add, refresh the
 * guide, verify, bank the per-scope streak — all safe at any frequency, see
 * `ConvergeDeps.noEscalate`'s doc) but never rung 4, the destructive
 * delete+re-add. That stays reserved for `convergeAll`'s own, unflagged calls
 * on its original cadence — so the reconciler adds pressure to *detect and
 * start* a repair sooner, never to *rebuild more often*. See
 * `tests/converge.test.ts`'s "noEscalate" suite for the guarantee this buys:
 * a server driven PURELY by the reconciler, however persistently drifted,
 * produces zero rebuilds — the maximum reconciler-attributable rebuild rate
 * is 0/hour, full stop; only `convergeAll` (unchanged since Task 6) can
 * trigger one.
 *
 * ─── Checks, and why each one runs (or doesn't) every 5 minutes ───────────
 *
 *  1. reachable  — `listUsers` on the actual server. Cheap (one GET), and the
 *     gate for everything else: a downstream Emby that's down makes every
 *     other check meaningless, so a failure here skips checks 2 and 3
 *     entirely rather than burning two more 15s-timeout calls against a
 *     server that just proved it isn't answering. No convergeServer call
 *     either — it would immediately hit the same dead server on every one of
 *     its own Emby calls. This is the "no converge spam" the brief calls out.
 *
 *  2. tuner present — does Emby still have a tuner host under OUR base URL
 *     (`hostScope`, the same ownership test the ladder itself uses)? This is
 *     the sharpest possible signal that Live TV is broken — Emby deleted (or
 *     never had) our host — and unlike the lineup-drift check below it has NO
 *     churn tolerance to respect, so every failure here is real and is both
 *     repaired (convergeServer) and alerted immediately. If the base URL
 *     itself is unconfigured (tuner.publicUrl / vod.publicUrl / BASE_URL all
 *     unset), the check can't be evaluated at all — reported ok (nothing to
 *     assert) rather than failing every 5 minutes on a one-time setup gap
 *     that convergeServer's own guard already logs on every pass it runs.
 *
 *  3. converged — reads `syncStates()`, which is free (local DB, no Emby
 *     call). Outcomes are treated differently on purpose:
 *       - "converged"            → idle and satisfied. ok, nothing to do.
 *       - "converging" / no row  → the ladder is mid-flight (just refreshed
 *         the guide, waiting out the 10-minute verify window) or has simply
 *         never run for this server yet. NOT ok — a convergeServer call is
 *         what lets it actually reach the verify step instead of sitting
 *         there until the next EPG-triggered pass — but it is also NOT
 *         alert-worthy: it's the ladder working as designed (or a brand-new
 *         server that hasn't had a turn yet), and paging an operator every
 *         time a lineup changes would train them to ignore the channel.
 *         EXCEPTION — staleness: a server whose fingerprint keeps changing
 *         faster than the 10-minute verify window never reaches "converged"
 *         at all, and would otherwise sit silently issuing a guide refresh
 *         every 5 minutes forever. A per-server in-memory clock
 *         (`firstNotConvergedAt`) tracks how long a server has been
 *         CONTINUOUSLY not-converged; past `STALE_MS` (2h — comfortably more
 *         than one full refresh→verify cycle, and far more than a legitimate
 *         provider sync would ever keep the fingerprint moving) it becomes
 *         alert-worthy so "perpetually converging" surfaces instead of
 *         hiding. Reset the moment the server converges, or on process
 *         restart (soft loss, not a correctness risk — worst case a stuck
 *         server waits one more restart's worth of time to be first noticed).
 *       - `needsAttention` (the 3-strike breaker tripped) → always
 *         alert-worthy. Checked independently of the derived state string,
 *         because a fresh fingerprint change can flip state back to
 *         "converging" (rung 2 still refreshes the guide even with the
 *         breaker tripped) while the breaker itself stays tripped — the
 *         silent-breaker case the brief calls out. The nudge (convergeServer)
 *         is skipped ONLY when `!st.pendingReadd` — i.e. only when there is
 *         truly nothing left to do but a wasted verify (two Emby GETs plus a
 *         full channel-list scan) every 5 minutes, since rung 4 is off and
 *         won't be revisited until an operator's `resetAttention`. CRITICAL:
 *         when `pendingReadd` IS set, the nudge keeps running every 5 minutes
 *         regardless of `needsAttention` — the most common way the breaker
 *         trips is a rebuild whose re-add itself failed (`rebuildTuners` /
 *         `finishReadd` in converge.ts both call
 *         `note(..., MAX_READD_FAILURES)` on that exact path), which means
 *         the household's tuner host is DELETED from Emby at the moment the
 *         breaker trips most often. Rung 0 (finish the owed re-add) is
 *         add-only, can never itself delete anything, and is unaffected by
 *         both `needsAttention` and `noEscalate` (see converge.ts's `ladder`)
 *         — refusing to nudge it would stall this specific recovery for up to
 *         `convergeAll`'s own 6-12h cadence, which is strictly worse than not
 *         having a reconciler at all for the case that matters most. An
 *         earlier revision of this file skipped the nudge unconditionally on
 *         `needsAttention`; that was a regression, caught in review, fixed
 *         here.
 *       - "drifted", not stale, not needsAttention → alert-worthy UNLESS the
 *         skip reason is one of converge.ts's own documented benign/
 *         self-resolving ones (`skipped:drift-unconfirmed` — a single
 *         unconfirmed read; `skipped:rate-limited` — working as intended;
 *         `skipped:live-session` — will retry once nobody's watching).
 *         Re-deriving converge.ts's FULL skip-reason taxonomy here would
 *         duplicate — and risk drifting out of sync with — that module; this
 *         allow-list only names the three reasons converge.ts's own docs
 *         describe as routine, and treats every other skip (a rejected
 *         re-add, a group with no host, an internal error, this loop's own
 *         `skipped:deferred-to-scheduled-pass`) as real, alert-worthy news.
 *
 *     convergeServer is called whenever tuner-present OR converged is not ok
 *     — EXCEPT when the breaker is tripped (see above). Calling it more often
 *     than the EPG scheduler does is safe for everything up to rung 3
 *     (idempotent reads/refreshes); rung 4 is where frequency would matter,
 *     and `noEscalate` (above) removes it from this loop's reach entirely.
 *
 *  4. vod-mirror-writable — NOT per-server; a single global check (reported
 *     under the synthetic id `"vod-mirror"`) that the .strm mirror root
 *     (`vod.libraryPath`) can actually be WRITTEN TO. Deliberately never
 *     creates the directory: `mkdirSync(root, {recursive:true})` would
 *     silently materialize the tree on the underlying filesystem the moment a
 *     network share hasn't mounted yet, shadowing the real mount point and
 *     reporting a false green on exactly the failure this check exists to
 *     catch. `accessSync(root, W_OK)` requires the root to already exist and
 *     be writable; a missing root is reported not-ok. The write-probe file
 *     itself lives directly under `libraryPath`, never inside `Movies/` or
 *     `Series/` — `rebuildVodLibrary` treats mtime changes under those as
 *     real content and Emby's realtime monitor watches them, so churning a
 *     probe file in there every 5 minutes would generate needless inotify
 *     traffic (see `feedback_emby_vod_db_bloat`-style history in this repo).
 *     Skipped (ok) when `features.vodLibrary` is off — an unused path being
 *     unwritable isn't a fault.
 *
 * ─── Bounding a slow webhook ───────────────────────────────────────────────
 *
 * `sendAlert` can take up to 15s when the webhook host is unreachable, and it
 * doesn't back off (src/alerts.ts). Alerts are awaited sequentially — a
 * downstream install realistically has one or two servers, and this keeps the
 * code simple and matches `convergeAll`'s own sequential-per-server precedent
 * — but the whole pass is wrapped in the SAME deadline pattern `convergeAll`
 * uses (`PASS_DEADLINE_MS`, checked between servers, never mid-server): if a
 * run is taking too long — many servers, a wedged webhook, or both — the
 * remaining servers are deferred to the next tick rather than let the pass
 * run long. A `running` guard skips starting a new tick while the previous
 * one is still in flight, so a genuinely wedged pass can't stack concurrent
 * reconcile runs against the same servers (convergeServer's own per-server
 * lock would no-op the duplicate anyway, but there's no reason to pay for the
 * redundant Emby calls). `reconcileOnce` itself never throws: every await
 * that isn't already contractually non-throwing (`servers()`, the VOD alert,
 * and each server's own checks) is wrapped so a single bad dependency can't
 * take down the whole pass.
 *
 * `beat()` fires in `tick()`'s `finally`, AFTER a pass actually finishes (or
 * throws), never at the top — the watchdog must see a pass COMPLETE, not
 * merely that the timer fired. A tick that returns early because `running`
 * is still true does NOT beat: if `PASS_DEADLINE_MS` itself somehow fails to
 * bound a pass (a bug in the deadline check, an await that isn't covered by
 * it), the heartbeat goes stale and the watchdog can still strike. Beating
 * unconditionally at the top of every tick — an earlier revision of this
 * file did exactly that — would let a wedged pass hold `running` true
 * forever while the heartbeat stayed perpetually fresh, silently defeating
 * Layer 1 for the one loop it most needs to catch.
 */

export interface ReconcileServerReport { serverId: string; checks: Check[] }
export type ReconcileReport = ReconcileServerReport[];

export interface ReconcileClient {
  listUsers: typeof embyClient.listUsers;
  listTunerHosts: typeof embyClient.listTunerHosts;
}

export interface ReconcileDeps {
  servers: () => Promise<DownstreamServer[]>;
  client: ReconcileClient;
  convergeServer: (s: DownstreamServer, deps: ConvergeDeps) => Promise<ConvergeResult>;
  convergeDeps: ConvergeDeps; // built once per pass (shared fingerprint snapshot + base URL); production wiring sets noEscalate: true
  syncStates: () => SyncState[];
  tunerBaseUrl: string; // resolved once per pass; "" disables the tuner-present check (see doc above)
  sendAlert: (kind: string, message: string) => Promise<boolean>;
  mirrorRoot: string; // vod.libraryPath's current value
  mirrorEnabled: boolean; // features.vodLibrary
  now: () => number; // for the staleness clock (check 3) — Date.now in production, injectable for tests
}

/** Synthetic report id for the global (not-per-server) VOD mirror check. */
// Exported so any other reader of the sync/converge namespace (Task 11's
// /api/sync/status) can recognize and exclude this synthetic id by reference
// instead of duplicating the string literal.
export const VOD_MIRROR_ID = "vod-mirror";
/** Same budget and reasoning as converge.ts's `convergeAll`: bound the wall
 *  clock a single pass can spend, checked between servers only. */
const PASS_DEADLINE_MS = 2 * 60_000;
/** How long a server may sit continuously NOT converged before "the ladder is
 *  still working on it" becomes "this looks stuck" (see module doc, check 3).
 *  2h is comfortably more than one refresh→verify cycle (refresh, then a
 *  10-minute wait, then a verify) even accounting for the reconciler missing
 *  a pass or two, and far longer than a legitimate provider sync
 *  (`providers.syncHours`, default 12h between runs) would ever keep a
 *  fingerprint continuously moving. */
const STALE_MS = 2 * 60 * 60_000;
/** converge.ts's own documented self-resolving skip reasons — not alert-
 *  worthy on their own. Every other `skipped:*` reason is real news. */
const BENIGN_DRIFT_ACTIONS = ["skipped:drift-unconfirmed", "skipped:rate-limited", "skipped:live-session"];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const label = (s: DownstreamServer) => s.name || s.url;

/** How long server `serverId` has been CONTINUOUSLY not-converged, in ms (0 if
 *  converged, or if this is the first time it's been seen not-converged).
 *  Module-level and in-memory by design — see module doc's staleness note. */
const firstNotConvergedAt = new Map<string, number>();
function trackStaleness(serverId: string, converged: boolean, now: number): number {
  if (converged) { firstNotConvergedAt.delete(serverId); return 0; }
  const since = firstNotConvergedAt.get(serverId);
  if (since == null) { firstNotConvergedAt.set(serverId, now); return 0; }
  return now - since;
}
/** Test-only: forget every server's staleness clock. */
export function _resetReconcilerState(): void {
  firstNotConvergedAt.clear();
}

/** Check 3 — see the module doc for the reasoning behind each branch. */
function convergedCheck(st: SyncState | undefined): { check: Check; alertWorthy: boolean; needsAttention: boolean } {
  if (st?.needsAttention) {
    return {
      check: {
        name: "converged", ok: false,
        detail: `circuit breaker tripped after ${st.readdFailures} failed rebuilds — escalation is OFF until an operator resets it (resetAttention)`,
      },
      alertWorthy: true,
      needsAttention: true,
    };
  }
  if (!st || st.state === "converging" || st.state === "unknown") {
    return {
      check: { name: "converged", ok: false, detail: st ? "convergence in progress" : "no convergence history yet" },
      alertWorthy: false,
      needsAttention: false,
    };
  }
  if (st.state === "converged") return { check: { name: "converged", ok: true }, alertWorthy: false, needsAttention: false };
  // "drifted" — the ladder itself gave up on its last pass. Alert-worthy
  // unless the reason is one of converge.ts's own documented benign skips.
  const benign = BENIGN_DRIFT_ACTIONS.some((p) => st.lastAction.startsWith(p));
  return { check: { name: "converged", ok: false, detail: st.lastError ?? `state=${st.state}` }, alertWorthy: !benign, needsAttention: false };
}

/** Check 2 — see the module doc. Returns `ok` separately from the `Check`
 *  itself so the caller doesn't have to re-derive it from `detail`. */
async function tunerCheck(s: DownstreamServer, deps: ReconcileDeps): Promise<{ check: Check; ok: boolean }> {
  if (!deps.tunerBaseUrl) {
    return {
      check: { name: "tuner", ok: true, detail: "tuner base URL unknown — skipped (set tuner.publicUrl or vod.publicUrl)" },
      ok: true,
    };
  }
  try {
    const hosts = await deps.client.listTunerHosts(s);
    const owned = hosts.some((h) => hostScope(h.Url, deps.tunerBaseUrl) !== null);
    return owned
      ? { check: { name: "tuner", ok: true }, ok: true }
      : { check: { name: "tuner", ok: false, detail: `no Phospharr tuner host under ${deps.tunerBaseUrl}/t/` }, ok: false };
  } catch (e) {
    return { check: { name: "tuner", ok: false, detail: errMsg(e) }, ok: false };
  }
}

/** Best-effort alert send — never lets a broken/injected sendAlert escape as
 *  an unhandled rejection (sendAlert's real contract never throws, but
 *  ReconcileDeps.sendAlert is caller-supplied and this keeps the guarantee
 *  regardless). */
async function safeAlert(deps: ReconcileDeps, kind: string, message: string): Promise<void> {
  try { await deps.sendAlert(kind, message); } catch (e) { console.error(`[reconciler] sendAlert itself failed for ${kind}: ${errMsg(e)}`); }
}

async function reconcileServer(s: DownstreamServer, deps: ReconcileDeps): Promise<ReconcileServerReport> {
  try {
    await deps.client.listUsers(s);
  } catch (e) {
    const detail = errMsg(e);
    // Don't let outage time masquerade as "stuck in converging" — that clock
    // measures the ladder failing to progress, not Emby being unreachable
    // (already alerted separately, right here). Without this reset, a server
    // down for >STALE_MS would fire a spurious "stuck for over 2h" alert the
    // moment it comes back, on its very next pass.
    trackStaleness(s.id, true, deps.now());
    await safeAlert(deps, `reconciler:${s.id}`, `${label(s)}: unreachable (${detail})`);
    return { serverId: s.id, checks: [{ name: "reachable", ok: false, detail }] };
  }

  const checks: Check[] = [{ name: "reachable", ok: true }];

  const { check: tCheck, ok: tunerOk } = await tunerCheck(s, deps);
  checks.push(tCheck);

  const st = deps.syncStates().find((x) => x.serverId === s.id);
  const { check: rawCCheck, alertWorthy: convergedAlertWorthy, needsAttention } = convergedCheck(st);
  const staleMs = trackStaleness(s.id, rawCCheck.ok, deps.now());
  const stale = staleMs > STALE_MS;
  // If stale, enrich the reported detail — and reuse that SAME enriched
  // detail in the alert message below, so the operator sees the same reason
  // in both places rather than the alert silently reverting to the raw one.
  const cCheck: Check = stale
    ? { ...rawCCheck, detail: `${rawCCheck.detail ?? "not converged"} — stuck for over ${Math.round(STALE_MS / 3600_000)}h` }
    : rawCCheck;
  checks.push(cCheck);

  const needsFix = !tunerOk || !cCheck.ok;
  // Skip the nudge ONLY when the breaker is tripped AND nothing is owed — a
  // pointless verify (rung 4 is unreachable from this call regardless, see
  // ConvergeDeps.noEscalate). But when a re-add IS owed (`pendingReadd`), the
  // nudge must keep running: rung 0 is add-only, cannot itself delete
  // anything, is unaffected by needsAttention/noEscalate, and is very often
  // how the breaker trips in the first place (a rebuild whose re-add failed
  // leaves the tuner host deleted from Emby AND the breaker tripped in the
  // same note() call — see rebuildTuners/finishReadd in converge.ts). Skipping
  // it here would strand that repair for up to convergeAll's own 6-12h cadence.
  const breakerBlocksNudge = needsAttention && !st?.pendingReadd;
  if (needsFix && !breakerBlocksNudge) {
    await deps.convergeServer(s, deps.convergeDeps);
  }

  const alertWorthy = convergedAlertWorthy || stale;
  const parts: string[] = [];
  if (!tunerOk) parts.push(tCheck.detail ? `tuner (${tCheck.detail})` : "tuner");
  if (alertWorthy) parts.push(cCheck.detail ? `converged (${cCheck.detail})` : "converged");
  if (parts.length) await safeAlert(deps, `reconciler:${s.id}`, `${label(s)}: ${parts.join("; ")}`);

  return { serverId: s.id, checks };
}

/** Check 4 — global, not per-server. Requires the mirror root to already
 *  exist and be writable; never creates it (see module doc). */
function mirrorCheck(deps: ReconcileDeps): Check {
  if (!deps.mirrorEnabled) return { name: "vod-mirror-writable", ok: true, detail: "disabled (features.vodLibrary off)" };
  if (!deps.mirrorRoot) return { name: "vod-mirror-writable", ok: false, detail: "vod.libraryPath is empty" };
  try {
    accessSync(deps.mirrorRoot, constants.W_OK);
  } catch (e) {
    return { name: "vod-mirror-writable", ok: false, detail: errMsg(e) };
  }
  try {
    const probe = join(deps.mirrorRoot, `.reconciler-write-probe-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return { name: "vod-mirror-writable", ok: true };
  } catch (e) {
    return { name: "vod-mirror-writable", ok: false, detail: errMsg(e) };
  }
}

/**
 * One reconcile pass: every enabled server's checks (repairing + alerting as
 * needed), plus the global VOD mirror check. Never throws — one server's
 * unexpected failure is recorded and the pass continues with the rest, same
 * "never blocks Phospharr's own serving path" contract as `convergeAll`.
 */
export async function reconcileOnce(deps: ReconcileDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = [];
  // A clock stub that throws must not escape either — converge.ts guards the
  // same class of failure around its own now()/save() error path. Falls back
  // to the real clock, which only degrades the deadline's precision, never
  // the "never throws" contract.
  const now = (): number => {
    try { return deps.now(); } catch (e) { console.error(`[reconciler] deps.now() threw: ${errMsg(e)}`); return Date.now(); }
  };
  const deadline = now() + PASS_DEADLINE_MS;

  let servers: DownstreamServer[] = [];
  try {
    servers = await deps.servers();
  } catch (e) {
    console.error(`[reconciler] could not list downstream servers: ${errMsg(e)}`);
  }

  for (const s of servers) {
    if (now() > deadline) {
      console.warn(`[reconciler] pass hit its ${PASS_DEADLINE_MS / 1000}s budget — deferring the remaining server(s) to the next run`);
      break;
    }
    try {
      report.push(await reconcileServer(s, deps));
    } catch (e) {
      console.error(`[reconciler] ${label(s)}: check failed unexpectedly: ${errMsg(e)}`);
      await safeAlert(deps, `reconciler:${s.id}`, `${label(s)}: check failed unexpectedly (${errMsg(e)})`);
      report.push({ serverId: s.id, checks: [{ name: "reconciler-error", ok: false, detail: errMsg(e) }] });
    }
  }

  try {
    const vodCheck = mirrorCheck(deps);
    if (!vodCheck.ok) await safeAlert(deps, `reconciler:${VOD_MIRROR_ID}`, `VOD mirror not writable: ${vodCheck.detail}`);
    report.push({ serverId: VOD_MIRROR_ID, checks: [vodCheck] });
  } catch (e) {
    console.error(`[reconciler] VOD mirror check failed unexpectedly: ${errMsg(e)}`);
    report.push({ serverId: VOD_MIRROR_ID, checks: [{ name: "vod-mirror-writable", ok: false, detail: errMsg(e) }] });
  }

  return report;
}

// ─── production wiring: 5-minute loop, watchdog-registered ─────────────────

const TICK_MS = 5 * 60_000;
const realClient: ReconcileClient = { listUsers: embyClient.listUsers, listTunerHosts: embyClient.listTunerHosts };

let timer: ReturnType<typeof setInterval> | null = null;
let beat: () => void = () => {};
let watchdogRegistered = false;
let running = false;

async function buildDeps(): Promise<ReconcileDeps> {
  const all = (await getSetting("epg.downstream")) ?? [];
  const targets = all.filter((s) => s.enabled && s.url && s.apiKey && s.type !== "plex");
  const base = await tunerBaseUrl();
  const fp = currentFingerprint(); // one snapshot for the whole pass, same as convergeAll
  const convergeDeps: ConvergeDeps = {
    fingerprint: () => fp,
    client: embyClient,
    now: Date.now,
    tunerUrl: base,
    verify: (s) => verifyLineup(s, embyClient, base),
    noEscalate: true, // this loop may never trigger rung 4 — see module doc
  };
  return {
    servers: async () => targets,
    client: realClient,
    convergeServer,
    convergeDeps,
    syncStates,
    tunerBaseUrl: base,
    sendAlert,
    mirrorRoot: await getSetting("vod.libraryPath"),
    mirrorEnabled: await getSetting("features.vodLibrary"),
    now: Date.now,
  };
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** One pass: run `reconcileOnce`, then beat — success or failure, but only
 *  once the pass actually settles. Factored out of `tick()` (which supplies
 *  the real settings-backed `deps` and the real watchdog-bound `beat`) so
 *  tests can drive the exact same running-guard + finally-beat structure with
 *  injected deps/beat instead — see `_runPass` below and its test. */
async function runPass(deps: ReconcileDeps, beatFn: () => void): Promise<void> {
  if (running) return; // previous pass still in flight (e.g. many servers + a wedged webhook) — don't stack, don't beat
  running = true;
  try {
    const report = await reconcileOnce(deps);
    const bad = report.filter((r) => r.checks.some((c) => !c.ok));
    if (bad.length) console.log(`[reconciler] needs attention this pass: ${bad.map((r) => r.serverId).join(", ")}`);
  } catch (e) {
    console.error("[reconciler] tick error:", errMsg(e));
  } finally {
    running = false;
    beatFn(); // heartbeat reflects PASS COMPLETION (bounded by PASS_DEADLINE_MS), not merely a timer tick — see module doc
  }
}

async function tick(): Promise<void> {
  // buildDeps() is a handful of settings reads — normally fast, but not
  // contractually non-throwing (a corrupt settings row can make it throw,
  // same class of failure tests/alerts.test.ts pins for sendAlert). A FAST
  // failure here still beats: it's a completed (if unsuccessful) attempt,
  // not a hang, and treating it as "no beat" would let a transient/corrupt
  // settings row escalate all the way to a watchdog restart+exit for a
  // problem the watchdog can't fix. A HUNG buildDeps() (an await that never
  // returns) is the real target of Finding 1's fix and is still caught: this
  // catch block, like runPass's, only runs once the await settles.
  let deps: ReconcileDeps;
  try {
    deps = await buildDeps();
  } catch (e) {
    console.error("[reconciler] tick error (buildDeps):", errMsg(e));
    beat();
    return;
  }
  await runPass(deps, beat);
}

/** Test-only: drive one pass with injected deps and an injected beat
 *  callback, bypassing `buildDeps()`'s real settings-backed wiring and the
 *  module's own watchdog-bound `beat`. Exercises the SAME `runPass` the
 *  production loop calls, so a regression that moves the beat back to the
 *  top of the pass (before the running-guard) fails this, not just a
 *  reimplementation of it. */
export function _runPass(deps: ReconcileDeps, beatFn: () => void): Promise<void> {
  return runPass(deps, beatFn);
}

/** Test-only: force the in-flight-pass guard back to false. A wedge test
 *  intentionally leaves a pass's promise permanently pending (its injected
 *  dependency never resolves), which would otherwise strand `running=true`
 *  for the rest of the process/test file. */
export function _resetRunningGuard(): void { running = false; }

/** Start the 5-min reconciler loop (idempotent). Watchdog-registered like the
 *  other background schedulers (src/epg/scheduler.ts, src/sync/favorites.ts). */
export function startReconciler(): void {
  if (timer) return; // already started
  if (!watchdogRegistered) {
    watchdogRegistered = true; // register once so the watchdog's strike count survives our own restarts
    ({ beat } = registerLoop("reconciler", TICK_MS, () => { stop(); startReconciler(); }));
  }
  timer = setInterval(() => { void tick(); }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref(); // don't keep the process alive on its own
  void tick(); // initial pass shortly after boot rather than waiting a full interval
}
