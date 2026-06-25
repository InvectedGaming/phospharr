import { muxer } from "./muxer.ts";
import { cachedSetting } from "../settings.ts";

/**
 * Live pause / rewind (timeshift).
 *
 * For each channel being timeshifted we keep a rolling in-memory ring of the
 * muxer's MPEG-TS output, tagged with arrival timestamps. A viewer reads the
 * channel through replay(): we hand them the buffered bytes from `behind`
 * seconds ago and then keep feeding new bytes as they arrive — one continuous
 * TS stream the player treats as live, only starting in the past.
 *
 * Because the *buffer* (not the muxer) owns the read cursor, a paused client
 * simply stops pulling and the cursor holds — so pausing no longer drops data
 * the way it does on the raw live mux. Resuming plays straight on from the
 * pause point, now behind live. Rewind/forward just re-open at a new `behind`.
 *
 * The buffer records one copy of the upstream (a single mux subscriber, so one
 * provider slot) and fans it to any number of replay readers. It's bounded by
 * BOTH the configured time window and a hard memory budget — whichever is
 * smaller wins, so a long window can't OOM the server. DVR-to-disk is a
 * separate feature; this is the live-edge convenience buffer.
 */

const HARD_MEMORY_CAP = 640 * 1024 * 1024; // ceiling per channel, regardless of window
const IDLE_TEARDOWN_MS = 30_000; // stop recording + free the buffer this long after the last reader leaves

type Chunk = { data: Uint8Array; t: number };
type Reader = { wake: (() => void) | null };

const TS_SYNC = 0x47;
const TS_PACKET = 188;
// First MPEG-TS packet boundary in a buffer: a 0x47 whose next-packet byte is
// also 0x47 (so we don't false-match a 0x47 inside a payload). Replays start
// mid-buffer, so we must hand mpegts.js a packet-aligned first byte or its
// demuxer starts on garbage. Returns -1 if the chunk has no usable boundary.
function tsBoundary(buf: Uint8Array): number {
  const n = buf.length;
  for (let i = 0; i < n; i++) {
    if (buf[i] !== TS_SYNC) continue;
    if (i + TS_PACKET >= n || buf[i + TS_PACKET] === TS_SYNC) return i;
  }
  return -1;
}

function windowMs(): number {
  return Math.max(1, Number(cachedSetting("timeshift.windowMinutes")) || 120) * 60_000;
}

class TimeshiftBuffer {
  readonly channelId: number;
  private chunks: Chunk[] = [];
  private evicted = 0; // count of chunks dropped off the front (for stable absolute indexing)
  private bytes = 0;
  private readers = new Set<Reader>();
  private recording = false;
  private ended = false;
  private abort = new AbortController();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onTeardown: () => void;

  constructor(channelId: number, onTeardown: () => void) {
    this.channelId = channelId;
    this.onTeardown = onTeardown;
  }

  /** Absolute index one past the newest chunk (the live edge). */
  private get head(): number {
    return this.evicted + this.chunks.length;
  }

  /** Seconds of buffer currently available behind the live edge. */
  windowAvailableMs(): number {
    if (!this.chunks.length) return 0;
    return Date.now() - this.chunks[0].t;
  }

  private append(data: Uint8Array) {
    this.chunks.push({ data, t: Date.now() });
    this.bytes += data.byteLength;
    // Evict by age first, then by the memory ceiling.
    const minT = Date.now() - windowMs();
    while (this.chunks.length > 1 && (this.chunks[0].t < minT || this.bytes > HARD_MEMORY_CAP)) {
      this.bytes -= this.chunks[0].data.byteLength;
      this.chunks.shift();
      this.evicted++;
    }
    for (const r of this.readers) if (r.wake) r.wake();
  }

  /** Begin recording the channel off the muxer (one shared upstream subscriber). */
  private async ensureRecording() {
    if (this.recording || this.ended) return;
    this.recording = true;
    const body = await muxer.open(this.channelId, this.abort.signal);
    if (!body) { this.recording = false; this.ended = true; for (const r of this.readers) if (r.wake) r.wake(); return; }
    const reader = body.getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) this.append(value);
        }
      } catch { /* upstream aborted / errored */ }
      this.recording = false;
      this.ended = true;
      for (const r of this.readers) if (r.wake) r.wake(); // unblock readers so they close
    })();
  }

  /** Absolute chunk index for a point `behindMs` behind the live edge. */
  private indexForBehind(behindMs: number): number {
    if (behindMs <= 0) return this.head; // live edge → only new chunks
    const target = Date.now() - behindMs;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].t >= target) return this.evicted + i;
    }
    return this.head;
  }

  /**
   * A continuous TS stream starting `behindMs` in the past and running on into
   * live. Used both for the initial tune (behind=0) and every rewind/seek.
   */
  replay(behindMs: number): ReadableStream<Uint8Array> {
    this.touch();
    void this.ensureRecording();
    let idx = this.indexForBehind(behindMs);
    let aligned = false; // have we handed out a packet-aligned first byte yet?
    const self = this;
    const reader: Reader = { wake: null };
    this.readers.add(reader);

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (true) {
          // A reader that fell behind eviction jumps forward to the oldest kept chunk.
          if (idx < self.evicted) idx = self.evicted;
          if (idx < self.head) {
            const chunk = self.chunks[idx - self.evicted];
            idx++;
            if (chunk) {
              if (aligned) { controller.enqueue(chunk.data); return; }
              // Trim leading bytes so playback begins on a TS packet boundary.
              const off = tsBoundary(chunk.data);
              if (off < 0) continue; // no boundary in this chunk — skip it
              aligned = true;
              controller.enqueue(off === 0 ? chunk.data : chunk.data.subarray(off));
              return;
            }
          }
          if (self.ended) { try { controller.close(); } catch { /* closed */ } return; }
          // Caught up to live — wait for the next recorded chunk.
          await new Promise<void>((resolve) => { reader.wake = resolve; });
          reader.wake = null;
        }
      },
      cancel() {
        self.readers.delete(reader);
        self.maybeIdle();
      },
    }, new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 * 1024 }));
  }

  private touch() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }
  private maybeIdle() {
    if (this.readers.size > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => this.teardown(), IDLE_TEARDOWN_MS);
  }
  private teardown() {
    if (this.readers.size > 0) return; // a reader re-attached during the idle grace
    this.ended = true;
    try { this.abort.abort(); } catch { /* noop */ }
    this.chunks = [];
    this.bytes = 0;
    this.onTeardown();
  }
}

class Timeshift {
  private buffers = new Map<number, TimeshiftBuffer>();

  private get(channelId: number): TimeshiftBuffer {
    let b = this.buffers.get(channelId);
    if (!b) {
      b = new TimeshiftBuffer(channelId, () => this.buffers.delete(channelId));
      this.buffers.set(channelId, b);
    }
    return b;
  }

  /** Open a replay stream for a channel, `behindSec` seconds behind live. */
  open(channelId: number, behindSec: number): ReadableStream<Uint8Array> {
    return this.get(channelId).replay(Math.max(0, behindSec) * 1000);
  }

  /** How much buffer is available behind live, in seconds (0 if not buffering). */
  windowSec(channelId: number): number {
    const b = this.buffers.get(channelId);
    return b ? Math.floor(b.windowAvailableMs() / 1000) : 0;
  }
}

export const timeshift = new Timeshift();
