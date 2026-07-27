import { and, eq } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { providers, vodEpisodes, vodMovies, vodSeries, type Provider } from "../db/schema.ts";
import { providerEgress } from "../net/egress.ts";

/**
 * VOD catalog ingest (Xtream providers). Catalogs are big — 50k+ movies, 10k+
 * series — so:
 *  - movies/series land via prepared-statement upserts in short batched
 *    transactions with event-loop yields (same pattern as the EPG merge; a sync
 *    must never freeze live TV)
 *  - EPISODES are lazy: fetched per-series the first time someone opens it
 *    (get_series_info per series would be 10k+ API calls up front)
 */

function apiBase(p: Provider): string | null {
  if (p.type !== "xtream" || !p.username || !p.password) return null;
  return `${p.url.replace(/\/$/, "")}/player_api.php?username=${encodeURIComponent(p.username)}&password=${encodeURIComponent(p.password)}`;
}

async function xtream<T>(p: Provider, action: string, extra = ""): Promise<T | null> {
  const base = apiBase(p);
  if (!base) return null;
  const eg = providerEgress(p.id);
  if (eg.blocked) throw new Error(`egress blocked: ${eg.reason}`);
  const res = await fetch(`${base}&action=${action}${extra}`, {
    ...(("proxy" in eg && eg.proxy) ? { proxy: eg.proxy } : {}),
    signal: AbortSignal.timeout(60_000),
    headers: { "User-Agent": "Phospharr/1.0" },
  });
  if (!res.ok) throw new Error(`xtream ${action} → ${res.status}`);
  return (await res.json()) as T;
}

const yieldLoop = () => new Promise((r) => setTimeout(r, 0));

function yearOf(name: string): number | null {
  const m = name.match(/\((19|20)\d{2}\)/);
  return m ? Number(m[0].slice(1, 5)) : null;
}

export interface VodSyncResult { movies: number; series: number }

/** Pull the provider's full movie + series catalogs. */
export async function syncVod(providerId: number): Promise<VodSyncResult> {
  const [p] = await db.select().from(providers).where(eq(providers.id, providerId));
  if (!p) throw new Error(`provider ${providerId} not found`);
  if (p.type !== "xtream") return { movies: 0, series: 0 };

  type Cat = { category_id: string; category_name: string };
  const [mcats, scats] = await Promise.all([
    xtream<Cat[]>(p, "get_vod_categories").catch(() => []),
    xtream<Cat[]>(p, "get_series_categories").catch(() => []),
  ]);
  const mcat = new Map((mcats ?? []).map((c) => [String(c.category_id), c.category_name]));
  const scat = new Map((scats ?? []).map((c) => [String(c.category_id), c.category_name]));

  // ── movies ──
  type XMovie = { stream_id: number; name: string; category_id: string; stream_icon?: string; container_extension?: string; rating?: string | number; added?: string };
  const movies = (await xtream<XMovie[]>(p, "get_vod_streams")) ?? [];
  const upMovie = sqlite.prepare(`
    INSERT INTO vod_movies (provider_id, stream_id, name, year, category, poster_url, ext, rating, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_id, stream_id) DO UPDATE SET
      name = excluded.name, category = excluded.category, poster_url = excluded.poster_url,
      ext = excluded.ext, rating = excluded.rating`);
  let mn = 0;
  for (let i = 0; i < movies.length; i += 2000) {
    const batch = movies.slice(i, i + 2000);
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const m of batch) {
        if (!m.stream_id || !m.name) continue;
        upMovie.run(p.id, m.stream_id, m.name, yearOf(m.name), mcat.get(String(m.category_id)) ?? null,
          m.stream_icon || null, (m.container_extension || "mp4").toLowerCase(), Number(m.rating) || null,
          m.added ? Number(m.added) : null);
        mn++;
      }
      sqlite.exec("COMMIT");
    } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    await yieldLoop(); // keep live TV responsive mid-sync
  }
  upMovie.finalize();

  // ── series (catalog only — episodes are fetched lazily per series) ──
  type XSeries = { series_id: number; name: string; category_id: string; cover?: string; plot?: string };
  const series = (await xtream<XSeries[]>(p, "get_series")) ?? [];
  const upSeries = sqlite.prepare(`
    INSERT INTO vod_series (provider_id, series_id, name, year, category, poster_url, plot)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_id, series_id) DO UPDATE SET
      name = excluded.name, category = excluded.category, poster_url = excluded.poster_url`);
  let sn = 0;
  for (let i = 0; i < series.length; i += 2000) {
    const batch = series.slice(i, i + 2000);
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const s of batch) {
        if (!s.series_id || !s.name) continue;
        upSeries.run(p.id, s.series_id, s.name, yearOf(s.name), scat.get(String(s.category_id)) ?? null, s.cover || null, s.plot || null);
        sn++;
      }
      sqlite.exec("COMMIT");
    } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    await yieldLoop();
  }
  upSeries.finalize();

  console.log(`[vod] synced provider ${p.id}: ${mn} movies, ${sn} series`);
  return { movies: mn, series: sn };
}

