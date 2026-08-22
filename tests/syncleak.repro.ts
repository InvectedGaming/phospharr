/**
 * Periodic-job memory repro — NOT a test (bun test skips non-.test.ts).
 *
 * The muxer was acquitted (see muxerleak.repro.ts): reconnect churn holds RSS
 * flat. What ratchets prod from ~215MB to the 4GiB OOM kill is suspected to be
 * the recurring jobs — VOD catalog sync (58k movies / 13k series), EPG refresh
 * (50k programmes), and the guide-snapshot rebuild each refresh invalidates.
 *
 * This loops those three at prod scale against local fixtures and samples the
 * live set (forced GC) after EACH phase, so growth is attributed per job.
 *
 * Run inside the image (worktree mounted at /app):
 *   bun tests/syncleak.repro.ts               # 8 cycles, prod-sized
 *   CYCLES=15 MOVIES=10000 bun tests/syncleak.repro.ts
 */
import "./setup.ts"; // own migrated DB, torn down at exit — never production

import { Database } from "bun:sqlite";
import { heapStats } from "bun:jsc";
import { getSettings } from "../src/settings.ts";

const CYCLES = Number(process.env.CYCLES) || 8;
const MOVIES = Number(process.env.MOVIES) || 50_000;
const SERIES = Number(process.env.SERIES) || 13_000;
const CHANNELS = Number(process.env.CHANNELS) || 200;
const PROGRAMMES = Number(process.env.PROGRAMMES) || 50_000; // spread across CHANNELS
const P = 990401; // id-space idiom from fingerprint.test.ts

// ------------------------------------------------------------- local fixtures
// Deterministic payloads, identical every cycle — so cycle 2+ is a pure resync
// (ON CONFLICT upsert path), exactly what prod does every few hours. Payloads
// are rebuilt per request on purpose: the transient JSON/XML strings must be
// collectable, and if the SYNC retains them we want to see it.
function vodMoviesJson(): string {
  const rows = [];
  for (let i = 1; i <= MOVIES; i++) {
    rows.push({ stream_id: i, name: `Movie ${i} (20${String(i % 26).padStart(2, "0")})`, category_id: String(i % 40), stream_icon: `http://img.local/p${i}.jpg`, container_extension: "mkv", rating: (i % 100) / 10, added: String(1700000000 + i) });
  }
  return JSON.stringify(rows);
}
function vodSeriesJson(): string {
  const rows = [];
  for (let i = 1; i <= SERIES; i++) {
    rows.push({ series_id: i, name: `Series ${i} (2021)`, category_id: String(i % 30), cover: `http://img.local/s${i}.jpg`, plot: `Plot for series ${i}. `.repeat(4) });
  }
  return JSON.stringify(rows);
}
function catsJson(n: number): string {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({ category_id: String(i), category_name: `Category ${i}` })));
}
function xmltv(): string {
  const parts = [`<?xml version="1.0" encoding="UTF-8"?>\n<tv>`];
  for (let c = 0; c < CHANNELS; c++) parts.push(`<channel id="repro.ch${c}"><display-name>Repro ${c}</display-name></channel>`);
  const perCh = Math.ceil(PROGRAMMES / CHANNELS);
  const t0 = Date.UTC(2026, 7, 22); // fixed epoch — identical feed every cycle
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
  };
  for (let c = 0; c < CHANNELS; c++) {
    for (let i = 0; i < perCh; i++) {
      const start = t0 + i * 30 * 60_000; // 30-min slots
      parts.push(`<programme start="${fmt(start)}" stop="${fmt(start + 30 * 60_000)}" channel="repro.ch${c}"><title>Show ${c}-${i}</title><desc>Episode ${i} on channel ${c}.</desc></programme>`);
    }
  }
  parts.push(`</tv>`);
  return parts.join("\n");
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/epg.xml") return new Response(xmltv(), { headers: { "content-type": "application/xml" } });
    const action = url.searchParams.get("action");
    if (action === "get_vod_categories") return Response.json(JSON.parse(catsJson(40)));
    if (action === "get_series_categories") return Response.json(JSON.parse(catsJson(30)));
    if (action === "get_vod_streams") return new Response(vodMoviesJson(), { headers: { "content-type": "application/json" } });
    if (action === "get_series") return new Response(vodSeriesJson(), { headers: { "content-type": "application/json" } });
    return new Response("{}", { headers: { "content-type": "application/json" } });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

