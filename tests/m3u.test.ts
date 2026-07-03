import { describe, expect, test } from "bun:test";
import { parseM3U } from "../src/ingest/m3u.ts";

const SAMPLE = `#EXTM3U
#EXTINF:-1 tvg-id="espn.us" tvg-name="ESPN" tvg-logo="http://x/espn.png" group-title="Sports",US| ESPN HD
http://provider.example/live/espn.ts
#EXTGRP:Sports
#EXTINF:-1 group-title="News, Weather",CNN
http://provider.example/live/cnn.ts

#EXTINF:-1,No Attrs At All
http://provider.example/live/bare.ts
#EXTINF:-1 tvg-id="orphaned.no.url",Orphaned Entry
`;

describe("parseM3U", () => {
  const entries = parseM3U(SAMPLE);

  test("parses every entry that has a URL, skipping orphans", () => {
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.url)).toEqual([
      "http://provider.example/live/espn.ts",
      "http://provider.example/live/cnn.ts",
      "http://provider.example/live/bare.ts",
    ]);
  });

  test("extracts attributes and display name", () => {
    const espn = entries[0];
    expect(espn.rawName).toBe("US| ESPN HD");
    expect(espn.tvgId).toBe("espn.us");
    expect(espn.logoUrl).toBe("http://x/espn.png");
    expect(espn.groupTitle).toBe("Sports");
  });

  test("display name is text after the LAST comma (commas inside quotes survive)", () => {
    expect(entries[1].rawName).toBe("CNN");
    expect(entries[1].groupTitle).toBe("News, Weather");
  });

  test("handles CRLF line endings", () => {
    const crlf = parseM3U(SAMPLE.replace(/\n/g, "\r\n"));
    expect(crlf.length).toBe(3);
    expect(crlf[0].url).toBe("http://provider.example/live/espn.ts");
  });
});
