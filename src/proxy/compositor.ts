import { cachedSetting } from "../settings.ts";
import { SupervisedProc } from "./supervisor.ts";
import { tileFeeds, TILE_FPS } from "./tilefeed.ts";

// Our compiled ffmpeg with libzmq (runtime filter control) + NVENC, and the
// zmqsend CLI the app spawns to push live `volume@aN volume X` commands.
const FFMPEG = process.env.PHOSPHARR_COMPOSITOR_FFMPEG || "ffmpeg-zmq";
const ZMQSEND = process.env.PHOSPHARR_ZMQSEND || "zmqsend";

/**
 * Server-side mosaic compositor.
 *
 * One supervised ffmpeg composites the grid into a single continuous MPEG-TS,
 * served like any channel (castable, tunable, low-latency). Its inputs are NOT
 * raw provider feeds — they are the tile intermediates from tilefeed.ts
 * (`/tile/<slot>`), which always flow: live video when the channel is up, a
 * labelled slate when it isn't. That property is what makes the grid solid:
 *
 *  - Startup is instant-ish: no input ever gates the first frame on a cold
 *    provider dial — slates flow from byte one, live video splices in as each
 *    tile's normalizer comes up.
 *  - A dead channel is a visible per-tile state that heals in place, not a
 *    frozen cell or a collapsed graph.
 *  - Input timestamps are stamped by wallclock, so seams in a tile feed
 *    (slate↔live splices) never desync the graph.
 *
 * The mosaic tab drives it via setState(): channel/layout/focus changes
 * restart just the grid encode (~1-2s; the tile normalizers keep running, so
 * no re-dials); the audible tile flips live over zmq — instant, no restart.
 */

const PORT = Number(process.env.PORT ?? 7777);
// Output geometry. NVENC handles 720p fine; without a GPU (libx264) drop
// PHOSPHARR_MOSAIC_RES to 960x540 if the CPU can't hold realtime.
const [W, H] = (process.env.PHOSPHARR_MOSAIC_RES ?? "1280x720").split("x").map(Number);
const FPS = Number(process.env.PHOSPHARR_MOSAIC_FPS ?? TILE_FPS);
// Explicit azmq endpoint. The filter's default (tcp://*:5555) is a shared
// well-known port — a stale process or unrelated tool holding it silently
// kills audio flips. Serialized restarts + a dedicated port keep the broker
// owned by exactly the running encode.
const ZMQ_PORT = Number(process.env.PHOSPHARR_COMPOSITOR_ZMQ_PORT || 5595);
const ZMQ_ENDPOINT = `tcp://127.0.0.1:${ZMQ_PORT}`;

export type MosaicLayout = "2up" | "2x2" | "3x3";
export interface MosaicState { channels: number[]; layout: MosaicLayout; focus: number | null; audio: number; names?: string[] }

function encoderArgs(): string[] {
  switch (process.env.PHOSPHARR_CAST_ENCODER) {
    case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-b:v", "8M", "-pix_fmt", "yuv420p"];
    case "h264_amf": return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cbr", "-b:v", "8M", "-pix_fmt", "yuv420p"];
    default: return ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-b:v", "6M", "-pix_fmt", "yuv420p"];
  }
}

type Cell = { x: number; y: number; w: number; h: number };
// Tile rectangles within the WxH frame for each layout (computed from W/H).
function cells(layout: MosaicLayout, count: number): Cell[] {
  if (layout === "2up") { const w = Math.floor(W / 2), h = Math.floor(w * 9 / 16), y = Math.floor((H - h) / 2); return [{ x: 0, y, w, h }, { x: w, y, w, h }].slice(0, count); }
  if (layout === "3x3") { const cw = Math.floor(W / 3), ch = Math.floor(H / 3); return Array.from({ length: 9 }, (_, i) => ({ x: (i % 3) * cw, y: Math.floor(i / 3) * ch, w: cw, h: ch })).slice(0, count); }
  const cw = Math.floor(W / 2), ch = Math.floor(H / 2); // 2x2
  return [{ x: 0, y: 0 }, { x: cw, y: 0 }, { x: 0, y: ch }, { x: cw, y: ch }].map((p) => ({ ...p, w: cw, h: ch })).slice(0, count);
}

/** The tiles actually drawn for a state — focused → just that one, else all. */
function drawnTiles(state: MosaicState): { channelId: number; name: string }[] {
  const ids = state.channels.filter((id): id is number => id != null);
  const names = (state.names ?? []).map(String);
  const all = ids.map((id, i) => ({ channelId: id, name: names[i] || "#" + id }));
  if (state.focus != null && all[state.focus]) return [all[state.focus]];
  return all;
}

