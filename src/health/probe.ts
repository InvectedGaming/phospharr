import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels, streams } from "../db/schema.ts";
import { providerEgress } from "../net/egress.ts";
import { pool } from "../scheduler/pool.ts";
import { getSetting } from "../settings.ts";
import { qualityScore } from "../canonical/matcher.ts";

/**
 * Health probe loop: pull a short slice of each stream (through its provider's
 * proper egress — VPN pins included, fail-closed) and ffprobe it, writing
 * health/resolution/codec back to the DB. That's what turns the UI badges and
 * `selectStream`'s dead-avoidance from guesses into measurements, and lets the
 * tuner outputs (HDHR/M3U) drop channels every source of which is provably dead
 * — so Emby/Jellyfin never list a channel that can only spin.
 *
 * It is deliberately a POLITE background tenant of the provider slot pool:
 * a probe only runs when it can leave HEADROOM slots free for real viewers, so
 * watching TV always wins over probing. Never-probed streams go first, then the
 * stalest; anything probed within REPROBE_MS is left alone.
 */

// ffprobe ships next to ffmpeg (jellyfin-ffmpeg in the container).
const FFPROBE =
  process.env.PHOSPHARR_FFPROBE ||
  (process.env.FFMPEG_PATH ? process.env.FFMPEG_PATH.replace(/ffmpeg([^/\\]*)$/, "ffprobe$1") : "ffprobe");

const HEADROOM_SLOTS = 2; // always leave this many provider slots for viewers
const CONCURRENCY = 2; // max simultaneous probes (each holds a slot while it runs)
const SAMPLE_BYTES = 1_200_000; // enough TS for ffprobe to find PAT/PMT + a keyframe
const SAMPLE_MS = 8_000; // slow feeds: give up on the sample after this
const REPROBE_MS = 12 * 3600_000; // full re-sweep cadence per stream
const IDLE_MS = 5 * 60_000; // sleep when nothing is due
const TICK_MS = 1_500; // gap between probe starts (spreads provider load)

export interface ProbeOutcome {
  health: "live" | "degraded" | "dead";
  resolution: number | null;
  codec: string | null;
  fps: number | null;
}

/** Classify a fetched sample via ffprobe. Exported for tests. */
export async function classifySample(bytes: Uint8Array): Promise<ProbeOutcome> {
  if (bytes.byteLength < 50_000) return { health: "dead", resolution: null, codec: null, fps: null };
  try {
    const proc = Bun.spawn(
      [FFPROBE, "-v", "error", "-show_streams", "-of", "json", "pipe:0"],
      { stdin: bytes, stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout as ReadableStream).text();
    await proc.exited;
    const info = JSON.parse(out || "{}") as { streams?: Array<Record<string, unknown>> };
    const v = (info.streams ?? []).find((s) => s.codec_type === "video");
    if (!v) return { health: "degraded", resolution: null, codec: null, fps: null }; // bytes flow, no decodable video
    const [num, den] = String(v.avg_frame_rate ?? "").split("/").map(Number);
    return {
      health: "live",
      resolution: typeof v.height === "number" ? v.height : null,
      codec: typeof v.codec_name === "string" ? v.codec_name : null,
      fps: num && den ? Math.round((num / den) * 100) / 100 : null,
    };
  } catch {
    return { health: "degraded", resolution: null, codec: null, fps: null };
  }
}

/** Fetch a bounded sample of a stream (returns what arrived, empty on failure). */
async function fetchSample(url: string, proxy: string | undefined): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Phospharr/0.1" },
      signal: AbortSignal.timeout(SAMPLE_MS),
      ...(proxy ? { proxy } : {}),
    });
    if (!res.ok || !res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const t0 = Date.now();
    while (n < SAMPLE_BYTES && Date.now() - t0 < SAMPLE_MS) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        n += value.length;
      }
    }
    try { await reader.cancel(); } catch { /* upstream gone */ }
  } catch {
    /* timeout / refused / VPN drop mid-read — whatever arrived decides the verdict */
  }
  const buf = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf;
}

type Due = { id: number; url: string; providerId: number };

async function dueStreams(limit: number): Promise<Due[]> {
  const cutoff = new Date(Date.now() - REPROBE_MS);
  // Hidden channels are skipped: not playable anywhere, so their health is moot.
  return db
    .select({ id: streams.id, url: streams.url, providerId: streams.providerId })
    .from(streams)
    .innerJoin(channels, eq(channels.id, streams.channelId))
    .where(and(eq(channels.isHidden, false), or(isNull(streams.lastProbedAt), lt(streams.lastProbedAt, cutoff))))
    .orderBy(sql`${streams.lastProbedAt} ASC NULLS FIRST`)
    .limit(limit);
}

async function probeOne(s: Due): Promise<void> {
  const eg = providerEgress(s.providerId);
  if (eg.blocked) return; // VPN down: no verdict — never probe direct, never guess
  // Politeness: leave viewers headroom, and skip (not fail) when the pool is busy.
  const usage = pool.usage(s.providerId);
  if (usage.max - usage.used <= HEADROOM_SLOTS) return;
  if (!pool.acquire(s.providerId)) return;
  try {
    const sample = await fetchSample(s.url, "proxy" in eg ? eg.proxy : undefined);
    const o = await classifySample(sample);
    await db
      .update(streams)
      .set({
        health: o.health,
        lastProbedAt: new Date(),
        ...(o.resolution != null ? { resolution: o.resolution } : {}),
        ...(o.codec != null ? { codec: o.codec } : {}),
        ...(o.fps != null ? { fps: o.fps } : {}),
        qualityScore: qualityScore(o.resolution ?? undefined, o.health),
      })
      .where(eq(streams.id, s.id));
  } finally {
    pool.release(s.providerId);
  }
}

let started = false;

/** Start the background probe loop (idempotent). Honors features.healthProbe live. */
export function startHealthProbe(): void {
  if (started) return;
  started = true;
  void (async () => {
    // Let boot finish (tunnels dialing, pool priming) before taking any slots.
    await Bun.sleep(20_000);
    let probed = 0;
    let lastLog = Date.now();
    while (true) {
      try {
        if (!(await getSetting("features.healthProbe"))) {
          await Bun.sleep(IDLE_MS);
          continue;
        }
        const batch = await dueStreams(CONCURRENCY);
        if (batch.length === 0) {
          await Bun.sleep(IDLE_MS);
          continue;
        }
        await Promise.all(batch.map((s) => probeOne(s).catch(() => { /* one bad probe never stops the loop */ })));
        probed += batch.length;
        if (Date.now() - lastLog > 10 * 60_000) {
          console.log(`[health] probed ${probed} streams in the last ${Math.round((Date.now() - lastLog) / 60000)}min`);
          probed = 0;
          lastLog = Date.now();
        }
        await Bun.sleep(TICK_MS);
      } catch (e) {
        // Loop must survive anything (DB hiccup, ffprobe missing) — retry later.
        console.error("[health] probe loop error:", e instanceof Error ? e.message : e);
        await Bun.sleep(IDLE_MS);
      }
    }
  })();
}
