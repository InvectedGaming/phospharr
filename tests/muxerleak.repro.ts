/**
 * Muxer reconnect-churn memory repro — NOT a test (bun test skips non-.test.ts).
 *
 * Reproduces the 2026-08-22 OOM pattern: a flaky source that dies every ~1.5s
 * (under RECONNECT_HEALTHY_MS, so the budget streak burns to RECONNECT_MAX and
 * the mux tears down "died, no alternates"), plus a client that re-attaches the
 * instant it gets EOF — mpegts.js's auto-reconnect behavior, i.e. the frozen
 * browser tab that kept channel 4859 dialing all evening.
 *
 * Run inside the image (worktree mounted at /app):
 *   bun tests/muxerleak.repro.ts                 # churn mode (the suspect path)
 *   MODE=steady bun tests/muxerleak.repro.ts     # control: same pump, no churn
 *   CYCLES=40 bun tests/muxerleak.repro.ts       # more cycles for a longer trend
 *
 * Verdict logic: after forced GC, live-set growth per churn cycle. The control
 * run tells us what "normal" is; churn minus control is the leak.
 */
import "./setup.ts"; // own migrated DB, torn down at exit — never production

import { Database } from "bun:sqlite";
import { heapStats } from "bun:jsc";
import { pool } from "../src/scheduler/pool.ts";
import { getSettings } from "../src/settings.ts";

const MODE = process.env.MODE === "steady" ? "steady" : "churn";
const CYCLES = Number(process.env.CYCLES) || 20;
const P = 990301, C = 990310, S = 990320; // same id-space idiom as fingerprint.test.ts

// ---------------------------------------------------------------- flaky source
// 188-byte TS packets (0x47 sync) in 200ms bursts. In churn mode the connection
// is hard-closed after ~1.5s — matching the measured sub-RECONNECT_HEALTHY_MS
// drops that burn the reconnect budget instead of resetting it.
const PKT = new Uint8Array(188 * 40); // 40 packets per burst ≈ 37KB/s — shape over volume
for (let i = 0; i < PKT.length; i += 188) { PKT[i] = 0x47; PKT[i + 1] = 0x1f; PKT[i + 2] = 0xff; }

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() {
    let timer: ReturnType<typeof setInterval> | null = null;
    let killer: ReturnType<typeof setTimeout> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        timer = setInterval(() => { try { ctrl.enqueue(PKT); } catch { /* closed */ } }, 200);
        if (MODE === "churn") {
          killer = setTimeout(() => { // die young: uptime < RECONNECT_HEALTHY_MS
            if (timer) clearInterval(timer);
            try { ctrl.error(new Error("provider hung up")); } catch { /* closed */ }
          }, 1_500);
        }
      },
      cancel() { if (timer) clearInterval(timer); if (killer) clearTimeout(killer); },
    });
    return new Response(stream, { headers: { "content-type": "video/mp2t" } });
  },
});

// ------------------------------------------------------------------- seed rows
const sqlite = new Database(process.env.DATABASE_URL!);
sqlite.exec(`INSERT INTO providers (id,name,type,url,max_connections,priority,enabled)
             VALUES (${P},'leak_repro','custom','http://127.0.0.1:${server.port}',4,100,1)`);
sqlite.exec(`INSERT INTO channels (id,canonical_id,name,number,category,is_hidden)
             VALUES (${C},'leak.repro','Leak Repro',990310,'test',0)`);
sqlite.exec(`INSERT INTO streams (id,channel_id,provider_id,url,raw_name,health)
             VALUES (${S},${C},${P},'http://127.0.0.1:${server.port}/live.ts','LEAK REPRO','unknown')`);

await getSettings(); // prime the settings cache (jitterMs etc.) like index.ts does
pool.setBudget(P, 4); // primePool() equivalent for our one provider

// muxer imported AFTER env/DB are ready (it touches cachedSetting at call time,
// but keep the ordering defensive anyway).
const { muxer } = await import("../src/proxy/muxer.ts");

// ------------------------------------------------------------------ measuring
function sample(label: string) {
  Bun.gc(true); // force a full collection: what remains is the live set
  const h = heapStats();
  const rss = process.memoryUsage().rss;
  return { label, rss, heapSize: h.heapSize, objects: h.objectCount };
}
const MB = (n: number) => (n / 1024 / 1024).toFixed(1).padStart(7);
const rows: ReturnType<typeof sample>[] = [];
function report(s: ReturnType<typeof sample>) {
  rows.push(s);
  console.log(`${s.label.padEnd(12)} rss ${MB(s.rss)}MB  jsHeap ${MB(s.heapSize)}MB  objects ${String(s.objects).padStart(8)}`);
}

// ------------------------------------------------------------- churn the muxer
// The "tab": open, drain until EOF, immediately re-open. In churn mode one
// open() survives ~5 die/reconnect rounds (~8-10s) before the mux gives up and
// EOFs us — one full prod churn cycle. In steady mode open() never EOFs, so we
// detach/re-attach on a timer to exercise attach/detach without source churn.
console.log(`mode=${MODE} cycles=${CYCLES} source=http://127.0.0.1:${server.port}\n`);
report(sample("baseline"));

for (let cycle = 1; cycle <= CYCLES; cycle++) {
  const body = await muxer.open(C, undefined, { preroll: false });
  if (!body) { // pool briefly saturated mid-teardown — the tab would just retry
    await Bun.sleep(250);
    cycle--;
    continue;
  }
  const reader = body.getReader();
  if (MODE === "steady") {
    const stop = Date.now() + 10_000; // match a churn cycle's wall time
    while (Date.now() < stop) { const { done } = await reader.read(); if (done) break; }
    await reader.cancel().catch(() => {});
  } else {
    while (true) { const { done } = await reader.read(); if (done) break; } // drain to EOF
  }
  report(sample(`cycle ${cycle}`));
}

// ------------------------------------------------------------------- verdict
const first = rows[1] ?? rows[0]; // skip baseline: first cycle pays one-time costs
const last = rows[rows.length - 1];
const n = Math.max(1, rows.length - 2);
console.log(`\nper-cycle growth over ${n} cycles (after forced GC):`);
console.log(`  rss    ${((last.rss - first.rss) / n / 1024).toFixed(1)} KB/cycle`);
console.log(`  jsHeap ${((last.heapSize - first.heapSize) / n / 1024).toFixed(1)} KB/cycle`);
console.log(`  objects ${Math.round((last.objects - first.objects) / n)} /cycle`);

server.stop(true);
process.exit(0);