/** Fetch + cache a series' episodes (and richer plot) the first time it's opened. */
export async function ensureEpisodes(seriesRowId: number, maxAgeMs = 24 * 3600_000): Promise<void> {
  const [s] = await db.select().from(vodSeries).where(eq(vodSeries.id, seriesRowId));
  if (!s) return;
  if (s.episodesCachedAt && Date.now() - s.episodesCachedAt.getTime() < maxAgeMs) return;
  const [p] = await db.select().from(providers).where(eq(providers.id, s.providerId));
  if (!p) return;

  type Info = {
    info?: { plot?: string; releaseDate?: string };
    episodes?: Record<string, Array<{ id: string | number; episode_num: number | string; title?: string; container_extension?: string; info?: { plot?: string; duration_secs?: number } }>>;
  };
  const info = await xtream<Info>(p, "get_series_info", `&series_id=${s.seriesId}`);
  if (!info) return;

  // Carry firstSeenAt across the wipe/reinsert so "new since last refresh" stays
  // answerable (the Torznab RSS feed is built on it). Episodes not seen before
  // get stamped now.
  const prevSeen = new Map<string, Date | null>();
  for (const e of await db.select().from(vodEpisodes).where(eq(vodEpisodes.seriesRowId, s.id)))
    prevSeen.set(`${e.season}|${e.episode}`, e.firstSeenAt);

  const seasons = info.episodes ?? {};
  const now = new Date();
  const rows: (typeof vodEpisodes.$inferInsert)[] = [];
  for (const [seasonKey, eps] of Object.entries(seasons)) {
    for (const e of eps ?? []) {
      const streamId = Number(e.id);
      if (!Number.isFinite(streamId)) continue; // skip malformed episode ids (NOT NULL column)
      const season = Number(seasonKey) || 0;
      const episode = Number(e.episode_num) || 0;
      rows.push({
        seriesRowId: s.id,
        season,
        episode,
        title: e.title || null,
        streamId,
        ext: (e.container_extension || "mp4").toLowerCase(),
        plot: e.info?.plot || null,
        durationSec: e.info?.duration_secs ? Number(e.info.duration_secs) : null,
        firstSeenAt: prevSeen.has(`${season}|${episode}`) ? prevSeen.get(`${season}|${episode}`) : now,
      });
    }
  }

  // A response with a body but ZERO parseable episodes for a series that had
  // some is far more likely a provider hiccup (rate limiting under the
  // indexer/watcher call pattern) than a real catalog removal — and wiping here
  // breaks every .strm and in-flight Sonarr grab pointing at the series. Keep
  // the cached list, DON'T bump episodesCachedAt, so the next call retries.
  if (!rows.length && prevSeen.size) {
    console.warn(`[vod] get_series_info for "${s.name}" (#${s.id}) returned no episodes (had ${prevSeen.size}) — keeping cached list`);
    return;
  }

  // Wipe only now that replacement rows are in hand (a delete-then-fail window
  // would leave the series empty for every reader until the next good fetch).
  await db.delete(vodEpisodes).where(eq(vodEpisodes.seriesRowId, s.id));
  for (let i = 0; i < rows.length; i += 500) await db.insert(vodEpisodes).values(rows.slice(i, i + 500));
  await db
    .update(vodSeries)
    .set({ episodesCachedAt: new Date(), plot: info.info?.plot || s.plot })
    .where(eq(vodSeries.id, s.id));
}

/** Lazy per-movie detail (plot + duration) via get_vod_info. */
export async function ensureMovieInfo(movieRowId: number): Promise<void> {
  const [m] = await db.select().from(vodMovies).where(eq(vodMovies.id, movieRowId));
  if (!m || m.plot != null) return;
  const [p] = await db.select().from(providers).where(eq(providers.id, m.providerId));
  if (!p) return;
  type Info = { info?: { plot?: string; description?: string; duration_secs?: number } };
  const info = await xtream<Info>(p, "get_vod_info", `&vod_id=${m.streamId}`).catch(() => null);
  if (!info?.info) return;
  await db
    .update(vodMovies)
    .set({ plot: info.info.plot || info.info.description || "", durationSec: info.info.duration_secs ? Number(info.info.duration_secs) : m.durationSec })
    .where(eq(vodMovies.id, m.id));
}

/** The direct provider file URL for a movie / episode (played via the remux proxy). */
export function vodUpstreamUrl(p: Provider, kind: "movie" | "series", streamId: number, ext: string): string {
  const base = p.url.replace(/\/$/, "");
  return `${base}/${kind === "movie" ? "movie" : "series"}/${encodeURIComponent(p.username ?? "")}/${encodeURIComponent(p.password ?? "")}/${streamId}.${ext}`;
}

/** Boot: if a provider has VOD support and we've never synced, pull the catalog. */
export function vodBootKick(): void {
  setTimeout(async () => {
    try {
      const count = (sqlite.prepare("SELECT COUNT(*) n FROM vod_movies").get() as { n: number }).n;
      if (count > 0) return;
      const provs = await db.select().from(providers).where(eq(providers.enabled, true));
      for (const p of provs) if (p.type === "xtream") await syncVod(p.id).catch((e) => console.error("[vod] boot sync:", e instanceof Error ? e.message : e));
    } catch { /* fresh install without tables yet */ }
  }, 25_000);
}
