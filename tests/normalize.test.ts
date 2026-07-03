import { describe, expect, test } from "bun:test";
import { normalizeName } from "../src/canonical/normalize.ts";
import { matchCanonical, qualityScore, similarity } from "../src/canonical/matcher.ts";
import { isAdult } from "../src/content/adult.ts";

describe("normalizeName", () => {
  test("strips country prefix, quality tag, and brackets", () => {
    const n = normalizeName("US| ESPN HD [1080]");
    expect(n.display).toBe("ESPN");
    expect(n.slug).toBe("espn");
    expect(n.resolution).toBe(1080); // the explicit 1080 outranks the vaguer "HD"
    expect(n.country).toBe("us");
  });

  test("FHD maps to 1080 and slug drops punctuation", () => {
    const n = normalizeName("UK: Sky Sports F1 FHD");
    expect(n.slug).toBe("skysportsf1");
    expect(n.resolution).toBe(1080);
    expect(n.country).toBe("uk");
  });

  test("a name that is all junk falls back to the raw name", () => {
    const n = normalizeName("VIP");
    expect(n.display).toBe("VIP");
    expect(n.slug.length).toBeGreaterThan(0);
  });
});

describe("matchCanonical", () => {
  test("trusts a dotted tvg-id as canonicalId", () => {
    const known = new Map<string, string>();
    const r = matchCanonical({ rawName: "US| ESPN HD", tvgId: "ESPN.us" }, known);
    expect(r.canonicalId).toBe("espn.us");
    expect(known.has("espn.us")).toBe(true);
  });

  test("groups near-duplicate names onto one canonical channel", () => {
    const known = new Map<string, string>();
    const a = matchCanonical({ rawName: "US| Sky Sports F1 FHD" }, known);
    const b = matchCanonical({ rawName: "US: Sky Sport F1 HD" }, known); // typo'd dupe
    expect(b.canonicalId).toBe(a.canonicalId);
  });

  test("similarity is symmetric-ish and bounded", () => {
    expect(similarity("espn", "espn")).toBe(1);
    expect(similarity("espn", "")).toBe(0);
    expect(similarity("skysportsf1", "skysportf1")).toBeGreaterThan(0.86);
  });
});

describe("qualityScore", () => {
  test("proven-live beats unknown at equal resolution; health bonus is bounded", () => {
    expect(qualityScore(1080, "live")).toBeGreaterThan(qualityScore(1080, "unknown"));
    expect(qualityScore(720, "live")).toBeGreaterThan(qualityScore(1080, "unknown"));
    expect(qualityScore(720, "degraded")).toBeGreaterThan(qualityScore(720, "unknown"));
    // the bonus is deliberately NOT absolute: an unprobed 4K source still outranks a live 1080
    expect(qualityScore(2160, "unknown")).toBeGreaterThan(qualityScore(1080, "live"));
  });
});

describe("isAdult", () => {
  test("catches explicit categories including bare 'Adult'", () => {
    expect(isAdult("XXX", "Movie Night")).toBe(true);
    expect(isAdult("Adult", "Whatever")).toBe(true);
    expect(isAdult("24/7 Adult", "Whatever")).toBe(true);
    expect(isAdult("For Adults", "Whatever")).toBe(true);
    expect(isAdult("18+", "Whatever")).toBe(true);
  });

  test("does NOT flag mainstream 'adult' blocks or lookalikes", () => {
    expect(isAdult("Adult Swim", "Rick and Morty")).toBe(false);
    expect(isAdult("Adult Cartoons", "Family Guy")).toBe(false);
    expect(isAdult("Adult Animation", "Archer")).toBe(false);
    expect(isAdult("Reality", "Hardcore Pawn")).toBe(false);
    expect(isAdult("UK Local", "BBC Sussex")).toBe(false);
  });

  test("name-only markers must be unambiguous", () => {
    expect(isAdult(null, "XXX Movies")).toBe(true);
    expect(isAdult(null, "Adult Swim")).toBe(false);
  });
});
