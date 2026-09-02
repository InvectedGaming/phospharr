import { describe, expect, test } from "bun:test";
import { getSetting } from "../src/settings.ts";

describe("slate settings", () => {
  test("ships disabled with the spec's defaults", async () => {
    expect(await getSetting("features.slate")).toBe(false);
    expect(await getSetting("slate.durationSec")).toBe(20);
    expect(await getSetting("slate.tailSec")).toBe(6);
    expect(await getSetting("slate.refreshHours")).toBe(6);
    expect(await getSetting("slate.memesPerReel")).toBe(5);
    expect(await getSetting("slate.subreddits")).toEqual([]);
    expect(await getSetting("slate.localDir")).toBe("");
  });
});