/** Build the ffmpeg args for a state. Returns null if there's nothing to show. */
function buildArgs(state: MosaicState): string[] | null {
  const key = encodeURIComponent(String(cachedSetting("access.streamKey") || ""));
  const drawn = drawnTiles(state);
  if (!drawn.length) return null;
  const focused = drawn.length === 1 && state.focus != null;
  const rects = focused ? [{ x: 0, y: 0, w: W, h: H }] : cells(state.layout, drawn.length);
  const audioPos = focused ? 0 : Math.min(Math.max(0, state.audio | 0), drawn.length - 1);

  // Each input is a tile intermediate from tilefeed.ts — always flowing, whole
  // TS packets, uniform codec/res/fps. Timestamps are stamped at ARRIVAL
  // (wallclock): tile feeds splice slate↔live with PTS jumps at the seams, and
  // wallclock stamping makes those seams invisible to the graph. No -reconnect
  // needed — the feed outlives providers by design.
  const inputs: string[] = [];
  for (let i = 0; i < drawn.length; i++) {
    inputs.push(
      "-use_wallclock_as_timestamps", "1",
      "-fflags", "nobuffer", "-flags", "low_delay",
      "-thread_queue_size", "512", "-analyzeduration", "500000", "-probesize", "500000",
      "-rw_timeout", "30000000",
      "-i", `http://127.0.0.1:${PORT}/tile/${i}?key=${key}`,
    );
  }

  // [bg] black clock; each tile scaled+padded into its cell; chained overlays.
  let fc = `color=c=black:s=${W}x${H}:r=${FPS}[bg];`;
  rects.forEach((r, i) => { fc += `[${i}:v]scale=${r.w}:${r.h}:force_original_aspect_ratio=decrease,pad=${r.w}:${r.h}:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS,fps=${FPS}[v${i}];`; });
  let last = "bg";
  rects.forEach((r, i) => { const out = i === rects.length - 1 ? "vout" : `o${i}`; fc += `[${last}][v${i}]overlay=${r.x}:${r.y}:eof_action=pass[${out}];`; last = out; });
  // Audio: mix every tile through a NAMED volume filter (active tile = 1, rest = 0),
  // then an azmq broker. The tab swaps which side you hear by sending the running
  // ffmpeg `volume@aN volume X` over zmq — INSTANT, no restart. Tile feeds always
  // carry an audio track (silence bed), so [i:a] can never fail the graph.
  drawn.forEach((_, i) => { fc += `[${i}:a]asetpts=PTS-STARTPTS,volume@a${i}=${i === audioPos ? "1.0" : "0.0"}:eval=frame[av${i}];`; });
  fc += `${drawn.map((_, i) => `[av${i}]`).join("")}amix=inputs=${drawn.length}:normalize=0:dropout_transition=0[amixpre];[amixpre]azmq=bind_address='tcp\\://127.0.0.1\\:${ZMQ_PORT}'[aout];`;
  fc = fc.replace(/;$/, "");

  return [
    FFMPEG, "-hide_banner", "-loglevel", "error",
    ...inputs,
    "-filter_complex", fc,
    "-map", "[vout]", "-map", "[aout]",
    ...encoderArgs(), "-g", String(FPS), "-bf", "0",
    "-c:a", "aac", "-ac", "2", "-b:a", "128k",
    "-muxdelay", "0", "-muxpreload", "0", "-flush_packets", "1",
    "-f", "mpegts", "-mpegts_flags", "+resend_headers", "pipe:1",
  ];
}

type Sub = { push: (c: Uint8Array) => boolean; close: () => void };

class Compositor {
  private subs = new Map<number, Sub>();
  private seq = 0;
  private state: MosaicState = { channels: [], layout: "2x2", focus: null, audio: 0 };
  private idle: ReturnType<typeof setInterval> | null = null;
  private warmUntil = 0; // keep the encode alive (no viewers) until this time — pre-warm + reconnect grace

  private sup = new SupervisedProc({
    name: "mosaic",
    cmd: () => buildArgs(this.state),
    wantRunning: () => !!buildArgs(this.state) && (this.subs.size > 0 || Date.now() < this.warmUntil),
    // Inside the serialized restart, before the encode dials its inputs:
    // normalizers up (or lingering warm), slates rendered — every /tile/<slot>
    // emits from byte one, so the new encode probes instantly.
    beforeSpawn: () => tileFeeds.ensureTiles(drawnTiles(this.state)),
    onStdout: (chunk) => {
      // A sub that can't take the chunk is seconds behind live. Dropping a
      // chunk mid-GOP corrupts its TS (decoder errors → player death spiral),
      // so DISCONNECT it instead — its player reconnects at the live edge.
      for (const [id, s] of [...this.subs]) {
        let ok = false;
        try { ok = s.push(chunk); } catch { /* closing */ }
        if (!ok) { this.subs.delete(id); try { s.close(); } catch { /* noop */ } }
      }
    },
    // Unexpected death: close viewers so their players reconnect cleanly
    // (instead of hanging on a silent stream), and hold the warm window so
    // the supervisor brings the encode back for the reattach.
    onDown: () => {
      this.warmUntil = Math.max(this.warmUntil, Date.now() + 30_000);
      this.closeSubs();
    },
    watchdogMs: 20_000, // alive but silent → wedged; tile slates make real starts fast
  });

