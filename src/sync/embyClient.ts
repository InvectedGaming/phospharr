import type { DownstreamServer } from "../settings.ts";

/**
 * Typed Emby/Jellyfin REST client — the transport layer downstream sync
 * (tuner-host convergence) and favorites read-back build on. Emby and
 * Jellyfin share this API surface (Jellyfin forked from Emby's REST API).
 *
 * Every call: 15 s timeout, throws a `METHOD path → HTTP status` error on a
 * non-2xx response so callers can surface *what* failed rather than silently
 * assuming success. Best-effort composition (never blocking Phospharr's own
 * serving path) is the caller's job — see `src/epg/downstream.ts`.
 *
 * Response bodies are shape-checked before being handed to callers. A 200
 * with an unexpected body (reverse-proxy error page, renamed envelope, an
 * Emby error object) must never be silently coerced into `[]` — Task 6's
 * convergence ladder deletes and re-adds a live tuner host based on what
 * `listChannels`/`listTunerHosts` report, so a fabricated empty list here
 * could look like "Emby has zero channels" when it really means "we
 * couldn't parse the response." Every parsing site throws instead.
 */

const TIMEOUT_MS = 15_000;
const base = (s: DownstreamServer) => s.url.trim().replace(/\/+$/, "");
const headers = (s: DownstreamServer) => ({
  "X-Emby-Token": s.apiKey,
  "X-MediaBrowser-Token": s.apiKey,
  Authorization: `MediaBrowser Token="${s.apiKey}"`,
  Accept: "application/json",
});

