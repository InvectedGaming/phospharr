import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { vodEpisodes, vodMovies, vodSeries } from "../db/schema.ts";
import { ensureEpisodes } from "./vod.ts";
import { getSetting, cachedSetting, type DownstreamServer } from "../settings.ts";

/**
 * VOD → media-server library. Mirrors the VOD movie catalog into a folder of
 * `.strm` files (each holds one absolute playback URL) + a `.nfo` per movie, in
 * the layout Emby/Jellyfin scan:  <libraryPath>/Movies/<Name> (Year)/<Name> (Year).strm
 *
 * With vod.includeSeries, series get the same treatment in a Sonarr-parseable
 * tree:  <libraryPath>/Series/<Show> (Year)/Season NN/<Show> - SxxEyy - <Title>.strm
 * so Sonarr can import them as a zero-storage catalog and Emby browses them
 * like owned content. Every run re-pulls episode lists for mirrored series
 * (vod.refreshExisting, default ON) so newly-aired episodes show up on their own.
 *
 * Point an Emby "Movies" library at <libraryPath>/Movies (and a "TV Shows" one
 * at <libraryPath>/Series) and it plays straight through Phospharr (which
 * remuxes on the fly). Reconciles each run: writes new/changed entries and
 * prunes folders for titles that left the catalog — like Radarr/Sonarr managing
 * a library — then we trigger the server's scan (epg/downstream). Writes are
 * strictly delta-only: a file whose content is unchanged is never rewritten, so
 * its mtime never moves (blind nightly rewrites of an ~80k-file tree trigger
 * inotify storms in Emby that bloat its SQLite WAL until library queries stall).
 *
 * Opt-in (features.vodLibrary) since it writes files. Needs an absolute base URL
 * Emby can reach (vod.publicUrl, else BASE_URL) — a LAN/Docker address is fine.
 * A category allow-list (vod.libraryCategories / vod.seriesCategories) keeps a
 * 50k-title dump in check.
 */

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string));

/** Match key for `vod.seriesInclude`. Case- and punctuation-insensitive so an
 *  operator can paste "Marvel's Agents of S.H.I.E.L.D. (2013)" without
 *  reproducing the provider's exact punctuation — but the year is KEPT, since
 *  dropping it would collide remakes ("Fargo (2014)" vs an older "Fargo").
 *  Deliberately not `normalizeName()`: that one is tuned for channel names and
 *  strips quality/country tokens that are meaningful in a show title. */
export function seriesKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Filesystem-safe name: strip the reserved chars (keep dashes etc.), collapse
 *  whitespace, drop trailing dots/spaces (invalid on Windows dirs). */
function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 120) || "Untitled";
}

/** Provider names frequently already embed "(YYYY)"; split it out so we don't
 *  double the year and the .nfo <title> stays clean for metadata scraping. */
export function titleYear(m: { name: string; year: number | null }): { title: string; year: number | null } {
  const embedded = m.name.match(/\((?:19|20)\d{2}\)\s*$/);
  const title = m.name.replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").trim() || m.name;
  const year = m.year ?? (embedded ? Number(embedded[0].replace(/\D/g, "")) : null);
  return { title, year };
}

export function publicBase(): string {
  return (String(cachedSetting("vod.publicUrl") || "") || process.env.BASE_URL || "").replace(/\/+$/, "");
}

/** Stable playback URL for an episode. Keyed on series ROW id + S/E — never the
 *  vod_episodes row id, which is wiped and reissued on every episode refetch. A
 *  row-id URL inside a .strm goes permanently stale the moment the list
 *  refreshes — fatal for stubs Sonarr has imported into its own library folder,
 *  since nothing ever rewrites those. The /vod/play/ep route resolves live. */
export function episodePlayUrl(base: string, key: string, seriesRowId: number, season: number, episode: number): string {
  return `${base}/vod/play/ep/${seriesRowId}/${season}/${episode}?key=${encodeURIComponent(key)}`;
}

const pad2 = (n: number) => String(Math.max(0, n)).padStart(2, "0");

