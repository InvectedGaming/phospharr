import { Hono } from "hono";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/index.ts";
import { vodEpisodes, vodSeries, type VodSeries } from "../db/schema.ts";
import { ensureEpisodes } from "../ingest/vod.ts";
import { cleanEpisodeTitle, epKeyOf, ownedEpisodeKeys, titleYear } from "../ingest/vodlibrary.ts";
import { getSetting } from "../settings.ts";

/**
 * Torznab indexer over the VOD series catalog — the demand-driven inverse of
 * the .strm mirror. Sonarr already asks "anything new for this show?" every 15
 * minutes; here that question IS the refresh trigger: a targeted tvsearch does
 * a live provider lookup for that one show (behind a short per-show TTL so
 * Sonarr's re-polling doesn't hammer the provider), and the RSS poll keeps just
 * the shows Sonarr has actually searched for (lastQueriedAt) fresh, a few per
 * tick. No bulk sweep, no stubs for shows nobody monitors.
 *
 * Grabs hand off via Usenet Blackhole: the download link serves a minimal .nzb
 * whose only real content is a phospharr payload (series row + S/E); the
 * blackhole watcher (ingest/blackhole.ts) turns it into a .strm for Sonarr to
 * import. See that file for the second half of the flow.
 *
 * Sonarr setup: Indexer → Torznab → URL http://<phospharr>:7777/torznab,
 * apikey from settings; Download Client → Usenet Blackhole → Nzb Folder =
 * vod.indexer.blackholeWatchPath, Watch Folder = blackholeCompletePath.
 */

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string));

/** Normalized show name for matching (year + punctuation insensitive). */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").replace(/[^a-z0-9]/g, "");
}

/** Scene-style token: "Grey's Anatomy" → "Greys.Anatomy". */
function scenify(s: string): string {
  return s.replace(/['’]/g, "").replace(/[^A-Za-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").replace(/\.{2,}/g, ".");
}

const pad2 = (n: number) => String(Math.max(0, n)).padStart(2, "0");
const NOMINAL_SIZE = 1_048_576; // ~1 MB — never 0, Sonarr's sanity checks may reject that

/** Release name Sonarr can parse deterministically: fixed SDTV quality tier and
 *  a PHOSPHARR group for custom-format matching. `show` should be the title
 *  Sonarr expects (skyhook title on tvdbid searches) or the provider name. */
export function releaseTitle(show: string, year: number | null, season: number, episode: number, epTitle: string | null): string {
  const parts = [scenify(year ? `${show} ${year}` : show), `S${pad2(season)}E${pad2(episode)}`];
  if (epTitle) parts.push(scenify(epTitle));
  return parts.filter(Boolean).join(".") + ".SDTV.x264-PHOSPHARR";
}

// ── grab payload: carried inside the .nzb so the blackhole watcher can resolve
// the episode later. Keyed on the STABLE ids (series row + S/E, never the
// episode row id, which is reissued on every refetch). ──
export interface GrabPayload { s: number; se: number; ep: number; n: string } // seriesRowId, season, episode, release title
export const encodePayload = (p: GrabPayload) => Buffer.from(JSON.stringify(p)).toString("base64url");
export function decodePayload(raw: string): GrabPayload | null {
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as GrabPayload;
    return Number.isFinite(p.s) && Number.isFinite(p.se) && Number.isFinite(p.ep) && typeof p.n === "string" ? p : null;
  } catch { return null; }
}
export const PAYLOAD_META_RE = /<meta type="phospharr">([A-Za-z0-9_-]+)<\/meta>/;

/** The .nzb we serve: valid NZB shape (so nothing chokes on it) whose only real
 *  content is the phospharr payload in a head meta. */
function nzbFor(p: GrabPayload): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head><meta type="phospharr">${encodePayload(p)}</meta></head>
  <file poster="phospharr" date="${Math.floor(Date.now() / 1000)}" subject="${xml(p.n)}">
    <groups><group>alt.binaries.phospharr</group></groups>
    <segments><segment bytes="${NOMINAL_SIZE}" number="1">${p.s}.${p.se}.${p.ep}@phospharr</segment></segments>
  </file>
</nzb>
`;
}

// ── tvdbid → title via Skyhook (Sonarr's own metadata service), so tvdbid
// searches resolve AND our release titles echo exactly the series title Sonarr
// expects. Cached in-memory: 24h hits, 1h misses. ──
const tvdbCache = new Map<number, { title: string; year: number | null; at: number; miss?: boolean }>();
async function tvdbShow(tvdbid: number): Promise<{ title: string; year: number | null } | null> {
  const hit = tvdbCache.get(tvdbid);
  if (hit && Date.now() - hit.at < (hit.miss ? 3600_000 : 24 * 3600_000)) return hit.miss ? null : hit;
  try {
    const res = await fetch(`https://skyhook.sonarr.tv/v1/tvdb/shows/en/${tvdbid}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { title?: string; year?: number; firstAired?: string };
    if (!body.title) throw new Error("no title");
    const entry = { title: body.title, year: body.year ?? (body.firstAired ? Number(body.firstAired.slice(0, 4)) || null : null), at: Date.now() };
    tvdbCache.set(tvdbid, entry);
    return entry;
  } catch {
    tvdbCache.set(tvdbid, { title: "", year: null, at: Date.now(), miss: true });
    return null;
  }
}

