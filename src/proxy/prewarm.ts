import { and, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels, viewEvents } from "../db/schema.ts";
import { pool } from "../scheduler/pool.ts";
import { muxer } from "./muxer.ts";
import { favoriteWeight } from "../sync/favorites.ts";
import { evictionPlan } from "./warmevict.ts";

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
 *  - muxer's evictor frees the oldest warm hold on a channel NOBODY is
 *    watching, the instant a real tune needs the slot (see warmevict.ts)
 *  - holds expire on their own; the ring follows the most recent real tune
 */

const HEADROOM = 1; // never leave fewer than this many free slots after warming
// One hold, held longer. The count matters far less than it used to now that a
// hold can never outrank a real viewer (see warmevict.ts) — it yields the moment
// a tune needs the slot — so the useful lever is duration, not quantity. 90s was
// short enough that a viewer settling on a channel for one programme would find
// the ring gone cold by the time they surfed again.
const MAX_WARM = 1; // at most this many simultaneous warm holds
const HOLD_MS = 5 * 60_000; // a hold's lifetime unless refreshed by another tune

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

/**
 * Free a slot for a real tune by dropping the OLDEST warm hold that nobody is
 * watching. The muxer calls this when a tune finds no free slot.
 *
 * Oldest-first because a warm hold's value decays: the ring follows the most
 * recent tune, so the channel warmed longest ago is the one least likely to be
 * surfed to next.
 *
 * Skipping watched channels is the part that matters. A hold subscribes to its
 * channel like any other viewer, so a channel can carry both a hold AND real
 * viewers — and `release()` tears the upstream down only when nothing is left
 * attached. Evicting such a hold frees no provider slot at all, yet the old code
 * reported success, so the muxer stopped looking and failed the very tune it was
 * evicting for. Those holds are still dropped as we pass them (a channel with a
 * viewer is not "warm" any more, and its drain-and-discard reader is pure
 * waste), but only an idle one counts as having freed a slot.
 */
function evictOne(): boolean {
  // viewers() counts the hold's own subscription, so >1 means a real viewer.
  const plan = evictionPlan(holds.keys(), (id) => muxer.viewers(id));
  for (const id of plan.drop) {
    release(id);
    if (id !== plan.freed) console.log(`[prewarm] channel ${id} has a viewer — kept live, warm hold dropped`);
  }
  if (plan.freed === null) return false;
  console.log(`[prewarm] evicted warm hold on channel ${plan.freed} for a real viewer`);
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

const FAVORITE_BOOST = 2; // one household favorite ≈ two habitual same-hour views

/** The channels worth warming around a just-tuned channel, ranked by a score:
 *  ring proximity + analytics habit are the base signal (what's PLAUSIBLY
 *  about to be tuned), and household favorites (src/sync/favorites.ts) boost
 *  whichever of those candidates the household actually cares about — so
 *  MAX_WARM's limited slots go to the nearer/habitual channel most likely to
 *  also be wanted, not just the nearer/habitual channel. Favorites don't
 *  introduce brand-new candidates on their own; they break ties within the
 *  set the ring/habit heuristics already produced. */
async function targets(channelId: number): Promise<number[]> {
  const [me] = await db
    .select({ number: channels.number })
    .from(channels)
    .where(eq(channels.id, channelId));

  const scores = new Map<number, number>();
  const bump = (id: number, by: number) => scores.set(id, (scores.get(id) ?? 0) + by);

  if (me?.number != null) {
    // number-adjacent visible channels (the surf ring), closest weighted highest
    const ring = await db
      .select({ id: channels.id, number: channels.number })
      .from(channels)
      .where(and(eq(channels.isHidden, false), isNotNull(channels.number), ne(channels.id, channelId)))
      .orderBy(sql`ABS(${channels.number} - ${me.number})`)
      .limit(2);
    ring.forEach((r, i) => bump(r.id, ring.length - i));
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
    for (const r of rows) if (r.channelId !== channelId) bump(r.channelId, 1);
  } catch { /* analytics empty — ring only */ }

  for (const id of scores.keys()) {
    const w = favoriteWeight(id);
    if (w > 0) bump(id, FAVORITE_BOOST * w);
  }

  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
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
