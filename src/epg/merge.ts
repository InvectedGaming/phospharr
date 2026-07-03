import { and, eq, gte, lte, lt } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { channels, programs, providers } from "../db/schema.ts";
import { fetchXmltvStream, streamXmltv, type XmltvProgramme } from "./xmltv.ts";
import { xtreamEpgUrl } from "../ingest/xtream.ts";
import { egress, providerEgress } from "../net/egress.ts";
import { normalizeName } from "../canonical/normalize.ts";
import { PRUNE_BEHIND_MS } from "./window.ts";
import { invalidateGuideSnapshot } from "./snapshot.ts";

/**
 * Derive one EPG URL per enabled provider: its configured epgUrl, else the
 * Xtream panel's standard xmltv.php feed. Shared by the manual /api/epg/sync
 * endpoint and the scheduled auto-refresh.
 */
export interface EpgSource { url: string; proxy?: string }
export async function providerEpgUrls(providerId?: number): Promise<EpgSource[]> {
  let rows = await db.select().from(providers).where(eq(providers.enabled, true));
  if (providerId) rows = rows.filter((p) => p.id === providerId);
  return rows
    .map((p): EpgSource | null => {
      const url = p.epgUrl
        ? p.epgUrl
        : p.type === "xtream" && p.username && p.password
          ? xtreamEpgUrl(p.url, p.username, p.password)
          : null;
      if (!url) return null;
      // Resolve the egress NOW — `proxy_url` may be a `vpn:<id>` pin, which fetch
      // can't use raw (passing it verbatim made every VPN-pinned provider's EPG
      // sync die with "Unable to connect"). Fail closed: skip the feed while the
      // pinned VPN is down rather than leak a direct request to the provider.
      const eg = providerEgress(p.id);
      if (eg.blocked) {
        console.error(`[epg] skipping ${p.name}: ${eg.reason}`);
        return null;
      }
      return { url, proxy: eg.proxy };
    })
    .filter((s): s is EpgSource => !!s);
}

/**
 * EPG merge: pull XMLTV from one or more URLs, bind each programme to a
 * canonicalId, and upsert. Multiple feeds merge per-channel — last write for a
 * given (canonicalId, startTime) wins, ordered by feed priority (caller order).
 *
 * Binding: prefer exact tvg-id == canonicalId; fall back to slug match against
 * the channel display name so feeds that use their own ids still attach.
 */

function buildCanonicalIndex(
  rows: { canonicalId: string | null; epgChannelId: string | null; name: string }[],
) {
  const byCanonical = new Set<string>(); // canonicalId itself
  const byEpgId = new Map<string, string>(); // provider tvg-id -> canonicalId
  const bySlug = new Map<string, string>(); // normalized name slug -> canonicalId
  for (const r of rows) {
    if (!r.canonicalId) continue;
    byCanonical.add(r.canonicalId.toLowerCase());
    if (r.epgChannelId) byEpgId.set(r.epgChannelId.toLowerCase(), r.canonicalId);
    bySlug.set(normalizeName(r.name).slug, r.canonicalId);
  }
  return { byCanonical, byEpgId, bySlug };
}

// Resolve an XMLTV programme to the channel's canonicalId (programs are stored +
// queried by canonicalId). Cheapest, most-reliable signal first.
function bindCanonicalId(
  prog: XmltvProgramme,
  displayName: string,
  idx: ReturnType<typeof buildCanonicalIndex>,
): string | null {
  const cid = prog.channelId.toLowerCase();
  if (idx.byEpgId.has(cid)) return idx.byEpgId.get(cid)!; // tvg-id match (the common path)
  if (idx.byCanonical.has(cid)) return cid; // xmltv id == canonicalId
  const direct = idx.bySlug.get(normalizeName(displayName).slug); // fall back to name
  if (direct) return direct;
  // Feeds often prefix a bare country word with NO separator ("USA NFL Sunday
  // 705") which normalizeName can't strip (it requires "US|"-style separators),
  // so the slug keeps the country and misses. Retry without the leading token —
  // only as a last resort, so "USA Network" (whose direct slug already matched
  // above) can never be mis-bound.
  const m = displayName.match(/^\s*(?:usa?|uk|ca|au|nz|de|fr|es|it|nl|pt|mx|br)\s+(.{3,})$/i);
  if (m) return idx.bySlug.get(normalizeName(m[1]).slug) ?? null;
  return null;
}

export interface EpgSyncResult {
  source: string;
  programmesBound: number;
  programmesSkipped: number;
}

