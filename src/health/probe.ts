import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels, streams } from "../db/schema.ts";
import { providerEgress } from "../net/egress.ts";
import { pool } from "../scheduler/pool.ts";
import { getSetting } from "../settings.ts";
import { qualityScore } from "../canonical/matcher.ts";
import { registerLoop } from "./watchdog.ts";
import { sendAlert } from "../alerts.ts";
import { updateVerdicts, type VerdictChange } from "./verdict.ts";

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

/** One probe's outcome, folded into the enclosing provider's health verdict
 *  (see verdict.ts). "healthy" here means "we got real bytes back", NOT
 *  "the picture is perfect" — a stream classified `degraded` (bytes flowed,
 *  ffprobe just couldn't find decodable video) still counts as healthy for
 *  PROVIDER purposes, because it proves the provider was reachable. Only
 *  `dead` (too few bytes / fetch failure) counts against it — that keeps a
 *  provider's verdict about connectivity, not about a handful of genuinely
 *  broken individual channels dragging down an otherwise fine source. */
type ProbeVerdictRow = { providerId: number; healthy: boolean };

async function probeOne(s: Due): Promise<ProbeVerdictRow | void> {
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
    return { providerId: s.providerId, healthy: o.health !== "dead" };
  } finally {
    pool.release(s.providerId);
  }
}

let started = false;
let beat: () => void = () => {};
let watchdogRegistered = false;

// Epoch guard: a restart has no way to cancel a wedged `await` in the old
// loop instance, so instead every loop iteration is stamped with the
// generation active when it started. If a stuck iteration ever resumes, it
// checks its stamp against the current generation at every await boundary
// and retires instead of racing the fresh loop a restart already spun up —
// this file is a "polite tenant" of the provider slot pool, so two loops
// probing concurrently is exactly what must never happen. Exported for tests.
let generation = 0;
export function _bumpGeneration(): number { return ++generation; }
export function _isStaleGeneration(gen: number): boolean { return gen !== generation; }

// Collaborators the loop body needs, factored out so tests can drive
// `_probeIteration` with stubs instead of a real DB/ffprobe/settings row —
// production always calls it with the real implementations (the default).
type ProbeCollaborators = {
  getSetting: (key: "features.healthProbe") => Promise<boolean>;
  dueStreams: (limit: number) => Promise<Due[]>;
  probeOne: (s: Due) => Promise<ProbeVerdictRow | void>;
  sendAlert: (kind: string, message: string) => Promise<boolean>;
};
const realCollaborators: ProbeCollaborators = { getSetting, dueStreams, probeOne, sendAlert };

type IterationResult = "retire" | "idle" | "probed";

// How often accumulated (providerId, healthy) outcomes are flushed into
// updateVerdicts — i.e. what counts as one verdict "round". Reuses the same
// cadence as the existing periodic probe-count log below (state.lastLog) so
// there's a single timer to reason about instead of two independent ones.
// A quiet catalog (few due streams) may take longer than this to accumulate
// MIN_PROBED samples for a given provider — that's fine: updateVerdicts
// leaves an under-sampled provider's verdict untouched, so a slow trickle
// just means "no verdict change yet", never a wrong one.
const VERDICT_ROUND_MS = 10 * 60_000;

/** Flush accumulated probe outcomes into a verdict round when due, log the
 *  probe throughput the way this loop always has, and alert on any verdict
 *  transition. Called from both the "found due streams" and "nothing due"
 *  paths so a quiet catalog still gets its verdicts flushed on schedule
 *  instead of waiting indefinitely for the next probe to trigger it. */
