import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { guidePushState } from "../db/schema.ts";
import { getSetting, type DownstreamServer } from "../settings.ts";
import { guideRows, type GuideProgram } from "../epg/guide.ts";
import { refreshOne, record } from "../epg/downstream.ts";

/**
 * Push guide programmes into Emby through the Phospharr plugin, so a change is
 * in the guide within seconds instead of after the nightly 15-minute Refresh
 * Guide. See docs/superpowers/specs/2026-09-05-emby-guide-plugin-design.md.
 *
 * Delta only: a per-channel fingerprint of the programme set is kept in
 * guide_push_state; only channels whose set changed are sent. A channel the
 * plugin reports as "channel not found" gets a negative fingerprint marker
 * (`!notfound:<k>:<retryAtMs>`) instead of no fingerprint, so it backs off
 * exponentially (capped at 16h) rather than being re-sent on every push —
 * see `parseNotFound`/`notFoundMarker`. Any other skip reason still stores
 * nothing, so it is retried next push.
 *
 * The plugin being absent must change nothing: a failed Ping falls back to the
 * existing RefreshGuide path (`pushGuide`'s default). Off by default per server.
 * Event-driven callers that only want the push — never a 15-minute RefreshGuide
 * triggered by e.g. a single Twitch title change — use `pushGuideOnly`, which
 * passes `{ fallback: false }` and silently skips servers without the plugin.
 */
export interface PushOutcome {
  serverId: string; mode: "pushed" | "fallback" | "disabled" | "skipped-busy";
  channelsSent: number; created: number; updated: number; deleted: number; skipped: number; channelsDeferred: number; error?: string;
}

const DEFAULT_CHUNK = 200; // channels per POST — keeps a request well under a second of plugin work
const PING_TIMEOUT_MS = 8_000;
const PUSH_TIMEOUT_MS = 120_000;

/** Backoff step for a "channel not found" marker, in hours, capped at 16h. */
const NOTFOUND_CAP_HOURS = 16;
const HOUR_MS = 3_600_000;

function headers(s: DownstreamServer): Record<string, string> {
  return { "X-Emby-Token": s.apiKey, "X-MediaBrowser-Token": s.apiKey, Authorization: `MediaBrowser Token="${s.apiKey}"`, Accept: "application/json" };
}
const iso = (unixSec: number) => new Date(unixSec * 1000).toISOString();

/** Order-independent over the fields Emby displays; a changed title, time or description changes it. */
export function fingerprint(programs: GuideProgram[]): string {
  const canon = [...programs].sort((a, b) => a.start - b.start)
    .map((p) => [p.start, p.end, p.title, p.description ?? "", p.category]);
  return Bun.hash(JSON.stringify(canon)).toString(16);
}

/** Parse a `guide_push_state.fingerprint` value that marks a channel as
 *  "channel not found" on the last push. Returns null for a normal (real)
 *  fingerprint. `k` is how many consecutive not-found results led here;
 *  `retryAtMs` is the unix-ms time before which the channel is skipped
 *  client-side rather than re-sent. */
export function parseNotFound(fp: string | undefined | null): { k: number; retryAtMs: number } | null {
  if (!fp) return null;
  const m = /^!notfound:(\d+):(\d+)$/.exec(fp);
  if (!m) return null;
  return { k: Number(m[1]), retryAtMs: Number(m[2]) };
}

/** Build the marker stored after the (k+1)th consecutive "channel not found"
 *  result, counting from 0. Wait doubles each time, capped at 16h. */
function notFoundMarker(k: number, nowMs: number): string {
  const hours = Math.min(2 ** k, NOTFOUND_CAP_HOURS);
  return `!notfound:${k}:${nowMs + hours * HOUR_MS}`;
}

