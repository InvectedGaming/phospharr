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

/** One TS packet, optionally carrying a PCR at `seconds`. */
function packet(seconds?: number, payload = 0x11): Uint8Array {
  const p = new Uint8Array(PKT).fill(payload);
  p[0] = 0x47; p[1] = 0x01; p[2] = 0x00;
  if (seconds === undefined) { p[3] = 0x10; return p; } // payload only, no AF
  p[3] = 0x30;   // adaptation field + payload
  p[4] = 7;      // AF length
  p[5] = 0x10;   // PCR_flag
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
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
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
});