function flushVerdictsIfDue(
  state: { probed: number; lastLog: number; roundOutcomes?: ProbeVerdictRow[] },
  deps: ProbeCollaborators,
): void {
  if (Date.now() - state.lastLog <= VERDICT_ROUND_MS) return;
  console.log(`[health] probed ${state.probed} streams in the last ${Math.round((Date.now() - state.lastLog) / 60000)}min`);
  const changes: VerdictChange[] = updateVerdicts(state.roundOutcomes ?? []);
  state.roundOutcomes = [];
  state.probed = 0;
  state.lastLog = Date.now();
  for (const c of changes) {
    // kind carries the provider id (never the message — see alerts.ts's dedup
    // contract) and the message text is fixed per target verdict (no "from"
    // state, no counts), so a flapping provider collapses onto at most the 3
    // possible (kind, message) pairs — sendAlert's own 1h dedup window then
    // caps each of those to one delivery, bounding worst-case alert volume
    // for a flapping provider instead of paging on every single transition.
    void deps.sendAlert(`provider:${c.providerId}`, `provider health is now ${c.to}`);
  }
}

/** One iteration of the probe loop's body. Exported (with injectable
 *  collaborators) so the generation guard's placement — the exact thing a
 *  future refactor could accidentally drop — is exercised by a real test
 *  instead of only by a standalone unit test of `_isStaleGeneration` itself.
 *  Mirrors the try-block that used to live inline in `startHealthProbe`'s
 *  loop, checks included, unchanged. */
export async function _probeIteration(
  myGen: number,
  state: { probed: number; lastLog: number; roundOutcomes?: ProbeVerdictRow[] },
  deps: ProbeCollaborators = realCollaborators,
): Promise<IterationResult> {
  if (_isStaleGeneration(myGen)) return "retire"; // a restart replaced us — retire, don't double-probe
  beat();
  try {
    if (!(await deps.getSetting("features.healthProbe"))) return "idle";
    if (_isStaleGeneration(myGen)) return "retire";
    const batch = await deps.dueStreams(CONCURRENCY);
    if (_isStaleGeneration(myGen)) return "retire";
    if (batch.length === 0) {
      flushVerdictsIfDue(state, deps); // quiet catalog still gets its round flushed on schedule
      return "idle";
    }
    const results = await Promise.all(
      batch.map((s) => deps.probeOne(s).catch(() => undefined)), // one bad probe never stops the loop, and an error (vs. a measured "dead") carries no verdict signal
    );
    if (_isStaleGeneration(myGen)) return "retire"; // don't log, re-arm, or verdict-count on behalf of a superseded round
    state.probed += batch.length;
    for (const r of results) if (r) (state.roundOutcomes ??= []).push(r);
    flushVerdictsIfDue(state, deps);
    return "probed";
  } catch (e) {
    // Loop must survive anything (DB hiccup, ffprobe missing) — retry later.
    console.error("[health] probe loop error:", e instanceof Error ? e.message : e);
    return "idle";
  }
}

/** Start the background probe loop (idempotent). Honors features.healthProbe live.
 *  Also the watchdog's restart target: since this loop has no timer to clear
 *  (it's a plain while(true) + Bun.sleep), a restart just flips `started`
 *  back off and re-enters — a fresh loop takes over, and the old one retires
 *  itself via the generation guard above rather than running alongside it. */
export function startHealthProbe(): void {
  if (started) return;
  started = true;
  const myGen = _bumpGeneration();
  if (!watchdogRegistered) {
    watchdogRegistered = true; // register once so the watchdog's strike count survives our own restarts
    ({ beat } = registerLoop("health-probe", IDLE_MS, () => { started = false; startHealthProbe(); }));
  }
  void (async () => {
    // Let boot finish (tunnels dialing, pool priming) before taking any slots.
    await Bun.sleep(20_000);
    if (_isStaleGeneration(myGen)) return; // superseded before the boot delay even finished
    const state = { probed: 0, lastLog: Date.now() };
    while (true) {
      const result = await _probeIteration(myGen, state);
      if (result === "retire") return;
      await Bun.sleep(result === "probed" ? TICK_MS : IDLE_MS);
    }
  })();
}
