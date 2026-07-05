import { describe, expect, test } from "bun:test";
import { persistentKeyframeFeed } from "../src/proxy/tsfeed.ts";

/**
 * persistentKeyframeFeed: a mosaic tile input must survive a CLEAN upstream EOF
 * (provider drop / mux failover) by re-dialing the channel — the tile used to
 * stay black until the next layout change. Synthetic 188-byte TS packets, same
 * scheme as tspreroll.test.ts.
 */
const PKT = 188;
const PMT_PID = 0x100;
const VIDEO_PID = 0x101;

function base(pid: number, opts: { pusi?: boolean; afc: number }): Uint8Array {
  const p = new Uint8Array(PKT).fill(0xff);
  p[0] = 0x47;
  p[1] = (opts.pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  p[3] = (opts.afc & 0x3) << 4;
  return p;
}

function patPkt(): Uint8Array {
  const p = base(0, { pusi: true, afc: 0x1 });
  p[4] = 0x00;
  p.fill(0x00, 5, 17);
  p[13] = 0x00; p[14] = 0x01;
  p[15] = 0xe0 | ((PMT_PID >> 8) & 0x1f); p[16] = PMT_PID & 0xff;
  return p;
}

function pmtPkt(): Uint8Array {
  const p = base(PMT_PID, { pusi: true, afc: 0x1 });
  p[4] = 0x00;
  p.fill(0x00, 5, 17);
  p[6] = 0x00; p[7] = 23;
  p[17] = 0x1b;
  p[18] = 0xe0 | ((VIDEO_PID >> 8) & 0x1f); p[19] = VIDEO_PID & 0xff;
  p[20] = 0x00; p[21] = 0x00;
  return p;
}

function keyframePkt(): Uint8Array {
  const p = base(VIDEO_PID, { pusi: true, afc: 0x3 });
  p[4] = 7;
  p[5] = 0x40; // random_access_indicator
  return p;
}

// A video packet carrying a marker byte so we can tell which dial it came from.
function videoPkt(marker: number): Uint8Array {
  const p = base(VIDEO_PID, { pusi: false, afc: 0x1 });
  p[10] = marker;
  return p;
}

function segment(marker: number): Uint8Array[] {
  return [patPkt(), pmtPkt(), keyframePkt(), videoPkt(marker)];
}

function streamOf(packets: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of packets) c.enqueue(p);
      c.close();
    },
  });
}

/** Drain a feed until it closes or `bytes` have arrived (whichever first). */
async function collect(feed: ReadableStream<Uint8Array>, bytes: number): Promise<Uint8Array> {
  const reader = feed.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (n < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(value); n += value.length; }
  }
  try { reader.cancel(); } catch { /* done */ }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function markers(data: Uint8Array): number[] {
  const seen: number[] = [];
  for (let i = 0; i + PKT <= data.length; i += PKT) {
    const pid = ((data[i + 1] & 0x1f) << 8) | data[i + 2];
    if (pid === VIDEO_PID && !(data[i + 1] & 0x40)) seen.push(data[i + 10]);
  }
  return seen;
}

describe("persistentKeyframeFeed", () => {
  test("re-dials on upstream EOF and keeps emitting", async () => {
    let dials = 0;
    const open = async () => {
      dials++;
      return dials <= 2 ? streamOf(segment(10 + dials)) : null; // two re-dials, then dry
    };
    const feed = persistentKeyframeFeed(open, streamOf(segment(1)), undefined);
    // 3 segments × 4 packets = 12 packets; ask for a bit more so we hit the dry close.
    const data = await collect(feed, 13 * PKT);
    const seen = markers(data);
    expect(seen).toContain(1);  // first dial
    expect(seen).toContain(11); // survived first EOF
    expect(seen).toContain(12); // survived second EOF
    expect(dials).toBeGreaterThanOrEqual(2);
  }, 15_000);

  test("each splice re-emits PAT+PMT before the keyframe", async () => {
    let dialed = false;
    const open = async () => {
      if (dialed) return null;
      dialed = true;
      return streamOf(segment(2));
    };
    const feed = persistentKeyframeFeed(open, streamOf(segment(1)), undefined);
    const data = await collect(feed, 8 * PKT);
    // Count PAT packets (pid 0) — one per dial, so the decoder can resync.
    let pats = 0;
    for (let i = 0; i + PKT <= data.length; i += PKT) {
      const pid = ((data[i + 1] & 0x1f) << 8) | data[i + 2];
      if (pid === 0) pats++;
    }
    expect(pats).toBe(2);
  }, 15_000);

  test("abort stops the feed without re-dialing forever", async () => {
    const ctrl = new AbortController();
    let dials = 0;
    const open = async () => { dials++; return streamOf(segment(9)); };
    const feed = persistentKeyframeFeed(open, streamOf(segment(1)), ctrl.signal);
    const reader = feed.getReader();
    await reader.read(); // pull something
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 700)); // past the 300ms redial pause
    const before = dials;
    await new Promise((r) => setTimeout(r, 700));
    expect(dials).toBe(before); // no further dialing after abort
    try { reader.cancel(); } catch { /* closed */ }
  }, 15_000);
});
