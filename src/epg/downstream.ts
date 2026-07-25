import { getSetting, type DownstreamServer } from "../settings.ts";

/**
 * Downstream guide sync. Phospharr is a tuner for Emby / Jellyfin / Plex, but
 * those servers cache their own copy of the guide and refresh it on their own
 * (slow) schedule — so right after we pull fresh EPG, their guide is stale.
 *
 * This nudges each configured server to reload its guide the moment ours lands,
 * through each server's native API:
 *   - Emby / Jellyfin: find the "RefreshGuide" scheduled task, start it.
 *   - Plex: reload the guide on each Live-TV DVR.
 *
 * Best-effort: a server that's down or misconfigured logs a result and never
 * blocks our own refresh. The last result per server is kept for the UI.
 */

export interface SyncResult {
  id: string;
  name: string;
  type: DownstreamServer["type"];
  ok: boolean;
  at: number; // ms
  message: string;
}

const lastResults = new Map<string, SyncResult>();
export function downstreamResults(): SyncResult[] {
  return [...lastResults.values()].sort((a, b) => b.at - a.at);
}

const TIMEOUT_MS = 15_000;
const trimUrl = (u: string) => u.trim().replace(/\/+$/, "");

async function jfetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** Emby & Jellyfin share the same API: list scheduled tasks, run "RefreshGuide". */
async function refreshEmby(s: DownstreamServer): Promise<string> {
  const base = trimUrl(s.url);
  const headers = {
    "X-Emby-Token": s.apiKey,
    "X-MediaBrowser-Token": s.apiKey,
    Authorization: `MediaBrowser Token="${s.apiKey}"`,
    Accept: "application/json",
  };
  const listRes = await jfetch(`${base}/ScheduledTasks?isHidden=false`, { headers });
  if (listRes.status === 401 || listRes.status === 403) throw new Error("unauthorized — check the API key");
  if (!listRes.ok) throw new Error(`ScheduledTasks HTTP ${listRes.status}`);
  const tasks = (await listRes.json()) as { Id: string; Key?: string; Name?: string }[];
  const guide = tasks.find((t) => t.Key === "RefreshGuide")
    ?? tasks.find((t) => /guide/i.test(t.Name ?? ""));
  if (!guide) throw new Error("no guide-refresh task (is Live TV set up on this server?)");
  const runRes = await jfetch(`${base}/ScheduledTasks/Running/${guide.Id}`, { method: "POST", headers });
  if (!runRes.ok && runRes.status !== 204) throw new Error(`start task HTTP ${runRes.status}`);
  return "guide refresh started";
}

/** Plex: reload the guide on every Live-TV DVR. */
async function refreshPlex(s: DownstreamServer): Promise<string> {
  const base = trimUrl(s.url);
  const headers = { "X-Plex-Token": s.apiKey, Accept: "application/json" };
  const dvrRes = await jfetch(`${base}/livetv/dvrs`, { headers });
  if (dvrRes.status === 401) throw new Error("unauthorized — check the X-Plex-Token");
  if (!dvrRes.ok) throw new Error(`livetv/dvrs HTTP ${dvrRes.status}`);
  const body = (await dvrRes.json()) as { MediaContainer?: { Dvr?: { key?: string | number }[] } };
  const dvrs = body.MediaContainer?.Dvr ?? [];
  if (!dvrs.length) throw new Error("no DVR configured on this Plex server");
  let n = 0;
  for (const dvr of dvrs) {
    const id = dvr.key;
    if (id == null) continue;
    const r = await jfetch(`${base}/livetv/dvrs/${id}/reloadGuide`, { method: "POST", headers });
    if (r.ok) n++;
  }
  if (!n) throw new Error("guide reload was rejected by every DVR");
  return `guide reload triggered on ${n} DVR${n > 1 ? "s" : ""}`;
}

/** Refresh one server, recording the outcome. Never throws. */
export async function refreshOne(s: DownstreamServer): Promise<SyncResult> {
  const at = Date.now();
  const base: SyncResult = { id: s.id, name: s.name || s.url, type: s.type, ok: false, at, message: "" };
  if (!s.url || !s.apiKey) return record({ ...base, message: "missing URL or API key" });
  try {
    const msg = s.type === "plex" ? await refreshPlex(s) : await refreshEmby(s);
    return record({ ...base, ok: true, message: msg });
  } catch (e) {
    const message = e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : e.message) : String(e);
    return record({ ...base, message });
  }
}

function record(r: SyncResult): SyncResult {
  lastResults.set(r.id, r);
  return r;
}

/** Trigger an Emby/Jellyfin media-library scan (picks up new VOD .strm files).
 *  Plex is skipped — its scan needs a per-section id, unlike the guide reload. */
async function scanEmbyLibrary(s: DownstreamServer): Promise<string> {
  const base = trimUrl(s.url);
  const headers = { "X-Emby-Token": s.apiKey, "X-MediaBrowser-Token": s.apiKey, Authorization: `MediaBrowser Token="${s.apiKey}"`, Accept: "application/json" };
  const r = await jfetch(`${base}/Library/Refresh`, { method: "POST", headers });
  if (r.status === 401 || r.status === 403) throw new Error("unauthorized — check the API key");
  if (!r.ok && r.status !== 204) throw new Error(`Library/Refresh HTTP ${r.status}`);
  return "library scan started";
}

/** Ask every enabled Emby/Jellyfin server to rescan its libraries — call after
 *  the VOD .strm library is rebuilt so new movies show up. Best-effort. */
export async function scanDownstreamLibraries(): Promise<SyncResult[]> {
  let servers: DownstreamServer[] = [];
  try { servers = (await getSetting("epg.downstream")) ?? []; } catch { return []; }
  const targets = servers.filter((s) => s.enabled && s.url && s.apiKey && s.type !== "plex");
  if (!targets.length) return [];
  const results = await Promise.all(targets.map(async (s) => {
    const at = Date.now();
    try { return record({ id: s.id, name: s.name || s.url, type: s.type, ok: true, at, message: await scanEmbyLibrary(s) }); }
    catch (e) { return record({ id: s.id, name: s.name || s.url, type: s.type, ok: false, at, message: e instanceof Error ? e.message : String(e) }); }
  }));
  console.log(`[vod] downstream library scan: ${results.filter((r) => r.ok).length}/${results.length} server(s)`);
  return results;
}

/** Nudge every ENABLED downstream server. Called after each EPG refresh. */
export async function refreshDownstreamGuides(): Promise<SyncResult[]> {
  let servers: DownstreamServer[] = [];
  try { servers = (await getSetting("epg.downstream")) ?? []; } catch { return []; }
  const enabled = servers.filter((s) => s.enabled && s.url && s.apiKey);
  if (!enabled.length) return [];
  const results = await Promise.all(enabled.map(refreshOne));
  const ok = results.filter((r) => r.ok).length;
  console.log(`[epg] downstream: refreshed ${ok}/${results.length} server(s)`);
  return results;
}
