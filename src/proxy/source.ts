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

// Minimal structural reader — the muxer only ever calls read(); this avoids the
// DOM-vs-Bun ReadableStreamDefaultReader type mismatch (Bun adds readMany).
export type TsReader = { read(): Promise<{ done: boolean; value?: Uint8Array }> };
export interface OpenedSource {
  reader: TsReader;
  close: () => void;
}

// ffmpeg output leg shared by both resolver modes: normalize to MPEG-TS the
// muxer/TsPreroll can align. Video copied (Twitch/most YouTube live is H.264);
// audio → AAC + aresample to hold sync over long sessions.
const FF_OUT = [
  "-map", "0:v:0", "-map", "0:a:0?",
  "-c:v", "copy",
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
    // streamlink pulls the platform's live HLS continuously and writes the raw
    // stream to stdout; ffmpeg remuxes it to MPEG-TS.
    const sl = Bun.spawn(
      [STREAMLINK, "--stdout", "--default-stream", "best", "--hls-live-restart", "--retry-streams", "5", "--retry-max", "0", "--url", stream.url],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    procs.push(sl);
    out = Bun.spawn(
      [FFMPEG, "-hide_banner", "-loglevel", "error", "-fflags", "nobuffer+genpts", "-i", "pipe:0", ...FF_OUT],
      { stdin: sl.stdout, stdout: "pipe", stderr: "ignore" },
    );
    procs.push(out);
  } else {
    // Direct HLS: ffmpeg opens the URL itself, with reconnect for flaky CDNs.
    out = Bun.spawn(
      [FFMPEG, "-hide_banner", "-loglevel", "error", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
        "-fflags", "nobuffer+genpts", "-i", stream.url, ...FF_OUT],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    procs.push(out);
  }
  return { reader: (out.stdout as ReadableStream<Uint8Array>).getReader(), close: kill };
}

/** Classify a user-supplied URL into a resolver (or null for a raw .ts). */
export function resolverFor(url: string): "streamlink" | "ffmpeg" | null {
  const u = url.trim().toLowerCase();
  if (/^https?:\/\/[^/]*\b(twitch\.tv|youtube\.com|youtu\.be|kick\.com|tiktok\.com|facebook\.com|dlive\.tv|nimo\.tv|trovo\.live)\b/.test(u)) {
    return "streamlink";
  }
  const path = u.replace(/[?#].*$/, "");
  if (path.endsWith(".m3u8")) return "ffmpeg"; // direct HLS
  if (path.endsWith(".ts")) return null; // raw MPEG-TS — fetch handles it
  return "streamlink"; // any other page: let streamlink try to find a stream
}
