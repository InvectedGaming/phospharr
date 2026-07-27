import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { vodEpisodes, vodSeries } from "../db/schema.ts";
import { ensureEpisodes } from "./vod.ts";
import { episodePlayUrl, publicBase } from "./vodlibrary.ts";
import { decodePayload, PAYLOAD_META_RE, type GrabPayload } from "../api/torznab.ts";
import { cachedSetting, getSetting } from "../settings.ts";

/**
 * Blackhole watcher — the download half of the Torznab indexer (api/torznab.ts).
 * When Sonarr grabs a release, its Usenet Blackhole client saves our .nzb into
 * the watch folder; we spot it, decode the phospharr payload inside, write the
 * episode's .strm into a per-release subfolder of the completed folder (which
 * Sonarr watches and imports from), and delete the .nzb. The .strm carries the
 * same stable playback URL the mirror writes (vod.publicUrl resolution).
 *
 * Foreign files (real .nzb from another indexer sharing the folder, partials,
 * anything without our meta) are left strictly alone. Our own files that fail
 * to resolve are retried a few ticks (the episode may need a provider fetch),
 * then parked as <name>.error so they can't loop forever.
 */

const TICK_MS = 10_000;
const MAX_ATTEMPTS = 3;

let timer: ReturnType<typeof setInterval> | null = null;
const attempts = new Map<string, number>(); // watch-file path → failed tries
const loggedForeign = new Set<string>(); // don't spam the log about files we ignore

async function resolveEpisode(p: GrabPayload): Promise<{ url: string; showName: string } | null> {
  const [s] = await db.select().from(vodSeries).where(eq(vodSeries.id, p.s));
  if (!s) { console.error(`[blackhole] series row #${p.s} no longer exists`); return null; }
  const find = () => db.select().from(vodEpisodes)
    .where(and(eq(vodEpisodes.seriesRowId, p.s), eq(vodEpisodes.season, p.se), eq(vodEpisodes.episode, p.ep)))
    .orderBy(vodEpisodes.id);
  let [e] = await find();
  if (!e) { // not cached (or wiped mid-flight) — pull the list fresh and retry
    try { await ensureEpisodes(p.s, 60_000); } catch { /* provider hiccup — retried next tick */ }
    [e] = await find();
  }
  if (!e) {
    // Say exactly what IS cached, so a season-numbering mismatch (payload says
    // s6, provider list has year-seasons) is distinguishable from an emptied or
    // never-fetched list at a glance.
    const all = await db.select().from(vodEpisodes).where(eq(vodEpisodes.seriesRowId, p.s));
    const seasons = [...new Set(all.map((x) => x.season))].sort((a, b) => a - b);
    console.error(`[blackhole] "${s.name}" (#${p.s}): s${p.se}e${p.ep} not in cached list — ${all.length} eps cached${seasons.length ? `, seasons ${seasons.join(",")}` : ""}`);
    return null;
  }
  const base = publicBase();
  if (!base) { console.error("[blackhole] no public URL — set vod.publicUrl (or BASE_URL) so .strm files carry an absolute address"); return null; }
  const key = String(cachedSetting("access.streamKey") || "");
  return { url: episodePlayUrl(base, key, p.s, p.se, p.ep), showName: s.name };
}

async function tick(): Promise<void> {
  if (!(await getSetting("vod.indexer.enabled"))) return;
  const watch = String(await getSetting("vod.indexer.blackholeWatchPath") || "");
  const complete = String(await getSetting("vod.indexer.blackholeCompletePath") || "");
  if (!watch || !complete || !existsSync(watch)) return;

  for (const f of readdirSync(watch)) {
    if (!/\.nzb$/i.test(f)) continue;
    const path = join(watch, f);
    let payload: GrabPayload | null = null;
    try {
      const m = readFileSync(path, "utf8").match(PAYLOAD_META_RE);
      if (!m) { // not ours — never touch foreign nzbs
        if (!loggedForeign.has(path)) { loggedForeign.add(path); console.log(`[blackhole] ignoring foreign nzb: ${f}`); }
        continue;
      }
      payload = decodePayload(m[1]);
    } catch { continue; } // unreadable (mid-write?) — next tick
    if (!payload) { park(path, f, "undecodable payload"); continue; }

    const resolved = await resolveEpisode(payload);
    if (!resolved) {
      const n = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, n);
      if (n >= MAX_ATTEMPTS) park(path, f, `episode s${payload.se}e${payload.ep} of series #${payload.s} not resolvable`);
      continue;
    }

    // Per-release subfolder in the completed dir; Sonarr imports from there.
    const dir = join(complete, payload.n);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${payload.n}.strm`), resolved.url);
    // Phospharr usually runs as root in Docker while Sonarr runs as its own
    // PUID; Sonarr must MOVE the file out of here, and rwxr-xr-x root-owned
    // dirs fail that with UnauthorizedAccessException. World-writable is fine —
    // this is a transient handoff folder, not a library.
    try { chmodSync(dir, 0o777); chmodSync(join(dir, `${payload.n}.strm`), 0o666); } catch { /* non-POSIX fs */ }
    rmSync(path, { force: true });
    attempts.delete(path);
    console.log(`[blackhole] ${resolved.showName} S${String(payload.se).padStart(2, "0")}E${String(payload.ep).padStart(2, "0")} → ${join(payload.n, `${payload.n}.strm`)}`);
  }
}

function park(path: string, f: string, why: string): void {
  console.error(`[blackhole] parking ${f}: ${why}`);
  try { renameSync(path, `${path}.error`); } catch { try { rmSync(path, { force: true }); } catch { /* gone */ } }
  attempts.delete(path);
}

let running = false;
/** Start the blackhole watcher. Gated per-tick on vod.indexer.enabled, so the
 *  UI toggle takes effect live. Idempotent. */
export function startBlackholeWatcher(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    tick().catch((e) => console.error("[blackhole] tick error:", e instanceof Error ? e.message : e)).finally(() => { running = false; });
  }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}
