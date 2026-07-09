import { describe, expect, test } from "bun:test";
import { refreshOne, downstreamResults } from "../src/epg/downstream.ts";
import type { DownstreamServer } from "../src/settings.ts";

/**
 * Downstream guide-sync: the network paths need a live server, but the guard
 * rails (missing config, result recording) are pure and worth locking.
 */

const base: DownstreamServer = { id: "t1", type: "emby", name: "T1", url: "", apiKey: "", enabled: true };

describe("refreshOne", () => {
  test("missing url or key fails fast without a network call", async () => {
    const r = await refreshOne({ ...base });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/missing/i);
    expect(r.id).toBe("t1");
  });

  test("records the last result, newest first", async () => {
    await refreshOne({ ...base, id: "a", url: "", apiKey: "" });
    await new Promise((r) => setTimeout(r, 5)); // distinct ms so the sort is deterministic
    await refreshOne({ ...base, id: "b", url: "", apiKey: "" });
    const ids = downstreamResults().map((r) => r.id);
    // both present; the most recent (b) sorts ahead of a
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("a"));
  });

  test("never throws — a bad URL resolves to a failed result", async () => {
    const r = await refreshOne({ ...base, id: "c", url: "http://127.0.0.1:9", apiKey: "k" });
    expect(r.ok).toBe(false);
    expect(typeof r.message).toBe("string");
    expect(r.message.length).toBeGreaterThan(0);
  }, 20_000);
});
