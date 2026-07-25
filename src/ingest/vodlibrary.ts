import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { vodMovies } from "../db/schema.ts";
import { getSetting, cachedSetting, type DownstreamServer } from "../settings.ts";

/**
 * VOD → media-server library. Mirrors the VOD movie catalog into a folder of
 * `.strm` files (each holds one absolute playback URL) + a `.nfo` per movie, in
 * the layout Emby/Jellyfin scan:  <libraryPath>/Movies/<Name> (Year)/<Name> (Year).strm
 *
 * Point an Emby "Movies" library at <libraryPath>/Movies and it plays straight
 * through Phospharr (which remuxes on the fly). Reconciles each run: writes
 * new/changed entries and prunes folders for movies that left the catalog — like
 * Radarr managing a library — then we trigger the server's scan (epg/downstream).
 *
 * Opt-in (features.vodLibrary) since it writes files. Needs an absolute base URL
 * Emby can reach (vod.publicUrl, else BASE_URL) — a LAN/Docker address is fine.
 * A category allow-list (vod.libraryCategories) keeps a 50k-title dump in check.
 */

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string));

/** Filesystem-safe name: strip the reserved chars (keep dashes etc.), collapse
 *  whitespace, drop trailing dots/spaces (invalid on Windows dirs). */
function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 120) || "Untitled";
}

/** Provider names frequently already embed "(YYYY)"; split it out so we don't
 *  double the year and the .nfo <title> stays clean for metadata scraping. */
function titleYear(m: typeof vodMovies.$inferSelect): { title: string; year: number | null } {
  const embedded = m.name.match(/\((?:19|20)\d{2}\)\s*$/);
  const title = m.name.replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").trim() || m.name;
  const year = m.year ?? (embedded ? Number(embedded[0].replace(/\D/g, "")) : null);
  return { title, year };
}

function publicBase(): string {
  return (String(cachedSetting("vod.publicUrl") || "") || process.env.BASE_URL || "").replace(/\/+$/, "");
}

function movieNfo(title: string, year: number | null, m: typeof vodMovies.$inferSelect): string {
  const lines = [`  <title>${xml(title)}</title>`];
  if (year) lines.push(`  <year>${year}</year>`);
  if (m.plot) lines.push(`  <plot>${xml(m.plot)}</plot>`);
  if (m.rating != null) lines.push(`  <rating>${m.rating}</rating>`);
  if (m.posterUrl) { lines.push(`  <thumb>${xml(m.posterUrl)}</thumb>`); lines.push(`  <art><poster>${xml(m.posterUrl)}</poster></art>`); }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<movie>\n${lines.join("\n")}\n</movie>\n`;
}

/** Dedup key: normalized title + year. VOD entries carry no TMDb/IMDb id, so
 *  matching is by title+year; Emby items also expose provider ids when present. */
function keyOf(title: string, year: number | null | undefined): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, "") + "|" + (year ?? "");
}

/** Titles already in the Emby/Jellyfin library as REAL files (not our .strm
 *  entries), so we can skip mirroring a movie the user already owns — and, since
 *  this runs every rebuild, prune the .strm later if they add the real file.
 *  Returns null when we can't check (no server / query failed) → skip nothing. */
async function ownedMovieKeys(): Promise<Set<string> | null> {
  let servers: DownstreamServer[] = [];
  try { servers = (await getSetting("epg.downstream")) ?? []; } catch { return null; }
  const embys = servers.filter((s) => s.enabled && s.url && s.apiKey && s.type !== "plex");
  if (!embys.length) return null;
  const owned = new Set<string>();
  let any = false;
  for (const s of embys) {
    try {
      const base = s.url.trim().replace(/\/+$/, "");
      const res = await fetch(`${base}/Items?Recursive=true&IncludeItemTypes=Movie&Fields=Path,ProviderIds,ProductionYear&EnableImages=false`, {
        headers: { "X-Emby-Token": s.apiKey, "X-MediaBrowser-Token": s.apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { Items?: Array<{ Name?: string; ProductionYear?: number; Path?: string; ProviderIds?: Record<string, string> }> };
      for (const it of body.Items ?? []) {
        if (it.Path && /\.strm$/i.test(it.Path)) continue; // our own VOD entry, not a real file the user owns
        const pid = it.ProviderIds ?? {};
        if (pid.Tmdb) owned.add("tmdb:" + pid.Tmdb);
        if (pid.Imdb) owned.add("imdb:" + String(pid.Imdb).toLowerCase());
        if (it.Name) owned.add(keyOf(it.Name, it.ProductionYear));
      }
      any = true;
    } catch { /* skip this server, don't block the rebuild */ }
  }
  return any ? owned : null;
}

export interface VodLibraryResult { movies: number; written: number; pruned: number; skippedOwned: number; skipped?: string }

export async function rebuildVodLibrary(): Promise<VodLibraryResult> {
  const out: VodLibraryResult = { movies: 0, written: 0, pruned: 0, skippedOwned: 0 };
  if (!(await getSetting("features.vodLibrary"))) return { ...out, skipped: "disabled (features.vodLibrary off)" };
  const base = publicBase();
  if (!base) return { ...out, skipped: "no public URL — set vod.publicUrl or BASE_URL (Emby needs an absolute, reachable URL)" };
  const key = String(cachedSetting("access.streamKey") || "");
  const root = join(await getSetting("vod.libraryPath"), "Movies");
  mkdirSync(root, { recursive: true });

  const cats = (await getSetting("vod.libraryCategories")) ?? [];
  const movies = cats.length
    ? await db.select().from(vodMovies).where(inArray(vodMovies.category, cats))
    : await db.select().from(vodMovies);
  out.movies = movies.length;

  const owned = (await getSetting("vod.skipOwned")) ? await ownedMovieKeys() : null;
  const wanted = new Set<string>();
  for (const m of movies) {
    const { title, year } = titleYear(m);
    if (owned && owned.has(keyOf(title, year))) { out.skippedOwned++; continue; } // already in the real library → don't mirror
    const display = year ? `${title} (${year})` : title;
    let folder = safeName(display);
    if (wanted.has(folder)) folder = safeName(`${display} [${m.id}]`); // disambiguate rare collisions
    wanted.add(folder);
    const dir = join(root, folder);
    const strmPath = join(dir, `${folder}.strm`);
    const url = `${base}/vod/play/movie/${m.id}?key=${encodeURIComponent(key)}`;
    const cur = existsSync(strmPath) ? readFileSync(strmPath, "utf8").trim() : null;
    if (cur !== url) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(strmPath, url);
      writeFileSync(join(dir, `${folder}.nfo`), movieNfo(title, year, m));
      out.written++;
    }
  }

  // prune folders for movies that left the catalog (or the category allow-list)
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && !wanted.has(e.name)) { rmSync(join(root, e.name), { recursive: true, force: true }); out.pruned++; }
  }
  return out;
}
