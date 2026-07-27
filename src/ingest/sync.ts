import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { providers, channels, streams, type Provider } from "../db/schema.ts";
import { fetchM3U } from "./m3u.ts";
import { fetchXtream, fetchXtreamCategories } from "./xtream.ts";
import { egress, providerEgress } from "../net/egress.ts";
import { matchCanonical, qualityScore } from "../canonical/matcher.ts";
import { muxer } from "../proxy/muxer.ts";
import { pool } from "../scheduler/pool.ts";
import { reconcileAutoHides } from "../content/filter.ts";
import { classify } from "../content/taxonomy.ts";
import { assignNumbersInBlocks } from "../content/lineup.ts";
import type { RawEntry } from "./types.ts";

/**
 * Ingest orchestrator: pull a provider's entries, collapse them into canonical
 * channels via the matcher, and upsert channels + streams. This is where the
 * spine gets built — N provider entries become logical channels with N sources.
 */

async function fetchEntries(p: Provider, categories?: string[]): Promise<RawEntry[]> {
  // Resolve a `vpn:<id>` pin to the tunnel's HTTP bridge — the raw pin string is
  // not a proxy URL fetch can use. Fail closed while the pinned VPN is down.
  const eg = providerEgress(p.id);
  if (eg.blocked) throw new Error(`egress blocked: ${eg.reason}`);
  const opts = egress(eg.proxy); // VPN passthrough per-source
  if (p.type === "m3u") {
    const all = await fetchM3U(p.url, opts);
    if (!categories) return all;
    // M3U has no scoped endpoint — full fetch, then filter to the wanted groups.
    const want = new Set(categories.map((c) => c.trim().toLowerCase()));
    return all.filter((e) => e.groupTitle != null && want.has(e.groupTitle.trim().toLowerCase()));
  }
  if (p.type === "xtream") {
    if (!p.username || !p.password) throw new Error(`Xtream provider ${p.id} missing credentials`);
    return categories
      ? fetchXtreamCategories(p.url, p.username, p.password, categories, opts)
      : fetchXtream(p.url, p.username, p.password, opts);
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
  streamsPruned: number;
}

/** One stream URL per host: the original plus one per mirror host (same path,
 *  swapped origin). This fans a channel across mirror servers so the health probe
 *  + selector pick the best-performing host and the muxer fails over between them. */
function hostVariants(url: string, mirrors: string[] | null | undefined): string[] {
  const out = [url];
  for (const h of mirrors ?? []) {
    const host = h.trim();
    if (!host) continue;
    try {
      const u = new URL(url);
      const m = new URL(host.includes("://") ? host : `http://${host}`);
      u.protocol = m.protocol;
      u.host = m.host;
      out.push(u.toString());
    } catch { /* skip a malformed mirror host */ }
  }
  return [...new Set(out)];
}

/** Full provider re-ingest, or — with opts.categories — a SCOPED sync of just
 *  those provider categories (the fast path for event/PPV tuner groups: a few
 *  hundred entries every few minutes instead of the whole lineup). A scoped
 *  sync additionally PRUNES this provider's streams in those categories that
 *  the pull no longer returned, so an event channel's stream detaching at the
 *  provider actually detaches here — that's what lets the no-stream auto-hide
 *  rule bury it until the next event. (The full sync intentionally never
 *  prunes; changing that needs its own safeguards.) */
export async function syncProvider(providerId: number, opts: { categories?: string[] } = {}): Promise<SyncResult> {
  const [p] = await db.select().from(providers).where(eq(providers.id, providerId));
  if (!p) throw new Error(`Provider ${providerId} not found`);
  const scoped = !!opts.categories?.length;

  const entries = await fetchEntries(p, opts.categories);
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
  let createdChannels = 0;
  const touched = new Set<number>();
  const seenUrls = new Set<string>();

  for (const entry of entries) {
    const match = matchCanonical({ rawName: entry.rawName, tvgId: entry.tvgId }, known);

    // Upsert the canonical channel.
    let channelId = channelIdByCanonical.get(match.canonicalId);
    if (!channelId) {
      createdChannels++;
      const tax = classify(entry.groupTitle, match.display); // structured kind/genre from the raw group
      const [ins] = await db
        .insert(channels)
        .values({
          canonicalId: match.canonicalId,
          epgChannelId: entry.tvgId ?? null,
          name: match.display,
          logoUrl: entry.logoUrl,
          category: entry.groupTitle,
          kind: tax.kind,
          genre: tax.genre,
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

    // Upsert one stream per host (primary + mirrors) — same channel, so the
    // selector auto-picks the best host and the muxer fails over between them.
    const score = qualityScore(match.resolution, "unknown");
    for (const url of hostVariants(entry.url, p.mirrorHosts)) {
      seenUrls.add(url);
      const existing = await db
        .select({ id: streams.id })
        .from(streams)
        .where(and(eq(streams.providerId, p.id), eq(streams.url, url)));

      if (existing.length) {
        await db
          .update(streams)
          .set({ channelId, rawName: entry.rawName, resolution: match.resolution, qualityScore: score })
          .where(eq(streams.id, existing[0].id));
      } else {
        await db.insert(streams).values({
          channelId,
          providerId: p.id,
          url,
          rawName: entry.rawName,
          resolution: match.resolution,
          qualityScore: score,
        });
      }
      streamsUpserted++;
    }
  }

  // Scoped prune: this provider's streams on channels in the scoped categories
  // that the (successful) pull no longer returned. An empty category is a valid
  // answer here — "no events right now" — because a failed fetch throws long
  // before this point.
  let streamsPruned = 0;
  if (scoped) {
    // Never prune under a live viewer: mid-watch failover re-queries
    // rankedStreams() from the DB, so deleting a watched channel's rows here
    // (say, on a transient provider glitch) would turn the next source blip
    // into "no alternates — dropping viewers" instead of a retry. Rows for an
    // actively-watched ended event just wait for the next scoped pass.
    const watched = new Set(muxer.stats().map((m) => m.channelId));
    const rows = await db
      .select({ id: streams.id, url: streams.url, channelId: streams.channelId })
      .from(streams)
      .innerJoin(channels, eq(streams.channelId, channels.id))
      .where(and(eq(streams.providerId, p.id), inArray(channels.category, opts.categories!)));
    for (const s of rows) {
      if (watched.has(s.channelId)) continue;
      if (!seenUrls.has(s.url)) { await db.delete(streams).where(eq(streams.id, s.id)); streamsPruned++; }
    }
  }

  if (!scoped) {
    // A scoped sync must not look like a full one: lastSyncedAt drives the full
    // re-ingest scheduler, and renumbering the whole lineup every few minutes
    // would churn channel numbers under Emby.
    await db.update(providers).set({ lastSyncedAt: new Date() }).where(eq(providers.id, p.id));
    pool.setBudget(p.id, p.maxConnections);
    await assignChannelNumbers();
  } else if (createdChannels > 0) {
    await assignChannelNumbers(); // new event channels still need lineup numbers
  }
  await reconcileAutoHides(); // re-hide newly-synced adult / hidden-category / streamless channels

  return {
    providerId,
    entries: entries.length,
    channelsTouched: touched.size,
    streamsUpserted,
    streamsPruned,
  };
}

/** New channels get a number in their taxonomy block (sticky — see content/lineup.ts). */
async function assignChannelNumbers() {
  const unnumbered = await db
    .select({ id: channels.id })
    .from(channels)
    .where(sql`${channels.number} IS NULL`)
    .orderBy(channels.name);
  await assignNumbersInBlocks(unnumbered.map((c) => c.id));
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
