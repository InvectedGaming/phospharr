import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { guidePushState } from "../db/schema.ts";
import { getSetting, type DownstreamServer } from "../settings.ts";
import { guideRows, type GuideProgram } from "../epg/guide.ts";
import { refreshOne } from "../epg/downstream.ts";

/**
 * Push guide programmes into Emby through the Phospharr plugin, so a change is
 * in the guide within seconds instead of after the nightly 15-minute Refresh
 * Guide. See docs/superpowers/specs/2026-09-05-emby-guide-plugin-design.md.
 *
 * Delta only: a per-channel fingerprint of the programme set is kept in
 * guide_push_state; only channels whose set changed are sent. A channel the
 * plugin reports as skipped keeps NO fingerprint, so it is retried next time —
 * "channel not found" is the normal state until Emby's lineup refresh lands it.
 *
 * The plugin being absent must change nothing: a failed Ping falls back to the
 * existing RefreshGuide path (`pushGuide`'s default). Off by default per server.
 * Event-driven callers that only want the push — never a 15-minute RefreshGuide
 * triggered by e.g. a single Twitch title change — use `pushGuideOnly`, which
 * passes `{ fallback: false }` and silently skips servers without the plugin.
 */
export interface PushOutcome {
  serverId: string; mode: "pushed" | "fallback" | "disabled";
  channelsSent: number; created: number; updated: number; deleted: number; skipped: number; error?: string;
}

const DEFAULT_CHUNK = 200; // channels per POST — keeps a request well under a second of plugin work
const PING_TIMEOUT_MS = 8_000;
const PUSH_TIMEOUT_MS = 120_000;

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

export async function pushGuide(s: DownstreamServer, opts: { now?: number; chunk?: number; fallback?: boolean } = {}): Promise<PushOutcome> {
  const out: PushOutcome = { serverId: s.id, mode: "pushed", channelsSent: 0, created: 0, updated: 0, deleted: 0, skipped: 0 };
  if (!s.guidePush || !s.enabled || !s.url || !s.apiKey) return { ...out, mode: "disabled" };
  const fallback = opts.fallback ?? true;
  if (!(await ping(s))) {
    // No plugin (or fallback disabled) → log once an hour, not once a tick —
    // this is a steady state, not an incident.
    const last = lastFallbackLog.get(s.id) ?? 0;
    if (Date.now() - last >= 3_600_000) {
      console.log(`[guidepush] ${s.name}: plugin not reachable — ${fallback ? "falling back to RefreshGuide" : "skipping push (fallback disabled)"}`);
      lastFallbackLog.set(s.id, Date.now());
    }
    if (!fallback) return { ...out, mode: "fallback", error: "plugin not reachable — no push (fallback disabled)" };
    // The old path, targeted at just this server (never throws).
    await refreshOne(s);
    return { ...out, mode: "fallback", error: "plugin not reachable — fell back to RefreshGuide" };
  }

  const g = guideRows({ now: opts.now });
  const known = new Map(
    db.select({ canonicalId: guidePushState.canonicalId, fingerprint: guidePushState.fingerprint })
      .from(guidePushState).where(eq(guidePushState.serverId, s.id)).all()
      .map((r) => [r.canonicalId, r.fingerprint] as const),
  );
  const pending: { canonicalId: string; fp: string; programs: GuideProgram[] }[] = [];
  for (const ch of g.channels) {
    const programs = g.programs.get(ch.canonicalId) ?? [];
    const fp = fingerprint(programs);
    if (known.get(ch.canonicalId) === fp) continue;
    pending.push({ canonicalId: ch.canonicalId, fp, programs });
  }
  if (!pending.length) return out;

  const chunk = Math.max(1, opts.chunk ?? DEFAULT_CHUNK);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  for (let i = 0; i < pending.length; i += chunk) {
    const slice = pending.slice(i, i + chunk);
    const body = {
      Channels: slice.map((c) => ({
        TvgId: c.canonicalId, WindowStart: iso(g.windowStart), WindowEnd: iso(g.windowEnd),
        Programs: c.programs.map((p) => ({ Start: iso(p.start), End: iso(p.end), Title: p.title, Subtitle: p.subtitle, Description: p.description, Category: p.category, IsLive: p.extraCategory === "24/7" || p.category === "Sports" })),
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
      if (!r || r.Skipped) { out.skipped++; continue; }
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
  console.log(`[guidepush] ${s.name}: ${out.channelsSent} channel(s) +${out.created} ~${out.updated} -${out.deleted}, ${out.skipped} skipped`);
  return out;
}

/** Every enabled downstream server: push where guidePush is on, else the old refresh —
 *  only for the servers NOT being pushed to, so a push is never immediately followed
 *  by the 15-minute RefreshGuide it exists to avoid. */
export async function pushOrRefreshDownstream(): Promise<PushOutcome[]> {
  const servers = ((await getSetting("epg.downstream")) ?? []).filter((s) => s.enabled && s.url && s.apiKey);
  const pushing = servers.filter((s) => s.guidePush);
  const refreshing = servers.filter((s) => !s.guidePush);
  const [pushed] = await Promise.all([
    Promise.all(pushing.map((s) => pushGuide(s))),
    Promise.all(refreshing.map((s) => refreshOne(s).catch(() => undefined))),
  ]);
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
