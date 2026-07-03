import { describe, expect, test } from "bun:test";
import { streamXmltv, type XmltvChannel, type XmltvProgramme } from "../src/epg/xmltv.ts";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
  <channel id="espn.us">
    <display-name>ESPN</display-name>
    <icon src="http://x/espn.png"/>
  </channel>
  <programme start="20260702180000 +0000" stop="20260702190000 +0000" channel="espn.us">
    <title>SportsCenter &amp; Friends</title>
    <desc>News &lt;live&gt;</desc>
    <category>Sports</category>
  </programme>
  <programme start="20260702140000 -0400" stop="20260702150000 -0400" channel="espn.us">
    <title>Offset Show</title>
  </programme>
  <programme start="garbage" stop="alsogarbage" channel="espn.us">
    <title>Bad Times</title>
  </programme>
</tv>`;

/** Stream the XML in awkward little chunks so tags split across reads. */
function chunked(s: string, size: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= s.length) return c.close();
      c.enqueue(enc.encode(s.slice(i, i + size)));
      i += size;
    },
  });
}

async function parse(size: number) {
  const channels: XmltvChannel[] = [];
  const programmes: XmltvProgramme[] = [];
  await streamXmltv(chunked(XML, size), {
    onChannel: (c) => channels.push(c),
    onProgramme: (p) => programmes.push(p),
  });
  return { channels, programmes };
}

describe("streamXmltv", () => {
  test("parses channels and programmes, decoding entities", async () => {
    const { channels, programmes } = await parse(4096);
    expect(channels).toEqual([{ id: "espn.us", displayName: "ESPN", iconUrl: "http://x/espn.png" }]);
    expect(programmes.length).toBe(3);
    expect(programmes[0].title).toBe("SportsCenter & Friends");
    expect(programmes[0].description).toBe("News <live>");
    expect(programmes[0].category).toBe("Sports");
  });

  test("XMLTV times honor UTC and negative offsets", async () => {
    const { programmes } = await parse(4096);
    expect(programmes[0].start.toISOString()).toBe("2026-07-02T18:00:00.000Z");
    // 14:00 -0400 == 18:00 UTC — same instant as the first programme
    expect(programmes[1].start.getTime()).toBe(programmes[0].start.getTime());
  });

  test("unparseable times surface as NaN dates (caller skips them)", async () => {
    const { programmes } = await parse(4096);
    expect(Number.isNaN(programmes[2].start.getTime())).toBe(true);
  });

  test("identical results when tags split across tiny chunks", async () => {
    const tiny = await parse(7); // guaranteed to split tags/entities mid-way
    const big = await parse(1 << 20);
    // stringify dates (NaN !== NaN would fail a deep-equal on the invalid one)
    const norm = (r: Awaited<ReturnType<typeof parse>>) => ({
      channels: r.channels,
      programmes: r.programmes.map((p) => ({ ...p, start: String(p.start.getTime()), stop: String(p.stop.getTime()) })),
    });
    expect(norm(tiny)).toEqual(norm(big));
  });
});
