import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { exportXmltv } from "../src/epg/export.ts";

// Deterministic fixture: two channels with real programmes (canonical_id order
// deliberately reversed from DB/list order — see below), one with none (gets
// synthetic 4h filler), one custom "live" channel whose filler title is customNow.
const NOW = 1_800_000_000; // 2027-01-15T08:00:00Z — hour-aligned so filler blocks are stable
const A = 993001, B = 993002, C = 993003, D = 993004;
sqlite.exec(`INSERT INTO channels (id,name,is_hidden,number,canonical_id,category,genre,kind) VALUES
  (${A},'GR NEWS',0,99301,'gr.news.test','USA News','News','tv'),
  (${B},'GR LOOP',0,99302,'gr.loop.test','24/7 Comedy','Comedy','tv'),
  (${C},'GR TWITCH',0,99303,'gr.twitch.test','Live','Sports','live')`);
sqlite.exec(`UPDATE channels SET custom_now='Live now: chess' WHERE id=${C}`);
sqlite.exec(`INSERT INTO programs (canonical_id,title,subtitle,description,start_time,end_time,category,epg_source) VALUES
  ('gr.news.test','Morning Show','Ep 1','desc',${NOW - 1800},${NOW + 1800},'News','t'),
  ('gr.news.test','Noon Report',NULL,NULL,${NOW + 1800},${NOW + 5400},'News','t')`);
// A second real-programme channel, inserted AFTER the three above (so it is
// last in DB/list order) but whose canonical_id ('gr.alpha.test') sorts
// BEFORE 'gr.news.test'. The old exporter emitted real programmes in one pass
// ordered by canonical_id across all channels; a per-channel-in-list-order
// renderer would interleave them differently. Only with two real-programme
// channels whose canonical_id order diverges from DB/list order can the
// golden actually distinguish the two renderings.
sqlite.exec(`INSERT INTO channels (id,name,is_hidden,number,canonical_id,category,genre,kind) VALUES
  (${D},'GR ALPHA',0,99304,'gr.alpha.test','USA News','News','tv')`);
sqlite.exec(`INSERT INTO programs (canonical_id,title,subtitle,description,start_time,end_time,category,epg_source) VALUES
  ('gr.alpha.test','Alpha Early',NULL,NULL,${NOW - 1800},${NOW + 1800},'News','t'),
  ('gr.alpha.test','Alpha Late',NULL,NULL,${NOW + 1800},${NOW + 5400},'News','t')`);
afterAll(() => {
  sqlite.exec(`DELETE FROM programs WHERE canonical_id IN ('gr.news.test','gr.alpha.test')`);
  sqlite.exec(`DELETE FROM channels WHERE id IN (${A},${B},${C},${D})`);
});

const only = (xml: string) => xml.split("\n").filter((l) => /gr\.(news|loop|twitch|alpha)\.test|phospharr\.mosaic/.test(l)).join("\n");

describe("exportXmltv characterisation", () => {
  // Mock time so the fixture's absolute times fall inside exportXmltv's window
  // (it reads Date.now() internally) and the golden is stable across runs.
  // Scoped to this describe's beforeAll/afterAll (not module scope) so other
  // test files sharing this process never see the patched clock.
  const realNow = Date.now;
  beforeAll(() => { Date.now = () => NOW * 1000; });
  afterAll(() => { Date.now = realNow; });

  test("golden: the fixture renders exactly as before the guideRows refactor", async () => {
    const xml = only(await exportXmltv(undefined, undefined));
    // Always write the actual output so a deliberate regeneration is one `cp` away.
    await Bun.write("/tmp/guiderows.golden.xml", xml);
    const golden = await Bun.file("tests/fixtures/guiderows.golden.xml").text().catch(() => {
      throw new Error(
        "tests/fixtures/guiderows.golden.xml is missing. This must be regenerated deliberately, not " +
          "silently treated as a pass: run this test once (it writes the actual output to " +
          "/tmp/guiderows.golden.xml), copy that file over tests/fixtures/guiderows.golden.xml, then " +
          "re-run this test to confirm it now passes.",
      );
    });
    expect(xml).toBe(golden);
  });
});

import { guideRows, WINDOW_AHEAD, WINDOW_BEHIND } from "../src/epg/guide.ts";

describe("guideRows", () => {
  test("real programmes come through with Emby colour category and window bounds", () => {
    const g = guideRows({ now: NOW });
    expect(g.windowStart).toBe(NOW - WINDOW_BEHIND);
    expect(g.windowEnd).toBe(NOW + WINDOW_AHEAD);
    const news = g.programs.get("gr.news.test")!;
    expect(news.map((p) => p.title)).toEqual(["Morning Show", "Noon Report"]);
    expect(news[0]!.category).toBe("News");
  });

  test("a channel with no rows gets filler on a fixed 4h UTC grid across the whole window", () => {
    const g = guideRows({ now: NOW });
    const fill = g.programs.get("gr.loop.test")!;
    expect(fill.length).toBeGreaterThan(10);
    expect(fill[0]!.start % (4 * 3600)).toBe(0);
    expect(fill[0]!.start).toBeLessThanOrEqual(g.windowStart);
    expect(fill.every((p) => p.end - p.start === 4 * 3600 && p.title === "GR LOOP" && p.extraCategory === "24/7")).toBe(true);
    expect(fill[fill.length - 1]!.start).toBeLessThan(g.windowEnd);
  });

  test("a live channel's filler title is its customNow text", () => {
    const g = guideRows({ now: NOW });
    expect(g.programs.get("gr.twitch.test")![0]!.title).toBe("Live now: chess");
  });

  test("the mosaic is present only in the unfiltered (main) lineup", () => {
    expect(guideRows({ now: NOW }).channels.some((c) => c.canonicalId === "phospharr.mosaic")).toBe(true);
    expect(guideRows({ now: NOW, catFilter: { include: ["Live"] } }).channels.some((c) => c.canonicalId === "phospharr.mosaic")).toBe(false);
  });

  test("catFilter include/exclude scopes channels exactly like the export routes", () => {
    const inc = guideRows({ now: NOW, catFilter: { include: ["Live"] } }).channels.map((c) => c.canonicalId);
    expect(inc).toContain("gr.twitch.test");
    expect(inc).not.toContain("gr.news.test");
    const exc = guideRows({ now: NOW, catFilter: { exclude: ["Live"] } }).channels.map((c) => c.canonicalId);
    expect(exc).not.toContain("gr.twitch.test");
    expect(exc).toContain("gr.news.test");
  });

  test("the filler flag marks channels with no real rows, including the mosaic", () => {
    const byId = new Map(guideRows({ now: NOW }).channels.map((c) => [c.canonicalId, c.filler]));
    expect(byId.get("gr.news.test")).toBe(false);
    expect(byId.get("gr.alpha.test")).toBe(false);
    expect(byId.get("gr.loop.test")).toBe(true);
    expect(byId.get("gr.twitch.test")).toBe(true);
    expect(byId.get("phospharr.mosaic")).toBe(true);
  });
});