/** Write only when the content actually differs, leaving mtimes of everything
 *  else untouched (see the inotify-storm rationale above). */
function writeIfChanged(path: string, content: string): boolean {
  try { if (readFileSync(path, "utf8") === content) return false; } catch { /* new file */ }
  writeFileSync(path, content);
  return true;
}

function movieNfo(title: string, year: number | null, m: typeof vodMovies.$inferSelect): string {
  const lines = [`  <title>${xml(title)}</title>`];
  if (year) lines.push(`  <year>${year}</year>`);
  if (m.plot) lines.push(`  <plot>${xml(m.plot)}</plot>`);
  if (m.rating != null) lines.push(`  <rating>${m.rating}</rating>`);
  if (m.posterUrl) { lines.push(`  <thumb>${xml(m.posterUrl)}</thumb>`); lines.push(`  <art><poster>${xml(m.posterUrl)}</poster></art>`); }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<movie>\n${lines.join("\n")}\n</movie>\n`;
}

function tvshowNfo(title: string, year: number | null, s: typeof vodSeries.$inferSelect): string {
  const lines = [`  <title>${xml(title)}</title>`];
  if (year) lines.push(`  <year>${year}</year>`);
  if (s.plot) lines.push(`  <plot>${xml(s.plot)}</plot>`);
  if (s.posterUrl) { lines.push(`  <thumb>${xml(s.posterUrl)}</thumb>`); lines.push(`  <art><poster>${xml(s.posterUrl)}</poster></art>`); }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<tvshow>\n${lines.join("\n")}\n</tvshow>\n`;
}

function episodeNfo(title: string, season: number, episode: number, plot: string | null): string {
  const lines = [`  <title>${xml(title)}</title>`, `  <season>${season}</season>`, `  <episode>${episode}</episode>`];
  if (plot) lines.push(`  <plot>${xml(plot)}</plot>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<episodedetails>\n${lines.join("\n")}\n</episodedetails>\n`;
}

/** Provider episode titles frequently embed the show name and/or the SxxEyy code
 *  ("Grey's Anatomy - S15E01 - Title"); using them verbatim in a filename that
 *  already carries both would duplicate the identifiers ("Show - S15E01 - Show -
 *  S15E01 - Title.strm"). Strip them so only the bare episode title remains. */
export function cleanEpisodeTitle(raw: string | null, show: string): string | null {
  if (!raw) return null;
  let t = raw.trim();
  if (t.toLowerCase().startsWith(show.toLowerCase())) t = t.slice(show.length);
  t = t.replace(/\bS\d{1,2}\s*[.\-–—: ]?\s*E\d{1,3}\b/gi, "").replace(/^[\s\-–—:.]+|[\s\-–—:.]+$/g, "").replace(/\s{2,}/g, " ");
  return t || null;
}

/** Dedup key: normalized title + year. VOD entries carry no TMDb/IMDb id, so
 *  matching is by title+year; Emby items also expose provider ids when present. */
function keyOf(title: string, year: number | null | undefined): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, "") + "|" + (year ?? "");
}

/** Episode dedup key: normalized show name (embedded "(YYYY)" stripped — Emby's
 *  SeriesName and provider names disagree on it) + season + episode. */
export function epKeyOf(show: string, season: number, episode: number): string {
  return show.toLowerCase().replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").replace(/[^a-z0-9]/g, "") + `|s${season}e${episode}`;
}

/** Enabled Emby/Jellyfin downstream servers (skipOwned checks run against these). */
async function embyServers(): Promise<DownstreamServer[] | null> {
  let servers: DownstreamServer[] = [];
  try { servers = (await getSetting("epg.downstream")) ?? []; } catch { return null; }
  const embys = servers.filter((s) => s.enabled && s.url && s.apiKey && s.type !== "plex");
  return embys.length ? embys : null;
}

