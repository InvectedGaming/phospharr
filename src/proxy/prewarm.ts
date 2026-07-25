import { and, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels, viewEvents } from "../db/schema.ts";
import { pool } from "../scheduler/pool.ts";
import { muxer } from "./muxer.ts";

/**
 * Predictive prewarm ring — what makes channel surf feel like a real TV.
 *
 * While someone is watching channel N, we quietly hold warm upstreams for the
 * number-adjacent channels (N±1 — the block numbering makes those RELATED
 * channels) plus the lineup's most-watched channels for this hour of day (from
 * view analytics). Surf up/down and the muxer attach is ~3ms instead of a cold
 * 5–9s provider dial. Benefits every consumer — web player, Emby, HDHR — since
 * it lives in the proxy.
 *
 * Politeness rules (a warm hold must NEVER cost a real viewer):
 *  - only warms while the pool keeps ≥ HEADROOM free slots
 *  - muxer's evictor frees the oldest warm hold the instant a real tune needs
 *    the slot (installed via muxer.setEvictor below)
 *  - holds expire on their own; the ring follows the most recent real tune
 */

const HEADROOM = 1; // never leave fewer than this many free slots after warming
const MAX_WARM = 2; // at most this many simultaneous warm holds
const HOLD_MS = 90_000; // a hold's lifetime unless refreshed by another tune

type Hold = { channelId: number; cancel: () => void; expires: ReturnType<typeof setTimeout> };
const holds = new Map<number, Hold>();

function release(channelId: number): void {
  const h = holds.get(channelId);
  if (!h) return;
  holds.delete(channelId);
  clearTimeout(h.expires);
  try { h.cancel(); } catch { /* already gone */ }
  muxer.dropIdle(channelId); // free the slot NOW, not after the keep-warm grace
}

/** Free the oldest warm hold — the muxer calls this when a real tune finds no slot. */
function evictOne(): boolean {
  const first = holds.keys().next();
  if (first.done) return false;
  release(first.value);
  console.log(`[prewarm] evicted warm hold on channel ${first.value} for a real viewer`);
  return true;
}
muxer.setEvictor(evictOne);

async function warm(channelId: number): Promise<void> {
  if (holds.has(channelId) || muxer.hasChannel(channelId)) return;
  if (holds.size >= MAX_WARM) return;
  if (pool.totalFree() <= HEADROOM) return;
  const body = await muxer.open(channelId, undefined, { preroll: false }).catch(() => null);
  if (!body) return;
  const reader = body.getReader();
  // drain-and-discard: the hold IS a viewer as far as the muxer cares, so the
  // upstream stays hot and its TsPreroll keeps a fresh keyframe for instant attach
  void (async () => {
    try {
      while (holds.has(channelId)) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch { /* upstream died — the hold just lapses */ }
  })();
  const hold: Hold = {
    channelId,
    cancel: () => { reader.cancel().catch(() => { /* closing */ }); },
    expires: setTimeout(() => release(channelId), HOLD_MS),
  };
  holds.set(channelId, hold);
}

/** The channels worth warming around a just-tuned channel. */
async function targets(channelId: number): Promise<number[]> {
  const [me] = await db
    .select({ number: channels.number })
    .from(channels)
    .where(eq(channels.id, channelId));
  const out: number[] = [];
  if (me?.number != null) {
    // number-adjacent visible channels (the surf ring)
    const ring = await db
      .select({ id: channels.id, number: channels.number })
      .from(channels)
      .where(and(eq(channels.isHidden, false), isNotNull(channels.number), ne(channels.id, channelId)))
      .orderBy(sql`ABS(${channels.number} - ${me.number})`)
      .limit(2);
    out.push(...ring.map((r) => r.id));
  }
  // the lineup's habit: most-watched channel for this hour of day, last 14 days
  try {
    const hour = new Date().getHours();
    // Wrap around midnight: BETWEEN hour-1 AND hour+1 loses an hour at the 0/23
    // seam (at 0 it queries -1..1, missing 23). Use an explicit wrapped set.
    const hrs = [(hour + 23) % 24, hour, (hour + 1) % 24];
    const rows = await db
      .select({ channelId: viewEvents.channelId, secs: sql<number>`SUM(${viewEvents.durationSec})` })
      .from(viewEvents)
      .where(and(
        eq(viewEvents.kind, "watch"),
        gte(viewEvents.startedAt, new Date(Date.now() - 14 * 86400_000)),
        sql`CAST(strftime('%H', ${viewEvents.startedAt}, 'unixepoch') AS INTEGER) IN (${hrs[0]}, ${hrs[1]}, ${hrs[2]})`,
      ))
      .groupBy(viewEvents.channelId)
      .orderBy(sql`SUM(${viewEvents.durationSec}) DESC`)
      .limit(1);
    for (const r of rows) if (r.channelId !== channelId) out.push(r.channelId);
  } catch { /* analytics empty — ring only */ }
  return [...new Set(out)];
}

/** Called on every REAL tune (not previews). Fire-and-forget, surf-debounced:
 *  rapid zapping only rings around where the viewer SETTLES, so we never churn
 *  provider connections chasing a surf in progress. */
let ringTimer: ReturnType<typeof setTimeout> | null = null;
export function onTune(channelId: number): void {
  if (ringTimer) clearTimeout(ringTimer);
  ringTimer = setTimeout(() => {
    ringTimer = null;
    void (async () => {
      try {
        const ids = await targets(channelId);
        // Drop holds that are no longer near the action, then warm the new ring.
        for (const held of [...holds.keys()]) if (!ids.includes(held)) release(held);
        for (const id of ids) await warm(id);
      } catch (e) {
        console.error("[prewarm]", e instanceof Error ? e.message : e);
      }
    })();
  }, 1500);
}
