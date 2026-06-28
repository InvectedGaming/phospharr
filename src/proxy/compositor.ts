import { FFMPEG } from "./transcode.ts";
import { cachedSetting } from "../settings.ts";

/**
 * Server-side mosaic compositor.
 *
 * ffmpeg composites N live channels (each pulled from the muxer's already-clean
 * per-source TS — NOT re-dialed from the provider, which is what made the old
 * xstack grid stall) into ONE continuous MPEG-TS. The grid is drawn over a
 * black base clock with overlay+repeatlast, so a stalled tile freezes only its
 * own cell instead of stalling the whole output. That single TS is served like
 * any channel: low-latency, no browser, no HLS — castable to a TV and exposable
 * in the lineup. The mosaic tab drives it via setState() (audio tile, focus,
 * layout, channels); a change re-launches ffmpeg (the muxer keeps the source
 * upstreams warm, so only the encode restarts).
 */

const PORT = Number(process.env.PORT ?? 7777);
const W = 1280, H = 720, FPS = 25;

export type MosaicLayout = "2up" | "2x2" | "3x3";
export interface MosaicState { channels: number[]; layout: MosaicLayout; focus: number | null; audio: number }

function encoderArgs(): string[] {
  switch (process.env.PHOSPHARR_CAST_ENCODER) {
    case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-b:v", "8M", "-pix_fmt", "yuv420p"];
    case "h264_amf": return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cbr", "-b:v", "8M", "-pix_fmt", "yuv420p"];
    default: return ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-b:v", "6M", "-pix_fmt", "yuv420p"];
  }
}

type Cell = { x: number; y: number; w: number; h: number };
// Tile rectangles within the 1280x720 frame for each layout (16:9 cells, centered).
function cells(layout: MosaicLayout, count: number): Cell[] {
  if (layout === "2up") { const y = (H - 360) / 2; return [{ x: 0, y, w: 640, h: 360 }, { x: 640, y, w: 640, h: 360 }].slice(0, count); }
  if (layout === "3x3") { const cw = Math.floor(W / 3), ch = Math.floor(H / 3); return Array.from({ length: 9 }, (_, i) => ({ x: (i % 3) * cw, y: Math.floor(i / 3) * ch, w: cw, h: ch })).slice(0, count); }
  return [{ x: 0, y: 0, w: 640, h: 360 }, { x: 640, y: 0, w: 640, h: 360 }, { x: 0, y: 360, w: 640, h: 360 }, { x: 640, y: 360, w: 640, h: 360 }].slice(0, count); // 2x2
}

/** Build the ffmpeg args for a state. Returns null if there's nothing to show. */
function buildArgs(state: MosaicState): string[] | null {
  const key = encodeURIComponent(String(cachedSetting("access.streamKey") || ""));
  const all = state.channels.filter((id): id is number => id != null);
  if (!all.length) return null;

  // Focused → just that tile, full frame; otherwise the grid.
  const focused = state.focus != null && all[state.focus] != null;
  const drawn = focused ? [all[state.focus as number]] : all;
  const rects = focused ? [{ x: 0, y: 0, w: W, h: H }] : cells(state.layout, drawn.length);
  const audioPos = focused ? 0 : Math.min(Math.max(0, state.audio | 0), drawn.length - 1);

  const inputs: string[] = [];
  for (const id of drawn) inputs.push("-rw_timeout", "10000000", "-thread_queue_size", "1024", "-i", `http://127.0.0.1:${PORT}/stream/${id}?key=${key}`);

  // [bg] black clock; each tile scaled+padded into its cell; chained overlays.
  let fc = `color=c=black:s=${W}x${H}:r=${FPS}[bg];`;
  rects.forEach((r, i) => { fc += `[${i}:v]scale=${r.w}:${r.h}:force_original_aspect_ratio=decrease,pad=${r.w}:${r.h}:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS,fps=${FPS}[v${i}];`; });
  let last = "bg";
  rects.forEach((r, i) => { const out = i === rects.length - 1 ? "vout" : `o${i}`; fc += `[${last}][v${i}]overlay=${r.x}:${r.y}:eof_action=pass[${out}];`; last = out; });
  fc = fc.replace(/;$/, "");

  return [
    "-hide_banner", "-loglevel", "error", "-fflags", "+genpts",
    ...inputs,
    "-filter_complex", fc,
    "-map", "[vout]", "-map", `${audioPos}:a:0?`,
    ...encoderArgs(), "-g", String(FPS * 2),
    "-c:a", "aac", "-ac", "2", "-b:a", "128k",
    "-f", "mpegts", "-mpegts_flags", "+resend_headers", "pipe:1",
  ];
}

type Sub = { push: (c: Uint8Array) => void; close: () => void };

class Compositor {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private subs = new Map<number, Sub>();
  private seq = 0;
  private state: MosaicState = { channels: [], layout: "2x2", focus: null, audio: 0 };
  private idle: ReturnType<typeof setInterval> | null = null;
  private lastErr = "";

  getState(): MosaicState { return this.state; }
  running(): boolean { return !!this.proc; }
  status() { return { running: !!this.proc, viewers: this.subs.size, state: this.state, err: this.lastErr.slice(-300) }; }

  /** Set what to show. Restarts the encode if anything changed and there are viewers. */
  setState(next: Partial<MosaicState>): void {
    const merged = { ...this.state, ...next };
    const changed = JSON.stringify(merged) !== JSON.stringify(this.state);
    this.state = merged;
    if (changed && this.subs.size > 0) this.restart();
  }

  private restart(): void {
    this.kill();
    const args = buildArgs(this.state);
    if (!args) return;
    const proc = Bun.spawn([FFMPEG, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    this.lastErr = "";
    void this.pump(proc);
    void this.drain(proc);
    proc.exited.then(() => { if (this.proc === proc) this.proc = null; });
  }

  private async pump(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    try {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) for (const s of this.subs.values()) { try { s.push(value); } catch { /* slow client */ } }
      }
    } catch { /* gone */ }
  }

  private async drain(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      while (true) { const { done, value } = await reader.read(); if (done) break; if (value) this.lastErr = (this.lastErr + dec.decode(value)).slice(-2000); }
    } catch { /* gone */ }
  }

  private kill(): void {
    if (this.proc) { try { this.proc.kill(); } catch { /* noop */ } this.proc = null; }
  }

  /** A viewer (TV, in-app player, the channel). Live MPEG-TS; starts ffmpeg on first viewer. */
  open(signal?: AbortSignal): ReadableStream<Uint8Array> | null {
    if (!buildArgs(this.state)) return null;
    if (!this.proc) this.restart();
    if (!this.idle) this.idle = setInterval(() => { if (this.subs.size === 0) this.stop(); }, 10_000);
    const id = ++this.seq;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.subs.set(id, {
          push: (chunk) => { if (controller.desiredSize !== null && controller.desiredSize <= 0) return; try { controller.enqueue(chunk); } catch { /* closing */ } },
          close: () => { try { controller.close(); } catch { /* closed */ } },
        });
        signal?.addEventListener("abort", () => this.detach(id), { once: true });
      },
      cancel: () => this.detach(id),
    }, new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 * 1024 }));
  }

  private detach(id: number): void { this.subs.delete(id); if (this.subs.size === 0) this.kill(); }

  stop(): void {
    this.kill();
    for (const s of this.subs.values()) { try { s.close(); } catch { /* noop */ } }
    this.subs.clear();
    if (this.idle) { clearInterval(this.idle); this.idle = null; }
  }
}

export const compositor = new Compositor();