async function embyItems<T>(s: DownstreamServer, query: string): Promise<T[] | null> {
  try {
    const base = s.url.trim().replace(/\/+$/, "");
    const res = await fetch(`${base}/Items?Recursive=true&EnableImages=false&${query}`, {
      headers: { "X-Emby-Token": s.apiKey, "X-MediaBrowser-Token": s.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { Items?: T[] }).Items ?? [];
  } catch { return null; } // skip this server, don't block the rebuild
}

/** Titles already in the Emby/Jellyfin library as REAL files (not our .strm
 *  entries), so we can skip mirroring a movie the user already owns — and, since
 *  this runs every rebuild, prune the .strm later if they add the real file.
 *  Returns null when we can't check (no server / query failed) → skip nothing. */
async function ownedMovieKeys(): Promise<Set<string> | null> {
  const embys = await embyServers();
  if (!embys) return null;
  const owned = new Set<string>();
  let any = false;
  for (const s of embys) {
    type Item = { Name?: string; ProductionYear?: number; Path?: string; ProviderIds?: Record<string, string> };
    const items = await embyItems<Item>(s, "IncludeItemTypes=Movie&Fields=Path,ProviderIds,ProductionYear");
    if (!items) continue;
    for (const it of items) {
      if (it.Path && /\.strm$/i.test(it.Path)) continue; // our own VOD entry, not a real file the user owns
      const pid = it.ProviderIds ?? {};
      if (pid.Tmdb) owned.add("tmdb:" + pid.Tmdb);
      if (pid.Imdb) owned.add("imdb:" + String(pid.Imdb).toLowerCase());
      if (it.Name) owned.add(keyOf(it.Name, it.ProductionYear));
    }
    any = true;
  }
  return any ? owned : null;
}

/** Same idea per-episode: episodes the user owns as real (non-.strm) files. */
export async function ownedEpisodeKeys(): Promise<Set<string> | null> {
  const embys = await embyServers();
  if (!embys) return null;
  const owned = new Set<string>();
  let any = false;
  for (const s of embys) {
    type Item = { SeriesName?: string; ParentIndexNumber?: number; IndexNumber?: number; Path?: string };
    const items = await embyItems<Item>(s, "IncludeItemTypes=Episode&Fields=Path");
    if (!items) continue;
    for (const it of items) {
      if (it.Path && /\.strm$/i.test(it.Path)) continue; // our own stub, not a real file
      if (it.SeriesName && it.ParentIndexNumber != null && it.IndexNumber != null)
        owned.add(epKeyOf(it.SeriesName, it.ParentIndexNumber, it.IndexNumber));
    }
    any = true;
  }
  return any ? owned : null;
}

/**
 * Hand the event loop back for one tick.
 *
 * This mirror walks tens of thousands of titles with synchronous fs calls, and
 * the runtime is single-threaded: an uninterrupted pass starves everything else
 * in the process. Measured at 53.5k movies it blocked for ~2.5 minutes, during
 * which live TV sources went silent and failed over, `/healthz` exceeded its
 * 10s timeout, and the container was restarted as unhealthy — which triggered
 * the boot-time mirror again, so the restarts fed themselves.
 *
 * A microtask is not enough (`Promise.resolve()` drains before I/O runs); this
 * must be a macrotask so pending socket reads and the health endpoint actually
 * get serviced.
 */
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
/** Yield every N items — often enough that nothing starves, rarely enough that
 *  the scheduling overhead stays in the noise. */
const BREATHE_EVERY = 200;

/** Remove files under `dir` that aren't in `wanted` (rel paths), then any
 *  directories left empty. Returns how many entries were removed. */
async function pruneExtraneous(dir: string, wanted: Map<string, string>): Promise<number> {
  let n = 0, seen = 0;
  const walk = async (rel: string): Promise<void> => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (++seen % BREATHE_EVERY === 0) await breathe();
      const r = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        await walk(r);
        if (!readdirSync(join(dir, r)).length) { rmSync(join(dir, r), { recursive: true, force: true }); n++; }
      } else if (!wanted.has(r)) { rmSync(join(dir, r), { force: true }); n++; }
    }
  };
  await walk("");
  return n;
}

