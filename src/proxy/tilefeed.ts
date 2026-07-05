import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { cachedSetting } from "../settings.ts";
import { FFMPEG } from "./transcode.ts";
import { SupervisedProc } from "./supervisor.ts";

/**
 * Per-tile feeds for the mosaic compositor — inputs that NEVER stall it.
 *
 * The old design pointed the grid ffmpeg straight at N provider-backed feeds.
 * Every tile shared fate with the whole graph: a slow dial gated the first
 * frame of the entire mosaic, a dead provider blacked its cell until the next
 * layout change, and input EOFs could collapse the encode.
 *
 * Now each composed channel gets its own supervised NORMALIZER ffmpeg that
 * re-encodes the channel to a uniform intermediate (fixed resolution / fps /
 * H.264 + AAC MPEG-TS, silence synthesized when the channel has no audio).
 * The compositor reads each tile from `/tile/<slot>` — an HTTP feed served by
 * this manager, which splices in a pre-rendered SLATE (channel name on a dark
 * card) whenever the normalizer isn't producing yet: cold dial, provider
 * drop, crash-loop backoff. So the compositor's inputs always flow from
 * byte one — the grid starts instantly and a dead tile shows a labelled slate
 * that heals in place instead of freezing the graph.
 *
 * Splice safety: every write is whole 188-byte TS packets (the aligner below),
 * every normalizer spawn begins with PAT/PMT + IDR (fresh ffmpeg mux), the
 * slate file does too, and both share codec/resolution/fps — the downstream
 * decoder resyncs within a GOP at every seam. The compositor stamps input
 * timestamps by wallclock, so PTS jumps across seams don't matter.
 *
 * Normalizers keep running for a short LINGER after a tile leaves the layout
 * (focus toggles, layout flips), so flipping back is instant — the encode
 * restarts, the tiles don't.
 */

const PKT = 188;
const SYNC = 0x47;
const PORT = Number(process.env.PORT ?? 7777);

// Uniform tile intermediate. 540p keeps N× libx264-ultrafast realtime cheap;
// override res/encoder via env on beefier hosts.
const [TILE_W, TILE_H] = (process.env.PHOSPHARR_TILE_RES ?? "960x540").split("x").map(Number);
export const TILE_FPS = Number(process.env.PHOSPHARR_TILE_FPS ?? 25);
const LINGER_MS = 20_000;
const SLATE_SECONDS = 2;

function tileEncoderArgs(): string[] {
  switch (process.env.PHOSPHARR_TILE_ENCODER) {
    case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ll", "-b:v", "2M", "-pix_fmt", "yuv420p"];
    case "h264_amf": return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cbr", "-b:v", "2M", "-pix_fmt", "yuv420p"];
    default: return ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-b:v", "1800k", "-pix_fmt", "yuv420p"];
  }
}

/** Emits only whole, sync-checked 188-byte packets; buffers the remainder.
 * Splicing arbitrary chunk boundaries into another TS corrupts the stream —
 * everything written to a tile consumer goes through one of these. */
export class PacketAligner {
  private rest: Uint8Array = new Uint8Array(0);
  private aligned = false;

  push(chunk: Uint8Array): Uint8Array | null {
    let buf: Uint8Array;
    if (this.rest.length) {
      buf = new Uint8Array(this.rest.length + chunk.length);
      buf.set(this.rest); buf.set(chunk, this.rest.length);
    } else buf = chunk;
    if (!this.aligned) {
      let off = -1;
      for (let i = 0; i + 2 * PKT < buf.length; i++) {
        if (buf[i] === SYNC && buf[i + PKT] === SYNC && buf[i + 2 * PKT] === SYNC) { off = i; break; }
      }
      if (off < 0) { this.rest = buf.length > 4 * PKT ? buf.slice(-2 * PKT) : buf.slice(); return null; }
      buf = buf.subarray(off);
      this.aligned = true;
    }
    let whole = Math.floor(buf.length / PKT) * PKT;
    // Lost sync mid-buffer → emit up to the loss, realign from there next push.
    for (let i = 0; i < whole; i += PKT) {
      if (buf[i] !== SYNC) { whole = i; this.aligned = false; break; }
    }
    this.rest = buf.slice(whole);
    return whole ? buf.slice(0, whole) : null;
  }

  reset(): void { this.rest = new Uint8Array(0); this.aligned = false; }
}

