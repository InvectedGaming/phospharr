import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { FFMPEG } from "./transcode.ts";
import { castBrowser } from "./castbrowser.ts";

// H.264 encoder for the cast HLS. CPU (libx264) by default; set
// PHOSPHARR_CAST_ENCODER=h264_nvenc (NVIDIA) or h264_amf (AMD) to offload to a GPU.
function videoEncoderArgs(): string[] {
  switch (process.env.PHOSPHARR_CAST_ENCODER) {
    case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-b:v", "6M", "-pix_fmt", "yuv420p"];
    case "h264_amf": return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cbr", "-b:v", "6M", "-pix_fmt", "yuv420p"];
    default: return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p"];
  }
}

/**
 * Mosaic cast — ingest the browser's composited grid and re-serve it as HLS.
 *
 * Compositing four live IPTV streams server-side (ffmpeg xstack) proved
 * fundamentally unreliable — it stalls until all four mid-GOP inputs sync. But
 * the BROWSER already composites the grid flawlessly and switches layout/audio
 * instantly. So we let it: the controller draws the grid (or a focused tile)
 * onto a canvas, captures it + the chosen audio, and streams that single feed
 * here over a WebSocket. ffmpeg just transcodes that ONE continuous stream to
 * HLS for the TV. Reliable, and focus/audio changes are instant because they
 * happen in the browser — the cast is a live mirror of what you see.
 */

const PORT = Number(process.env.PORT ?? 7777);
const OUT_ROOT = join(tmpdir(), "phospharr-mosaic");

class MosaicCast {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private sink: { write: (c: Uint8Array) => number; flush?: () => void; end?: () => void } | null = null;
  private dir = "";
  private lastAccess = 0;
  private idle: ReturnType<typeof setInterval> | null = null;
  private lastErr = "";
  // What the render page should show; it polls this via /caststate.
  private castState: { channels: number[]; focus: number | null; audio: number } = { channels: [], focus: null, audio: 0 };

  getCastState() { return this.castState; }

  private async drain(proc: ReturnType<typeof Bun.spawn>) {
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      while (true) { const { done, value } = await reader.read(); if (done) break; if (value) this.lastErr = (this.lastErr + dec.decode(value)).slice(-2000); }
    } catch { /* gone */ }
  }

  /** A new browser ingest connection — (re)start the transcoder. */
  startIngest() {
    this.stop();
    this.dir = join(OUT_ROOT, String(PORT));
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* noop */ }
    mkdirSync(this.dir, { recursive: true });
    // Single WebM (VP8/Opus) stream from the browser's MediaRecorder → H.264/AAC HLS.
    const args = [
      "-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-i", "pipe:0",
      "-map", "0:v:0?", "-map", "0:a:0?",
      ...videoEncoderArgs(), "-g", "48",
      "-c:a", "aac", "-ac", "2", "-b:a", "128k",
      "-f", "hls", "-hls_time", "2", "-hls_list_size", "6",
      "-hls_flags", "delete_segments+append_list+omit_endlist",
      "-hls_segment_filename", join(this.dir, "seg_%d.ts"), join(this.dir, "index.m3u8"),
    ];
    this.proc = Bun.spawn([FFMPEG, ...args], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    this.sink = this.proc.stdin as unknown as { write: (c: Uint8Array) => number; flush?: () => void; end?: () => void };
    this.lastErr = "";
    void this.drain(this.proc);
    this.lastAccess = Date.now();
    if (!this.idle) this.idle = setInterval(() => { if (this.proc && Date.now() - this.lastAccess > 20_000) this.stop(); }, 5000);
  }

  /** Feed a chunk of the browser's WebM stream to ffmpeg. */
  feed(chunk: Uint8Array) {
    if (!this.sink) return;
    this.lastAccess = Date.now();
    try { this.sink.write(chunk); this.sink.flush?.(); } catch { /* pipe closed */ }
  }

  /** Start (or update) a server-side cast: launch the headless renderer if needed
   * and tell it what to show. The renderer connects back to /castingest, which is
   * what fires startIngest() above. */
  async cast(channels: number[], focus: number | null, audio: number, key: string): Promise<boolean> {
    this.castState = { channels, focus, audio }; // the render page polls this and updates instantly
    if (!castBrowser.running()) {
      const ok = await castBrowser.launch(key);
      if (!ok) return false;
    }
    // Wait for the render page to connect its ingest socket (→ ffmpeg running).
    for (let i = 0; i < 30; i++) { if (this.proc) return true; await new Promise((r) => setTimeout(r, 300)); }
    return !!this.proc;
  }

  stop() {
    castBrowser.stop();
    if (this.sink) { try { this.sink.end?.(); } catch { /* noop */ } this.sink = null; }
    if (this.proc) { try { this.proc.kill(); } catch { /* noop */ } this.proc = null; }
    if (this.idle) { clearInterval(this.idle); this.idle = null; }
    if (this.dir) { try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* noop */ } }
  }

  running(): boolean { return !!this.proc; }
  status() { return { running: !!this.proc, err: this.lastErr.slice(-300) }; }

  file(name: string): { body: Uint8Array; type: string } | null {
    if (!this.dir || !/^[a-zA-Z0-9_.-]+$/.test(name)) return null;
    const p = join(this.dir, name);
    if (!existsSync(p)) return null;
    this.lastAccess = Date.now();
    const type = name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
    try { return { body: readFileSync(p), type }; } catch { return null; }
  }
}

export const mosaic = new MosaicCast();
