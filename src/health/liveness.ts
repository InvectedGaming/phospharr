/**
 * Liveness for resolver-backed channels (Twitch and friends).
 *
 * A provider channel is a 24h feed: "is it healthy?" is a question about the
 * SOURCE, and a 12h re-probe sweep answers it fine. A Twitch channel is the
 * opposite — the source is permanently fine and the BROADCAST comes and goes,
 * usually several times a day. Treated as a normal channel it sits in the guide
 * around the clock and plays nothing for most of it.
 *
 * So these are treated like event channels: live while the broadcast is up, gone
 * from the lineup when it is not. The removal needs no new machinery — the tuner
 * already lists only channels holding a non-dead stream (`hasUsableSource` in
 * tuner/hdhr.ts), so writing `dead` on the stream is exactly "hide it".
 *
 * Why this is not just a faster health probe:
 *  - The generic probe fetches the stream URL. For `https://twitch.tv/lofigirl`
 *    that returns an HTML page — bytes flow, so it lands on a verdict that has
 *    nothing to do with whether anyone is broadcasting. (This is why an offline
 *    MarvelRivals read `degraded` rather than `dead`.) probe.ts now skips
 *    resolver-backed streams and leaves them to this module.
 *  - Liveness is answerable without opening a stream at all: one aliased GraphQL
 *    call returns the state of every channel we care about in ~140ms, so a
 *    3-minute cadence costs nothing. Actually resolving each stream through
 *    streamlink would cost seconds apiece and hammer Twitch.
 *
 * These channels belong to a fast-sync tuner group, NOT the main lineup. The
 * main fingerprint feeds the reconciler, and a row set that changes every few
 * minutes would keep Emby permanently "converging" — a guide refresh every 5
 * minutes forever plus a staleness alert every 2h. Grouped categories are
 * excluded from the main export, which keeps the churn where it belongs.
 */

import { eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels, streams } from "../db/schema.ts";
import { pushOrRefreshDownstream } from "../sync/embyguide.ts";
import { registerLoop } from "./watchdog.ts";

const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL = "https://gql.twitch.tv/gql";

/** Poll cadence. Comfortably faster than the group's sync so the lineup Emby
 *  pulls is already correct by the time it asks. */
export const LIVENESS_INTERVAL_MS = 3 * 60_000;

/** Aliases per GraphQL request. Twitch answers a batch this size in one round
 *  trip; chunking keeps a large channel list from building an enormous query. */
const BATCH = 40;

/** twitch.tv/<login> → login. Returns null for anything that is not a plain
 *  Twitch channel URL (clips, videos, other platforms) — we only claim to know
 *  liveness for the shape we can actually ask about. */
