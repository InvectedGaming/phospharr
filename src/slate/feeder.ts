const PACKET = 188; // MPEG-TS packet size

export interface SlateFeederOpts {
  data: Uint8Array;       // the composed reel (raw TS bytes)
  totalSec: number;       // reel duration — sets the real-time pace
  tailStartFrac: number;  // loop point as a fraction of data.length
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

  private timer: ReturnType<typeof setInterval> | null = null;
  private pos = 0;
  private segmentStart = 0; // byte offset the current pacing epoch started counting from
  private epoch = 0; // Date.now() when segmentStart began playing

  constructor(o: SlateFeederOpts) {
    this.data = o.data;
    this.tailStart = Math.floor((o.data.length * o.tailStartFrac) / PACKET) * PACKET;
    this.tickMs = o.tickMs ?? 100;
    this.push = o.push;
    this.bytesPerSec = o.totalSec > 0 ? o.data.length / o.totalSec : o.data.length;
  }

  start(): void {
    this.pos = 0;
    this.segmentStart = 0;
    this.epoch = Date.now();
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
