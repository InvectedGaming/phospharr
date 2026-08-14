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

  /**
   * Measured against the live provider 2026-08-14: the CDN answers 200, streams
   * at ~1MB/s, then closes on its own after 5.6s / 6.8s / 13.8s. Every one of
   * those is a session that delivered real content — the viewer was watching —
   * but each drop landed under the old 60s bar, so the streak never reset. The
   * budget burned 1..5 in well under a minute and the viewer was thrown off with
   * "died, no alternates". A session long enough to have shown real video must
   * start a fresh incident, or this provider can never be watched at all.
   */
  test("a CDN-length session that delivered video resets the budget", () => {
    for (const uptime of [5_600, 6_800, 13_800]) {
      const p = reconnectPlan({ attempts: RECONNECT_MAX, sourceUptimeMs: uptime });
      expect(p.retry).toBe(true);
      expect(p.attempt).toBe(1);
    }
  });

  test("an instantly-failing source still exhausts its budget", () => {
    // The flip side: sub-second failures are a broken source, not a viewer
    // mid-watch, and must still give up rather than spin forever.
    const p = reconnectPlan({ attempts: RECONNECT_MAX, sourceUptimeMs: 900 });
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
