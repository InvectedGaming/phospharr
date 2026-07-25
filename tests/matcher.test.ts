import { test, expect } from "bun:test";
import { matchCanonical } from "../src/canonical/matcher.ts";

// Regression for the fuzzy-merge bug: numbered siblings differ by one char over a
// long slug (~0.90 similarity), which clears the 0.86 fuzzy threshold. They are
// DISTINCT channels and must never collapse into one canonical id.
test("numbered siblings stay distinct channels", () => {
  const known = new Map<string, string>();
  const one = matchCanonical({ rawName: "Sky Sports 1" }, known);
  const two = matchCanonical({ rawName: "Sky Sports 2" }, known);
  expect(two.canonicalId).not.toBe(one.canonicalId);
});

test("beIN Sports 1-12 resolve to 12 distinct channels", () => {
  const known = new Map<string, string>();
  const ids = new Set<string>();
  for (let n = 1; n <= 12; n++) {
    ids.add(matchCanonical({ rawName: `beIN Sports ${n}` }, known).canonicalId);
  }
  expect(ids.size).toBe(12);
});

// A quality variant carries the SAME number, so it still collapses onto the base.
test("HD variant merges with its base numbered channel", () => {
  const known = new Map<string, string>();
  const base = matchCanonical({ rawName: "Sky Sports 1" }, known);
  const hd = matchCanonical({ rawName: "Sky Sports 1 FHD" }, known);
  expect(hd.canonicalId).toBe(base.canonicalId);
});

// Fuzzy matching still does its job for genuine near-misses that share numbers.
test("near-miss spelling still merges when the numbers match", () => {
  const known = new Map<string, string>();
  const a = matchCanonical({ rawName: "Sky Sports F1" }, known);
  const b = matchCanonical({ rawName: "Sky Sport F1" }, known); // "Sport" typo
  expect(b.canonicalId).toBe(a.canonicalId);
});

// A real EPG id is trusted directly (step 1), independent of the fuzzy guard.
test("dotted tvg-id is trusted as the canonical id", () => {
  const known = new Map<string, string>();
  const r = matchCanonical({ rawName: "Sky Sports 1", tvgId: "SkySports1.uk" }, known);
  expect(r.canonicalId).toBe("skysports1.uk");
});
