import { sqlite } from "../db/index.ts";
import { normalizeName } from "../canonical/normalize.ts";
import { similarity, digitRuns } from "../canonical/matcher.ts";
import { listUsers, listFavoriteChannels } from "./embyClient.ts";
import { getSetting } from "../settings.ts";
import { registerLoop } from "../health/watchdog.ts";
import type { DownstreamServer } from "../settings.ts";

/**
 * Favorites read-back: pull each Emby/Jellyfin user's favorite channels and
 * use them to weight the prewarm ring (src/proxy/prewarm.ts) — a channel
 * several household members favorited is worth holding warm even outside its
 * number-adjacent surf ring or its analytics-derived "watched this hour"
 * slot.
 *
 * MAPPING (mapFavorite): Emby's guide `Number` is the cheap, precise signal —
 * it round-trips our own `channels.number` (a real, uniquely-indexed lineup
 * slot), so an exact numeric match is trusted outright. When that misses (no
 * Number, or a number Emby hasn't picked up yet) we fall back to a name slug
 * match against `channels.name`, exact first, then fuzzy. The fuzzy step
 * reuses BOTH pieces of src/canonical/matcher.ts's ingest-time matching, not
 * just its 0.86 Levenshtein-similarity bar: also its `digitRuns` guard, which
 * requires two slugs' digit-groups to match before they're allowed to fuzzy-
 * merge. Without that guard, numbered siblings ("Sky Sports 1" vs "Sky Sports
 * 2") are ~0.90 similar — comfortably over 0.86 — so a stale/number-less
 * favorite name could silently bind to the wrong sibling, with the winner
 * decided by scan order rather than which channel the household actually
 * favorited. The digit guard makes that impossible: a candidate whose digits
 * don't match the query's is never even scored, so at worst an ambiguous
 * (digit-less) favorite maps to nothing (counted as unmapped) rather than to
 * a coin-flip sibling.
 *
 * Ground truth (measured on production 2026-08-07): `channels` holds ~6580
 * is_hidden=0 rows, but only ~3285 are ever playlist-eligible (is_hidden=0 AND
 * number IS NOT NULL AND a non-dead stream — src/content/lineup.ts). The rest
 * are non-live entries (VOD/series titles like "1899", "30 Rock") that
 * happened to land in `channels`. A name-slug match that considered those
 * rows could silently bind a favorite to a channel that can never be warmed —
 * worse, to the WRONG row if a VOD title happens to share a normalized slug
 * with a real channel. So both match paths are restricted to
 * `is_hidden = 0 AND number IS NOT NULL`: candidates that could actually
 * reach a playlist. A favorite that still can't be mapped is counted and
 * logged (see _pollOnce) rather than silently dropped.
 *
 * REPLACE SEMANTICS (_pollOnce): each poll is expected to fully replace a
 * server's rows in `downstream_favorites` — a user who unfavorited everything
 * should stop contributing weight. The risk that creates: Emby's `Users` or
 * `Items?Filters=IsFavorite` endpoints returning a well-formed BUT WRONG empty
 * result (a transient auth/session issue, a permissions change, an API shape
 * change Emby ships) would, naively, wipe the ring's weighting on every such
 * poll even though nothing actually changed. `embyClient.ts` already turns
 * outright failures (non-2xx, malformed bodies) into thrown errors rather
 * than a fabricated `[]` — so the one case left to guard is "the call
 * SUCCEEDED and returned `[]`", which is indistinguishable from a genuine
 * empty-favorites user at the HTTP layer.
 *
 * The guard: _pollOnce fetches EVERY user's favorites for a server first and
 * only performs the delete+insert if the entire round-trip succeeded. If any
 * user's `listFavoriteChannels` (or `listUsers`) call THROWS, the function
 * rethrows and the DB is never touched — last-known-good weighting survives a
 * bad poll intact, and pollFavorites() logs the failure and tries the next
 * server. A poll that fully succeeds and legitimately reports zero favorites
 * for everyone DOES replace the rows with nothing — that's a real signal, not
 * a degraded one. This can't silently degrade the feature: the only way
 * weighting drops to zero is a complete, successful confirmation that nobody
 * has favorites, and the only way a failure can hurt is by leaving data
 * stale, never by erasing it.
 */

