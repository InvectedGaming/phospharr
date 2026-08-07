import { describe, expect, test } from "bun:test";
import { reconnectPlan, RECONNECT_MAX, RECONNECT_HEALTHY_MS } from "../src/proxy/reconnect.ts";

/**
 * Observed on the live service: a single-source channel dropped three times in
 * five minutes, each time throwing the viewer off with "no alternates". The
 * reconnect always succeeded when tried by hand, so this policy decides when to
 * try it automatically.
 */

describe("reconnectPlan", () => {
  test("retries a fresh drop immediately-ish, not after a long wait", () => {
    const p = reconnectPlan({ attempts: 0, sourceUptimeMs: 5_000 });
    expect(p.retry).toBe(true);
    expect(p.attempt).toBe(1);
    // Must land well inside the jitter cushion, or the viewer sees the gap.
    expect(p.backoffMs).toBeLessThan(1_000);
  });

  test("backs off progressively but stays bounded", () => {
    const waits = [0, 1, 2, 3, 4].map((a) => reconnectPlan({ attempts: a, sourceUptimeMs: 1_000 }).backoffMs);
    expect(waits).toEqual([250, 500, 1000, 2000, 2000]);
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1] as number);
  });

  test("gives up once the budget is spent, so a dead source can't spin forever", () => {
    const p = reconnectPlan({ attempts: RECONNECT_MAX, sourceUptimeMs: 1_000 });
    expect(p.retry).toBe(false);
  });

  test("a source that streamed healthily gets a fresh budget", () => {
    // Otherwise hours of good playback accumulate toward the cap and a
    // long-running channel sits one drop away from giving up on its viewers.
    const spent = reconnectPlan({ attempts: RECONNECT_MAX, sourceUptimeMs: RECONNECT_HEALTHY_MS });
    expect(spent.retry).toBe(true);
    expect(spent.attempt).toBe(1);
  });

  test("a source that died just under the healthy threshold does NOT reset", () => {
    const p = reconnectPlan({ attempts: RECONNECT_MAX, sourceUptimeMs: RECONNECT_HEALTHY_MS - 1 });
    expect(p.retry).toBe(false);
  });

  test("the whole budget is usable before giving up", () => {
    let attempts = 0;
    const tried: number[] = [];
    for (;;) {
      const p = reconnectPlan({ attempts, sourceUptimeMs: 100 });
      if (!p.retry) break;
      tried.push(p.attempt);
      attempts = p.attempt;
    }
    expect(tried).toEqual([1, 2, 3, 4, 5]);
  });
});
