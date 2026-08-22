/**
 * Health-prober memory repro — NOT a test (bun test skips non-.test.ts).
 *
 * Third suspect after the muxer and the sync jobs both plateaued. The prober's
 * hot path per stream: fetch up to 1.2MB of TS into JS chunks, concatenate,
 * hand the whole buffer to `Bun.spawn(ffprobe, { stdin: bytes })`. Prod runs
 * ~170 of these per 10min (432 in the window before the OOM kill). If the
 * spawn-stdin handoff (or the sample assembly) retains native memory, RSS
 * ratchets while the JS heap stays flat — the exact prod fingerprint.
 *
 * Exercises the REAL functions (fetchSample is module-private, so we go through
 * probe.ts's exported classifySample for the spawn path, and replicate the
 * sample fetch against a local server for the network path).
 *
 * Run inside the image: bun tests/proberleak.repro.ts        # 400 probes
 *                       ITERS=1000 bun tests/proberleak.repro.ts
 */
import "./setup.ts"; // probe.ts → egress.ts prepares SQL at import time — needs the test DB

import { heapStats } from "bun:jsc";
import { classifySample } from "../src/health/probe.ts";

const ITERS = Number(process.env.ITERS) || 400;
const SAMPLE_BYTES = 1_200_000;

// Valid-but-boring TS packets: ffprobe parses them, finds no video, returns
// "degraded" — same code path as probing a junk stream, full spawn round-trip.
const TS = new Uint8Array(SAMPLE_BYTES);
for (let i = 0; i + 188 <= TS.length; i += 188) { TS[i] = 0x47; TS[i + 1] = 0x1f; TS[i + 2] = 0xff; }

// Local server for the fetch/assembly half of the path.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() { return new Response(TS, { headers: { "content-type": "video/mp2t" } }); },
});

// Mirrors probe.ts fetchSample (module-private): chunked read + concat.
async function fetchSample(url: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  const reader = res.body!.getReader();
  while (n < SAMPLE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(value); n += value.length; }
  }
  try { await reader.cancel(); } catch { /* gone */ }
  const buf = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf;
}

const MB = (n: number) => (n / 1024 / 1024).toFixed(1).padStart(7);
function sample(label: string) {
  Bun.gc(true);
  const h = heapStats();
  console.log(`${label.padEnd(10)} rss ${MB(process.memoryUsage().rss)}MB  jsHeap ${MB(h.heapSize)}MB  objects ${String(h.objectCount).padStart(8)}`);
  return process.memoryUsage().rss;
}

console.log(`iters=${ITERS} sample=${SAMPLE_BYTES} bytes  (prod: ~170 probes/10min, 432 pre-OOM)\n`);
const r0 = sample("baseline");
let firstCheckpoint = 0;
for (let i = 1; i <= ITERS; i++) {
  const bytes = await fetchSample(`http://127.0.0.1:${server.port}/s.ts`);
  const outcome = await classifySample(bytes);
  if (i === 1 && outcome.health === "live") console.log("  [warn] synthetic TS classified live — unexpected");
  if (i % 50 === 0) {
    const r = sample(`probe ${i}`);
    if (i === 50) firstCheckpoint = r;
  }
}
const rLast = sample("final");
const n = Math.max(1, ITERS - 50);
console.log(`\nper-probe growth, probe 50 → ${ITERS} (after forced GC): ${(((rLast - firstCheckpoint) / n) / 1024).toFixed(1)} KB/probe`);
console.log(`prod-rate projection: ${((rLast - firstCheckpoint) / n * 170 * 6 / 1024 / 1024).toFixed(0)} MB/hour at 170 probes/10min`);

server.stop(true);
process.exit(0);
