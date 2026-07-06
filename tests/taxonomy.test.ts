import { describe, expect, test } from "bun:test";
import { classify, localNetwork } from "../src/content/taxonomy.ts";

// Real category/name shapes from a production lineup.
describe("classify", () => {
  test("24/7 groups become loops with the tail genre", () => {
    expect(classify("24/7 Drama", "Breaking Bad")).toEqual({ kind: "loop", genre: "Drama" });
    expect(classify("24/7 Comedy", "The Office")).toEqual({ kind: "loop", genre: "Comedy" });
    expect(classify("24/7 Kids", "Bluey")).toEqual({ kind: "loop", genre: "Kids" });
    expect(classify("24/7 Movie Series", "John Wick")).toEqual({ kind: "loop", genre: "Movies" });
    expect(classify("24/7 Classic Tv Series", "I Love Lucy")).toEqual({ kind: "loop", genre: "Classics" });
    expect(classify("24/7 Shows", "Future Man").kind).toBe("loop");
    expect(classify("24/7 Netflix", "Ozark")).toEqual({ kind: "loop", genre: "Entertainment" });
  });

  test("local affiliates: group- or name-tagged", () => {
    expect(classify("USA Local - ABC", "USA ABC 7 KABC Los Angeles")).toEqual({ kind: "local", genre: "Locals" });
    expect(classify("USA Local Channels ( Full List )", "TX San Antonio NBC WOAI")).toEqual({ kind: "local", genre: "Locals" });
    // callsign in the name even without a Local group
    expect(classify("USA Entertainment", "USA FOX 12 KPTV PORTLAND").kind).toBe("local");
  });

  test("sports / news / movies networks", () => {
    expect(classify("USA Sports", "ESPN")).toEqual({ kind: "network", genre: "Sports" });
    expect(classify("USA News", "CNN")).toEqual({ kind: "network", genre: "News" });
    expect(classify("USA Movies Channels", "HBO East")).toEqual({ kind: "network", genre: "Movies" });
    expect(classify(null, "NFL RedZone").genre).toBe("Sports");
  });

  test("international: country-prefixed groups or names", () => {
    expect(classify("UK Entertainment", "UK CineBox Family").kind).toBe("intl");
    expect(classify(null, "UK Sky Sports F1")).toEqual({ kind: "intl", genre: "Sports" });
    // "USA ..." must NOT read as intl
    expect(classify("USA Entertainment", "Comedy Central").kind).toBe("network");
  });

  test("foreign brands on US feeds go international, not ahead of CNN", () => {
    expect(classify("USA News", "USA AL JAZEERA")).toEqual({ kind: "intl", genre: "News" });
    expect(classify("USA News", "USA BBC World News")).toEqual({ kind: "intl", genre: "News" });
    expect(classify("USA News", "USA CGTN")).toEqual({ kind: "intl", genre: "News" });
    expect(classify(null, "France 24 English").kind).toBe("intl");
    // …but BBC America is a US cable network, and American news stays put
    expect(classify("USA Entertainment", "USA BBC America").kind).toBe("network");
    expect(classify("USA News", "USA CNN *")).toEqual({ kind: "network", genre: "News" });
    expect(classify("USA News", "USA Fox News").kind).toBe("network");
  });

  test("music + PPV", () => {
    expect(classify("USA Music", "USA Stingray Karaoke").genre).toBe("Music");
    expect(classify("PPV Events", "UFC 320 PPV")).toEqual({ kind: "event", genre: "Sports" });
  });

  test("bare show names default to network/Entertainment", () => {
    expect(classify(null, "Ultimate Tag")).toEqual({ kind: "network", genre: "Entertainment" });
  });
});

describe("localNetwork", () => {
  test("prefers the group tag, falls back to the name, misc sorts last", () => {
    expect(localNetwork("USA Local - ABC", "whatever")).toBe("ABC");
    expect(localNetwork("USA Local Channels ( Full List )", "TX San Antonio NBC WOAI")).toBe("NBC");
    expect(localNetwork("USA Local - MISC", "Some Indie Station")).toBe("ZZZ");
  });
});
