import { describe, expect, test } from "bun:test";
import { OverlapGate, readPcr } from "../src/proxy/overlap.ts";

/**
 * Reconnecting to a dropped source keeps viewers attached, but the provider
 * answers a new connection with ~11-14s of recent history so a player can fill
 * its buffer. Relayed to someone already watching, that is a backwards jump —
 * observed as "the stream goes back like 39 seconds" once several reconnects
 * clustered. This gate removes the repeated part.
 */

const PKT = 188;

/** One TS packet, optionally carrying a PCR at `seconds`. PCR packets default
 *  to payload_unit_start, the way a real mux stamps the PCR on the video
 *  PES-start packet — so the plain gate tests resume on the catch-up packet. */
function packet(
  seconds?: number,
  opts: { pusi?: boolean; rai?: boolean; pid?: number } = {},
): Uint8Array {
  const pid = opts.pid ?? 0x100;
  const pusi = opts.pusi ?? seconds !== undefined;
  const p = new Uint8Array(PKT).fill(0x11);
  p[0] = 0x47;
  p[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  if (seconds === undefined && !opts.rai) { p[3] = 0x10; return p; } // payload only, no AF
  p[3] = 0x30;   // adaptation field + payload
  p[4] = 7;      // AF length
  p[5] = (opts.rai ? 0x40 : 0) | (seconds !== undefined ? 0x10 : 0); // RAI / PCR_flag
  if (seconds === undefined) return p;
  const base = Math.round(seconds * 90_000);
  p[6] = Math.floor(base / 2 ** 25) & 0xff;
  p[7] = Math.floor(base / 2 ** 17) & 0xff;
  p[8] = Math.floor(base / 2 ** 9) & 0xff;
  p[9] = Math.floor(base / 2) & 0xff;
  p[10] = ((base & 1) << 7) & 0xff;
  return p;
}

/** A run of packets, one PCR per second of content. */
function stream(fromS: number, toS: number, step = 1): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let s = fromS; s < toS; s += step) { parts.push(packet(s)); parts.push(packet()); }
  return cat(...parts);
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Minimal PAT → PMT → H.264 video PID, mirroring tspreroll.test.ts, so the
 *  gate can learn which PID carries video. PMT pid deliberately differs from
 *  the 0x100 the data packets use. */
const PMT_PID = 0x30;
const VIDEO_PID = 0x101;

function patPkt(): Uint8Array {
  const p = new Uint8Array(PKT).fill(0xff);
  p[0] = 0x47; p[1] = 0x40; p[2] = 0x00; p[3] = 0x10;
  p[4] = 0x00; // pointer_field → section at 5
  p.fill(0x00, 5, 17);
  p[13] = 0x00; p[14] = 0x01; // program 1 → PMT pid
  p[15] = 0xe0 | ((PMT_PID >> 8) & 0x1f); p[16] = PMT_PID & 0xff;
  return p;
}

function pmtPkt(): Uint8Array {
  const p = new Uint8Array(PKT).fill(0xff);
  p[0] = 0x47; p[1] = 0x40 | ((PMT_PID >> 8) & 0x1f); p[2] = PMT_PID & 0xff; p[3] = 0x10;
  p[4] = 0x00; // pointer_field → section at 5
  p.fill(0x00, 5, 17);
  p[6] = 0x00; p[7] = 23; // section_length: covers one ES entry
  p[17] = 0x1b; // stream_type H.264
  p[18] = 0xe0 | ((VIDEO_PID >> 8) & 0x1f); p[19] = VIDEO_PID & 0xff;
  p[20] = 0x00; p[21] = 0x00; // ES info length
  return p;
}

describe("readPcr", () => {
  test("reads a PCR back out of a packet that carries one", () => {
    expect(readPcr(packet(42))).toBe(42 * 90_000);
  });
  test("returns null for a packet with no adaptation field", () => {
    expect(readPcr(packet())).toBeNull();
  });
  test("returns null for a non-sync byte", () => {
    const p = packet(5); p[0] = 0x00;
    expect(readPcr(p)).toBeNull();
  });
});