const FUZZY_THRESHOLD = 0.86; // same bar + digitRuns guard as canonical ingest matching (src/canonical/matcher.ts)
const POLL_INTERVAL_MS = 15 * 60_000;

export interface FavoritesEmbyClient {
  listUsers: typeof listUsers;
  listFavoriteChannels: typeof listFavoriteChannels;
}

const realClient: FavoritesEmbyClient = { listUsers, listFavoriteChannels };

// Prepared lazily: this module is imported at boot, and a compile-time
// `prepare` would turn a not-yet-migrated DB into an import crash.
let stmts: {
  byNumber: ReturnType<typeof sqlite.prepare>;
  playable: ReturnType<typeof sqlite.prepare>;
  del: ReturnType<typeof sqlite.prepare>;
  insert: ReturnType<typeof sqlite.prepare>;
  weight: ReturnType<typeof sqlite.prepare>;
} | null = null;

function q() {
  return (stmts ??= {
    byNumber: sqlite.prepare("SELECT id FROM channels WHERE is_hidden = 0 AND number = ?"),
    // number ASC: deterministic scan order so a duplicate/near-duplicate name
    // resolves to the same channel every time, not whichever row SQLite
    // happens to return first.
    playable: sqlite.prepare("SELECT id, name FROM channels WHERE is_hidden = 0 AND number IS NOT NULL ORDER BY number ASC"),
    del: sqlite.prepare("DELETE FROM downstream_favorites WHERE server_id = ?"),
    insert: sqlite.prepare(
      `INSERT INTO downstream_favorites (server_id, user_id, channel_id, seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(server_id, user_id, channel_id) DO UPDATE SET seen_at = excluded.seen_at`,
    ),
    weight: sqlite.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM downstream_favorites WHERE channel_id = ?"),
  });
}

/**
 * Map one Emby favorite entry to a channel id, or null if it can't be
 * confidently resolved. Number match first (exact, cheap, trusted); slug
 * match second (exact, then fuzzy). Both paths only consider playlist-
 * eligible channels — see the module header for why.
 */
export function mapFavorite(fav: { Number?: string; Name: string }): number | null {
  const { byNumber, playable } = q();

  if (fav.Number != null && fav.Number.trim() !== "") {
    const n = Number(fav.Number);
    if (Number.isFinite(n)) {
      const row = byNumber.get(n) as { id: number } | undefined;
      if (row) return row.id;
    }
  }

  const slug = normalizeName(fav.Name ?? "").slug;
  if (!slug) return null;
  const slugDigits = digitRuns(slug);

  const rows = playable.all() as { id: number; name: string }[];
  let best: { id: number; score: number } | null = null;
  for (const r of rows) {
    const rSlug = normalizeName(r.name).slug;
    if (rSlug === slug) return r.id; // exact slug match wins outright
    // Numbered siblings ("Sky Sports 1" vs "2") can be ~0.90 similar — above
    // FUZZY_THRESHOLD — so a fuzzy match additionally requires identical
    // digit-groups, same guard src/canonical/matcher.ts pairs with
    // similarity() for the same reason. A digit-less/ambiguous query matches
    // neither and falls through to null (counted as unmapped) instead of
    // silently binding to whichever sibling the scan happens to reach first.
    if (digitRuns(rSlug) !== slugDigits) continue;
    const score = similarity(slug, rSlug);
    if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) best = { id: r.id, score };
  }
  return best?.id ?? null;
}

/** Distinct households favoriting a channel — 0 if none/unmapped. Read on the
 *  prewarm scoring hot path (src/proxy/prewarm.ts), so this is a single
 *  indexed COUNT(DISTINCT), not a scan. */
