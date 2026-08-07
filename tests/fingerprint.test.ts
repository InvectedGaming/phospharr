import { afterAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { computeFingerprint, currentFingerprint } from "../src/sync/fingerprint.ts";
import { lineupRows, fingerprintRows } from "../src/tuner/hdhr.ts";
import type { FingerprintRow } from "../src/tuner/hdhr.ts";

const A: FingerprintRow = { canonicalId: "espn.us", guideNumber: "100", name: "ESPN", logoUrl: "l", category: "sports" };
const B: FingerprintRow = { canonicalId: "cnn.us", guideNumber: "101", name: "CNN", logoUrl: "m", category: "news" };

describe("lineup fingerprint", () => {
  test("stable across order", () => {
    expect(computeFingerprint([A, B])).toBe(computeFingerprint([B, A]));
  });
  test("changes when any field changes", () => {
    const base = computeFingerprint([A, B]);
    expect(computeFingerprint([{ ...A, name: "ESPN 2" }, B])).not.toBe(base);
    expect(computeFingerprint([{ ...A, logoUrl: "other" }, B])).not.toBe(base);
    expect(computeFingerprint([A])).not.toBe(base);
  });
  test("does not collide on a space inside name/category vs. a different split", () => {
    // "USA Local - ABC" style categories mean a naive " "-joined string could
    // let two different (name, category) pairs hash the same.
    const x: FingerprintRow = { canonicalId: "c1", guideNumber: "1", name: "Foo Bar", logoUrl: "", category: "Baz" };
    const y: FingerprintRow = { canonicalId: "c1", guideNumber: "1", name: "Foo", logoUrl: "", category: "Bar Baz" };
    expect(computeFingerprint([x])).not.toBe(computeFingerprint([y]));
  });
});

/**
 * Regression guards seeded against the real DB (not hand-built literals), so
 * these fail if the projections regress. Uses high, unlikely-to-collide ids
 * and cleans up after itself, following tests/analytics.test.ts convention.
 */
const P1 = 990201;
const C1 = 990210;
const S1 = 990220;

function seed() {
  sqlite.exec(
    `INSERT INTO providers (id,name,type,url,max_connections,priority,enabled) VALUES
       (${P1},'fp_test_provider_${P1}','custom','http://example.invalid',1,100,1)`,
  );
  sqlite.exec(
    `INSERT INTO channels (id,canonical_id,name,number,logo_url,category,is_hidden) VALUES
       (${C1},'fp.test.${C1}','FP Test Channel ${C1}',990210,'http://logo.example/original.png','sports',0)`,
  );
  sqlite.exec(
    `INSERT INTO streams (id,channel_id,provider_id,url,raw_name,health) VALUES
       (${S1},${C1},${P1},'http://stream.example/x.ts','FP TEST RAW','unknown')`,
  );
}
function cleanup() {
  sqlite.exec(`DELETE FROM streams WHERE id = ${S1}`);
  sqlite.exec(`DELETE FROM channels WHERE id = ${C1}`);
  sqlite.exec(`DELETE FROM providers WHERE id = ${P1}`);
}

afterAll(cleanup);

describe("lineupRows (regression guard for the /lineup.json extraction)", () => {
  test("builds the same GuideNumber/GuideName/URL/HD shape the route used to build inline", () => {
    cleanup(); // idempotent from a prior aborted run
    seed();

    const rows = lineupRows("http://x/auto");
    const ch = rows.find((r) => r.GuideNumber === "990210");

    expect(ch).toEqual({ GuideNumber: "990210", GuideName: `FP Test Channel ${C1}`, URL: `http://x/auto/stream/${C1}`, HD: 1 });
    expect(rows[0]).toEqual({ GuideNumber: "1", GuideName: "Mosaic", URL: "http://x/auto/mosaic.ts", HD: 1 }); // mosaic always first
  });
});

/**
 * The fingerprint must track the LINEUP DEFINITION, not transient source
 * health. On the live install the source-filtered set churned twice in seven
 * minutes as the health probe flipped streams dead/alive, which reset the
 * convergence ladder's verify window every time — verify never ran and the
 * server sat permanently "converging" while pushing a guide refresh downstream
 * every ~5 minutes. Re-adding a `health <> 'dead'` filter to fingerprintRows()
 * reintroduces exactly that, so these guard it.
 */
describe("fingerprint ignores transient stream health", () => {
  test("a channel whose only source goes dead stays in the fingerprint, but leaves the served lineup", () => {
    cleanup(); // idempotent from a prior aborted run
    seed();

    const before = currentFingerprint();
    expect(fingerprintRows().some((r) => r.guideNumber === "990210")).toBe(true);
    expect(lineupRows("http://x/auto").some((r) => r.GuideNumber === "990210")).toBe(true);

    // The probe marks the channel's only source dead — a routine, reversible event.
    sqlite.exec(`UPDATE streams SET health = 'dead' WHERE id = ${S1}`);

    // Served lineup correctly drops it (players would just spin on a dead source)…
    expect(lineupRows("http://x/auto").some((r) => r.GuideNumber === "990210")).toBe(false);
    // …but the lineup DEFINITION is unchanged, so the fingerprint must not move.
    expect(fingerprintRows().some((r) => r.guideNumber === "990210")).toBe(true);
    expect(currentFingerprint()).toBe(before);

    // And it recovers without ever having disturbed convergence.
    sqlite.exec(`UPDATE streams SET health = 'live' WHERE id = ${S1}`);
    expect(currentFingerprint()).toBe(before);
  });

  test("a real lineup change still moves the fingerprint", () => {
    cleanup();
    seed();
    const before = currentFingerprint();
    sqlite.exec(`UPDATE channels SET name = 'FP Test Channel RENAMED' WHERE id = ${C1}`);
    expect(currentFingerprint()).not.toBe(before);
    sqlite.exec(`UPDATE channels SET is_hidden = 1 WHERE id = ${C1}`);
    expect(fingerprintRows().some((r) => r.guideNumber === "990210")).toBe(false);
  });
});

describe("fingerprintRows / currentFingerprint drift detection (regression guard)", () => {
  test("fingerprintRows carries canonicalId/guideNumber/name/logoUrl/category for a real channel", () => {
    cleanup();
    seed();

    const row = fingerprintRows().find((r) => r.guideNumber === "990210");
    expect(row).toEqual({ canonicalId: `fp.test.${C1}`, guideNumber: "990210", name: `FP Test Channel ${C1}`, logoUrl: "http://logo.example/original.png", category: "sports" });
  });

  test("a logo-only change flips the fingerprint — fails if logo is dropped from the projection", () => {
    cleanup();
    seed();

    const before = currentFingerprint();
    sqlite.exec(`UPDATE channels SET logo_url = 'http://logo.example/CHANGED.png' WHERE id = ${C1}`);
    const after = currentFingerprint();

    expect(after).not.toBe(before);
  });

  test("a category-only change flips the fingerprint — fails if category is dropped from the projection", () => {
    cleanup();
    seed();

    const before = currentFingerprint();
    sqlite.exec(`UPDATE channels SET category = 'news' WHERE id = ${C1}`);
    const after = currentFingerprint();

    expect(after).not.toBe(before);
  });
});
