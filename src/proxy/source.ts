import type { Stream } from "../db/schema.ts";
import { providerEgress } from "../net/egress.ts";

/**
 * Turn a Stream into a live MPEG-TS byte reader, whatever the source is:
 *
 *   resolver = null        provider stream — raw TS over fetch (the hot path)
 *   resolver = "streamlink" a platform page (Twitch/YouTube/Kick) — streamlink
 *                           continuously restreams it, piped through ffmpeg to a
 *                           clean MPEG-TS (copy video, AAC audio)
 *   resolver = "ffmpeg"     a direct HLS (.m3u8) ffmpeg opens itself
 *
 * The muxer fans ONE of these out to every viewer and handles failover — a
 * custom live channel gets the same multiplexing + keep-warm as everything else.
 */

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const STREAMLINK = process.env.PHOSPHARR_STREAMLINK || "streamlink";
const YTDLP = process.env.PHOSPHARR_YTDLP || "yt-dlp";
// h264 encoder for sources whose codec MPEG-TS can't carry (YouTube = VP9/AV1).
const VENC = process.env.PHOSPHARR_CAST_ENCODER === "h264_nvenc"
  ? ["-c:v", "h264_nvenc", "-preset", "p4", "-b:v", "6M", "-pix_fmt", "yuv420p"]
  : ["-c:v", "libx264", "-preset", "veryfast", "-b:v", "6M", "-pix_fmt", "yuv420p"];

// Minimal structural reader — the muxer only ever calls read(); this avoids the
// DOM-vs-Bun ReadableStreamDefaultReader type mismatch (Bun adds readMany).
export type TsReader = { read(): Promise<{ done: boolean; value?: Uint8Array }> };
export interface OpenedSource {
  reader: TsReader;
  close: () => void;
}

// ffmpeg output leg → MPEG-TS the muxer/TsPreroll can align. Audio → AAC with
// aresample to hold sync over long sessions. Video is COPIED for H.264 sources
// (Twitch/Kick/most direct HLS) and TRANSCODED when the source codec can't ride
// in MPEG-TS (YouTube VP9/AV1).
const ffOut = (copyVideo: boolean) => [
  "-map", "0:v:0", "-map", "0:a:0?",
  ...(copyVideo ? ["-c:v", "copy"] : [...VENC, "-g", "50", "-bf", "0"]),
  "-af", "aresample=async=1000:min_hard_comp=0.100:first_pts=0",
  "-c:a", "aac", "-ac", "2", "-b:a", "128k",
  "-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "pipe:1",
];