  getState(): MosaicState { return this.state; }
  running(): boolean { return this.sup.running(); }
  status() { return { running: this.sup.running(), viewers: this.subs.size, state: this.state, err: this.sup.lastErr().slice(-300), tiles: tileFeeds.status() }; }

  /** Set what to show. Restarts the encode if the video layout changed. */
  setState(next: Partial<MosaicState>): void {
    const merged = { ...this.state, ...next };
    // Only the VIDEO layout (channels / grid / focused tile) needs a re-encode.
    // An audio-tile change is just a live gain flip over zmq — no restart, no
    // re-buffer, no drift: the audible side swaps instantly (the command center).
    const vsig = (s: MosaicState) => JSON.stringify([s.channels, s.layout, s.focus]);
    const videoChanged = vsig(merged) !== vsig(this.state);
    const audioChanged = merged.audio !== this.state.audio;
    this.state = merged;
    if (!buildArgs(this.state)) { this.stop(); return; } // no channels selected → tear down
    // Pre-warm: start the encode the moment the app composes, BEFORE the TV
    // connects, and keep it warm long enough for the TV to open.
    this.warmUntil = Date.now() + 45_000;
    if (videoChanged || !this.sup.running()) this.sup.restart();
    else if (audioChanged) this.applyAudio();
    this.ensureIdle();
  }

  /** Flip the audible tile on the RUNNING ffmpeg via zmq — instant, no restart. */
  private applyAudio(): void {
    if (!this.sup.running()) return;
    const drawn = drawnTiles(this.state);
    if (drawn.length === 1) return; // focused → its audio is the mix
    const audioPos = Math.min(Math.max(0, this.state.audio | 0), drawn.length - 1);
    drawn.forEach((_, i) => {
      const cmd = `volume@a${i} volume ${i === audioPos ? "1.0" : "0.0"}`;
      try {
        const p = Bun.spawn(["bash", "-c", `echo '${cmd}' | timeout 3 ${ZMQSEND} -b '${ZMQ_ENDPOINT}'`], { stdout: "ignore", stderr: "ignore" });
        void p.exited.then((code) => { if (code !== 0) this.sup.noteErr(`[audio flip zmq failed (exit ${code})]`); });
      } catch { /* best effort */ }
    });
  }

  private closeSubs(): void {
    for (const s of this.subs.values()) { try { s.close(); } catch { /* noop */ } }
    this.subs.clear();
  }

  /** Idle monitor: reap the encode after the keep-warm window with no viewers. */
  private ensureIdle(): void {
    if (this.idle) return;
    this.idle = setInterval(() => { if (this.subs.size === 0 && Date.now() > this.warmUntil) this.stop(); }, 5_000);
  }

  /** A viewer (TV, in-app player, the channel). Live MPEG-TS; starts ffmpeg on first viewer. */
  open(signal?: AbortSignal): ReadableStream<Uint8Array> | null {
    if (!buildArgs(this.state)) return null;
    // The sub only registers when the Response starts consuming — bump the warm
    // window NOW so a queued restart can't mistake this for a stale teardown.
    this.warmUntil = Math.max(this.warmUntil, Date.now() + 45_000);
    if (!this.sup.running() && !this.sup.pending()) this.sup.restart();
    this.ensureIdle();
    const id = ++this.seq;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.subs.set(id, {
          push: (chunk) => {
            if (controller.desiredSize !== null && controller.desiredSize <= 0) return false; // full — onStdout disconnects us
            try { controller.enqueue(chunk); } catch { /* closing */ }
            return true;
          },
          close: () => { try { controller.close(); } catch { /* closed */ } },
        });
        signal?.addEventListener("abort", () => this.detach(id), { once: true });
      },
      cancel: () => this.detach(id),
    }, new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 * 1024 }));
  }

  // Keep-warm on last-viewer-leave (don't kill): a mpegts.js reload detaches then
  // immediately reattaches — killing here would force a fresh cold start every
  // reload. The idle monitor reaps it after the grace.
  private detach(id: number): void { this.subs.delete(id); if (this.subs.size === 0) this.warmUntil = Math.max(this.warmUntil, Date.now() + 15_000); }

  stop(): void {
    this.warmUntil = 0;
    this.sup.stop();
    this.closeSubs();
    tileFeeds.releaseAll();
    if (this.idle) { clearInterval(this.idle); this.idle = null; }
  }
}

export const compositor = new Compositor();
