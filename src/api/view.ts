import { db } from "../db/index.ts";
import { providers, channels, streams, type User } from "../db/schema.ts";
import { channelVisible } from "../auth.ts";

/**
 * One aggregated payload that powers the entire Phospharr UI in a single fetch:
 * channels enriched with health + source count, the guide window of programs,
 * and server-health counters. Keeps the frontend to one round-trip.
 */

export interface ViewChannel {
  id: number;
  num: number | null;
  name: string;
  canonicalId: string | null;
  category: string | null;
  logoUrl: string | null;
  isHidden: boolean;
  isFavorite: boolean;
  health: "live" | "sd" | "dead";
  sources: number;
  resolution: number | null;
  updated: string;
}

function rel(ts: Date | null): string {
  if (!ts) return "—";
  const diff = Date.now() - ts.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Collapse a channel's stream healths into the UI's live/sd/dead badge. */
function channelHealth(rows: { health: string; resolution: number | null }[]): {
  health: "live" | "sd" | "dead";
  resolution: number | null;
} {
  if (rows.length === 0) return { health: "dead", resolution: null };
  const best = rows.reduce((m, r) => Math.max(m, r.resolution ?? 0), 0) || null;
  // "unknown" = not yet probed. Treat as usable — a channel is only Dead once
  // every source has actually been probed dead (the health-probe loop is roadmap).
  const usable = rows.some((r) => r.health === "live" || r.health === "unknown");
  const degraded = rows.some((r) => r.health === "degraded");
  if (usable) {
    // A source known to be under 720p reads as "SD" in the badge.
    return { health: best && best < 720 ? "sd" : "live", resolution: best };
  }
  if (degraded) return { health: "sd", resolution: best };
  return { health: "dead", resolution: best };
}

export async function buildView(user?: User | null) {
  // Channels + health + source counts. The guide itself is served separately
  // (cached, compressed) via /api/guide.
  const [chanRows, streamRows, provRows] = await Promise.all([
    db.select().from(channels).orderBy(channels.number),
    db
      .select({
        channelId: streams.channelId,
        health: streams.health,
        resolution: streams.resolution,
        lastProbedAt: streams.lastProbedAt,
      })
      .from(streams),
    db.select({ id: providers.id }).from(providers),
  ]);

  // Group streams by channel.
  const byChannel = new Map<number, typeof streamRows>();
  for (const s of streamRows) {
    const arr = byChannel.get(s.channelId) ?? [];
    arr.push(s);
    byChannel.set(s.channelId, arr);
  }

  // Restricted (non-admin) users only see channels their restrictions allow.
  const restrict = user && user.role !== "admin" ? user.restrictions : null;
  const visibleRows = restrict ? chanRows.filter((ch) => channelVisible(ch, restrict)) : chanRows;

  const viewChannels: ViewChannel[] = visibleRows.map((ch) => {
    const ss = byChannel.get(ch.id) ?? [];
    const { health, resolution } = channelHealth(ss);
    const updated = ss.reduce<Date | null>(
      (latest, s) => (s.lastProbedAt && (!latest || s.lastProbedAt > latest) ? s.lastProbedAt : latest),
      null,
    );
    return {
      id: ch.id,
      num: ch.number,
      name: ch.name,
      canonicalId: ch.canonicalId,
      category: ch.category,
      logoUrl: ch.logoUrl,
      isHidden: ch.isHidden,
      isFavorite: ch.isFavorite,
      health,
      sources: ss.length,
      resolution,
      updated: rel(updated),
    };
  });

  return {
    now: Date.now(),
    serverHealth: {
      channels: viewChannels.filter((c) => !c.isHidden).length,
      streams: streamRows.length,
      sources: provRows.length,
    },
    channels: viewChannels,
  };
}
