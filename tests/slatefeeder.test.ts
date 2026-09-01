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
    const f = new SlateFeeder({ data: reel(100), totalSec: 1, tailStartFrac: 0.5, tickMs: 50, push: (c) => chunks.push(c) });
    f.start();
    await new Promise((r) => setTimeout(r, 320));
    f.stop();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total % 188).toBe(0);
    expect(total).toBeGreaterThan(188 * 15); // ~30 expected; generous lower bound
    expect(total).toBeLessThan(188 * 60);    // and it must NOT dump the whole reel
    for (const c of chunks) expect(c[0]).toBe(0x47);
  });

  test("loops from the tail fraction instead of stopping", async () => {
    const chunks: Uint8Array[] = [];
    const f = new SlateFeeder({ data: reel(10), totalSec: 0.1, tailStartFrac: 0.5, tickMs: 20, push: (c) => chunks.push(c) });
    f.start();
    await new Promise((r) => setTimeout(r, 300));
    f.stop();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeGreaterThan(10 * 188); // wrapped at least once
  });

  test("stop() stops; push after stop never happens", async () => {
    let n = 0;
    const f = new SlateFeeder({ data: reel(100), totalSec: 1, tailStartFrac: 0.5, tickMs: 20, push: () => n++ });
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
    const f = new SlateFeeder({ data: reel(100), totalSec: 1, tailStartFrac: 0.5, tickMs: 50, push: (c) => chunks.push(c) });
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