export async function openSource(stream: Stream, signal: AbortSignal): Promise<OpenedSource> {
  if (!stream.resolver) {
    // Provider stream: raw TS over fetch, through the per-source egress (VPN).
    const eg = providerEgress(stream.providerId);
    if (eg.blocked) throw new Error(`egress blocked: ${eg.reason}`);
    const res = await fetch(stream.url, {
      signal,
      redirect: "follow",
      headers: { "User-Agent": "Phospharr/0.1" },
      ...(eg.proxy ? { proxy: eg.proxy } : {}),
    });
    if (!res.ok || !res.body) throw new Error(`upstream ${res.status}`);
    return { reader: res.body.getReader(), close: () => { try { res.body!.cancel(); } catch { /* gone */ } } };
  }

  const procs: ReturnType<typeof Bun.spawn>[] = [];
  const kill = () => { for (const p of procs) { try { p.kill(); } catch { /* gone */ } } };
  signal.addEventListener("abort", kill, { once: true });

  let out: ReturnType<typeof Bun.spawn>;
  if (stream.resolver === "streamlink") {
    // Twitch/Kick: streamlink continuously restreams the live HLS to stdout;
    // ffmpeg remuxes to MPEG-TS. These are H.264 → copy video.
    const sl = Bun.spawn(
      [STREAMLINK, "--stdout", "--default-stream", "best", "--hls-live-restart", "--retry-streams", "5", "--retry-max", "0", "--url", stream.url],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    procs.push(sl);
    out = Bun.spawn(
      [FFMPEG, "-hide_banner", "-loglevel", "error", "-fflags", "nobuffer+genpts", "-i", "pipe:0", ...ffOut(true)],
      { stdin: sl.stdout, stdout: "pipe", stderr: "ignore" },
    );
    procs.push(out);
  } else if (stream.resolver === "ytdlp") {
    // YouTube (and other yt-dlp sites): yt-dlp pipes the live stream to stdout.
    // DENO gives it the JS runtime YouTube now demands; video is VP9/AV1 so we
    // TRANSCODE to H.264. Best-effort — Google actively fights datacenter IPs.
    const dl = Bun.spawn(
      [YTDLP, "--quiet", "--no-warnings", "--js-runtimes", "deno", "-f", "bestvideo[height<=1080]+bestaudio/best", "-o", "-", stream.url],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin` } },
    );
    procs.push(dl);
    out = Bun.spawn(
      [FFMPEG, "-hide_banner", "-loglevel", "error", "-fflags", "nobuffer+genpts", "-i", "pipe:0", ...ffOut(false)],
      { stdin: dl.stdout, stdout: "pipe", stderr: "ignore" },
    );
    procs.push(out);
  } else {
    // Direct HLS: ffmpeg opens the URL itself, with reconnect for flaky CDNs.
    out = Bun.spawn(
      [FFMPEG, "-hide_banner", "-loglevel", "error", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
        "-fflags", "nobuffer+genpts", "-i", stream.url, ...ffOut(true)],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    procs.push(out);
  }
  return { reader: (out.stdout as ReadableStream<Uint8Array>).getReader(), close: kill };
}

/**
 * Probe a URL before saving: run its resolver for a few seconds and report
 * whether real bytes came out (and the actual error if not). Lets the Add-stream
 * UI say "✓ works" / "✗ YouTube blocked this" up front instead of a black screen.
 */
export async function probeSource(url: string, ms = 9000): Promise<{ ok: boolean; resolver: string | null; bytes: number; error?: string }> {
  const resolver = resolverFor(url);
  if (!resolver) {
    // raw .ts — just check it fetches
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { "User-Agent": "Phospharr/1.0" } });
      if (!r.ok) return { ok: false, resolver, bytes: 0, error: `HTTP ${r.status}` };
      const rd = r.body!.getReader(); const { value } = await rd.read(); rd.cancel().catch(() => {});
      return { ok: !!(value && value.length), resolver, bytes: value?.length ?? 0 };
    } catch (e) { return { ok: false, resolver, bytes: 0, error: e instanceof Error ? e.message : String(e) }; }
  }
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  const kill = () => { for (const p of procs) { try { p.kill(); } catch { /* gone */ } } };
  let out: ReturnType<typeof Bun.spawn>;
  let errProc: ReturnType<typeof Bun.spawn>;
  if (resolver === "streamlink") {
    const sl = Bun.spawn([STREAMLINK, "--stdout", "--default-stream", "best", "--url", url], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    procs.push(sl); errProc = sl;
    out = Bun.spawn([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...ffOut(true)], { stdin: sl.stdout, stdout: "pipe", stderr: "ignore" });
    procs.push(out);
  } else if (resolver === "ytdlp") {
    const dl = Bun.spawn([YTDLP, "--quiet", "--no-warnings", "--js-runtimes", "deno", "-f", "bestvideo[height<=1080]+bestaudio/best", "-o", "-", url], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    procs.push(dl); errProc = dl;
    out = Bun.spawn([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...ffOut(false)], { stdin: dl.stdout, stdout: "pipe", stderr: "ignore" });
    procs.push(out);
  } else {
    out = Bun.spawn([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", url, ...ffOut(true)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    procs.push(out); errProc = out;
  }
  let bytes = 0; const t0 = Date.now(); const rd = (out.stdout as ReadableStream<Uint8Array>).getReader();
  try { while (Date.now() - t0 < ms && bytes < 300_000) { const { done, value } = await rd.read(); if (done) break; if (value) bytes += value.length; } } catch { /* died */ }
  let err = "";
  try { err = (await new Response(errProc.stderr as ReadableStream).text()).trim().split("\n").filter(Boolean).pop() ?? ""; } catch { /* noop */ }
  kill();
  const ok = bytes > 50_000;
  return { ok, resolver, bytes, error: ok ? undefined : (err || "no playable stream found") };
}

/** Classify a user-supplied URL into a resolver (or null for a raw .ts). */
export function resolverFor(url: string): "streamlink" | "ffmpeg" | "ytdlp" | null {
  const u = url.trim().toLowerCase();
  if (/^https?:\/\/[^/]*\b(youtube\.com|youtu\.be)\b/.test(u)) return "ytdlp"; // YouTube → yt-dlp+deno (JS runtime)
  if (/^https?:\/\/[^/]*\b(twitch\.tv|kick\.com|tiktok\.com|dlive\.tv|nimo\.tv|trovo\.live)\b/.test(u)) return "streamlink";
  const path = u.replace(/[?#].*$/, "");
  if (path.endsWith(".m3u8")) return "ffmpeg"; // direct HLS
  if (path.endsWith(".ts")) return null; // raw MPEG-TS — fetch handles it
  return "streamlink"; // any other page: let streamlink try to find a stream
}