// One reused prepared statement is ~200× faster than rebuilding a multi-row
// drizzle insert per batch. start_time/end_time are stored as Unix seconds
// (matching drizzle's `timestamp` mode), so we divide ms by 1000.
const UPSERT_SQL = `
  INSERT INTO programs
    (canonical_id, title, subtitle, description, start_time, end_time, category, epg_source, icon_url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(canonical_id, start_time) DO UPDATE SET
    title = excluded.title, subtitle = excluded.subtitle, description = excluded.description,
    end_time = excluded.end_time, category = excluded.category,
    epg_source = excluded.epg_source, icon_url = excluded.icon_url`;

// EPG syncs share one SQLite connection and a single write transaction, so two
// at once would throw "cannot start a transaction within a transaction" (e.g.
// the scheduler firing while a manual sync runs). Serialize them on a tail chain.
let epgSyncChain: Promise<unknown> = Promise.resolve();
export function syncEpgFromUrls(sources: Array<string | EpgSource>): Promise<EpgSyncResult[]> {
  const norm = sources.map((s) => (typeof s === "string" ? { url: s } : s));
  const run = epgSyncChain.then(() => runEpgSync(norm), () => runEpgSync(norm));
  epgSyncChain = run.then(() => {}, () => {}); // keep the chain alive past errors
  return run;
}

async function runEpgSync(sources: EpgSource[]): Promise<EpgSyncResult[]> {
  const chanRows = await db
    .select({
      canonicalId: channels.canonicalId,
      epgChannelId: channels.epgChannelId,
      name: channels.name,
    })
    .from(channels);
  const idx = buildCanonicalIndex(chanRows);

  const upsert = sqlite.prepare(UPSERT_SQL);
  const results: EpgSyncResult[] = [];

  // Batched writes in SHORT transactions instead of one spanning the whole feed.
  // Why: the stream yields to the event loop between chunks (see streamXmltv), and
  // a feed-spanning BEGIN on the app's shared connection would swallow any foreign
  // write that interleaves during a yield — rolled back with the sync on failure.
  // A few-thousand-row sync transaction is a couple of ms; upserts are idempotent,
  // so a mid-feed failure just leaves earlier batches applied (next sync repairs).
  const BATCH_ROWS = 2000;

  for (const { url, proxy } of sources) {
    const stream = await fetchXmltvStream(url, egress(proxy));
    const nameById = new Map<string, string>();
    let bound = 0;
    let skipped = 0;

    type UpsertArgs = [string, string, string | null, string | null, number, number, string | null, string, string | null];
    let batch: UpsertArgs[] = [];
    const flush = () => {
      if (!batch.length) return;
      // Fully synchronous (no awaits inside) — nothing else can join this transaction.
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const args of batch) upsert.run(...args);
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
      batch = [];
    };

    await streamXmltv(stream, {
      onChannel: (c) => nameById.set(c.id.toLowerCase(), c.displayName),
      onProgramme: (p: XmltvProgramme) => {
        const startMs = p.start.getTime();
        const stopMs = p.stop.getTime();
        if (Number.isNaN(startMs) || Number.isNaN(stopMs)) {
          skipped++;
          return;
        }
        const displayName = nameById.get(p.channelId.toLowerCase()) ?? p.channelId;
        const canonicalId = bindCanonicalId(p, displayName, idx);
        if (!canonicalId) {
          skipped++;
          return;
        }
        bound++;
        batch.push([
          canonicalId,
          p.title,
          p.subtitle ?? null,
          p.description ?? null,
          Math.floor(startMs / 1000),
          Math.floor(stopMs / 1000),
          p.category ?? null,
          url,
          p.iconUrl ?? null,
        ]);
        if (batch.length >= BATCH_ROWS) flush();
      },
    });
    flush();
    // Bound table growth: drop programmes that ended well in the past.
    db.delete(programs).where(lt(programs.endTime, new Date(Date.now() - PRUNE_BEHIND_MS))).run();

    results.push({ source: url, programmesBound: bound, programmesSkipped: skipped });
  }

  upsert.finalize();
  invalidateGuideSnapshot(); // next /api/guide rebuilds from the fresh data
  return results;
}

/** Compute "what's on now" for a canonical channel. */
export async function nowNext(canonicalId: string, at = new Date()) {
  const rows = await db
    .select()
    .from(programs)
    .where(and(eq(programs.canonicalId, canonicalId), lte(programs.startTime, at)))
    .orderBy(programs.startTime);
  const now = rows.reverse().find((p) => p.endTime > at) ?? null;
  const next = now
    ? (
        await db
          .select()
          .from(programs)
          .where(and(eq(programs.canonicalId, canonicalId), gte(programs.startTime, now.endTime)))
          .orderBy(programs.startTime)
          .limit(1)
      )[0] ?? null
    : null;
  return { now, next };
}