export interface VodLibraryResult {
  movies: number;
  series: number;
  episodes: number;
  written: number; // files created or updated (delta writes only)
  pruned: number; // folders/files removed (left catalog, or now owned for real)
  skippedOwned: number; // titles/episodes not mirrored because a real file exists
  skippedUnchanged: number; // files compared and left untouched (mtime preserved)
  skipped?: string;
}

export async function rebuildVodLibrary(): Promise<VodLibraryResult> {
  const out: VodLibraryResult = { movies: 0, series: 0, episodes: 0, written: 0, pruned: 0, skippedOwned: 0, skippedUnchanged: 0 };
  if (!(await getSetting("features.vodLibrary"))) return { ...out, skipped: "disabled (features.vodLibrary off)" };
  const base = publicBase();
  if (!base) return { ...out, skipped: "no public URL — set vod.publicUrl or BASE_URL (Emby needs an absolute, reachable URL)" };
  const key = String(cachedSetting("access.streamKey") || "");
  const libPath = await getSetting("vod.libraryPath");
  const skipOwned = await getSetting("vod.skipOwned");

  // ── movies ──
  const root = join(libPath, "Movies");
  mkdirSync(root, { recursive: true });

  const cats = (await getSetting("vod.libraryCategories")) ?? [];
  const movies = cats.length
    ? await db.select().from(vodMovies).where(inArray(vodMovies.category, cats))
    : await db.select().from(vodMovies);
  out.movies = movies.length;

  const owned = skipOwned ? await ownedMovieKeys() : null;
  const wanted = new Set<string>();
  let seen = 0;
  for (const m of movies) {
    if (++seen % BREATHE_EVERY === 0) await breathe(); // see `breathe` — this loop must not starve live TV
    const { title, year } = titleYear(m);
    if (owned && owned.has(keyOf(title, year))) { out.skippedOwned++; continue; } // already in the real library → don't mirror
    const display = year ? `${title} (${year})` : title;
    let folder = safeName(display);
    if (wanted.has(folder)) folder = safeName(`${display} [${m.id}]`); // disambiguate rare collisions
    wanted.add(folder);
    const dir = join(root, folder);
    mkdirSync(dir, { recursive: true });
    const url = `${base}/vod/play/movie/${m.id}?key=${encodeURIComponent(key)}`;
    for (const changed of [writeIfChanged(join(dir, `${folder}.strm`), url), writeIfChanged(join(dir, `${folder}.nfo`), movieNfo(title, year, m))])
      changed ? out.written++ : out.skippedUnchanged++;
  }

  // prune folders for movies that left the catalog (or the category allow-list)
  seen = 0;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (++seen % BREATHE_EVERY === 0) await breathe();
    if (e.isDirectory() && !wanted.has(e.name)) { rmSync(join(root, e.name), { recursive: true, force: true }); out.pruned++; }
  }

  // ── series (opt-in) ──
  if (await getSetting("vod.includeSeries")) {
    const seriesRoot = join(libPath, "Series");
    mkdirSync(seriesRoot, { recursive: true });

    const scats = (await getSetting("vod.seriesCategories")) ?? [];
    const byCategory = scats.length
      ? await db.select().from(vodSeries).where(inArray(vodSeries.category, scats))
      : await db.select().from(vodSeries);

    // Show-level allowlist, applied after the category filter. Categories are
    // far too coarse for a curated library: a single one holds thousands of
    // shows, and every mirrored show costs a provider episode-list fetch per
    // refresh plus a folder of .strm files. Matching is on the catalog name
    // (vod_series.name) case- and punctuation-insensitively, so titles can be
    // pasted without reproducing the provider's exact punctuation or year.
    const include = (await getSetting("vod.seriesInclude")) ?? [];
    const want = new Set(include.map(seriesKey));
    const shows = want.size ? byCategory.filter((s) => want.has(seriesKey(s.name))) : byCategory;
    out.series = shows.length;
    if (want.size) {
      // Loud: a typo'd or renamed title silently mirrors nothing at all.
      const got = new Set(shows.map((s) => seriesKey(s.name)));
      const missed = include.filter((n) => !got.has(seriesKey(n)));
      if (missed.length) {
        console.warn(`[vod] seriesInclude: ${missed.length}/${include.length} not in the catalog — ${missed.slice(0, 8).join(", ")}${missed.length > 8 ? " …" : ""}`);
      }
    }

    // Refresh-existing (default ON) re-pulls each mirrored show's episode list
    // every run so newly-aired episodes appear on their own — with it off the
    // catalog freezes at whatever aired when the folder was first written. The
    // 0.9× cadence keeps a run scheduled exactly at vod.syncHours from finding
    // an oh-so-slightly-fresh cache and skipping the fetch.
    const hours = Math.max(1, Number(await getSetting("vod.syncHours")) || 24);
    const maxAgeMs = (await getSetting("vod.refreshExisting")) ? hours * 3600_000 * 0.9 : Number.MAX_SAFE_INTEGER;
    const ownedEps = skipOwned ? await ownedEpisodeKeys() : null;

    const wantedShows = new Set<string>();
    for (const s of shows) {
      try { await ensureEpisodes(s.id, maxAgeMs); } catch { /* provider hiccup — mirror the cached episodes */ }
      const eps = await db.select().from(vodEpisodes).where(eq(vodEpisodes.seriesRowId, s.id))
        .orderBy(asc(vodEpisodes.season), asc(vodEpisodes.episode));
      out.episodes += eps.length;
      if (!eps.length) continue; // nothing to mirror (an existing folder prunes below)

      const { title, year } = titleYear(s);
      // Sonarr-parseable layout: Season NN/<Show> - SxxEyy - <Title>.strm — the
      // show/episode identifiers appear exactly once (provider titles that embed
      // them are cleaned, else you get "Show - S15E01 - Show - S15E01 - Title").
      const files = new Map<string, string>(); // rel path within the show dir → content
      for (const e of eps) {
        if (ownedEps?.has(epKeyOf(title, e.season, e.episode))) { out.skippedOwned++; continue; }
        const se = `S${pad2(e.season)}E${pad2(e.episode)}`;
        const epTitle = cleanEpisodeTitle(e.title, title);
        const seasonDir = `Season ${pad2(e.season)}`;
        let name = safeName(epTitle ? `${title} - ${se} - ${epTitle}` : `${title} - ${se}`);
        if (files.has(join(seasonDir, `${name}.strm`))) name = safeName(`${name} [${e.id}]`); // duplicate SxxEyy variants
        files.set(join(seasonDir, `${name}.strm`), episodePlayUrl(base, key, s.id, e.season, e.episode));
        files.set(join(seasonDir, `${name}.nfo`), episodeNfo(epTitle ?? se, e.season, e.episode, e.plot));
      }
      if (!files.size) continue; // every episode owned for real → drop the whole mirror

      const display = year ? `${title} (${year})` : title;
      let folder = safeName(display);
      if (wantedShows.has(folder)) folder = safeName(`${display} [${s.id}]`);
      wantedShows.add(folder);
      files.set("tvshow.nfo", tvshowNfo(title, year, s));

      const dir = join(seriesRoot, folder);
      let wrote = 0;
      for (const [rel, content] of files) {
        if (++wrote % BREATHE_EVERY === 0) await breathe();
        const p = join(dir, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeIfChanged(p, content) ? out.written++ : out.skippedUnchanged++;
      }
      out.pruned += await pruneExtraneous(dir, files); // episodes that left / became owned
    }

    // prune shows that left the catalog (or the allow-list, or are fully owned)
    let scanned = 0;
    for (const e of readdirSync(seriesRoot, { withFileTypes: true })) {
      if (++scanned % BREATHE_EVERY === 0) await breathe();
      if (e.isDirectory() && !wantedShows.has(e.name)) { rmSync(join(seriesRoot, e.name), { recursive: true, force: true }); out.pruned++; }
    }
  }

  return out;
}