export function favoriteWeight(channelId: number): number {
  const row = q().weight.get(channelId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Fetch every user's favorites for one server and replace that server's rows
 * in `downstream_favorites` — but ONLY if every fetch in the round succeeded.
 * Throws (without touching the DB) if `listUsers` or any `listFavoriteChannels`
 * call throws, so a bad poll can never zero out or partially corrupt the
 * prewarm ring's weighting. See the module header for the full reasoning.
 */
export async function _pollOnce(s: DownstreamServer, client: FavoritesEmbyClient = realClient): Promise<void> {
  const users = await client.listUsers(s);
  const rows: { userId: string; channelId: number }[] = [];
  let total = 0;
  let unmapped = 0;
  for (const u of users) {
    const favs = await client.listFavoriteChannels(s, u.Id);
    for (const f of favs) {
      total++;
      const channelId = mapFavorite(f);
      if (channelId == null) {
        unmapped++;
        continue;
      }
      rows.push({ userId: u.Id, channelId });
    }
  }
  if (unmapped > 0) {
    console.warn(`[favorites] ${s.name || s.url}: ${unmapped}/${total} favorite(s) could not be mapped to a channel`);
  }

  const { del, insert } = q();
  const now = Date.now();
  const replace = sqlite.transaction(() => {
    del.run(s.id);
    for (const r of rows) insert.run(s.id, r.userId, r.channelId, now);
  });
  replace();
}

/**
 * Poll every enabled, non-Plex downstream server's favorites. Best-effort —
 * one server's failure (network blip, bad API key) is logged and skipped so
 * it never blocks the others or Phospharr's own serving path.
 */
export async function pollFavorites(): Promise<void> {
  let servers: DownstreamServer[] = [];
  try {
    servers = (await getSetting("epg.downstream")) ?? [];
  } catch (e) {
    console.error("[favorites] could not read epg.downstream settings:", e instanceof Error ? e.message : e);
    return;
  }
  const targets = servers.filter((s) => s.enabled && s.url && s.apiKey && s.type !== "plex");
  for (const s of targets) {
    try {
      await _pollOnce(s, realClient);
    } catch (e) {
      console.error(`[favorites] poll failed for ${s.name || s.url}:`, e instanceof Error ? e.message : e);
    }
  }
}

// ─── 15-minute loop, watchdog-registered ────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null;
let beat: () => void = () => {};
let watchdogRegistered = false;

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** One poll pass, then beat — success or failure, but only once the pass
 *  actually settles. Factored out of `tick()` (which supplies the real
 *  `pollFavorites` and the real watchdog-bound `beat`) so tests can drive the
 *  same finally-beat structure with an injected, controllable poll function —
 *  see `_runPoll` below and its test. */
async function runPoll(pollFn: () => Promise<void>, beatFn: () => void): Promise<void> {
  try {
    await pollFn();
  } catch (e) {
    // pollFavorites() already catches per-server; this is a backstop so the
    // interval itself can never die from an unexpected throw.
    console.error("[favorites] tick error:", e instanceof Error ? e.message : e);
  } finally {
    // Beat AFTER the pass finishes, not at the top of the tick — the
    // watchdog must see a poll actually complete, not merely that the timer
    // fired. Bound: every embyClient call this poll makes has its own 15s
    // AbortSignal.timeout (src/sync/embyClient.ts), so no single fetch can
    // hang forever; there is no PASS_DEADLINE_MS-style cap on the pass AS A
    // WHOLE the way the reconciler has one, so the worst case is bounded by
    // (servers × users × 15s) rather than a small fixed constant — still
    // finite, just not tightly bounded for an install with many downstream
    // users. See reconciler.ts's tick() for the sibling loop this mirrors.
    beatFn();
  }
}

async function tick(): Promise<void> {
  await runPoll(pollFavorites, beat);
}

/** Test-only: drive one poll pass with an injected poll function and beat
 *  callback, bypassing the real settings-backed `pollFavorites` and the
 *  module's own watchdog-bound `beat`. Exercises the SAME `runPoll` the
 *  production loop calls. */
export function _runPoll(pollFn: () => Promise<void>, beatFn: () => void): Promise<void> {
  return runPoll(pollFn, beatFn);
}

/** Start the 15-min favorites poll loop (idempotent). Registers with the
 *  watchdog so a wedged loop gets restarted / escalated like the other
 *  background schedulers. */
export function startFavoritesLoop(): void {
  if (timer) return; // already started
  if (!watchdogRegistered) {
    watchdogRegistered = true; // register once so the watchdog's strike count survives our own restarts
    ({ beat } = registerLoop("favorites", POLL_INTERVAL_MS, () => { stop(); startFavoritesLoop(); }));
  }
  timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref(); // don't keep the process alive on its own
  void tick(); // initial poll shortly after boot rather than waiting a full interval
}

/** Test-only: delete one server's rows. NEVER truncates the whole table —
 *  `downstream_favorites` can hold real household data when this suite runs
 *  against a populated DB. */
export function _clearFavorites(serverId: string): void {
  q().del.run(serverId);
}
