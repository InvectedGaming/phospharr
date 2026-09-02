import { describe, expect, test } from "bun:test";
import { SlateFeeder } from "../src/slate/feeder.ts";

const reel = (packets: number) => {
  const d = new Uint8Array(packets * 188);
  for (let i = 0; i < packets; i++) d[i * 188] = 0x47;
  return d;
};

describe("SlateFeeder", () => {
  test("pushes packet-aligned chunks at a real-time pace", async () => {
    const chunks: Uint8Array[] = [];
    // 100 packets over 1s, ticking every 50ms → ~5 packets per tick.
    const f = new SlateFeeder({ data: reel(100), totalSec: 1, tailStartByte: 50 * 188, tickMs: 50, push: (c) => chunks.push(c) });
    f.start();
    await new Promise((r) => setTimeout(r, 320));
    f.stop();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total % 188).toBe(0);
    expect(total).toBeGreaterThan(188 * 15); // ~30 expected; generous lower bound
    expect(total).toBeLessThan(188 * 60);    // and it must NOT dump the whole reel
    for (const c of chunks) expect(c[0]).toBe(0x47);
  });

  test("loops from the tail byte offset instead of stopping", async () => {
    const chunks: Uint8Array[] = [];
    const f = new SlateFeeder({ data: reel(10), totalSec: 0.1, tailStartByte: 5 * 188, tickMs: 20, push: (c) => chunks.push(c) });
    f.start();
    await new Promise((r) => setTimeout(r, 300));
    f.stop();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeGreaterThan(10 * 188); // wrapped at least once
  });

  test("stop() stops; push after stop never happens", async () => {
    let n = 0;
    const f = new SlateFeeder({ data: reel(100), totalSec: 1, tailStartByte: 50 * 188, tickMs: 20, push: () => n++ });
    f.start(); await new Promise((r) => setTimeout(r, 60)); f.stop();
    const at = n;
    await new Promise((r) => setTimeout(r, 80));
    expect(n).toBe(at);
  });

  test("start() twice does not leak a second interval (single-rate pacing, not double)", async () => {
    const chunks: Uint8Array[] = [];
    // Same shape as the real-time-pace test above: 100 packets over 1s,
    // ticking every 50ms. If a second start() leaked a second interval, the
    // push volume would roughly double and blow through the upper bound.
    const f = new SlateFeeder({ data: reel(100), totalSec: 1, tailStartByte: 50 * 188, tickMs: 50, push: (c) => chunks.push(c) });
    f.start();
    f.start(); // second call — must be a no-op while already running
    await new Promise((r) => setTimeout(r, 320));
    f.stop();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total % 188).toBe(0);
    expect(total).toBeGreaterThan(188 * 15); // ~30 expected; generous lower bound
    expect(total).toBeLessThan(188 * 60);    // double-rate would blow past this
  });
});

describe("SlateFeeder startByte", () => {
  test("begins pushing from the requested 188-aligned offset", async () => {
    // 100 packets; each packet's 2nd byte encodes its index so we can tell
    // WHERE the feed started from.
    const d = new Uint8Array(100 * 188);
    for (let i = 0; i < 100; i++) { d[i * 188] = 0x47; d[i * 188 + 1] = i; }
    const chunks: Uint8Array[] = [];
    const f = new SlateFeeder({
      data: d, totalSec: 1, tailStartByte: 50 * 188, tickMs: 20,
      startByte: 30 * 188, push: (c) => chunks.push(c),
    });
    f.start();
    await new Promise((r) => setTimeout(r, 120));
    f.stop();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0][0]).toBe(0x47);
    expect(chunks[0][1]).toBe(30); // first pushed packet IS packet 30
  });

  test("a misaligned or out-of-range startByte is clamped, never throws", async () => {
    const d = new Uint8Array(10 * 188);
    for (let i = 0; i < 10; i++) d[i * 188] = 0x47;
    for (const sb of [37, 10 * 188 + 500, -40]) {
      const chunks: Uint8Array[] = [];
      const f = new SlateFeeder({ data: d, totalSec: 0.1, tailStartByte: 5 * 188, tickMs: 20, startByte: sb, push: (c) => chunks.push(c) });
      f.start();
      await new Promise((r) => setTimeout(r, 60));
      f.stop();
      for (const c of chunks) { expect(c.length % 188).toBe(0); expect(c[0]).toBe(0x47); }
    }
  });
});

describe("SlateFeeder lifetime cap", () => {
  test("stops itself and fires onExpire when live never arrives", async () => {
    const d = new Uint8Array(20 * 188);
    for (let i = 0; i < 20; i++) d[i * 188] = 0x47;
    let expired = 0;
    let pushes = 0;
    const f = new SlateFeeder({
      data: d, totalSec: 0.2, tailStartByte: 10 * 188, tickMs: 20,
      maxMs: 150, onExpire: () => { expired++; },
      push: () => { pushes++; },
    });
    f.start();
    await new Promise((r) => setTimeout(r, 400));
    const atStop = pushes;
    await new Promise((r) => setTimeout(r, 120));
    expect(expired).toBe(1);          // fired exactly once
    expect(pushes).toBe(atStop);      // and genuinely stopped pushing
  });

  test("no maxMs means it loops indefinitely, as before", async () => {
    const d = new Uint8Array(20 * 188);
    for (let i = 0; i < 20; i++) d[i * 188] = 0x47;
    let expired = 0, pushes = 0;
    const f = new SlateFeeder({
      data: d, totalSec: 0.2, tailStartByte: 10 * 188, tickMs: 20,
      onExpire: () => { expired++; }, push: () => { pushes++; },
    });
    f.start();
    await new Promise((r) => setTimeout(r, 250));
    f.stop();
    expect(expired).toBe(0);
    expect(pushes).toBeGreaterThan(3);
  });
});
