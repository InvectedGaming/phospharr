/**
 * Combined-load memory repro — NOT a test (bun test skips non-.test.ts).
 *
 * Every subsystem plateaus IN ISOLATION (muxerleak / syncleak / proberleak
 * repros), yet prod rests at 1.6GiB after boot and ratchets to the 4GiB OOM in
 * ~6.5h. Hypothesis: it's the INTERLEAVING — concurrent big native transients
 * (catalog JSON, XMLTV, probe samples, stream buffers) fragment allocator
 * arenas so freed pages never return, which no isolated loop reproduces.
 *
 * So: run all of them at once, staggered like prod —
 *   - a churn viewer on a flaky source (reconnect burn + re-attach, continuous)
 *   - prober: fetch 1.2MB sample + ffprobe spawn, every ~1.5s
 *   - sync cycle (VOD + EPG + guide snapshot) every SYNC_EVERY_S
 * and sample GC'd RSS on a timer for DURATION_S.
 *
 * Run inside the image: bun tests/combinedleak.repro.ts     # 8 minutes
 *   DURATION_S=1200 bun tests/combinedleak.repro.ts         # longer trend
 */
import "./setup.ts"; // own migrated DB, torn down at exit — never production

import { Database } from "bun:sqlite";
import { heapStats } from "bun:jsc";
import { pool } from "../src/scheduler/pool.ts";
import { getSettings } from "../src/settings.ts";

const DURATION_S = Number(process.env.DURATION_S) || 480;
const SYNC_EVERY_S = Number(process.env.SYNC_EVERY_S) || 60; // prod is 15min+; compressed to force interleaving
const MOVIES = 25_000, SERIES = 6_000, CHANNELS = 2_000, PROGRAMMES = 25_000;
const P_LIVE = 990501, C_LIVE = 990510, S_LIVE = 990520, P_XT = 990502;

// ------------------------------------------------- fixture: flaky TS source
const PKT = new Uint8Array(188 * 40);
for (let i = 0; i < PKT.length; i += 188) { PKT[i] = 0x47; PKT[i + 1] = 0x1f; PKT[i + 2] = 0xff; }
const SAMPLE = new Uint8Array(1_200_000);
for (let i = 0; i + 188 <= SAMPLE.length; i += 188) { SAMPLE[i] = 0x47; SAMPLE[i + 1] = 0x1f; SAMPLE[i + 2] = 0xff; }

function vodMoviesJson(): string {
  const rows = [];
  for (let i = 1; i <= MOVIES; i++) rows.push({ stream_id: i, name: `Movie ${i} (2021)`, category_id: String(i % 40), stream_icon: `http://img.local/p${i}.jpg`, container_extension: "mkv", rating: (i % 100) / 10, added: String(1700000000 + i) });
  return JSON.stringify(rows);
}
function vodSeriesJson(): string {
  const rows = [];
  for (let i = 1; i <= SERIES; i++) rows.push({ series_id: i, name: `Series ${i} (2021)`, category_id: String(i % 30), cover: `http://img.local/s${i}.jpg`, plot: `Plot for series ${i}. `.repeat(4) });
  return JSON.stringify(rows);
}
function xmltv(): string {
  const parts = [`<?xml version="1.0" encoding="UTF-8"?>\n<tv>`];
  for (let c = 0; c < CHANNELS; c++) parts.push(`<channel id="combo.ch${c}"><display-name>Combo ${c}</display-name></channel>`);
  const perCh = Math.ceil(PROGRAMMES / CHANNELS);
  const t0 = Date.UTC(2026, 7, 22);
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
  };
  for (let c = 0; c < CHANNELS; c++) for (let i = 0; i < perCh; i++) {
    const s = t0 + i * 30 * 60_000;
    parts.push(`<programme start="${fmt(s)}" stop="${fmt(s + 30 * 60_000)}" channel="combo.ch${c}"><title>Show ${c}-${i}</title><desc>Ep ${i}.</desc></programme>`);
  }
  parts.push(`</tv>`);
  return parts.join("\n");
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/flaky.ts") { // dies young, like the prod source
      let timer: ReturnType<typeof setInterval> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          timer = setInterval(() => { try { ctrl.enqueue(PKT); } catch { /* closed */ } }, 200);
          setTimeout(() => { if (timer) clearInterval(timer); try { ctrl.error(new Error("hangup")); } catch { /* closed */ } }, 1_500);
        },
        cancel() { if (timer) clearInterval(timer); },
      });
      return new Response(stream, { headers: { "content-type": "video/mp2t" } });
    }
    if (url.pathname === "/sample.ts") return new Response(SAMPLE, { headers: { "content-type": "video/mp2t" } });
    if (url.pathname === "/epg.xml") return new Response(xmltv(), { headers: { "content-type": "application/xml" } });
    const action = url.searchParams.get("action");
    if (action === "get_vod_streams") return new Response(vodMoviesJson(), { headers: { "content-type": "application/json" } });
    if (action === "get_series") return new Response(vodSeriesJson(), { headers: { "content-type": "application/json" } });
    if (action === "get_vod_categories" || action === "get_series_categories") return Response.json(Array.from({ length: 40 }, (_, i) => ({ category_id: String(i), category_name: `Cat ${i}` })));
    return new Response("{}", { headers: { "content-type": "application/json" } });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

