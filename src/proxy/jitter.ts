/**
 * Jitter buffer: turns a bursty upstream into a steady feed.
 *
 * Measured on the live provider, a channel does not arrive smoothly — it goes
 * silent for ~4s, delivers a burst, and repeats, with occasional gaps up to 10s:
 *
 *   channel 4022: 11 gaps >1s in 60s, 10 of them >4s, worst 10.0s, 8.8 Mbps avg
 *   channel   88: 12 gaps >1s in 60s,  3 of them >4s, worst  5.4s, 3.9 Mbps avg
 *
 * The average bitrate is fine; the delivery is lumpy. Relayed as-is, a player's
 * live buffer runs dry during the silence and playback cuts out. Both VPN paths
 * (OpenVPN-TCP and WireGuard) measured identically, so this is the provider's
 * pacing, not the tunnel — nothing upstream of us is going to fix it.
 *
 * So: accept bursts, hold a target depth of stream, and emit at a steady rate.
 * Depth is held by a proportional controller rather than a fixed rate, because
 * the true bitrate is unknown and varies (VBR): emitting slightly faster when
 * the buffer is deeper than target and slower when it is shallower converges on
 * the real input rate without ever needing to measure it accurately.
 *
 * Cost is latency: a viewer waits `targetMs` before the first frame, and live is
 * that far behind. That is the trade being made deliberately — see stream.jitterMs.
 */

