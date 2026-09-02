const PACKET = 188; // MPEG-TS packet size

export interface SlateFeederOpts {
  data: Uint8Array;       // the composed reel (raw TS bytes)
  totalSec: number;       // reel duration — sets the real-time pace
  // Loop point as a 188-aligned byte offset (NOT a time fraction — VBR made a
  // time-fraction-as-byte-fraction wrong in practice, non-IDR-aligned and off
  // by a variable amount). builder.ts scans the composed reel for the first
  // keyframe at/after the countdown's own aligned time offset and records
  // that byte position; see builder.ts's findTailStartByte.
  tailStartByte: number;
  /** Begin playback at this 188-aligned byte offset (default 0). Lets each tune
   *  start at a different meme so the reel doesn't feel identical every time;
   *  clamped into [0, tailStart) so a random start always lands in the countdown
   *  body, never inside the loop tail. */
  startByte?: number;
  /** Hard lifetime cap. The hold bound in the muxer only fires once live bytes
   *  ARRIVE; a source that never delivers a single byte would otherwise loop the
   *  tail forever, which reads as "frozen on the last meme" rather than as a
   *  failure. Past this, stop and hand control back via onExpire. */
  maxMs?: number;
  onExpire?: () => void;
  tickMs?: number;        // pacing tick interval; default 100ms
  push: (c: Uint8Array) => void; // sink for each paced, packet-aligned chunk
}

/**
 * Paces a pre-composed TS reel out at real time, packet-aligned, looping from
 * a tail fraction once the end is reached. Used to feed a splice-out-ready
 * buffer while the live upstream warms up.
 *
 * Position is derived from ELAPSED REAL TIME each tick (not accumulated
 * per-tick increments) so timer jitter can never accumulate drift — a slow or
 * delayed tick just catches up to where real time says we should be.
 */
export class SlateFeeder {
  private readonly data: Uint8Array;
  private readonly tailStart: number; // byte offset, 188-aligned
  private readonly tickMs: number;
  private readonly push: (c: Uint8Array) => void;
  private readonly bytesPerSec: number;
  private readonly maxMs: number;
  private readonly onExpire: (() => void) | null;
  private startedAt = 0; // NOT reset on tail loop — the cap is wall-clock from start

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly startAt: number;
  private pos = 0;
  private segmentStart = 0; // byte offset the current pacing epoch started counting from
  private epoch = 0; // Date.now() when segmentStart began playing

  constructor(o: SlateFeederOpts) {
    this.data = o.data;
    // Already 188-aligned by construction (builder.ts's scan snaps to packet
    // boundaries) — align down and clamp into bounds defensively anyway
    // rather than trust a manifest that could in principle be stale/corrupt.
    const dataEnd = o.data.length - (o.data.length % PACKET);
    this.tailStart = Math.min(dataEnd, Math.max(0, Math.floor(o.tailStartByte / PACKET) * PACKET));
    const rawStart = Math.floor((o.startByte ?? 0) / PACKET) * PACKET;
    this.startAt = Math.min(Math.max(0, rawStart), Math.max(0, this.tailStart - PACKET));
    this.tickMs = o.tickMs ?? 100;
    this.push = o.push;
    this.bytesPerSec = o.totalSec > 0 ? o.data.length / o.totalSec : o.data.length;
    this.maxMs = o.maxMs ?? 0; // 0 = uncapped (previous behaviour)
    this.onExpire = o.onExpire ?? null;
  }

  start(): void {
    if (this.timer !== null) return; // already running — a second call must not leak a second interval
    this.pos = this.startAt;
    this.segmentStart = this.startAt;
    this.epoch = Date.now();
    this.startedAt = this.epoch;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    // Wall-clock cap first: a source that never sends a byte leaves the muxer's
    // hold bound unreachable (it only runs on live arrival), so this is the only
    // thing standing between a dead channel and an endlessly looping reel.
    if (this.maxMs > 0 && Date.now() - this.startedAt >= this.maxMs) {
      this.stop();
      this.onExpire?.();
      return;
    }
    const elapsedSec = (Date.now() - this.epoch) / 1000;
    let target = this.segmentStart + Math.floor((this.bytesPerSec * elapsedSec) / PACKET) * PACKET;
    const dataEnd = this.data.length - (this.data.length % PACKET); // defensive: last full packet
    if (target > dataEnd) target = dataEnd;

    if (target > this.pos) {
      const chunk = this.data.slice(this.pos, target);
      if (chunk.length > 0) this.push(chunk);
      this.pos = target;
    }

    if (this.pos >= dataEnd) {
      // Reached the end — loop from the tail so playback replays at real time.
      this.segmentStart = this.tailStart;
      this.pos = this.tailStart;
      this.epoch = Date.now();
    }
  }
}