describe("OverlapGate", () => {
  test("passes everything through when not reconnecting", () => {
    const g = new OverlapGate();
    const s = stream(0, 10);
    expect(g.filter(s).length).toBe(s.length);
    expect(g.positionSeconds).toBeCloseTo(9, 5);
  });

  test("drops the replayed history a reconnect delivers, keeping what is new", () => {
    const g = new OverlapGate();
    g.filter(stream(0, 30));           // watched up to t=29
    g.arm();                            // source dropped; reconnecting
    // Provider replays from t=18 (12s of history) and continues past where we were.
    const out = g.filter(stream(18, 40));
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(stream(18, 40).length); // the overlap is gone
    // The first PCR delivered must be NEWER than where we had got to.
    expect(readPcr(out, 0)).toBeGreaterThan(29 * 90_000);
    expect(g.isArmed).toBe(false);      // and the gate stands down afterwards
  });

  test("emits nothing while the replay is still behind us", () => {
    const g = new OverlapGate();
    g.filter(stream(0, 30));
    g.arm();
    expect(g.filter(stream(10, 20)).length).toBe(0); // entirely old
    expect(g.isArmed).toBe(true);                    // still waiting to catch up
    const out = g.filter(stream(20, 35));            // now it overtakes
    expect(out.length).toBeGreaterThan(0);
    expect(g.isArmed).toBe(false);
  });

  test("a reconnect with no overlap at all passes straight through", () => {
    const g = new OverlapGate();
    g.filter(stream(0, 10));
    g.arm();
    const fresh = stream(10, 20);
    expect(g.filter(fresh).length).toBe(fresh.length);
  });

  test("never arms before any PCR is known — the first connection must not be eaten", () => {
    const g = new OverlapGate();
    g.arm();
    expect(g.isArmed).toBe(false);
    const s = stream(0, 5);
    expect(g.filter(s).length).toBe(s.length);
  });

  test("reset lets an unrelated source through — a different clock is not a replay", () => {
    const g = new OverlapGate();
    g.filter(stream(1000, 1010));
    g.reset();                       // real failover to another source
    const other = stream(0, 10);     // its clock starts far in the "past"
    expect(g.filter(other).length).toBe(other.length);
  });

  test("a wildly backwards clock is accepted, not discarded forever", () => {
    // A provider resetting its clock (or a 33-bit wrap) must not wedge the gate
    // into dropping the stream indefinitely.
    const g = new OverlapGate();
    g.filter(stream(5000, 5010));
    g.arm();
    const out = g.filter(stream(0, 10)); // ~5000s backwards — not a replay
    expect(out.length).toBeGreaterThan(0);
  });

  test("survives chunk boundaries that split packets", () => {
    const g = new OverlapGate();
    g.filter(stream(0, 30));
    g.arm();
    const s = stream(18, 40);
    // Feed it in awkward slices that cut packets in half.
    let got = 0;
    for (let i = 0; i < s.length; i += 277) got += g.filter(s.subarray(i, Math.min(i + 277, s.length))).length;
    expect(got).toBeGreaterThan(0);
    expect(g.isArmed).toBe(false);
  });

  test("resumes at a video PES start, not on the packet whose PCR caught up", () => {
    // Resuming on the first ahead-PCR packet handed ffmpeg the middle of a PES
    // packet — "[mpegts] Packet corrupt (stream = 0, ...)" at every reconnect —
    // because a PCR-bearing packet is not a PES boundary.
    const g = new OverlapGate();
    g.filter(cat(patPkt(), pmtPkt(), stream(0, 30))); // learns video PID + clock
    g.arm();
    const out = g.filter(cat(
      stream(18, 31),                                       // replay; PCR catches up at t=30 on a non-video pid
      packet(undefined, { pid: VIDEO_PID }),                // mid-PES continuation — not a legal resume point
      packet(undefined, { pid: VIDEO_PID }),
      packet(undefined, { pid: VIDEO_PID, pusi: true }),    // the PES start
      stream(31, 34),
    ));
    expect(out[0]).toBe(0x47);
    expect(out[1] & 0x40).toBe(0x40);                         // payload_unit_start set
    expect(((out[1] & 0x1f) << 8) | out[2]).toBe(VIDEO_PID);  // and it is the video PID
    expect(out.length).toBe(7 * PKT);                         // PES start + what follows, nothing earlier
    expect(g.isArmed).toBe(false);
  });

  test("gives up the PES-start hunt after 2MB rather than going black forever", () => {
    // If the video PID is mis-identified (or the stream carries no conventional
    // PES starts) a restart point never matches; without a bound the gate would
    // discard the channel indefinitely after a reconnect.
    const g = new OverlapGate();
    g.filter(stream(0, 30));
    g.arm();
    let got = g.filter(packet(31, { pusi: false })).length; // clock caught up, no PUSI anywhere
    const filler = packet(undefined, { pusi: false });
    const chunk = cat(...Array.from({ length: 256 }, () => filler));
    let fed = 0;
    while (got === 0 && fed < 4 * 1024 * 1024) { got += g.filter(chunk).length; fed += chunk.length; }
    expect(got).toBeGreaterThan(0);
    expect(fed).toBeGreaterThan(1_900_000); // it held out for the full bound first
    expect(g.isArmed).toBe(false);
  });

  test("a PES start split across chunk boundaries still resumes cleanly", () => {
    // The restart packet can arrive cut in half by the network; resuming on the
    // fragment would emit a torn packet — the very corruption being removed.
    const g = new OverlapGate();
    g.filter(cat(patPkt(), pmtPkt(), stream(0, 30)));
    g.arm();
    const s = cat(
      stream(18, 31),
      packet(undefined, { pid: VIDEO_PID }),
      packet(undefined, { pid: VIDEO_PID, pusi: true, rai: true }), // keyframe PES start
      stream(31, 36),
    );
    let out = new Uint8Array(0);
    for (let i = 0; i < s.length; i += 277) out = cat(out, g.filter(s.subarray(i, Math.min(i + 277, s.length))));
    expect(out.length % PKT).toBe(0);      // nothing torn
    expect(out[0]).toBe(0x47);
    expect(out[1] & 0x40).toBe(0x40);
    expect(((out[1] & 0x1f) << 8) | out[2]).toBe(VIDEO_PID);
  });

  test("without a PMT, a PES start on the PCR's own PID is the resume point", () => {
    // Some sources drop before any PMT has been relayed; the PCR rides on the
    // video PID in practice, so its PID stands in rather than resuming mid-PES.
    const g = new OverlapGate();
    g.filter(stream(0, 30)); // no PAT/PMT ever seen
    g.arm();
    const out = g.filter(cat(
      packet(30.5, { pusi: false }), // ahead, but mid-PES on the PCR pid
      packet(),
      packet(31),                    // PUSI on the PCR pid
      stream(32, 34),
    ));
    expect(readPcr(out, 0)).toBe(31 * 90_000);
    expect(out[1] & 0x40).toBe(0x40);
  });
});