async function ping(s: DownstreamServer): Promise<boolean> {
  try {
    const r = await fetch(`${s.url.replace(/\/+$/, "")}/Phospharr/Ping`, { headers: headers(s), signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    return r.ok;
  } catch { return false; }
}

/** Last time the "plugin not reachable" line was logged, per server — throttled
 *  to once an hour so a steady-state outage doesn't spam the log every tick. */
const lastFallbackLog = new Map<string, number>();

/** Test-only: forget the fallback-log throttle for one (or all) servers. */
export function _resetFallbackLog(serverId?: string): void {
  if (serverId) lastFallbackLog.delete(serverId);
  else lastFallbackLog.clear();
}

/** Servers with a push currently in flight — guards against a second overlapping
 *  `pushGuide()` call for the same server (e.g. the 6-hourly EPG cycle and an
 *  event-driven liveness push landing at the same moment) racing on the same
 *  fingerprints and duplicating plugin work. */
const inFlight = new Set<string>();

/** Post one server's outcome to `downstreamResults()` so `GET /api/epg/downstream`
 *  reflects the push rather than a stale refresh result. Skipped for
 *  "skipped-busy" (nothing new happened — the in-flight push will record its
 *  own outcome) and for the "fell back to RefreshGuide" path, where
 *  `refreshOne` has already recorded a more specific result. */
function recordOutcome(s: DownstreamServer, out: PushOutcome): void {
  const at = Date.now();
  const base = { id: s.id, name: s.name || s.url, type: s.type, at };
  if (out.mode === "disabled") {
    record({ ...base, ok: true, message: "guide push disabled" });
    return;
  }
  if (out.mode === "fallback") {
    record({ ...base, ok: false, message: out.error ?? "fell back to RefreshGuide" });
    return;
  }
  if (out.mode === "pushed") {
    let message = `push: ${out.channelsSent}ch +${out.created} ~${out.updated} -${out.deleted}, ${out.skipped} skipped, ${out.channelsDeferred} deferred`;
    if (out.error) message += ` (chunk error: ${out.error})`;
    record({ ...base, ok: !out.error, message });
  }
}

export async function pushGuide(s: DownstreamServer, opts: { now?: number; chunk?: number; fallback?: boolean } = {}): Promise<PushOutcome> {
  const out: PushOutcome = { serverId: s.id, mode: "pushed", channelsSent: 0, created: 0, updated: 0, deleted: 0, skipped: 0, channelsDeferred: 0 };
  if (!s.guidePush || !s.enabled || !s.url || !s.apiKey) {
    const result: PushOutcome = { ...out, mode: "disabled" };
    recordOutcome(s, result);
    return result;
  }
  if (inFlight.has(s.id)) return { ...out, mode: "skipped-busy" };
  inFlight.add(s.id);
  try {
    const fallback = opts.fallback ?? true;
    if (!(await ping(s))) {
      // No plugin (or fallback disabled) → log once an hour, not once a tick —
      // this is a steady state, not an incident.
      const last = lastFallbackLog.get(s.id) ?? 0;
      if (Date.now() - last >= 3_600_000) {
        console.log(`[guidepush] ${s.name}: plugin not reachable — ${fallback ? "falling back to RefreshGuide" : "skipping push (fallback disabled)"}`);
        lastFallbackLog.set(s.id, Date.now());
      }
      if (!fallback) {
        const result: PushOutcome = { ...out, mode: "fallback", error: "plugin not reachable — no push (fallback disabled)" };
        recordOutcome(s, result);
        return result;
      }
      // The old path, targeted at just this server (never throws). It records
      // its own (more specific) outcome, so we don't overwrite it here.
      await refreshOne(s);
      return { ...out, mode: "fallback", error: "plugin not reachable — fell back to RefreshGuide" };
    }

    const g = guideRows({ now: opts.now });
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    const nowMs = now * 1000;
    const known = new Map(
      db.select({ canonicalId: guidePushState.canonicalId, fingerprint: guidePushState.fingerprint })
        .from(guidePushState).where(eq(guidePushState.serverId, s.id)).all()
        .map((r) => [r.canonicalId, r.fingerprint] as const),
    );
    const pending: { canonicalId: string; fp: string; programs: GuideProgram[]; notFoundK?: number }[] = [];
    for (const ch of g.channels) {
      const programs = g.programs.get(ch.canonicalId) ?? [];
      const fp = fingerprint(programs);
      const stored = known.get(ch.canonicalId);
      const nf = parseNotFound(stored);
      if (nf) {
        if (nowMs < nf.retryAtMs) { out.channelsDeferred++; continue; }
        pending.push({ canonicalId: ch.canonicalId, fp, programs, notFoundK: nf.k });
        continue;
      }
      if (stored === fp) continue;
      pending.push({ canonicalId: ch.canonicalId, fp, programs });
    }
    if (!pending.length) { recordOutcome(s, out); return out; }

    const chunk = Math.max(1, opts.chunk ?? DEFAULT_CHUNK);
    for (let i = 0; i < pending.length; i += chunk) {
      const slice = pending.slice(i, i + chunk);
      const body = {
        Channels: slice.map((c) => ({
          TvgId: c.canonicalId, WindowStart: iso(g.windowStart), WindowEnd: iso(g.windowEnd),
          // XMLTV exports no live marker and Emby's own refresh clears this anyway —
          // always false, kept on the wire so the plugin contract is unchanged.
          Programs: c.programs.map((p) => ({ Start: iso(p.start), End: iso(p.end), Title: p.title, Subtitle: p.subtitle, Description: p.description, Category: p.category, IsLive: false })),
        })),
      };
      let res: { Channels?: { TvgId: string; Created?: number; Updated?: number; Deleted?: number; Skipped?: boolean; Reason?: string }[]; Error?: string };
      try {
        const r = await fetch(`${s.url.replace(/\/+$/, "")}/Phospharr/Guide`, { method: "POST", headers: { ...headers(s), "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        res = (await r.json()) as typeof res;
        if (res.Error) throw new Error(res.Error);
      } catch (e) {
        // This chunk keeps its old fingerprints and is retried next push; later chunks still go.
        out.error = e instanceof Error ? e.message : String(e);
        console.error(`[guidepush] ${s.name}: chunk ${i / chunk + 1} failed — ${out.error}`);
        continue;
      }
      out.channelsSent += slice.length;
      const ok: { canonicalId: string; fp: string }[] = [];
      for (const c of slice) {
        const r = res.Channels?.find((x) => x.TvgId === c.canonicalId);
        if (!r) { out.skipped++; continue; }
        if (r.Skipped) {
          out.skipped++;
          if (r.Reason === "channel not found") {
            const k = (c.notFoundK ?? -1) + 1;
            const marker = notFoundMarker(k, nowMs);
            db.insert(guidePushState).values({ serverId: s.id, canonicalId: c.canonicalId, fingerprint: marker, pushedAt: now })
              .onConflictDoUpdate({ target: [guidePushState.serverId, guidePushState.canonicalId], set: { fingerprint: marker, pushedAt: now } }).run();
          }
          // Any other skip reason: store nothing, so it is retried next push.
          // If this channel still carried a `!notfound:` marker whose retryAtMs
          // had already elapsed (that's why it was in `pending` at all — see the
          // parseNotFound branch above), the stale marker is simply left in the
          // table rather than cleared. That's harmless: retryAtMs is in the past,
          // so every push from here on re-includes the channel in `pending`
          // regardless of the marker's presence — it's sent every push, not stuck
          // on backoff. Self-correcting, not a starvation bug.
          continue;
        }
        out.created += r.Created ?? 0; out.updated += r.Updated ?? 0; out.deleted += r.Deleted ?? 0;
        ok.push({ canonicalId: c.canonicalId, fp: c.fp });
      }
      if (ok.length) {
        for (const o of ok) {
          db.insert(guidePushState).values({ serverId: s.id, canonicalId: o.canonicalId, fingerprint: o.fp, pushedAt: now })
            .onConflictDoUpdate({ target: [guidePushState.serverId, guidePushState.canonicalId], set: { fingerprint: o.fp, pushedAt: now } }).run();
        }
      }
    }
    console.log(`[guidepush] ${s.name}: ${out.channelsSent} channel(s) +${out.created} ~${out.updated} -${out.deleted}, ${out.skipped} skipped, ${out.channelsDeferred} deferred`);
    recordOutcome(s, out);
    return out;
  } finally {
    inFlight.delete(s.id);
  }
}

/** Every enabled downstream server: push where guidePush is on, else the old refresh —
 *  only for the servers NOT being pushed to, so a push is never immediately followed
 *  by the 15-minute RefreshGuide it exists to avoid. */
export async function pushOrRefreshDownstream(): Promise<PushOutcome[]> {
  const servers = ((await getSetting("epg.downstream")) ?? []).filter((s) => s.enabled && s.url && s.apiKey);
  const pushing = servers.filter((s) => s.guidePush);
  const refreshing = servers.filter((s) => !s.guidePush);
  const [pushed, refreshed] = await Promise.all([
    Promise.all(pushing.map((s) => pushGuide(s))),
    Promise.all(refreshing.map((s) => refreshOne(s).catch(() => undefined))),
  ]);
  const refreshedOk = refreshed.filter((r) => r?.ok).length;
  console.log(`[epg] downstream: pushed ${pushing.length}, refreshed ${refreshedOk}/${refreshing.length}`);
  return pushed;
}

/** Push to every server running the plugin; never touch the rest. For event-
 *  driven callers (liveness) — a Twitch title change must not start a
 *  15-minute Refresh Guide on a server that has no plugin, and the 6-hourly
 *  EPG cycle already covers those servers. */
export async function pushGuideOnly(): Promise<PushOutcome[]> {
  const servers = ((await getSetting("epg.downstream")) ?? []).filter((s) => s.enabled && s.url && s.apiKey && s.guidePush);
  return Promise.all(servers.map((s) => pushGuide(s, { fallback: false })));
}

/** Test-only: forget one server's fingerprints. */
export function _resetGuidePushState(serverId: string): void {
  db.delete(guidePushState).where(eq(guidePushState.serverId, serverId)).run();
}