// ── owned-episode cache (skipOwned): a full Emby episode dump per 15-min poll
// would be heavier than the feature is worth, so cache it for one TTL window. ──
let ownedCache: { at: number; keys: Set<string> | null } | null = null;
async function ownedEps(ttlMs: number): Promise<Set<string> | null> {
  if (!(await getSetting("vod.skipOwned"))) return null;
  if (!ownedCache || Date.now() - ownedCache.at > ttlMs) ownedCache = { at: Date.now(), keys: await ownedEpisodeKeys() };
  return ownedCache.keys;
}

interface Release { title: string; guid: string; payload: GrabPayload; pubDate: Date; tvdbid?: number }

function itemXml(r: Release, origin: string, apikey: string): string {
  const link = `${origin}/torznab/download/${encodePayload(r.payload)}.nzb?apikey=${encodeURIComponent(apikey)}`;
  // 5030 (TV/SD), not the parent 5000: Sonarr filters items on LEAF categories,
  // and a parent-only value fails registration with "no results in the
  // configured categories". SD is semantically right for SDTV releases.
  const attrs = [
    `    <torznab:attr name="category" value="5030"/>`,
    `    <torznab:attr name="season" value="${r.payload.se}"/>`,
    `    <torznab:attr name="episode" value="${r.payload.ep}"/>`,
  ];
  if (r.tvdbid) attrs.push(`    <torznab:attr name="tvdbid" value="${r.tvdbid}"/>`);
  return `  <item>
    <title>${xml(r.title)}</title>
    <guid isPermaLink="false">${xml(r.guid)}</guid>
    <link>${xml(link)}</link>
    <pubDate>${r.pubDate.toUTCString()}</pubDate>
    <size>${NOMINAL_SIZE}</size>
    <category>5030</category>
    <enclosure url="${xml(link)}" length="${NOMINAL_SIZE}" type="application/x-nzb"/>
${attrs.join("\n")}
  </item>`;
}

