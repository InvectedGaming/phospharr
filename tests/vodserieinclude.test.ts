import { describe, expect, test } from "bun:test";
import { seriesKey } from "../src/ingest/vodlibrary.ts";

/**
 * `vod.seriesInclude` is the show-level allowlist that keeps a curated VOD TV
 * library curated. Category scoping alone is far too coarse — a single category
 * holds thousands of shows, and each mirrored show costs a provider
 * episode-list fetch per refresh plus a folder of .strm files. Getting the
 * match key wrong fails in the worst way: a title that doesn't match mirrors
 * NOTHING, silently, and the library just stays empty.
 */
describe("seriesKey (vod.seriesInclude matching)", () => {
  test("ignores case and punctuation so pasted titles still match", () => {
    expect(seriesKey("Marvel's Agents of S.H.I.E.L.D. (2013)")).toBe(seriesKey("marvels agents of shield (2013)"));
    expect(seriesKey("It's Always Sunny in Philadelphia")).toBe(seriesKey("Its Always Sunny In Philadelphia"));
    expect(seriesKey("Law & Order: SVU")).toBe(seriesKey("law and order svu".replace(" and ", " & ")));
  });

  test("KEEPS the year, so remakes never collide", () => {
    // The catalog carries both a bare title and year-suffixed ones; treating
    // them as equal would silently mirror the wrong show.
    expect(seriesKey("Fargo (2014)")).not.toBe(seriesKey("Fargo"));
    expect(seriesKey("Castle (2009)")).not.toBe(seriesKey("Castle"));
    expect(seriesKey("Firefly (2002)")).not.toBe(seriesKey("Firefly Lane (2021)"));
  });

  test("distinguishes shows whose names differ only past the punctuation", () => {
    expect(seriesKey("Oz")).not.toBe(seriesKey("Ozark (2017)"));
    expect(seriesKey("Columbo (1971)")).not.toBe(seriesKey("Mrs. Columbo (1979)"));
  });

  test("is stable for the real curated titles this library was built for", () => {
    // Exact catalog spellings — these are what the allowlist ships with.
    for (const n of ["30 Rock (2006)", "Abbott Elementary (2021)", "Blue Bloods (2010)", "Castle", "Oz"]) {
      expect(seriesKey(n)).toBe(seriesKey(n.toUpperCase()));
      expect(seriesKey(n).length).toBeGreaterThan(0);
    }
  });
});
