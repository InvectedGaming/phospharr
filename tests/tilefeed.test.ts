import { describe, expect, test } from "bun:test";
import { PacketAligner, slateFor } from "../src/proxy/tilefeed.ts";
import { FFMPEG } from "../src/proxy/transcode.ts";

/**
 * Tile feed building blocks: the whole-packet aligner every consumer write
 * goes through (splice safety), and the pre-rendered slate.
 */

const PKT = 188;

function pkt(fill: number): Uint8Array {
  const p = new Uint8Array(PKT).fill(fill);
  p[0] = 0x47;
  return p;
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe("PacketAligner", () => {
  test("emits only whole packets across arbitrary chunk boundaries", () => {
    const a = new PacketAligner();
    const stream = cat(pkt(1), pkt(2), pkt(3));
    const out: Uint8Array[] = [];
    // Feed in awkward slices: 100 bytes, then 200, then the rest.
    for (const [s, e] of [[0, 100], [100, 300], [300, stream.length]] as const) {
      const w = a.push(stream.subarray(s, e));
      if (w) out.push(w);
    }
    const all = cat(...out);
    expect(all.length).toBe(3 * PKT);
    for (let i = 0; i < all.length; i += PKT) expect(all[i]).toBe(0x47);
  });

  test("skips leading garbage to find alignment", () => {
    const a = new PacketAligner();
    const junk = new Uint8Array(37).fill(0xab);
    const w = a.push(cat(junk, pkt(1), pkt(2), pkt(3), pkt(4)));
    expect(w).not.toBeNull();
    expect(w!.length % PKT).toBe(0);
    expect(w!.length).toBeGreaterThanOrEqual(3 * PKT);
    for (let i = 0; i < w!.length; i += PKT) expect(w![i]).toBe(0x47);
  });

  test("re-syncs after sync loss mid-stream", () => {
    const a = new PacketAligner();
    const bad = new Uint8Array(PKT).fill(0x00); // no 0x47 at packet boundary
    const first = a.push(cat(pkt(1), pkt(2), bad, pkt(3), pkt(4), pkt(5)));
    const out: Uint8Array[] = first ? [first] : [];
    const more = a.push(cat(pkt(6), pkt(7), pkt(8)));
    if (more) out.push(more);
    const all = cat(...out);
    expect(all.length % PKT).toBe(0);
    for (let i = 0; i < all.length; i += PKT) expect(all[i]).toBe(0x47);
  });
});

// The slate needs a real ffmpeg; skip when the resolved binary isn't runnable
// (CI without ffmpeg). Locally and in the Docker image it runs.
const ffmpegOk = await (async () => {
  try { return (await Bun.spawn([FFMPEG, "-version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0; }
  catch { return false; }
})();

describe.skipIf(!ffmpegOk)("slateFor", () => {
  test("renders a valid aligned MPEG-TS card and caches it", async () => {
    const s1 = await slateFor("ESPN 2");
    expect(s1.length).toBeGreaterThan(PKT);
    expect(s1.length % PKT).toBe(0);
    expect(s1[0]).toBe(0x47);
    expect(s1[PKT]).toBe(0x47);
    const s2 = await slateFor("ESPN 2"); // cached — same object
    expect(s2).toBe(s1);
  }, 30_000);

  test("sanitizes hostile channel names", async () => {
    const s = await slateFor("evil':drawtext=%{pts}\\,x=0");
    expect(s.length % PKT).toBe(0);
    expect(s[0]).toBe(0x47);
  }, 30_000);
});
