import { describe, expect, test } from "bun:test";
import { JitterBuffer } from "../src/proxy/jitter.ts";

/**
 * This buffer's entire job is behaviour over TIME, so these tests drive a fake
 * clock and call tick() by hand — a real clock would make every assertion a
 * race, and the failure being prevented (a viewer's picture cutting out) is
 * itself a timing failure.
 *
 * The source shape reproduced here is the one measured on the live provider:
 * a burst carrying several seconds of stream, delivered over a fraction of a
 * second, then silence until the next burst.
 */

const RATE = 1_000_000; // bytes/sec — a ~8 Mbps channel
const TICK = 100;
const BURST_MS = 200;   // wall time a burst occupies

function harness(targetMs: number) {
  let t = 0;
  const out: number[] = [];
  const jb = new JitterBuffer({
    targetMs, tickMs: TICK, now: () => t,
    onEmit: (c) => { out[out.length - 1] = (out[out.length - 1] ?? 0) + c.length; },
  });
  const advance = (ms: number) => {
    for (let i = 0; i < Math.round(ms / TICK); i++) { t += TICK; out.push(0); jb.tick(); }
  };
  return {
    jb, out, advance,
    /** One source cycle: `contentMs` of stream arrives in a burst, then silence
     *  fills out the rest of the cycle. Net input rate stays real-time. */
    cycle(contentMs: number) {
      const total = (RATE * contentMs) / 1000;
      const n = 8;
      for (let i = 0; i < n; i++) { t += BURST_MS / n; jb.push(new Uint8Array(total / n)); }
      advance(contentMs - BURST_MS);
    },
    at: () => t,
  };
}

describe("JitterBuffer — absorbing a bursty source", () => {
  test("holds back until the target depth is reached", () => {
    const h = harness(12_000);
    h.cycle(4000);
    expect(h.jb.isPrimed).toBe(false);
    expect(h.out.reduce((a, b) => a + b, 0)).toBe(0); // nothing emitted yet
  });

  test("emits during the silence that would otherwise starve a player", () => {
    const h = harness(4000);
    for (let i = 0; i < 6; i++) h.cycle(4000); // prime and reach steady state
    const start = h.out.length;
    h.cycle(4000);                              // one more burst + 3.8s of silence
    const during = h.out.slice(start);
    const silentTicks = during.filter((b) => b === 0).length;
    expect(during.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    // The source was silent for ~95% of this window; the viewer must not be.
    expect(silentTicks).toBeLessThan(during.length / 2);
  });

  test("output covers most ticks, where the input covered almost none", () => {
    const h = harness(4000);
    for (let i = 0; i < 12; i++) h.cycle(4000);
    const tail = h.out.slice(-160);
    const nonZero = tail.filter((b) => b > 0).length;
    // Input arrived in 2 ticks out of every 40 (200ms of each 4s cycle).
    expect(nonZero).toBeGreaterThan(tail.length * 0.7);
  });

  test("survives the worst gap measured on the live provider (10s)", () => {
    const h = harness(12_000);
    for (let i = 0; i < 8; i++) h.cycle(4000); // prime with 32s of normal cycles
    const start = h.out.length;
    h.advance(10_000);                          // the 10s outage seen on channel 4022
    const during = h.out.slice(start);
    const silent = during.filter((b) => b === 0).length;
    // A 12s cushion must cover a 10s hole almost entirely.
    expect(silent).toBeLessThan(during.length * 0.2);
  });

  test("does not drift unboundedly behind live", () => {
    const h = harness(4000);
    for (let i = 0; i < 30; i++) h.cycle(4000);
    expect(h.jb.depth).toBeLessThanOrEqual(h.jb.inputRate * 8.5); // ≤ ~8s held
  });

  test("conserves every byte — a jitter buffer must never drop stream", () => {
    let t = 0, pushed = 0, emitted = 0;
    const jb = new JitterBuffer({ targetMs: 2000, tickMs: TICK, now: () => t, onEmit: (c) => { emitted += c.length; } });
    for (let i = 0; i < 12; i++) {
      for (let k = 0; k < 8; k++) { t += 25; jb.push(new Uint8Array(25_000)); pushed += 25_000; }
      for (let k = 0; k < 18; k++) { t += TICK; jb.tick(); }
    }
    jb.flush();
    expect(emitted).toBe(pushed);
  });
});

describe("JitterBuffer — lifecycle", () => {
  test("reset clears the backlog but keeps the learned rate for failover", () => {
    const h = harness(4000);
    for (let i = 0; i < 6; i++) h.cycle(4000);
    const rate = h.jb.inputRate;
    expect(rate).toBeGreaterThan(0);
    h.jb.reset();
    expect(h.jb.depth).toBe(0);
    expect(h.jb.isPrimed).toBe(false);
    // Re-learning from zero would re-prime against a nonsense target and stall
    // the very failover this is meant to smooth.
    expect(h.jb.inputRate).toBe(rate);
  });

  test("flush drains the tail rather than discarding it", () => {
    let emitted = 0, t = 0;
    const jb = new JitterBuffer({ targetMs: 10_000, tickMs: TICK, now: () => t, onEmit: (c) => { emitted += c.length; } });
    jb.push(new Uint8Array(5000)); t += 100;
    jb.push(new Uint8Array(5000));
    expect(emitted).toBe(0); // never primed
    jb.flush();
    expect(emitted).toBe(10_000); // the viewer sees the tail, not a cut
  });

  test("a transient underrun does not force a full re-prime", () => {
    // Requiring targetMs of refill after every momentary empty is worse than no
    // buffer at all — it would emit nothing for most of a bursty source's cycle.
    const h = harness(2000);
    for (let i = 0; i < 5; i++) h.cycle(2000);
    expect(h.jb.isPrimed).toBe(true);
    h.advance(6000); // long enough to drain completely
    expect(h.jb.depth).toBe(0);
    expect(h.jb.isPrimed).toBe(true); // still primed — the controller refills it
    const before = h.out.length;
    h.cycle(2000);
    expect(h.out.slice(before).reduce((a, b) => a + b, 0)).toBeGreaterThan(0); // resumes at once
  });

  test("start/stop are idempotent and leave no timer running", () => {
    const jb = new JitterBuffer({ targetMs: 1000, onEmit: () => {} });
    jb.start(); jb.start(); jb.stop(); jb.stop();
    expect(jb.depth).toBe(0);
  });
});
