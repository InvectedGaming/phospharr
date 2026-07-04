import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedSetting } from "../settings.ts";

/**
 * HLS output layer — what makes Phospharr standalone on devices without Media
 * Source Extensions: iOS/iPadOS Safari (native HLS), Chromecast, AirPlay, and
 * smart-TV players. One on-demand ffmpeg per WATCHED channel segments the
 * muxer's keyframe-aligned feed into fMP4 chunks + a rolling live playlist.
 *
 *  - fed from /mosaicfeed (the muxer) → shares the provider slot with every
 *    other viewer of the channel; no extra upstream connection
 *  - video copied untouched; audio normalized to AAC (Safari requirement)
 *  - reaped after IDLE_MS without a playlist request
 */

const PORT = Number(process.env.PORT ?? 7777);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const HLS_ROOT = join(tmpdir(), "phospharr-hls");
const IDLE_MS = 30_000;
const START_TIMEOUT_MS = 20_000;

type Session = { proc: ReturnType<typeof Bun.spawn>; dir: string; lastAccess: number };
const sessions = new Map<number, Session>();
let reaper: ReturnType<typeof setInterval> | null = null;

function ensureReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    for (const [id, s] of sessions) {
      if (Date.now() - s.lastAccess > IDLE_MS) stop(id);
    }
  }, 5_000);
  if (typeof reaper.unref === "function") reaper.unref();
}

function stop(channelId: number) {
  const s = sessions.get(channelId);
  if (!s) return;
  sessions.delete(channelId);
  try { s.proc.kill(); } catch { /* gone */ }
  try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* busy */ }
}

async function start(channelId: number): Promise<Session | null> {
  const key = encodeURIComponent(String(cachedSetting("access.streamKey") || ""));
  const dir = join(HLS_ROOT, String(channelId));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fresh */ }
  mkdirSync(dir, { recursive: true });
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-fflags", "nobuffer+genpts", "-flags", "low_delay",
    "-analyzeduration", "1000000", "-probesize", "1000000",
    "-i", `http://127.0.0.1:${PORT}/mosaicfeed/${channelId}?key=${key}`,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "copy", "-c:a", "aac", "-ac", "2", "-b:a", "128k",
    "-f", "hls",
    "-hls_time", "2", "-hls_list_size", "6",
    "-hls_flags", "delete_segments+independent_segments",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", join(dir, "seg_%d.m4s"),
    join(dir, "index.m3u8"),
  ];
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([FFMPEG, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    return null; // ffmpeg missing
  }
  const s: Session = { proc, dir, lastAccess: Date.now() };
  sessions.set(channelId, s);
  ensureReaper();
  void proc.exited.then(() => { if (sessions.get(channelId) === s) sessions.delete(channelId); });
  return s;
}

/** Playlist text (starts the segmenter on first request; waits for the first segments). */
export async function playlist(channelId: number): Promise<string | null> {
  let s = sessions.get(channelId);
  if (!s) s = (await start(channelId)) ?? undefined as never;
  if (!s) return null;
  s.lastAccess = Date.now();
  const file = join(s.dir, "index.m3u8");
  const t0 = Date.now();
  // first request: wait for ffmpeg to emit a playlist with at least one segment
  while (Date.now() - t0 < START_TIMEOUT_MS) {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      if (text.includes(".m4s")) return text;
    }
    if (!sessions.has(channelId)) return null; // ffmpeg died (no source)
    await Bun.sleep(300);
  }
  return null;
}

/** A segment / init file for an active session. */
export function segment(channelId: number, name: string): ReturnType<typeof Bun.file> | null {
  const s = sessions.get(channelId);
  if (!s) return null;
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name.includes("..")) return null; // no traversal
  s.lastAccess = Date.now();
  const p = join(s.dir, name);
  return existsSync(p) ? Bun.file(p) : null;
}
