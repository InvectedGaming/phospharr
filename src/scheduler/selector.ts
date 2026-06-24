import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { streams, type Stream } from "../db/schema.ts";
import { pool } from "./pool.ts";

/**
 * Source selection: given a logical channel, pick which underlying stream to
 * actually pull, considering health, quality, and live slot availability.
 *
 * This is where failover and capacity routing converge: we walk the ranked
 * sources and take the first one whose provider has a free slot (or is already
 * serving this exact stream — multiplex hit).
 */

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
  // Dead sources sink to the bottom but stay as last-resort.
  return rows.sort((a, b) => {
    const deadA = a.health === "dead" ? 1 : 0;
    const deadB = b.health === "dead" ? 1 : 0;
    if (deadA !== deadB) return deadA - deadB;
    return b.qualityScore - a.qualityScore;
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

  // 2. First source with a free provider slot.
  for (const s of ranked) {
    if (s.health === "dead") continue;
    if (pool.hasFreeSlot(s.providerId)) return { stream: s, multiplexHit: false };
  }

  // 3. Last resort: include dead-marked sources (probe may be stale).
  for (const s of ranked) {
    if (pool.hasFreeSlot(s.providerId)) return { stream: s, multiplexHit: false };
  }

  return null;
}
