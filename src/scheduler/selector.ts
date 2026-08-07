import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { streams, type Stream } from "../db/schema.ts";
import { pool } from "./pool.ts";
import { providerVerdict } from "../health/verdict.ts";

/**
 * Source selection: given a logical channel, pick which underlying stream to
 * actually pull, considering health, quality, and live slot availability.
 *
 * This is where failover and capacity routing converge: we walk the ranked
 * sources and take the first one whose provider has a free slot (or is already
 * serving this exact stream — multiplex hit).
 *
 * Provider verdicts (see health/verdict.ts) fold into the same ranking a
 * stream's own probed health already uses:
 *  - `down` sinks a stream to the same last-resort tier as `health: "dead"` —
 *    tried only when nothing better has a free slot, never preferred. It is
 *    NOT removed outright: a `down` verdict can itself be wrong (see
 *    verdict.ts's reasoning), so the existing "last resort, not never" escape
 *    hatch that already exists for stale dead-marks covers a wrong down-mark
 *    too, and it's the only thing standing between a bad verdict and a
 *    channel going fully unplayable.
 *  - `degraded` stays in the normal tier but takes a fixed score penalty
 *    (DEGRADED_PENALTY) — deliberately smaller than the smallest gap between
 *    adjacent resolution tiers in canonical/normalize.ts's QUALITY table
 *    (2160/1080/720/480 -> a 240-point floor between 720 and 480). That means
 *    a degraded provider only loses to an EQUAL-OR-BETTER-tier healthy
 *    alternative, never to a healthy stream a full tier down — and when a
 *    degraded provider is the only source for a channel at all, there is no
 *    competing candidate for the penalty to lose to, so it still wins.
 */

// Kept below the smallest adjacent-tier gap in canonical/normalize.ts's
// QUALITY table (720 -> 480 = 240) so a degraded provider never gets
// leap-frogged by a healthy stream a full quality tier lower — only by an
// equal-or-higher-tier healthy alternative, which is the intended trade-off.
const DEGRADED_PENALTY = 150;

function effectiveScore(s: Stream): number {
  return providerVerdict(s.providerId) === "degraded" ? s.qualityScore - DEGRADED_PENALTY : s.qualityScore;
}

export interface Selection {
  stream: Stream;
  /** true if an upstream for this stream is already live and we can fan out. */
  multiplexHit: boolean;
}

/** Streams currently being pulled, by streamId -> upstream key (for multiplex). */
const liveStreamIds = new Set<number>();

export function markLive(streamId: number) {
  liveStreamIds.add(streamId);
}
export function markDead(streamId: number) {
  liveStreamIds.delete(streamId);
}
export function isLive(streamId: number): boolean {
  return liveStreamIds.has(streamId);
}

export async function rankedStreams(channelId: number): Promise<Stream[]> {
  const rows = await db
    .select()
    .from(streams)
    .where(eq(streams.channelId, channelId))
    .orderBy(desc(streams.qualityScore));
  // Dead-health streams and down-provider streams sink to the bottom but
  // stay as last-resort (see the module doc above for why down isn't a hard
  // exclude). Within the normal tier, degraded providers rank by an
  // effective score that's penalized but not disqualifying.
  return rows.sort((a, b) => {
    const lastResortA = a.health === "dead" || providerVerdict(a.providerId) === "down" ? 1 : 0;
    const lastResortB = b.health === "dead" || providerVerdict(b.providerId) === "down" ? 1 : 0;
    if (lastResortA !== lastResortB) return lastResortA - lastResortB;
    return effectiveScore(b) - effectiveScore(a);
  });
}

/**
 * Select a stream to serve for a channel.
 *  - If a ranked source is already live → multiplex onto it (zero new slots).
 *  - Else pick the highest-ranked source whose provider has a free slot.
 *  - Else null = pool genuinely full for every source of this channel.
 */
export async function selectStream(channelId: number): Promise<Selection | null> {
  const ranked = await rankedStreams(channelId);
  if (ranked.length === 0) return null;

  // 1. Multiplex onto an already-live source.
  for (const s of ranked) {
    if (isLive(s.id)) return { stream: s, multiplexHit: true };
  }

  // 2. First source with a free provider slot, excluding dead-health streams
  // and down-verdict providers.
  for (const s of ranked) {
    if (s.health === "dead" || providerVerdict(s.providerId) === "down") continue;
    if (pool.hasFreeSlot(s.providerId)) return { stream: s, multiplexHit: false };
  }

  // 3. Last resort: include dead-marked / down-provider sources (the probe
  // or the verdict may be stale/wrong) — this is what lets a degraded OR
  // down provider still serve a channel that exists nowhere else, instead
  // of a wrong verdict making the channel unplayable outright.
  for (const s of ranked) {
    if (pool.hasFreeSlot(s.providerId)) return { stream: s, multiplexHit: false };
  }

  return null;
}