async function call(s: DownstreamServer, path: string, init?: RequestInit): Promise<Response> {
  const h: Record<string, string> = { ...headers(s) };
  if (init?.body) h["Content-Type"] = "application/json"; // only when actually sending a body
  const res = await fetch(`${base(s)}${path}`, { ...init, headers: h, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → HTTP ${res.status}`); // 204 is already .ok
  return res;
}

/** Truncate an unexpected body for an error message — never dump a huge payload. */
function truncate(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/** A 200 response is expected to be a bare JSON array. Throw (naming the endpoint
 *  and what actually came back) rather than let callers get a confusing TypeError
 *  or, worse, silently treat something unusable as an empty list. */
function expectArray<T>(path: string, body: unknown): T[] {
  if (!Array.isArray(body)) throw new Error(`GET ${path} → expected a JSON array, got ${truncate(body)}`);
  return body as T[];
}

/** A 200 response is expected to be `{ Items: [...] }`. Same reasoning as
 *  `expectArray` — a missing or non-array `Items` throws instead of `?? []`. */
function expectItems<T>(path: string, body: unknown): T[] {
  if (body === null || typeof body !== "object" || !("Items" in body) || !Array.isArray((body as { Items?: unknown }).Items)) {
    throw new Error(`GET ${path} → expected { Items: [...] }, got ${truncate(body)}`);
  }
  return (body as { Items: T[] }).Items;
}

/**
 * A tuner host exactly as Emby stores it. `Id`/`Url`/`Type` are the keys we
 * reason about; the open index signature carries everything else the server
 * keeps on the record — `FriendlyName`, `ImportGuideData`,
 * `PreferEpgChannelImages`, `PreferEpgChannelNumbers`, `AllowMappingByNumber`,
 * `AllowHWTranscoding`, `ImportFavoritesOnly`, `ProviderOptions`,
 * `TunerCount`, `SetupUrl`, `DataVersion`, … Those are real settings: a
 * re-add that posts only `{Url, Type}` silently resets them, which scrambles
 * guide images and channel numbering for the whole household. The convergence
 * ladder therefore round-trips the captured object minus `Id`, so the type has
 * to be able to hold fields we never name.
 */
export type TunerHost = { Id: string; Url: string; Type: string; [key: string]: unknown };
/** The same record on the way back in — Emby assigns a fresh `Id` itself. */
export type TunerHostInput = { Url: string; Type: string; [key: string]: unknown };

/**
 * Every tuner host Emby has, validated PER ELEMENT.
 *
 * "It's an array" is not enough here: the convergence ladder DELETES these
 * records and posts them back, so it must be able to trust `Id` (what it
 * deletes), `Url` (how it decides the host is ours rather than a neighbouring
 * HDHomeRun's) and `Type` (which Emby requires and never infers). A record
 * missing `Type` that got deleted and re-added without one would come back as a
 * broken tuner; a record missing `Url` could be mistaken for a foreign host and
 * silently skipped, or worse, matched by an empty prefix.
 *
 * So a malformed element fails the whole call. That is deliberately fail-safe:
 * the ladder treats a throwing read as inconclusive, refreshes the guide, and
 * never escalates — the household keeps its tuner and the error surfaces.
 */
export async function listTunerHosts(s: DownstreamServer) {
  const path = "/LiveTv/TunerHosts";
  const body = await (await call(s, path)).json();
  const list = expectArray<unknown>(path, body);
  return list.map((h, i) => {
    if (h === null || typeof h !== "object" || Array.isArray(h)) {
      throw new Error(`GET ${path} → tuner host [${i}] is not an object: ${truncate(h)}`);
    }
    const rec = h as Record<string, unknown>;
    for (const k of ["Id", "Url", "Type"] as const) {
      if (typeof rec[k] !== "string" || !(rec[k] as string).trim()) {
        throw new Error(`GET ${path} → tuner host [${i}] has no usable ${k}: ${truncate(h)}`);
      }
    }
    return rec as TunerHost;
  });
}

/**
 * DELETE /LiveTv/TunerHosts?Id=<id> — Emby's (and Jellyfin's, which forked
 * the same REST surface) documented delete-tuner-host endpoint takes the id
 * as a query param, not a path segment or a `/Delete` POST variant. Nothing
 * else in this codebase talks to TunerHosts yet, so there's no prior local
 * evidence either way — this is the form in Emby's published API contract.
 * If a server's history predates it and 404s/405s, `call()` throws
 * `DELETE /LiveTv/TunerHosts?Id=... → HTTP <status>` so the caller (the
 * convergence ladder in a later task) sees the failure instead of assuming
 * the delete succeeded.
 */
export async function deleteTunerHost(s: DownstreamServer, id: string): Promise<void> {
  await call(s, `/LiveTv/TunerHosts?Id=${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function addTunerHost(s: DownstreamServer, host: TunerHostInput): Promise<void> {
  await call(s, "/LiveTv/TunerHosts", { method: "POST", body: JSON.stringify(host) });
}

export async function listChannels(s: DownstreamServer) {
  const path = "/LiveTv/Channels?EnableUserData=false";
  const body = await (await call(s, path)).json();
  return expectItems<{ Number?: string; Name: string }>(path, body);
}

export async function hasLiveSession(s: DownstreamServer): Promise<boolean> {
  const path = "/Sessions";
  const body = await (await call(s, path)).json();
  const sessions = expectArray<{ NowPlayingItem?: { Type?: string } }>(path, body);
  return sessions.some((x) => x.NowPlayingItem?.Type === "TvChannel");
}

export async function listUsers(s: DownstreamServer) {
  const path = "/Users";
  const body = await (await call(s, path)).json();
  return expectArray<{ Id: string; Name: string }>(path, body);
}

export async function listFavoriteChannels(s: DownstreamServer, userId: string) {
  const path = `/Users/${userId}/Items?Filters=IsFavorite&IncludeItemTypes=TvChannel&Recursive=true`;
  const body = await (await call(s, path)).json();
  return expectItems<{ Number?: string; Name: string }>(path, body);
}

/**
 * Emby & Jellyfin share the same API: list scheduled tasks, run "RefreshGuide".
 * Moved verbatim from `src/epg/downstream.ts`'s former `refreshEmby` — kept as
 * direct `fetch` calls (rather than the generic `call()` above) so the
 * specific 401/403 "check the API key" and per-step HTTP-status messages
 * `refreshOne`'s UI already surfaces are preserved unchanged.
 */
export async function refreshGuide(s: DownstreamServer): Promise<void> {
  const b = base(s);
  const h = headers(s);
  const listRes = await fetch(`${b}/ScheduledTasks?isHidden=false`, { headers: h, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (listRes.status === 401 || listRes.status === 403) throw new Error("unauthorized — check the API key");
  if (!listRes.ok) throw new Error(`ScheduledTasks HTTP ${listRes.status}`);
  const tasksBody = await listRes.json();
  const tasks = expectArray<{ Id: string; Key?: string; Name?: string }>("/ScheduledTasks?isHidden=false", tasksBody);
  const guide = tasks.find((t) => t.Key === "RefreshGuide") ?? tasks.find((t) => /guide/i.test(t.Name ?? ""));
  if (!guide) throw new Error("no guide-refresh task (is Live TV set up on this server?)");
  const runRes = await fetch(`${b}/ScheduledTasks/Running/${guide.Id}`, { method: "POST", headers: h, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!runRes.ok && runRes.status !== 204) throw new Error(`start task HTTP ${runRes.status}`);
}
