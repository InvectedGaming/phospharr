import { describe, expect, test } from "bun:test";
import { TsPreroll } from "../src/proxy/tspreroll.ts";

/**
 * Synthetic MPEG-TS: hand-built 188-byte packets exercising exactly what
 * TsPreroll parses — PAT (pid 0) → PMT pid, PMT → video PID, and the
 * random_access_indicator keyframe flag in the adaptation field.
 */
const PKT = 188;
const PMT_PID = 0x100;
const VIDEO_PID = 0x101;

function base(pid: number, opts: { pusi?: boolean; afc: number }): Uint8Array {
  const p = new Uint8Array(PKT).fill(0xff);
  p[0] = 0x47;
  p[1] = (opts.pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  p[3] = (opts.afc & 0x3) << 4; // afc: 0x1 payload-only, 0x3 AF+payload
  return p;
}

function patPkt(): Uint8Array {
  const p = base(0, { pusi: true, afc: 0x1 });
  p[4] = 0x00; // pointer_field → section at 5
  p.fill(0x00, 5, 17);
  // one program entry at offset 13: program 1 → PMT pid
  p[13] = 0x00; p[14] = 0x01;
  p[15] = 0xe0 | ((PMT_PID >> 8) & 0x1f); p[16] = PMT_PID & 0xff;
  return p;
}

function pmtPkt(): Uint8Array {
  const p = base(PMT_PID, { pusi: true, afc: 0x1 });
  p[4] = 0x00; // pointer_field → section at 5
  p.fill(0x00, 5, 17);
  p[6] = 0x00; p[7] = 23; // section_length: covers one ES entry
  // program_info_length = 0 (bytes 15,16 already zero) → ES loop at 17
  p[17] = 0x1b; // stream_type H.264
  p[18] = 0xe0 | ((VIDEO_PID >> 8) & 0x1f); p[19] = VIDEO_PID & 0xff;
  p[20] = 0x00; p[21] = 0x00; // ES info length
  return p;
}

function keyframePkt(): Uint8Array {
  const p = base(VIDEO_PID, { pusi: true, afc: 0x3 });
  p[4] = 7; // adaptation field length
  p[5] = 0x40; // random_access_indicator
  return p;
}

function videoPkt(): Uint8Array {
  return base(VIDEO_PID, { pusi: false, afc: 0x1 });
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const pidOf = (b: Uint8Array, pktIdx: number) => ((b[pktIdx * PKT + 1] & 0x1f) << 8) | b[pktIdx * PKT + 2];

describe("TsPreroll", () => {
  test("replays PAT + PMT + current GOP from the keyframe", () => {
    const ts = new TsPreroll();
    const region = ts.push(cat(patPkt(), pmtPkt(), keyframePkt(), videoPkt(), videoPkt()));
    expect(region?.length).toBe(5 * PKT); // aligned input passes straight through
    const pre = ts.preroll();
    expect(pre).not.toBeNull();
    expect(pre!.length).toBe(5 * PKT); // PAT + PMT + keyframe + 2 video
    expect(pidOf(pre!, 0)).toBe(0);
    expect(pidOf(pre!, 1)).toBe(PMT_PID);
    expect(pidOf(pre!, 2)).toBe(VIDEO_PID);
    expect(pre![2 * PKT + 5] & 0x40).toBe(0x40); // GOP starts ON the keyframe
  });

  test("a new keyframe resets the GOP buffer", () => {
    const ts = new TsPreroll();
    ts.push(cat(patPkt(), pmtPkt(), keyframePkt(), videoPkt(), videoPkt()));
    ts.push(cat(keyframePkt(), videoPkt()));
    expect(ts.preroll()!.length).toBe(4 * PKT); // PAT + PMT + fresh keyframe + 1
  });

  test("no preroll before the first keyframe", () => {
    const ts = new TsPreroll();
    ts.push(cat(patPkt(), pmtPkt(), videoPkt()));
    expect(ts.preroll()).toBeNull();
  });

  test("finds packet alignment past leading garbage", () => {
    const ts = new TsPreroll();
    const garbage = new Uint8Array(10).fill(0xaa);
    const region = ts.push(cat(garbage, patPkt(), pmtPkt(), keyframePkt(), videoPkt()));
    expect(region).not.toBeNull();
    expect(region!.length % PKT).toBe(0);
    expect(region![0]).toBe(0x47);
    expect(ts.preroll()).not.toBeNull();
  });

  test("packets split across pushes still come out whole", () => {
    const ts = new TsPreroll();
    const all = cat(patPkt(), pmtPkt(), keyframePkt(), videoPkt(), videoPkt());
    // feed in three ragged slices that split packets mid-way
    const slices = [all.subarray(0, 100), all.subarray(100, 411), all.subarray(411)];
    let total = 0;
    for (const s of slices) {
      const r = ts.push(s);
      if (r) total += r.length;
    }
    expect(total).toBe(5 * PKT);
    expect(ts.preroll()!.length).toBe(5 * PKT);
  });

  test("non-TS input falls back to raw passthrough after 64KB", () => {
    const ts = new TsPreroll();
    const junk = new Uint8Array(32 * 1024).fill(0xaa);
    expect(ts.push(junk)).toBeNull(); // still hunting for alignment
    const r = ts.push(new Uint8Array(40 * 1024).fill(0xaa)); // crosses 64KB
    expect(r).not.toBeNull();
    // and from now on it's a plain byte pump
    const chunk = new Uint8Array(500).fill(0xbb);
    expect(ts.push(chunk)).toBe(chunk);
    expect(ts.preroll()).toBeNull();
  });
});
