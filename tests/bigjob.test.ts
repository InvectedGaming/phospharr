import { describe, expect, test } from "bun:test";
import { withBigJob } from "../src/scheduler/bigjob.ts";

/**
 * The big-job mutex: EPG refresh, VOD catalog sync and the full lineup sync
 * each allocate tens-to-hundreds of MB of transients (50k-programme XMLTV,
 * 58k-movie JSON). Run alone, each plateaus; run TOGETHER their peaks stack —
 * that pileup (plus probe samples and reconnect churn) is what cleared the
 * container's memory cap on 2026-08-22 and OOM-killed live TV mid-stream.
 * Serializing just these jobs keeps every individual cadence and only ever
 * delays a background sync by another sync's runtime.
 */

const tick = () => new Promise<void>((r) => setTimeout(r, 10));

describe("withBigJob", () => {
  test("returns the job's result", async () => {
    expect(await withBigJob("t1", async () => 42)).toBe(42);
  });

  test("two jobs never overlap — the second starts after the first finishes", async () => {
    const events: string[] = [];
    const a = withBigJob("a", async () => { events.push("a:start"); await tick(); await tick(); events.push("a:end"); });
    const b = withBigJob("b", async () => { events.push("b:start"); events.push("b:end"); });
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("a throwing job releases the mutex for the next one", async () => {
    await expect(withBigJob("boom", async () => { throw new Error("sync failed"); })).rejects.toThrow("sync failed");
    expect(await withBigJob("after", async () => "ran")).toBe("ran");
  });

  test("queue order is FIFO across several jobs", async () => {
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => withBigJob(`j${n}`, async () => { await tick(); order.push(n); })));
    expect(order).toEqual([1, 2, 3]);
  });
});
