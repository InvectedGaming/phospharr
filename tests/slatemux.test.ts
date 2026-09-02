import { describe, expect, test, mock } from "bun:test";
import { ChannelMux } from "../src/proxy/muxer.ts";
import type { Stream } from "../src/db/schema.ts";

/**
 * Drives ChannelMux's private fanout()/attach()/teardown() directly (via
 * `as any`) rather than through the full Muxer.open() path, which needs a
 * live pool/selector/upstream. `this.slate` is assigned a fake feeder by
 * hand — this exercises fanout's hold/splice/abandon decisions in isolation
 * from SlateFeeder's own real-time pacing (covered by slatefeeder.test.ts)
 * and from the gate/settings/loadReel plumbing (covered by slategate.test.ts
 * and maybeStartSlate's own logic).
 *
 * Synthetic MPEG-TS packets mirror tspreroll.test.ts's builder: just enough
 * (PAT / PMT / keyframe / plain video) to drive TsPreroll's alignment and
 * keyframe detection, which is what fanout's slate branch keys off of.
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
function videoPkt(): Uint8Array {
  return base(VIDEO_PID, { pusi: false, afc: 0x1 });
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function fakeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: 1,
    channelId: 42,
    providerId: 7,
    url: "http://example.invalid/stream.ts",
    rawName: "Test Channel",
    resolution: 1080,
    fps: 25,
    bitrate: null,
    codec: "h264",
    health: "live",
    resolver: null,
    lastProbedAt: null,
    qualityScore: 0,
    ...overrides,
  } as Stream;
}

function fakeFeeder() {
  return { stop: mock(() => {}), start: mock(() => {}) };
}

// Builds a mux with one attached subscriber, a manually-assigned fake slate
// feeder (bypassing maybeStartSlate's async gating — that path is covered
// elsewhere), and no upstream ever started (so pool/selector are never touched).
function coldMuxWithSlate(overrides: Partial<Stream> = {}) {
  const mux = new ChannelMux(fakeStream(overrides), () => {}, () => {});
  const push = mock((_c: Uint8Array) => {});
  const close = mock(() => {});
  mux.attach({ push, close }, true, false); // allowSlate=false — we set `slate` by hand below
  const feeder = fakeFeeder();
  (mux as unknown as { slate: unknown }).slate = feeder;
  return { mux: mux as unknown as { fanout: (c: Uint8Array) => void; slate: unknown; slateHeldSince: number }, push, close, feeder };
}

describe("ChannelMux slate hold/splice/abandon (fanout)", () => {
  test("withholds live regions while the slate is up and no keyframe has arrived yet", () => {
    const { mux, push, feeder } = coldMuxWithSlate();
    mux.fanout(cat(patPkt(), pmtPkt(), videoPkt())); // aligned, but no keyframe yet
    expect(push).not.toHaveBeenCalled();
    expect(feeder.stop).not.toHaveBeenCalled();
    expect(mux.slate).toBe(feeder); // still holding, slate still up
  });

  test("on the first live keyframe, subs receive the preroll exactly once and the slate stops", () => {
    const { mux, push, feeder } = coldMuxWithSlate();
    mux.fanout(cat(patPkt(), pmtPkt(), keyframePkt(), videoPkt()));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].length).toBe(4 * PKT); // PAT + PMT + keyframe + 1 video — the preroll
    expect(feeder.stop).toHaveBeenCalledTimes(1);
    expect(mux.slate).toBeNull();

    // Live flows normally after the splice — no second copy of the spliced bytes.
    mux.fanout(videoPkt());
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[1][0].length).toBe(PKT);
  });

  test("hold bound: past SLATE_HOLD_MAX_MS with no keyframe, the slate is abandoned and live flows raw", () => {
    const { mux, push, feeder } = coldMuxWithSlate();
    mux.fanout(cat(patPkt(), pmtPkt(), videoPkt())); // starts the hold clock, still no keyframe
    expect(push).not.toHaveBeenCalled();
    expect(mux.slateHeldSince).toBeGreaterThan(0);

    // Backdate the hold clock past the 8s bound instead of sleeping for real.
    mux.slateHeldSince = Date.now() - 9_000;
    mux.fanout(videoPkt()); // still no keyframe — this is what trips the bound
    expect(feeder.stop).toHaveBeenCalledTimes(1);
    expect(mux.slate).toBeNull();
    expect(push).toHaveBeenCalledTimes(1); // this region flowed raw, mid-GOP — no preroll was ever built
    expect(push.mock.calls[0][0].length).toBe(PKT);
  });

  test("teardown (stop()) stops a still-running feeder — no leak", () => {
    const mux = new ChannelMux(fakeStream(), () => {}, () => {});
    const feeder = fakeFeeder();
    (mux as unknown as { slate: unknown }).slate = feeder;
    mux.stop();
    expect(feeder.stop).toHaveBeenCalledTimes(1);
    expect((mux as unknown as { slate: unknown }).slate).toBeNull();
  });
});
