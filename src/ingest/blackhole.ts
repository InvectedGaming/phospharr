import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  if (!s) return null;
  const find = () => db.select().from(vodEpisodes)
    .where(and(eq(vodEpisodes.seriesRowId, p.s), eq(vodEpisodes.season, p.se), eq(vodEpisodes.episode, p.ep)))
    .orderBy(vodEpisodes.id);
  let [e] = await find();
  if (!e) { // not cached (or wiped mid-flight) — pull the list fresh and retry
    try { await ensureEpisodes(p.s, 60_000); } catch { /* provider hiccup — retried next tick */ }
    [e] = await find();
  }
  if (!e) return null;
  const base = publicBase();
  if (!base) return null; // same requirement as the mirror: Emby/Sonarr need an absolute URL
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