// ------------------------------------------------------------------- seed rows
const sqlite = new Database(process.env.DATABASE_URL!);
sqlite.exec(`INSERT INTO providers (id,name,type,url,username,password,max_connections,priority,enabled)
             VALUES (${P},'sync_leak_repro','xtream','${BASE}','u','p',4,100,1)`);
const insCh = sqlite.prepare(`INSERT INTO channels (canonical_id,name,number,category,is_hidden,epg_channel_id)
                              VALUES (?,?,?,?,0,?)`);
for (let c = 0; c < CHANNELS; c++) insCh.run(`repro.ch${c}`, `Repro ${c}`, 990500 + c, "test", `repro.ch${c}`);
insCh.finalize();

await getSettings(); // prime the settings cache like index.ts does

const { syncVod } = await import("../src/ingest/vod.ts");
const { syncEpgFromUrls } = await import("../src/epg/merge.ts");
const { getGuideSnapshot, invalidateGuideSnapshot } = await import("../src/epg/snapshot.ts");

// ------------------------------------------------------------------ measuring
function sample(label: string) {
  Bun.gc(true);
  const h = heapStats();
  return { label, rss: process.memoryUsage().rss, heapSize: h.heapSize, objects: h.objectCount };
}
const MB = (n: number) => (n / 1024 / 1024).toFixed(1).padStart(7);
const byPhase: Record<string, ReturnType<typeof sample>[]> = { vod: [], epg: [], snap: [] };
function report(phase: string, s: ReturnType<typeof sample>) {
  byPhase[phase].push(s);
  console.log(`${s.label.padEnd(10)} rss ${MB(s.rss)}MB  jsHeap ${MB(s.heapSize)}MB  objects ${String(s.objects).padStart(8)}`);
}

// ---------------------------------------------------------------------- cycle
console.log(`cycles=${CYCLES} movies=${MOVIES} series=${SERIES} programmes=${PROGRAMMES}\n`);
console.log(`${"baseline".padEnd(10)} rss ${MB(process.memoryUsage().rss)}MB`);

for (let cycle = 1; cycle <= CYCLES; cycle++) {
  const t0 = Date.now();
  await syncVod(P);
  report("vod", sample(`vod ${cycle}`));

  const epgRes = await syncEpgFromUrls([`${BASE}/epg.xml`]);
  if (cycle === 1) console.log(`  [epg bound: ${epgRes.reduce((n, r) => n + r.programmesBound, 0)} programmes]`);
  report("epg", sample(`epg ${cycle}`));

  invalidateGuideSnapshot(); // what a real refresh does…
  await getGuideSnapshot(); // …and the next /api/guide hit rebuilds
  report("snap", sample(`snap ${cycle}`));
  console.log(`  cycle ${cycle} took ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

// ------------------------------------------------------------------- verdict
console.log(`per-cycle growth, cycle 2 → ${CYCLES} (after forced GC; cycle 1 pays one-time costs):`);
for (const [phase, rows] of Object.entries(byPhase)) {
  if (rows.length < 3) continue;
  const first = rows[1], last = rows[rows.length - 1];
  const n = rows.length - 2 || 1;
  console.log(`  ${phase.padEnd(5)} rss ${((last.rss - first.rss) / n / 1024).toFixed(0).padStart(6)} KB/cycle   jsHeap ${((last.heapSize - first.heapSize) / n / 1024).toFixed(0).padStart(6)} KB/cycle   objects ${Math.round((last.objects - first.objects) / n)}/cycle`);
}

server.stop(true);
process.exit(0);