/** Names go into a drawtext filter — allow a safe subset, drop the rest. */
function slateLabel(name: string): string {
  const clean = (name || "").replace(/[^A-Za-z0-9 .+#&()\-]/g, "").trim().slice(0, 28);
  return clean || "channel";
}

const slateCache = new Map<string, Uint8Array>(); // label|WxH → TS bytes
const slateDir = join(tmpdir(), "phospharr-tiles");

/** Render the tile's slate: channel name on a dark card, silent audio, same
 * codec/res/fps as the live intermediate. Cached per label. Falls back to a
 * plain card if drawtext is unavailable (no freetype/fonts in the ffmpeg). */
export async function slateFor(name: string): Promise<Uint8Array> {
  const label = slateLabel(name);
  const key = `${label}|${TILE_W}x${TILE_H}`;
  const hit = slateCache.get(key);
  if (hit) return hit;
  mkdirSync(slateDir, { recursive: true });
  const file = join(slateDir, `slate-${Buffer.from(key).toString("hex").slice(0, 40)}.ts`);
  const common = (vf: string | null) => [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=0x0b0f14:s=${TILE_W}x${TILE_H}:r=${TILE_FPS}:d=${SLATE_SECONDS}`,
    "-f", "lavfi", "-t", String(SLATE_SECONDS), "-i", "anullsrc=r=48000:cl=stereo",
    ...(vf ? ["-vf", vf] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-b:v", "800k", "-pix_fmt", "yuv420p", "-g", String(TILE_FPS),
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "96k",
    "-muxdelay", "0", "-muxpreload", "0",
    "-f", "mpegts", file,
  ];
  const text = label.replace(/\\/g, "").replace(/[':,]/g, ""); // belt over slateLabel's braces
  const draw = (font: string | null) => `drawtext=${font ? `fontfile='${font}':` : ""}text='${text}':fontcolor=0x77808a:fontsize=${Math.round(TILE_H / 11)}:x=(w-text_w)/2:y=(h-text_h)/2`;
  // Known font files first (fontconfig has no default config on some hosts,
  // e.g. Windows dev boxes), then fontconfig's default, then a text-less card.
  const fontFile = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", // Debian (fonts-dejavu-core, the Docker image)
    "C\\:/Windows/Fonts/arial.ttf", // Windows dev
  ].find((f) => { try { return existsSync(f.replace("\\:", ":")); } catch { return false; } }) ?? null;
  for (const vf of [...(fontFile ? [draw(fontFile)] : []), draw(null), null]) {
    try {
      const p = Bun.spawn([FFMPEG, ...common(vf)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      if ((await p.exited) === 0) {
        const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
        if (bytes.length >= PKT) { slateCache.set(key, bytes); return bytes; }
      }
    } catch { /* try the fallback form */ }
  }
  // Last resort: no ffmpeg at all — a null-packet stream keeps bytes flowing so
  // the compositor's probe doesn't sit on a silent input (it will show black).
  const nul = new Uint8Array(PKT).fill(0xff);
  nul[0] = SYNC; nul[1] = 0x1f; nul[2] = 0xff; nul[3] = 0x10;
  const filler = new Uint8Array(PKT * 100);
  for (let i = 0; i < 100; i++) filler.set(nul, i * PKT);
  slateCache.set(key, filler);
  return filler;
}

type Consumer = { slot: number; write: (c: Uint8Array) => void; close: () => void };

class Tile {
  readonly proc: SupervisedProc;
  readonly consumers = new Set<Consumer>();
  private aligner = new PacketAligner();
  slate: Uint8Array | null = null;
  retiredAt = 0; // 0 = composed; else when it left the layout (linger start)

  constructor(readonly channelId: number, public name: string) {
    this.proc = new SupervisedProc({
      name: `tile:${channelId}`,
      cmd: () => this.args(),
      wantRunning: () => this.retiredAt === 0 || Date.now() - this.retiredAt < LINGER_MS,
      onStdout: (chunk) => {
        const whole = this.aligner.push(chunk);
        if (whole) for (const c of this.consumers) c.write(whole);
      },
      onDown: () => this.aligner.reset(),
      watchdogMs: 10_000, // upstream wedged (no EOF, no bytes) → re-dial
      backoffCapMs: 10_000,
    });
  }

  private args(): string[] {
    const key = encodeURIComponent(String(cachedSetting("access.streamKey") || ""));
    return [
      FFMPEG, "-hide_banner", "-loglevel", "error",
      "-fflags", "nobuffer+genpts", "-flags", "low_delay",
      "-rw_timeout", "15000000", "-analyzeduration", "1000000", "-probesize", "1000000",
      "-i", `http://127.0.0.1:${PORT}/mosaicfeed/${this.channelId}?key=${key}`,
      // Silence bed: [1:a] guarantees an audio track when the channel has none,
      // so the compositor's per-input [i:a] selector never fails the graph.
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-map", "0:v:0", "-map", "0:a:0?", "-map", "1:a:0", "-shortest",
      "-vf", `scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,fps=${TILE_FPS}`,
      "-af", "aresample=async=1:first_pts=0",
      ...tileEncoderArgs(), "-g", String(TILE_FPS * 2),
      "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "96k",
      "-muxdelay", "0", "-muxpreload", "0", "-flush_packets", "1",
      "-f", "mpegts", "pipe:1",
    ];
  }

  writeSlate(): void {
    if (!this.slate || this.proc.producing()) return;
    for (const c of this.consumers) c.write(this.slate);
  }

  stop(): void {
    this.proc.stop();
    for (const c of this.consumers) { try { c.close(); } catch { /* noop */ } }
    this.consumers.clear();
  }
}

export class TileFeedManager {
  private tiles = new Map<number, Tile>(); // by channelId
  private slots: number[] = []; // slot index → channelId (the drawn order)
  private bySlot = new Map<number, Consumer>(); // one consumer per slot
  private pump: ReturnType<typeof setInterval> | null = null;
  private janitor: ReturnType<typeof setInterval> | null = null;

  /** Sync the tile set to the drawn layout: start normalizers for new
   * channels, pre-render slates, retire (with linger) tiles that left.
   * Called inside the compositor's serialized restart, BEFORE its spawn —
   * every /tile/<slot> the new encode dials is ready to emit immediately. */
  async ensureTiles(drawn: { channelId: number; name: string }[]): Promise<void> {
    this.slots = drawn.map((d) => d.channelId);
    const want = new Set(this.slots);
    for (const [id, tile] of this.tiles) {
      if (!want.has(id)) { if (!tile.retiredAt) tile.retiredAt = Date.now(); }
    }
    await Promise.all(drawn.map(async ({ channelId, name }) => {
      let tile = this.tiles.get(channelId);
      if (!tile) { tile = new Tile(channelId, name); this.tiles.set(channelId, tile); }
      tile.name = name;
      tile.retiredAt = 0;
      tile.slate = await slateFor(name).catch(() => null);
      if (!tile.proc.running() && !tile.proc.pending()) tile.proc.restart();
    }));
    this.ensureTimers();
  }

  /** The compositor's input for a slot — whole-packet TS that always flows
   * (live intermediate when the normalizer produces, slate otherwise). A new
   * open replaces the slot's previous consumer (encode restarts re-dial). */
  openSlot(slot: number): ReadableStream<Uint8Array> | null {
    const channelId = this.slots[slot];
    const tile = channelId != null ? this.tiles.get(channelId) : undefined;
    if (!tile) return null;
    const prev = this.bySlot.get(slot);
    if (prev) { this.detach(prev); try { prev.close(); } catch { /* noop */ } }
    const self = this;
    let consumer: Consumer | null = null;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        consumer = {
          slot,
          write: (c) => {
            if (controller.desiredSize !== null && controller.desiredSize <= 0) return; // whole packets — a drop degrades, never corrupts alignment
            try { controller.enqueue(c); } catch { /* closing */ }
          },
          close: () => { try { controller.close(); } catch { /* closed */ } },
        };
        tile.consumers.add(consumer);
        self.bySlot.set(slot, consumer);
        tile.writeSlate(); // first bytes NOW — the encode's probe never waits
      },
      cancel() { if (consumer) self.detach(consumer); },
    }, new ByteLengthQueuingStrategy({ highWaterMark: 4 * 1024 * 1024 }));
  }

  private detach(consumer: Consumer): void {
    for (const tile of this.tiles.values()) tile.consumers.delete(consumer);
    if (this.bySlot.get(consumer.slot) === consumer) this.bySlot.delete(consumer.slot);
  }

  /** Per-tile health for /api/mosaic/status and the app's cast bar. */
  status(): { channelId: number; name: string; live: boolean; spawns: number; err: string }[] {
    return this.slots.map((id) => {
      const t = this.tiles.get(id);
      return t
        ? { channelId: id, name: t.name, live: t.proc.producing(), spawns: t.proc.spawnCount, err: t.proc.lastErr().slice(-200) }
        : { channelId: id, name: "#" + id, live: false, spawns: 0, err: "" };
    });
  }

  /** Compose cleared / compositor reaped — retire everything (linger applies,
   * so a quick re-compose reattaches to still-warm normalizers). */
  releaseAll(): void {
    for (const tile of this.tiles.values()) if (!tile.retiredAt) tile.retiredAt = Date.now();
    this.slots = [];
  }

  private ensureTimers(): void {
    // Slate pump: just under the slate duration so the feed never runs dry.
    if (!this.pump) this.pump = setInterval(() => { for (const t of this.tiles.values()) t.writeSlate(); }, SLATE_SECONDS * 1000 - 100);
    if (!this.janitor) this.janitor = setInterval(() => {
      for (const [id, tile] of this.tiles) {
        if (tile.retiredAt && Date.now() - tile.retiredAt > LINGER_MS) { tile.stop(); this.tiles.delete(id); }
      }
      if (this.tiles.size === 0) {
        if (this.pump) { clearInterval(this.pump); this.pump = null; }
        if (this.janitor) { clearInterval(this.janitor); this.janitor = null; }
      }
    }, 5_000);
  }
}

export const tileFeeds = new TileFeedManager();