export function twitchLogin(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]{2,25})\/?(?:[?#].*)?$/.exec(url.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Whether a login is broadcasting, and its stream title while it is. */
export type LiveState = { live: boolean; title: string | null };

/** Ask Twitch which of these logins are broadcasting.
 *  Returns a map login → { live, title }. A login missing from the result is
 *  one Twitch did not answer for; callers must leave those alone rather than
 *  guess. */
export async function fetchLiveness(logins: string[]): Promise<Map<string, LiveState>> {
  const out = new Map<string, LiveState>();
  for (let i = 0; i < logins.length; i += BATCH) {
    const chunk = logins.slice(i, i + BATCH);
    const query = `query { ${chunk.map((l, n) => `u${n}: user(login: ${JSON.stringify(l)}) { login stream { id title } }`).join(" ")} }`;
    let data: Record<string, { login: string; stream: { title: string | null } | null } | null> | undefined;
    try {
      const r = await fetch(GQL, {
        method: "POST",
        headers: { "Client-ID": CLIENT_ID, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) continue; // no answer for this chunk — record nothing
      data = ((await r.json()) as { data?: typeof data }).data;
    } catch {
      continue; // network blip: say nothing rather than declare everyone offline
    }
    for (const u of Object.values(data ?? {})) {
      if (!u?.login) continue; // deleted/banned channel — no verdict
      out.set(u.login.toLowerCase(), { live: u.stream != null, title: u.stream?.title ?? null });
    }
  }
  return out;
}

/** One pass: read the resolver-backed streams, ask Twitch, write health and
 *  the "Live now: <title>" guide filler. Returns counts for the log/tests. */
export async function pollOnce(
  fetcher: (logins: string[]) => Promise<Map<string, LiveState>> = fetchLiveness,
): Promise<{ live: number; offline: number; skipped: number; changed: boolean }> {
  const rows = db.select({ id: streams.id, channelId: streams.channelId, url: streams.url, health: streams.health })
    .from(streams).where(isNotNull(streams.resolver)).all();

  const byLogin = new Map<string, { id: number; channelId: number; health: string }[]>();
  let skipped = 0;
  for (const r of rows) {
    const login = twitchLogin(r.url);
    if (!login) { skipped++; continue; } // not a Twitch channel URL — not ours to judge
    let list = byLogin.get(login);
    if (!list) { list = []; byLogin.set(login, list); }
    list.push({ id: r.id, channelId: r.channelId, health: r.health });
  }
  if (!byLogin.size) return { live: 0, offline: 0, skipped, changed: false };

  const state = await fetcher([...byLogin.keys()]);

  // Group the writes by target health so this is two statements, not one per row.
  const toLive: number[] = [], toDead: number[] = [];
  const wantNow = new Map<number, string | null>(); // channelId -> desired customNow
  for (const [login, entries] of byLogin) {
    const s = state.get(login);
    if (s === undefined) continue; // Twitch didn't answer — keep the last known state
    const desired = s.live ? `Live now: ${s.title ?? "streaming"}` : null;
    for (const e of entries) {
      const want = s.live ? "live" : "dead";
      if (e.health !== want) (s.live ? toLive : toDead).push(e.id);
      wantNow.set(e.channelId, desired);
    }
  }
  const now = new Date();
  if (toLive.length) await db.update(streams).set({ health: "live", lastProbedAt: now }).where(inArray(streams.id, toLive));
  if (toDead.length) await db.update(streams).set({ health: "dead", lastProbedAt: now }).where(inArray(streams.id, toDead));

  let changed = toLive.length > 0 || toDead.length > 0;
  if (wantNow.size) {
    const channelIds = [...wantNow.keys()];
    const current = db.select({ id: channels.id, customNow: channels.customNow })
      .from(channels).where(inArray(channels.id, channelIds)).all();
    for (const c of current) {
      const desired = wantNow.get(c.id) ?? null;
      if (c.customNow !== desired) {
        await db.update(channels).set({ customNow: desired }).where(eq(channels.id, c.id));
        changed = true;
      }
    }
  }

  let live = 0, offline = 0;
  for (const v of state.values()) v.live ? live++ : offline++;
  if (toLive.length || toDead.length) {
    console.log(`[liveness] ${live} live, ${offline} offline (${toLive.length} came up, ${toDead.length} went down)`);
  }
  return { live, offline, skipped, changed };
}

let timer: ReturnType<typeof setInterval> | null = null;
let watchdogRegistered = false;
let beat: () => void = () => {};

let pushTimer: ReturnType<typeof setTimeout> | null = null;
/** Coalesce a burst of liveness changes into one push, ~10s later. */
function scheduleGuidePush(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushOrRefreshDownstream().catch((e) => console.error("[liveness] guide push failed:", e));
  }, 10_000);
  if (typeof pushTimer.unref === "function") pushTimer.unref();
}

async function tick(): Promise<void> {
  try {
    const r = await pollOnce();
    if (r.changed) scheduleGuidePush();
  } catch (e) {
    console.error("[liveness] poll failed:", e);
  }
  beat();
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Start the liveness poll loop (idempotent), watchdog-registered like the
 *  other background schedulers so a wedged loop is restarted. */
export function startLivenessLoop(): void {
  if (timer) return;
  if (!watchdogRegistered) {
    watchdogRegistered = true;
    ({ beat } = registerLoop("liveness", LIVENESS_INTERVAL_MS, () => { stop(); startLivenessLoop(); }));
  }
  timer = setInterval(() => { void tick(); }, LIVENESS_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  void tick(); // first pass right after boot, not one interval later
}

/** Test-only. */
export function _stopLiveness(): void { stop(); }
