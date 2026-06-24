import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { providers, channels, streams, type Provider } from "../db/schema.ts";
import { fetchM3U } from "./m3u.ts";
import { fetchXtream } from "./xtream.ts";
import { egress, vpnProxyUrl } from "../net/egress.ts";
import { matchCanonical, qualityScore } from "../canonical/matcher.ts";
import { pool } from "../scheduler/pool.ts";
import type { RawEntry } from "./types.ts";

/**
 * Ingest orchestrator: pull a provider's entries, collapse them into canonical
 * channels via the matcher, and upsert channels + streams. This is where the
 * spine gets built — N provider entries become logical channels with N sources.
 */

async function fetchEntries(p: Provider): Promise<RawEntry[]> {
  const opts = egress(p.viaVpn ? vpnProxyUrl() : undefined); // VPN passthrough per-source
  if (p.type === "m3u") return fetchM3U(p.url, opts);
  if (p.type === "xtream") {
    if (!p.username || !p.password) throw new Error(`Xtream provider ${p.id} missing credentials`);
    return fetchXtream(p.url, p.username, p.password, opts);
  }
  throw new Error(`Unknown provider type ${p.type}`);
}

/** Load the existing canonicalId -> slug index so re-syncs reuse channels. */
async function loadKnown(): Promise<Map<string, string>> {
  const rows = await db
    .select({ canonicalId: channels.canonicalId, name: channels.name })
    .from(channels)
    .where(isNotNull(channels.canonicalId));
  const known = new Map<string, string>();
  for (const r of rows) {
    if (r.canonicalId) known.set(r.canonicalId, r.canonicalId.split(".")[0]);
  }
  return known;
}

export interface SyncResult {
  providerId: number;
  entries: number;
  channelsTouched: number;
  streamsUpserted: number;
}

export async function syncProvider(providerId: number): Promise<SyncResult> {
  const [p] = await db.select().from(providers).where(eq(providers.id, providerId));
  if (!p) throw new Error(`Provider ${providerId} not found`);

  const entries = await fetchEntries(p);
  const known = await loadKnown();

  // Map canonicalId -> channelId, hydrated lazily.
  const channelIdByCanonical = new Map<string, number>();
  for (const row of await db
    .select({ id: channels.id, canonicalId: channels.canonicalId })
    .from(channels)
    .where(isNotNull(channels.canonicalId))) {
    if (row.canonicalId) channelIdByCanonical.set(row.canonicalId, row.id);
  }

  let streamsUpserted = 0;
  const touched = new Set<number>();

  for (const entry of entries) {
    const match = matchCanonical({ rawName: entry.rawName, tvgId: entry.tvgId }, known);

    // Upsert the canonical channel.
    let channelId = channelIdByCanonical.get(match.canonicalId);
    if (!channelId) {
      const [ins] = await db
        .insert(channels)
        .values({
          canonicalId: match.canonicalId,
          epgChannelId: entry.tvgId ?? null,
          name: match.display,
          logoUrl: entry.logoUrl,
          category: entry.groupTitle,
        })
        .returning({ id: channels.id });
      channelId = ins.id;
      channelIdByCanonical.set(match.canonicalId, channelId);
    } else {
      // Backfill logo / EPG id if we didn't capture them on first sight.
      if (entry.logoUrl) {
        await db
          .update(channels)
          .set({ logoUrl: entry.logoUrl })
          .where(and(eq(channels.id, channelId), isNullLogo()));
      }
      if (entry.tvgId) {
        await db
          .update(channels)
          .set({ epgChannelId: entry.tvgId })
          .where(and(eq(channels.id, channelId), sql`${channels.epgChannelId} IS NULL`));
      }
    }
    touched.add(channelId);

    // Upsert the stream (one per provider+url).
    const score = qualityScore(match.resolution, "unknown");
    const existing = await db
      .select({ id: streams.id })
      .from(streams)
      .where(and(eq(streams.providerId, p.id), eq(streams.url, entry.url)));

    if (existing.length) {
      await db
        .update(streams)
        .set({ channelId, rawName: entry.rawName, resolution: match.resolution, qualityScore: score })
        .where(eq(streams.id, existing[0].id));
    } else {
      await db.insert(streams).values({
        channelId,
        providerId: p.id,
        url: entry.url,
        rawName: entry.rawName,
        resolution: match.resolution,
        qualityScore: score,
      });
    }
    streamsUpserted++;
  }

  await db.update(providers).set({ lastSyncedAt: new Date() }).where(eq(providers.id, p.id));
  pool.setBudget(p.id, p.maxConnections);
  await assignChannelNumbers();

  return {
    providerId,
    entries: entries.length,
    channelsTouched: touched.size,
    streamsUpserted,
  };
}

/** Assign sequential lineup numbers to any channel missing one. */
async function assignChannelNumbers() {
  const numbered = await db
    .select({ max: sql<number>`COALESCE(MAX(${channels.number}), 0)` })
    .from(channels);
  let next = Math.floor(numbered[0]?.max ?? 0) + 1;

  const unnumbered = await db
    .select({ id: channels.id })
    .from(channels)
    .where(sql`${channels.number} IS NULL`)
    .orderBy(channels.name);

  for (const ch of unnumbered) {
    await db.update(channels).set({ number: next++ }).where(eq(channels.id, ch.id));
  }
}

// Small helper to keep the upsert readable.
function isNullLogo() {
  return sql`${channels.logoUrl} IS NULL`;
}

/** Load all provider budgets into the pool on boot. */
export async function primePool() {
  const rows = await db.select().from(providers).where(eq(providers.enabled, true));
  for (const p of rows) pool.setBudget(p.id, p.maxConnections);
}
