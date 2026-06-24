import { muxer } from "./muxer.ts";
import { cachedSetting } from "../settings.ts";

/**
 * Browser-compatible transcode layer.
 *
 * Browsers can't decode AC-3/E-AC-3 audio (common on US channels) via MSE, and
 * some channels use HEVC video. For the web player we run the *lightest possible*
 * transcode: copy the video stream untouched and re-encode only the audio to
 * stereo AAC. That's a few % CPU per channel instead of a full re-encode.
 *
 * Efficiency: this wraps ONE ffmpeg per channel around a single raw-muxer client,
 * then fans ffmpeg's output out to N browser viewers. So a channel watched by ten
 * tabs is still one upstream connection + one ffmpeg.
 *
 * Raw MPEG-TS passthrough (/stream) stays untouched for Plex/HDHR consumers; the
 * player only falls back here when the browser rejects the native codec.
 */

const keepWarmMs = () => Math.max(0, cachedSetting("stream.keepWarmSeconds")) * 1000;

/** Locate ffmpeg: explicit env → PATH → winget (Gyan.FFmpeg) install location. */
function resolveFfmpeg(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const onPath = Bun.which("ffmpeg");
  if (onPath) return onPath;
  const local = process.env.LOCALAPPDATA;
  if (local) {
    try {
      const glob = new Bun.Glob("Gyan.FFmpeg*/ffmpeg-*/bin/ffmpeg.exe");
      for (const m of glob.scanSync({ cwd: `${local}/Microsoft/WinGet/Packages`, absolute: true })) {
        return m;
      }
    } catch {
      /* fall through */
    }
  }
  return "ffmpeg";
}

const FFMPEG = resolveFfmpeg();
console.log(`[transcode] ffmpeg: ${FFMPEG}`);

// video copy (no re-encode) · AC-3/whatever → stereo AAC · remux to MPEG-TS on stdout
const FFMPEG_ARGS = [
  "-hide_banner", "-loglevel", "error",
  "-fflags", "+genpts",
  "-i", "pipe:0",
  "-map", "0:v:0", "-map", "0:a:0?",
  "-c:v", "copy",
  "-c:a", "aac", "-ac", "2", "-b:a", "128k",
  "-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0",
  "pipe:1",
];

type Subscriber = { id: number; push: (chunk: Uint8Array) => void; close: () => void };

class TranscodeChannel {
  private subs = new Map<number, Subscriber>();
  private seq = 0;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private rawStream: ReadableStream<Uint8Array> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(
    readonly channelId: number,
    private onTeardown: () => void,
  ) {}

  get viewerCount() {
    return this.subs.size;
  }

  async start(): Promise<boolean> {
    if (this.started) return true;
    // One raw-muxer client feeds ffmpeg — reuses the existing upstream fan-out.
    const raw = await muxer.open(this.channelId);
    if (!raw) return false;
    this.rawStream = raw;
    try {
      this.proc = Bun.spawn([FFMPEG, ...FFMPEG_ARGS], {
        stdin: raw,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      try { await raw.cancel(); } catch { /* noop */ }
      return false; // ffmpeg binary missing
    }
    this.started = true;
    this.pump().catch(() => this.teardown());
    return true;
  }

  private async pump() {
    const reader = (this.proc!.stdout as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        for (const sub of this.subs.values()) {
          try {
            sub.push(value);
          } catch {
            this.detach(sub.id);
          }
        }
      }
    }
    this.teardown();
  }

  attach(sub: Omit<Subscriber, "id">): number {
    const id = ++this.seq;
    this.subs.set(id, { id, ...sub });
    if (this.grace) {
      clearTimeout(this.grace);
      this.grace = null;
    }
    return id;
  }

  detach(id: number) {
    const sub = this.subs.get(id);
    if (!sub) return;
    this.subs.delete(id);
    try {
      sub.close();
    } catch {
      /* already closed */
    }
    if (this.subs.size === 0 && !this.grace) {
      this.grace = setTimeout(() => this.teardown(), keepWarmMs());
    }
  }

  private teardown() {
    if (this.grace) clearTimeout(this.grace);
    this.grace = null;
    if (this.subs.size > 0) return;
    try { this.proc?.kill(); } catch { /* noop */ }
    try { this.rawStream?.cancel(); } catch { /* noop */ }
    for (const sub of this.subs.values()) sub.close();
    this.subs.clear();
    this.proc = null;
    this.started = false;
    this.onTeardown();
  }
}

class Transcoder {
  private active = new Map<number, TranscodeChannel>();

  async open(channelId: number, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
    let tc = this.active.get(channelId);
    if (!tc) {
      tc = new TranscodeChannel(channelId, () => this.active.delete(channelId));
      this.active.set(channelId, tc);
      const ok = await tc.start();
      if (!ok) {
        this.active.delete(channelId);
        return null;
      }
    }
    const ref = tc;
    let subId = -1;
    return new ReadableStream<Uint8Array>(
      {
        start(controller) {
          subId = ref.attach({
            push: (chunk) => {
              // Backpressure: drop when the client can't keep up instead of
              // buffering unbounded (never OOM the server on a stalled viewer).
              if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
              try {
                controller.enqueue(chunk);
              } catch {
                /* closing */
              }
            },
            close: () => {
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            },
          });
          if (signal) signal.addEventListener("abort", () => ref.detach(subId), { once: true });
        },
        cancel() {
          ref.detach(subId);
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 24 * 1024 * 1024 }),
    );
  }
}

export const transcoder = new Transcoder();