function rssXml(items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel>
  <title>Phospharr</title>
  <description>Phospharr VOD catalog</description>
  <link>https://github.com/InvectedGaming/phospharr</link>
${items.join("\n")}
</channel>
</rss>
`;
}

const CAPS = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="Phospharr"/>
  <limits max="100" default="100"/>
  <searching>
    <search available="yes" supportedParams="q"/>
    <tv-search available="yes" supportedParams="q,tvdbid,season,ep"/>
    <movie-search available="no" supportedParams="q"/>
  </searching>
  <categories>
    <category id="5000" name="TV">
      <subcat id="5030" name="TV/SD"/>
      <subcat id="5040" name="TV/HD"/>
    </category>
  </categories>
</caps>
`;

const err = (code: number, description: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<error code="${code}" description="${xml(description)}"/>\n`;
const XMLH = { "Content-Type": "application/xml; charset=utf-8" };

/** Serve-side category allow-list (vod.indexer.categories). */
async function catAllowed(s: VodSeries): Promise<boolean> {
  const cats = (await getSetting("vod.indexer.categories")) ?? [];
  return !cats.length || (s.category != null && cats.includes(s.category));
}

/** Refresh one show's episode list (TTL-gated inside ensureEpisodes) and return
 *  its episodes, optionally filtered to a season/ep. Marks lastQueriedAt so the
 *  RSS tick knows Sonarr cares about this show. */
async function liveEpisodes(s: VodSeries, ttlMs: number, season?: number, ep?: number): Promise<{ eps: (typeof vodEpisodes.$inferSelect)[]; cacheHit: boolean }> {
  const cacheHit = !!s.episodesCachedAt && Date.now() - s.episodesCachedAt.getTime() < ttlMs;
  await db.update(vodSeries).set({ lastQueriedAt: new Date() }).where(eq(vodSeries.id, s.id));
  try { await ensureEpisodes(s.id, ttlMs); } catch { /* provider hiccup — serve cached rows */ }
  const conds = [eq(vodEpisodes.seriesRowId, s.id)];
  if (season != null) conds.push(eq(vodEpisodes.season, season));
  if (ep != null) conds.push(eq(vodEpisodes.episode, ep));
  const eps = await db.select().from(vodEpisodes).where(and(...conds)).orderBy(asc(vodEpisodes.season), asc(vodEpisodes.episode));
  return { eps, cacheHit };
}

function toReleases(s: VodSeries, eps: (typeof vodEpisodes.$inferSelect)[], showTitle: string, showYear: number | null, owned: Set<string> | null, tvdbid?: number): Release[] {
  const { title: provTitle } = titleYear(s);
  const out: Release[] = [];
  for (const e of eps) {
    if (owned?.has(epKeyOf(provTitle, e.season, e.episode))) continue; // user already owns the real file
    const epTitle = cleanEpisodeTitle(e.title, provTitle);
    const name = releaseTitle(showTitle, showYear, e.season, e.episode, epTitle);
    out.push({
      title: name,
      guid: `phospharr://ep/${s.id}/${e.season}/${e.episode}`, // stable across refetches (series ROW id, not episode row id)
      payload: { s: s.id, se: e.season, ep: e.episode, n: name },
      pubDate: e.firstSeenAt ?? new Date(),
      tvdbid,
    });
  }
  return out;
}

export const torznab = new Hono();