export interface JitterOpts {
  /** Depth of stream to hold before emitting, and to maintain thereafter. */
  targetMs: number;
  /** Emit paced output. Called with whole chunks, in order. */
  onEmit: (chunk: Uint8Array) => void;
  /** Drain tick. Smaller is smoother and costs more timer wakeups. */
  tickMs?: number;
  /** Injected for tests — the pacing is entirely time-driven, so a real clock
   *  would make every assertion a race. */
  now?: () => number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class JitterBuffer {
  private q: Uint8Array[] = [];
  private queued = 0;             // bytes currently held
  private primed = false;         // has the initial target depth been reached?
  private rate = 0;               // bytes/sec, mean input over the trailing window
  private windowBytes = 0;        // bytes since the last rate sample
  private hist: number[] = [];    // bytes per tick, trailing window
  private histIdx = 0;
  private histSum = 0;
  private readonly histLen: number;
  private firstPushAt = 0;        // start of the current fill, for priming
  private carry = 0;              // fractional bytes owed from the last tick
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickMs: number;
  private readonly now: () => number;

  constructor(private readonly o: JitterOpts) {
    this.tickMs = o.tickMs ?? 100;
    this.now = o.now ?? Date.now;
    // 30s of history, not 10s. A 10s window is mostly *outage* during the very
    // gaps this buffer exists to ride out: the measured rate collapses, the
    // controller below concludes it is over-buffered, and it dumps the cushion
    // exactly when the cushion is needed. Over 30s a 10s hole moves the estimate
    // by a third, which the controller absorbs.
    this.histLen = Math.max(1, Math.round(30_000 / this.tickMs));
  }

  /** Bytes currently buffered — the viewer-visible latency, in bytes. */
  get depth(): number { return this.queued; }
  get isPrimed(): boolean { return this.primed; }
  /** Observed input rate in bytes/sec (0 until the second chunk arrives). */
  get inputRate(): number { return this.rate; }

  /** Target depth in bytes at the current observed rate. */
  private get targetBytes(): number { return (this.rate * this.o.targetMs) / 1000; }

  push(chunk: Uint8Array): void {
    if (!chunk.length) return;
    if (!this.firstPushAt) this.firstPushAt = this.now();
    this.q.push(chunk);
    this.queued += chunk.length;
    this.windowBytes += chunk.length; // sampled on the tick, see below
  }

  /** Start pacing. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Drop everything and re-prime — used on failover, where the new source's
   *  bytes must not be spliced onto the old one's backlog. */
  reset(): void {
    this.q = [];
    this.queued = 0;
    this.primed = false;
    this.carry = 0;
    this.firstPushAt = 0;
    this.windowBytes = 0;
    // `rate` and its history are deliberately KEPT: the replacement source carries the same
    // channel at a similar bitrate, and re-learning from zero would re-prime
    // against a nonsense target and stall the failover it is meant to smooth.
  }

  /** Emit everything still held, immediately — for a source that has ended.
   *  Draining beats discarding: the viewer sees the tail instead of a cut. */
  flush(): void {
    for (const c of this.q) this.o.onEmit(c);
    this.q = [];
    this.queued = 0;
    this.carry = 0;
    this.primed = false;
    this.firstPushAt = 0;
  }

  /** One pacing step. Public for tests, which drive time deterministically. */
  tick(): void {
    // Rate = mean over a trailing wall-clock window, NOT an EWMA of per-tick
    // rates. Two traps this avoids, both of which produced a rate ~13× the truth
    // and made the buffer dump its whole cushion the instant it primed:
    //   · inter-arrival sampling only ever sees bursts (silence pushes nothing),
    //   · an EWMA seeded from the first tick starts at the burst rate (40MB/s on
    //     a 1MB/s channel) and decays far too slowly to recover.
    // A plain windowed mean counts the silent ticks and is exact immediately.
    const b = this.windowBytes;
    this.windowBytes = 0;
    if (this.hist.length < this.histLen) { this.hist.push(b); this.histSum += b; }
    else {
      this.histSum -= this.hist[this.histIdx] as number;
      this.hist[this.histIdx] = b;
      this.histSum += b;
      this.histIdx = (this.histIdx + 1) % this.histLen;
    }
    const secs = (this.hist.length * this.tickMs) / 1000;
    this.rate = secs > 0 ? this.histSum / secs : 0;

    // Prime on elapsed wall time, which needs no rate estimate: for a live
    // source, `targetMs` of wall clock IS `targetMs` of content.
    if (!this.primed && this.firstPushAt && this.now() - this.firstPushAt >= this.o.targetMs && this.q.length) {
      this.primed = true;
      // Bootstrap from what actually accumulated, so the first ticks pace
      // correctly even if the window has not seen a full cycle yet.
      if (this.rate <= 0) this.rate = (this.queued * 1000) / this.o.targetMs;
    }
    if (!this.primed || !this.q.length) return;

    // Proportional control toward the target depth. Faster when we are running
    // deep (drain the excess latency), slower when shallow (rebuild the cushion),
    // bounded so a bad rate estimate can never run away in either direction.
    const target = this.targetBytes;
    const error = target > 0 ? (this.queued - target) / target : 0;
    const factor = clamp(1 + error * 0.5, 0.5, 2);
    let budget = (this.rate * factor * this.tickMs) / 1000 + this.carry;

    // Never hold more than 2× target: a source that ran fast (catch-up after a
    // gap) would otherwise leave the viewer permanently further behind live.
    // Bled off ~10% per tick rather than in one go — dumping it instantly is an
    // abrupt burst of output, which is the thing this class exists to prevent.
    const excess = this.queued - target * 2;
    if (excess > 0) budget += excess * 0.1;

    if (budget < 1) { this.carry = budget; return; }

    // Split chunks to hit the budget instead of emitting whole ones. Whole-chunk
    // emission looked safer but paces terribly: one 500KB chunk against a 100KB
    // tick budget fires once and then goes silent for four ticks paying off the
    // debt — the output stays as lumpy as the input this exists to smooth.
    // Splitting is safe because this is a TS byte stream over TCP, not datagrams,
    // and TsPreroll downstream realigns arbitrary boundaries anyway.
    let sent = 0;
    while (this.q.length && sent < budget) {
      const c = this.q[0] as Uint8Array;
      const room = Math.floor(budget - sent);
      if (room < 1) break;
      if (c.length <= room) {
        this.q.shift();
        this.o.onEmit(c);
        sent += c.length;
        this.queued -= c.length;
      } else {
        this.q[0] = c.subarray(room);
        const head = c.subarray(0, room);
        this.o.onEmit(head);
        sent += room;
        this.queued -= room;
      }
    }
    this.carry = budget - sent;
    if (this.carry < -target) this.carry = -target; // bound the debt
    // Deliberately NOT un-primed when the queue momentarily empties. Requiring a
    // full re-prime after every transient underrun is worse than no buffer at
    // all: against a source that bursts every 4s, it spends most of its life
    // refilling and emits nothing. The controller above already rebuilds the
    // cushion on its own — while depth is under target it emits slower than the
    // input arrives, so the buffer grows back without a hard stall.
  }
}
