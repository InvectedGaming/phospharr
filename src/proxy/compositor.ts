import { cachedSetting } from "../settings.ts";

// Our compiled ffmpeg with libzmq (runtime filter control) + NVENC, and the
// zmqsend CLI the app spawns to push live `volume@aN volume X` / overlay commands.
const FFMPEG = process.env.PHOSPHARR_COMPOSITOR_FFMPEG || "ffmpeg-zmq";
const ZMQSEND = process.env.PHOSPHARR_ZMQSEND || "zmqsend";

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
// 720p — fine for the GPU (NVENC). Without a GPU (PHOSPHARR_CAST_ENCODER unset →
// libx264) drop this to 960x540 if the CPU can't hold realtime on a busy grid.
const W = 1280, H = 720, FPS = 25;
// Explicit azmq endpoint. The filter's default (tcp://*:5555) is a shared
// well-known port: if the OLD encode hasn't fully exited when the new one
// spawns, the new azmq can't bind and every audio flip after that silently
// goes nowhere. A dedicated port (+ serialized restarts below) keeps the
// broker owned by exactly the running encode.
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

  // Feed each tile from /mosaicfeed — a KEYFRAME-ALIGNED feed (muxer preroll). With
  // /livefeed (live edge, no keyframe) ffmpeg sat ~9s waiting for the next keyframe
  // on every input before it could render a single frame — that was the "freezing".
  // The preroll starts each input on a decodable keyframe, so the composite produces
  // output in ~1-2s at the cost of being ~1 GOP behind live (an acceptable trade).
  // -reconnect: if a tile's feed transiently fails (e.g. the muxer has no free
  // provider slot yet and returns 503), ffmpeg RETRIES that input instead of
  // aborting the whole graph. Without this, one momentarily-unavailable channel
  // kills the entire mosaic the instant it starts (the tile just stays black until
  // its slot frees).
  const inputs: string[] = [];
  for (const id of drawn) inputs.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_http_error", "4xx,5xx", "-reconnect_delay_max", "6", "-fflags", "nobuffer+genpts", "-flags", "low_delay", "-avioflags", "direct", "-rw_timeout", "12000000", "-thread_queue_size", "512", "-analyzeduration", "1000000", "-probesize", "1000000", "-i", `http://127.0.0.1:${PORT}/mosaicfeed/${id}?key=${key}`);

  // [bg] black clock; each tile scaled+padded into its cell; chained overlays.
  let fc = `color=c=black:s=${W}x${H}:r=${FPS}[bg];`;
  rects.forEach((r, i) => { fc += `[${i}:v]scale=${r.w}:${r.h}:force_original_aspect_ratio=decrease,pad=${r.w}:${r.h}:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS,fps=${FPS}[v${i}];`; });
  let last = "bg";
  rects.forEach((r, i) => { const out = i === rects.length - 1 ? "vout" : `o${i}`; fc += `[${last}][v${i}]overlay=${r.x}:${r.y}:eof_action=pass[${out}];`; last = out; });
  // Audio: mix every tile through a NAMED volume filter (active tile = 1, rest = 0),
  // then an azmq broker. The tab swaps which side you hear by sending the running
  // ffmpeg `volume@aN volume X` over zmq — INSTANT, no restart. asetpts re-bases
  // each to the 0-based video so A/V stays in sync.
  drawn.forEach((_, i) => { fc += `[${i}:a]asetpts=PTS-STARTPTS,volume@a${i}=${i === audioPos ? "1.0" : "0.0"}:eval=frame[av${i}];`; });
  fc += `${drawn.map((_, i) => `[av${i}]`).join("")}amix=inputs=${drawn.length}:normalize=0:dropout_transition=0[amixpre];[amixpre]azmq=bind_address='tcp\\://127.0.0.1\\:${ZMQ_PORT}'[aout];`;
  fc = fc.replace(/;$/, "");

  return [
    "-hide_banner", "-loglevel", "error",
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
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private subs = new Map<number, Sub>();
  private seq = 0;
  private state: MosaicState = { channels: [], layout: "2x2", focus: null, audio: 0 };
  private idle: ReturnType<typeof setInterval> | null = null;
  private warmUntil = 0; // keep the encode alive (no viewers) until this time — pre-warm + reconnect grace
  private lastErr = "";
  private procStarted = 0; // when the current encode spawned
  private lastOut = 0; // last time ffmpeg produced output (watchdog)
  private crashes = 0; // consecutive early exits → restart backoff
  private restartQueued = false; // a restart is queued on the chain (it reads the latest state)
  private restarting = false; // a restart is executing right now
  private chain: Promise<void> = Promise.resolve(); // serializes restarts: old encode fully exits before the new spawns

  getState(): MosaicState { return this.state; }
  running(): boolean { return !!this.proc; }
  status() { return { running: !!this.proc, viewers: this.subs.size, state: this.state, err: this.lastErr.slice(-300) }; }

  /** Set what to show. Restarts the encode if anything changed and there are viewers. */
  setState(next: Partial<MosaicState>): void {
    const merged = { ...this.state, ...next };
    // Only the VIDEO layout (channels / grid / focused tile) needs a re-encode.
    // An audio-tile change is just a live gain flip over zmq — no restart, no
    // re-buffer, no drift: the cast keeps running and the audible side swaps
    // instantly (the command center).
    const vsig = (s: MosaicState) => JSON.stringify([s.channels, s.layout, s.focus]);
    const videoChanged = vsig(merged) !== vsig(this.state);
    const audioChanged = merged.audio !== this.state.audio;
    this.state = merged;
    if (!buildArgs(this.state)) { this.stop(); return; } // no channels selected → tear down
    // Pre-warm: start the encode the moment the app composes, BEFORE the TV connects,
    // so the TV attaches to an already-running stream instead of triggering a cold
    // 15s provider-dial. Keep it warm for a window so the TV has time to open.
    this.warmUntil = Date.now() + 45_000;
    if (videoChanged || !this.proc) this.requestRestart();
    else if (audioChanged) this.applyAudio();
  }

  /** Flip the audible tile on the RUNNING ffmpeg via zmq — instant, no restart. */
  private applyAudio(): void {
    if (!this.proc) return;
    const all = this.state.channels.filter((id): id is number => id != null);
    if (this.state.focus != null && all[this.state.focus] != null) return; // focus = single tile
    const audioPos = Math.min(Math.max(0, this.state.audio | 0), all.length - 1);
    all.forEach((_, i) => {
      const cmd = `volume@a${i} volume ${i === audioPos ? "1.0" : "0.0"}`;
      try {
        const p = Bun.spawn(["bash", "-c", `echo '${cmd}' | timeout 3 ${ZMQSEND} -b '${ZMQ_ENDPOINT}'`], { stdout: "ignore", stderr: "ignore" });
        void p.exited.then((code) => { if (code !== 0) this.lastErr = (this.lastErr + `\n[audio flip zmq failed (exit ${code})]`).slice(-2000); });
      } catch { /* best effort */ }
    });
  }

  /** Queue a restart. Restarts are serialized on a chain — the old encode must
   * FULLY exit before the new one spawns, or the new azmq can't bind the port
   * and audio flips die. One queued restart is enough: it reads the state at
   * execution time, so rapid layout changes collapse into a single re-encode. */
  private requestRestart(): void {
    if (this.restartQueued) return;
    this.restartQueued = true;
    this.chain = this.chain.then(async () => {
      this.restartQueued = false;
      this.restarting = true;
      try { await this.doRestart(); } finally { this.restarting = false; }
    });
  }

  private async doRestart(): Promise<void> {
    await this.killAndWait();
    // Torn down (or reaped) while we were queued → don't resurrect.
    if (this.subs.size === 0 && Date.now() > this.warmUntil) return;
    const args = buildArgs(this.state);
    if (!args) return;
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([FFMPEG, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      this.lastErr = `ffmpeg spawn failed: ${e instanceof Error ? e.message : e}`;
      return;
    }
    this.proc = proc;
    this.procStarted = Date.now();
    this.lastOut = Date.now();
    this.lastErr = "";
    void this.pump(proc);
    void this.drain(proc);
    void proc.exited.then((code) => this.onExit(proc, code));
    this.ensureIdle();
  }

  /** Unexpected encode death (input collapse, encoder error, OOM-kill). The old
   * behavior just nulled the pointer: attached viewers hung on a silent stream
   * forever and nothing restarted — the "mosaic dies after a while". Now: close
   * the viewers so their players reconnect cleanly, and bring the encode back
   * (with backoff if it's crash-looping) so they reattach to a warm stream. */
  private onExit(proc: ReturnType<typeof Bun.spawn>, code: number | undefined): void {
    if (this.proc !== proc) return; // replaced or intentionally stopped
    this.proc = null;
    const uptime = Date.now() - this.procStarted;
    this.crashes = uptime > 20_000 ? 0 : this.crashes + 1;
    this.lastErr = (this.lastErr + `\n[encode exited (${code ?? "?"}) after ${Math.round(uptime / 1000)}s]`).slice(-2000);
    const hadViewers = this.subs.size > 0;
    this.closeSubs();
    if (hadViewers || Date.now() < this.warmUntil) {
      this.warmUntil = Math.max(this.warmUntil, Date.now() + 30_000); // hold the warm window for the reattach
      const delay = Math.min(500 * 2 ** this.crashes, 15_000);
      setTimeout(() => { if (!this.proc && !this.restartQueued && !this.restarting && buildArgs(this.state)) this.requestRestart(); }, delay);
    }
  }

  /** Kill the current encode and WAIT for it to exit (bounded, then SIGKILL) so
   * it releases the zmq port before a successor binds it. */
  private async killAndWait(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null; // onExit sees the swap and treats this exit as intentional
    try { proc.kill(); } catch { /* noop */ }
    const timeout = (ms: number) => new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms));
    if (await Promise.race([proc.exited, timeout(1500)]) === "timeout") {
      try { proc.kill(9); } catch { /* noop */ }
      await Promise.race([proc.exited, timeout(1000)]);
    }
  }

  private closeSubs(): void {
    for (const s of this.subs.values()) { try { s.close(); } catch { /* noop */ } }
    this.subs.clear();
  }

  /** Idle monitor: reap the encode after the keep-warm window with no viewers,
   * and watchdog a wedged one (process alive, zero output) back to life. */
  private ensureIdle(): void {
    if (this.idle) return;
    this.idle = setInterval(() => {
      if (this.subs.size === 0 && Date.now() > this.warmUntil) { this.stop(); return; }
      // 25s of silence with viewers attached (past any cold-start dial) = wedged.
      if (this.proc && !this.restartQueued && !this.restarting && this.subs.size > 0 && Date.now() - this.lastOut > 25_000) {
        this.lastErr = (this.lastErr + "\n[watchdog: no output for 25s — restarting the encode]").slice(-2000);
        this.closeSubs();
        this.requestRestart();
      }
    }, 5_000);
  }

  private async pump(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    try {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (this.proc === proc) this.lastOut = Date.now();
        // A sub that can't take the chunk is seconds behind live. Dropping a
        // chunk mid-GOP corrupts its TS (decoder errors → player death spiral),
        // so DISCONNECT it instead — its player reconnects at the live edge.
        for (const [id, s] of [...this.subs]) {
          let ok = false;
          try { ok = s.push(value); } catch { /* closing */ }
          if (!ok) { this.subs.delete(id); try { s.close(); } catch { /* noop */ } }
        }
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
    // The sub only registers when the Response starts consuming — bump the warm
    // window NOW so the queued restart can't mistake this for a stale teardown.
    this.warmUntil = Math.max(this.warmUntil, Date.now() + 45_000);
    if (!this.proc && !this.restartQueued && !this.restarting) this.requestRestart();
    this.ensureIdle();
    const id = ++this.seq;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.subs.set(id, {
          push: (chunk) => {
            if (controller.desiredSize !== null && controller.desiredSize <= 0) return false; // full — pump disconnects us
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
  // immediately reattaches — killing here would force a fresh 15s cold-start every
  // reload (the "reconnecting" loop). The idle monitor reaps it after the grace.
  private detach(id: number): void { this.subs.delete(id); if (this.subs.size === 0) this.warmUntil = Date.now() + 15_000; }

  stop(): void {
    this.warmUntil = 0; // a queued restart checks this and stays down
    this.kill();
    this.closeSubs();
    if (this.idle) { clearInterval(this.idle); this.idle = null; }
  }
}

export const compositor = new Compositor();