torznab.get("/torznab/api", async (c) => {
  if (!(await getSetting("vod.indexer.enabled"))) return c.text("not found", 404);
  const t = c.req.query("t") ?? "caps";
  if (t === "caps") return c.body(CAPS, 200, XMLH); // caps is metadata-only — allowed unauthenticated for indexer-test compatibility

  const apikey = String(await getSetting("vod.indexer.apiKey"));
  if (!apikey || c.req.query("apikey") !== apikey) return c.body(err(100, "Incorrect user credentials"), 200, XMLH);
  if (t !== "tvsearch" && t !== "search") return c.body(err(203, `Function not available: ${t}`), 200, XMLH);

  const ttlMs = Math.max(1, Number(await getSetting("vod.indexer.cacheTtlMinutes")) || 15) * 60_000;
  const origin = new URL(c.req.url).origin;
  const offset = Number(c.req.query("offset")) || 0;
  const q = (c.req.query("q") ?? "").trim();
  const tvdbid = Number(c.req.query("tvdbid")) || undefined;
  const season = c.req.query("season") != null && c.req.query("season") !== "" ? Number(c.req.query("season")) : undefined;
  const ep = c.req.query("ep") != null && c.req.query("ep") !== "" ? Number(c.req.query("ep")) : undefined;
  const owned = await ownedEps(ttlMs);

  let releases: Release[] = [];
  let log = "";

  if (tvdbid) {
    // ── targeted by tvdb id: resolve the title Sonarr means via skyhook, match
    // it against the catalog, then do a live (TTL-cached) provider lookup ──
    const show = await tvdbShow(tvdbid);
    if (!show) {
      log = `tvsearch tvdbid=${tvdbid} → skyhook miss`;
    } else {
      const matches = (await db.select().from(vodSeries)).filter((s) => norm(s.name) === norm(show.title));
      for (const s of matches) {
        if (!(await catAllowed(s))) continue;
        const { eps, cacheHit } = await liveEpisodes(s, ttlMs, season, ep);
        // skyhook title verbatim, no year appended: it's exactly the title Sonarr
        // expects, and already carries "(YYYY)" when tvdb disambiguates with one
        releases.push(...toReleases(s, eps, show.title, null, owned, tvdbid));
        log = `tvsearch tvdbid=${tvdbid} "${show.title}"${season != null ? ` s${season}` : ""}${ep != null ? `e${ep}` : ""} → ${matches.length} match, ${eps.length} eps (${cacheHit ? "cache hit" : "provider fetch"})`;
      }
      if (!matches.length) log = `tvsearch tvdbid=${tvdbid} "${show.title}" → no catalog match`;
    }
  } else if (q) {
    // ── text search (interactive search / non-id fallback) ──
    const matches = (await db.select().from(vodSeries)).filter((s) => {
      const n = norm(s.name);
      return n === norm(q) || n.includes(norm(q));
    }).slice(0, 5);
    for (const s of matches) {
      if (!(await catAllowed(s))) continue;
      const { eps } = await liveEpisodes(s, ttlMs, season, ep);
      const { title, year } = titleYear(s);
      releases.push(...toReleases(s, eps, title, year, owned));
    }
    log = `${t} q="${q}"${season != null ? ` s${season}` : ""}${ep != null ? ` e${ep}` : ""} → ${matches.length} series, ${releases.length} releases`;
  } else {
    // ── RSS mode (no terms — Sonarr polls this every ~15 min): keep the shows
    // Sonarr has actually searched for fresh, a few per tick, then serve
    // recently-appeared episodes ──
    const stale = await db.select().from(vodSeries)
      .where(and(isNotNull(vodSeries.lastQueriedAt), or(isNull(vodSeries.episodesCachedAt), lt(vodSeries.episodesCachedAt, new Date(Date.now() - ttlMs)))))
      .orderBy(asc(vodSeries.episodesCachedAt)).limit(5);
    for (const s of stale) { try { await ensureEpisodes(s.id, ttlMs); } catch { /* next tick retries */ } }

    const cutoff = new Date(Date.now() - 7 * 24 * 3600_000);
    const rows = await db.select({ e: vodEpisodes, s: vodSeries }).from(vodEpisodes)
      .innerJoin(vodSeries, eq(vodEpisodes.seriesRowId, vodSeries.id))
      .where(gt(vodEpisodes.firstSeenAt, cutoff))
      .orderBy(desc(vodEpisodes.firstSeenAt)).limit(300);
    for (const { e, s } of rows) {
      if (releases.length >= 100 + offset) break;
      if (!(await catAllowed(s))) continue;
      const { title, year } = titleYear(s);
      releases.push(...toReleases(s, [e], title, year, owned));
    }
    log = `rss → ${releases.length} recent (refreshed ${stale.length} tracked series)`;
  }

  // One release per episode, even when the same show exists under several
  // providers: duplicate near-instant .strm grabs are the trigger for the
  // *arr import/delete loop (Radarr #11435), and dupes add nothing — every
  // release is the same nominal SDTV stub.
  const seen = new Set<string>();
  releases = releases.filter((r) => {
    const k = r.title.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  releases = releases.slice(offset, offset + 100);
  console.log(`[torznab] ${log}${offset ? ` offset=${offset}` : ""}`);
  return c.body(rssXml(releases.map((r) => itemXml(r, origin, apikey))), 200, XMLH);
});

// The grab link: serves the phospharr-flavored .nzb Sonarr drops into its
// blackhole folder. Auth via the same apikey (it's embedded in the link).
torznab.get("/torznab/download/:file", async (c) => {
  if (!(await getSetting("vod.indexer.enabled"))) return c.text("not found", 404);
  const apikey = String(await getSetting("vod.indexer.apiKey"));
  if (!apikey || c.req.query("apikey") !== apikey) return c.text("unauthorized", 401);
  const p = decodePayload(c.req.param("file").replace(/\.nzb$/i, ""));
  if (!p) return c.text("bad payload", 400);
  const [s] = await db.select().from(vodSeries).where(eq(vodSeries.id, p.s));
  console.log(`[torznab] grab ${p.n} (${s ? s.name : "unknown series"} s${p.se}e${p.ep})`);
  return c.body(nzbFor(p), 200, {
    "Content-Type": "application/x-nzb",
    "Content-Disposition": `attachment; filename="${p.n.replace(/[^A-Za-z0-9.\-]/g, "_")}.nzb"`,
  });
});