// ------------------------------------------------------------------- seed rows
const sqlite = new Database(process.env.DATABASE_URL!);
sqlite.exec(`INSERT INTO providers (id,name,type,url,max_connections,priority,enabled)
             VALUES (${P_LIVE},'combo_live','custom','${BASE}',4,100,1)`);
sqlite.exec(`INSERT INTO providers (id,name,type,url,username,password,max_connections,priority,enabled)
             VALUES (${P_XT},'combo_xt','xtream','${BASE}','u','p',4,100,1)`);
sqlite.exec(`INSERT INTO channels (id,canonical_id,name,number,category,is_hidden)
             VALUES (${C_LIVE},'combo.live','Combo Live',990599,'test',0)`);
sqlite.exec(`INSERT INTO streams (id,channel_id,provider_id,url,raw_name,health)
             VALUES (${S_LIVE},${C_LIVE},${P_LIVE},'${BASE}/flaky.ts','COMBO LIVE','unknown')`);
const insCh = sqlite.prepare(`INSERT INTO channels (canonical_id,name,number,category,is_hidden,epg_channel_id) VALUES (?,?,?,?,0,?)`);
for (let c = 0; c < CHANNELS; c++) insCh.run(`combo.ch${c}`, `Combo ${c}`, 991000 + c, "test", `combo.ch${c}`);
insCh.finalize();

await getSettings();
pool.setBudget(P_LIVE, 4);
pool.setBudget(P_XT, 4);

const { muxer } = await import("../src/proxy/muxer.ts");
const { syncVod } = await import("../src/ingest/vod.ts");
const { syncEpgFromUrls } = await import("../src/epg/merge.ts");
const { getGuideSnapshot, invalidateGuideSnapshot } = await import("../src/epg/snapshot.ts");
const { classifySample } = await import("../src/health/probe.ts");

// ------------------------------------------------------------------ measuring
const MB = (n: number) => (n / 1024 / 1024).toFixed(1).padStart(7);
const t0 = Date.now();
const counts = { churn: 0, probes: 0, syncs: 0 };
const rssSeries: number[] = [];
function tick(label: string) {
  Bun.gc(true);
  const h = heapStats();
  const rss = process.memoryUsage().rss;
  rssSeries.push(rss);
  console.log(`t=${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s ${label.padEnd(8)} rss ${MB(rss)}MB  jsHeap ${MB(h.heapSize)}MB  churns=${counts.churn} probes=${counts.probes} syncs=${counts.syncs}`);
}

const deadline = t0 + DURATION_S * 1000;
let stopping = false;

// --------------------------------------------------------------- worker loops
const churnLoop = (async () => {
  while (!stopping && Date.now() < deadline) {
    const body = await muxer.open(C_LIVE, undefined, { preroll: false });
    if (!body) { await Bun.sleep(250); continue; }
    const reader = body.getReader();
    while (true) { const { done } = await reader.read(); if (done) break; }
    counts.churn++;
  }
})();

const probeLoop = (async () => {
  while (!stopping && Date.now() < deadline) {
    const res = await fetch(`${BASE}/sample.ts`).catch(() => null);
    if (res?.body) {
      const chunks: Uint8Array[] = [];
      let n = 0;
      const reader = res.body.getReader();
      while (n < SAMPLE.length) { const { done, value } = await reader.read(); if (done) break; if (value) { chunks.push(value); n += value.length; } }
      const buf = new Uint8Array(n);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
      await classifySample(buf);
      counts.probes++;
    }
    await Bun.sleep(1_500); // prod prober tick
  }
})();

const syncLoop = (async () => {
  while (!stopping && Date.now() < deadline) {
    await syncVod(P_XT).catch((e) => console.error("[combo vod]", e.message));
    await syncEpgFromUrls([`${BASE}/epg.xml`]).catch((e) => console.error("[combo epg]", e.message));
    invalidateGuideSnapshot();
    await getGuideSnapshot().catch(() => {});
    counts.syncs++;
    await Bun.sleep(SYNC_EVERY_S * 1000);
  }
})();

const sampleLoop = (async () => {
  while (Date.now() < deadline) { await Bun.sleep(30_000); tick("sample"); }
})();

tick("baseline");
await Promise.all([churnLoop, probeLoop, syncLoop, sampleLoop]);
stopping = true;
tick("final");

// ------------------------------------------------------------------- verdict
const half = Math.floor(rssSeries.length / 2);
const a = rssSeries.slice(1, half + 1), b = rssSeries.slice(half + 1);
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const slope = (avg(b) - avg(a)) / ((DURATION_S / 2) / 3600) / 1024 / 1024;
console.log(`\nfirst-half avg ${MB(avg(a))}MB → second-half avg ${MB(avg(b))}MB`);
console.log(`trend ≈ ${slope.toFixed(0)} MB/hour under combined load (prod leaked ~580 MB/hour)`);

server.stop(true);
process.exit(0);
