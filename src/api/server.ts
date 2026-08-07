import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { and, asc, eq, gt, lt, lte, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { providers, channels, streams, rules, programs, vpns, dvrRules, recordings, userFavorites, reminders, vodMovies, vodSeries, vodEpisodes, vodProgress, downstreamFavorites } from "../db/schema.ts";
import { syncVod, ensureEpisodes, ensureMovieInfo, vodUpstreamUrl } from "../ingest/vod.ts";
import { dvrOverview, scheduleRecording, cancelRecording, deleteRule } from "../dvr/recorder.ts";
import { startVpn, stopVpn, vpnStatus } from "../net/tunnel.ts";
import { syncProvider } from "../ingest/sync.ts";
import { fetchM3U } from "../ingest/m3u.ts";
import { fetchXtream } from "../ingest/xtream.ts";
import { egress, providerEgress } from "../net/egress.ts";
import { vpnProxyUrl } from "../net/tunnel.ts";
import { nordCountries, nordRecommend, isNordConfig, setNordServer, setLocationComment, parseNordInfo } from "../net/nordvpn.ts";
import { syncEpgFromUrls, nowNext, providerEpgUrls } from "../epg/merge.ts";
import { refreshDownstreamGuides, refreshOne, downstreamResults, scanDownstreamLibraries } from "../epg/downstream.ts";
import { convergeAll, syncStates, resetAttention } from "../sync/converge.ts";
import { VOD_MIRROR_ID } from "../sync/reconciler.ts";
import { rebuildVodLibrary } from "../ingest/vodlibrary.ts";
import { applyRules } from "../rules/engine.ts";
import { reconcileAutoHides, listCategories, listProviderCategories } from "../content/filter.ts";
import { muxer } from "../proxy/muxer.ts";
import { timeshift } from "../proxy/timeshift.ts";
import { tileFeeds } from "../proxy/tilefeed.ts";
import { compositor } from "../proxy/compositor.ts";
import { readFileSync } from "node:fs";
import { persistentKeyframeFeed } from "../proxy/tsfeed.ts";
import { transcoder } from "../proxy/transcode.ts";
import { pool } from "../scheduler/pool.ts";
import * as hdhr from "../tuner/hdhr.ts";
import { clientIp, isLocalIp, externalAllowed } from "../net/access.ts";
import { exportXmltv } from "../epg/export.ts";
import { buildView } from "./view.ts";
import { getGuideSnapshot, snapshotAgeMs } from "../epg/snapshot.ts";
import { healthzChecks } from "./healthz.ts";
import { loopStates } from "../health/watchdog.ts";
import { VERSION } from "../version.ts";
import * as prewarm from "../proxy/prewarm.ts";
import { getLogo } from "../tuner/logocache.ts";
import { getSettings, getSetting, setSetting, cachedSetting, envLockedKeys, capabilities, type Settings } from "../settings.ts";
import { recordView, getAnalytics, recentChannels } from "../analytics.ts";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  SESSION_COOKIE, userForToken, userCount, createUser, login, logout, publicUser, hashPassword, channelVisible,
} from "../auth.ts";
import { users, viewEvents } from "../db/schema.ts";
import {
  createShare, listShares, revokeShare, deleteShare, getValidShare,
  issueTicket, redeemTicket, acquireSlot, releaseSlot, liveCount, touchShare,
  registerStream, unregisterStream,
} from "../shares.ts";
import type { User } from "../db/schema.ts";
import type { Context } from "hono";

type Env = { Variables: { user: User } };

function baseUrl(c: { req: { url: string } }): string {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");
  const u = new URL(c.req.url);
  return `${u.protocol}//${u.host}`;
}

// Record a view session: on client disconnect, log channel + duration for analytics.
// userId scopes the per-user "Jump back in" row; null for tuner/key streams.
function trackSession(c: Context, channelId: number, source: "passthrough" | "transcode", userId?: number | null) {
  const kind = c.req.query("as") === "preview" ? "preview" : "watch";
  const startedAt = Date.now();
  c.req.raw.signal.addEventListener(
    "abort",
    () => recordView({ channelId, userId, kind, source, startedAt, endedAt: Date.now() }),
    { once: true },
  );
}

export const app = new Hono<Env>();
// WebSocket support (watch-party chat). `websocket` is wired into the Bun
// server export in index.ts; `upgradeWebSocket` turns a route into a WS endpoint.
const { upgradeWebSocket, websocket } = createBunWebSocket();
export { websocket };

const COOKIE_OPTS = { httpOnly: true, sameSite: "Lax" as const, path: "/", maxAge: 30 * 24 * 3600 };
/** Session-cookie options, adding Secure when the request arrived over HTTPS so
 *  the 30-day token isn't transmitted in cleartext behind a TLS proxy. Plain-HTTP
 *  LAN keeps it off so the cookie still works there. */
function cookieOpts(c: Context<Env>) {
  let https = false;
  try {
    const fwd = cachedSetting("access.trustProxy") ? c.req.header("x-forwarded-proto")?.split(",")[0].trim() : undefined;
    https = fwd ? fwd === "https" : new URL(c.req.url).protocol === "https:";
  } catch { /* default to not-secure */ }
  return https ? { ...COOKIE_OPTS, secure: true } : COOKIE_OPTS;
}
/** 403 unless the request's user is an admin; null means OK to proceed. */
function ensureAdmin(c: Context<Env>) {
  const u = c.get("user");
  return u && u.role === "admin" ? null : c.json({ error: "admin only" }, 403);
}

// ─── Phospharr UI (the Watch + Manage face, served static) ───
// Resolve ./public relative to this file so the server runs from any cwd.
const publicDir = new URL("../../public", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// The app shell + script must never be cached — otherwise a browser keeps
// running a stale build and silently misses new features/fixes.
const noStore = "no-store, no-cache, must-revalidate";
// Cache-bust client JS: a CDN (Cloudflare) caches .js by extension and ignores
// our no-store, pinning a stale app.js across deploys. index.html is never
// CDN-cached, so stamp the asset URLs with a content hash (?v=) that changes only
// when app.js changes — each deploy is a fresh URL the CDN must refetch.
const assetVer = (() => { try { return Bun.hash(readFileSync(`${publicDir}/app.js`)).toString(36); } catch { return Date.now().toString(36); } })();
const indexHtml = (() => {
  try { return readFileSync(`${publicDir}/index.html`, "utf8").replace(/(src|href)="(\/app\.js|\/vendor\/[^"]+\.js)"/g, `$1="$2?v=${assetVer}"`); }
  catch { return ""; }
})();
app.get("/", () => new Response(indexHtml, { headers: { "Content-Type": "text/html", "Cache-Control": noStore } }));
app.get("/app.js", () => new Response(Bun.file(`${publicDir}/app.js`), { headers: { "Content-Type": "text/javascript", "Cache-Control": noStore } }));
app.get("/vendor/mpegts.js", () =>
  new Response(Bun.file(`${publicDir}/vendor/mpegts.js`), {
    headers: { "Content-Type": "text/javascript", "Cache-Control": "max-age=86400" },
  }),
);
app.get("/vendor/hls.js", () =>
  new Response(Bun.file(`${publicDir}/vendor/hls.js`), {
    headers: { "Content-Type": "text/javascript", "Cache-Control": "max-age=86400" },
  }),
);

// ─── PWA assets (manifest, service worker, icons) ───
// Served public (no auth) so the app is installable and works offline-first.
// The service worker must not be cached, so updates roll out; the manifest +
// icons can cache for a day.
const PWA_FILES: Record<string, { type: string; cache: string }> = {
  "/manifest.webmanifest": { type: "application/manifest+json", cache: "max-age=86400" },
  "/sw.js": { type: "text/javascript", cache: noStore },
  "/icon.svg": { type: "image/svg+xml", cache: "max-age=86400" },
  "/icon-192.png": { type: "image/png", cache: "max-age=86400" },
  "/icon-512.png": { type: "image/png", cache: "max-age=86400" },
  "/icon-maskable-512.png": { type: "image/png", cache: "max-age=86400" },
};
for (const [path, meta] of Object.entries(PWA_FILES)) {
  app.get(path, () => {
    const headers: Record<string, string> = { "Content-Type": meta.type, "Cache-Control": meta.cache };
    // The SW is allowed to control the whole origin.
    if (path === "/sw.js") headers["Service-Worker-Allowed"] = "/";
    return new Response(Bun.file(`${publicDir}${path}`), { headers });
  });
}
// ─── Public share links (login-free, scoped to ONE channel) ───
// Keep crawlers away entirely; these live outside /api so the auth gate doesn't
// touch them, but each is independently validated against the share token.
app.get("/robots.txt", () =>
  new Response("User-agent: *\nDisallow: /s/\nDisallow: /share/\nDisallow: /api/\n", {
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
  }),
);
const SHARE_HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "X-Robots-Tag": "noindex, nofollow, noarchive, noimageindex",
} as const;
app.get("/s/:token", () => new Response(Bun.file(`${publicDir}/share.html`), { headers: SHARE_HTML_HEADERS }));

// The share page asks for the channel name + validity (no auth, token-scoped).
app.get("/share/:token/info", (c) => {
  const s = getValidShare(c.req.param("token"));
  if (!s) return c.json({ valid: false }, 404);
  const ch = db.select({ name: channels.name, logoUrl: channels.logoUrl }).from(channels).where(eq(channels.id, s.channelId)).get();
  return c.json({ valid: true, channel: ch?.name ?? "Channel", logoUrl: ch?.logoUrl ?? null, expiresAt: s.expiresAt });
});

// Mint a single-use, 60s stream ticket — the real media URL is never reusable.
app.post("/share/:token/ticket", (c) => {
  const s = getValidShare(c.req.param("token"));
  if (!s) return c.json({ error: "This link has expired or been revoked." }, 403);
  if (liveCount(s.id) >= s.maxConcurrent) return c.json({ error: "This link is at its viewer limit." }, 429);
  return c.json({ ticket: issueTicket(s) });
});

// Redeem the ticket → proxy the channel through the muxer (provider stays hidden).
app.get("/share/:token/stream", async (c) => {
  const s = getValidShare(c.req.param("token"));
  if (!s) return c.text("link expired or revoked", 403);
  const redeemed = redeemTicket(c.req.query("t"));
  if (!redeemed || redeemed.shareId !== s.id) return c.text("invalid or used ticket", 403);
  if (!acquireSlot(s)) return c.text("viewer limit reached", 429);
  // Own AbortController so revoke/delete can kill this exact connection live; it
  // also fires on client disconnect. Either way the slot is released once.
  const ac = new AbortController();
  registerStream(s.id, ac);
  c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });
  ac.signal.addEventListener("abort", () => { unregisterStream(s.id, ac); releaseSlot(s.id); }, { once: true });
  const transcode = c.req.query("mode") === "transcode";
  const body = transcode
    ? await transcoder.open(s.channelId, ac.signal)
    : await muxer.open(s.channelId, ac.signal);
  if (!body) { ac.abort(); return c.text("no playable source / tuners busy", 503); }
  touchShare(s.id);
  return new Response(body, {
    headers: { "Content-Type": "video/mp2t", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
});

// ─── Auth (public). The FIRST account created becomes the admin. ───
app.get("/api/auth/me", (c) => {
  const user = userForToken(getCookie(c, SESSION_COOKIE));
  return c.json({ user: user ? publicUser(user) : null, needsSetup: userCount() === 0 });
});
app.post("/api/auth/register", async (c) => {
  const first = userCount() === 0;
  if (!first) {
    const admin = userForToken(getCookie(c, SESSION_COOKIE));
    if (!admin || admin.role !== "admin") return c.json({ error: "admin only" }, 403);
  }
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  if (!username || !password) return c.json({ error: "username and password required" }, 400);
  if (password.length < 6) return c.json({ error: "password must be at least 6 characters" }, 400);
  if (db.select().from(users).where(eq(users.username, username)).get()) {
    return c.json({ error: "username already taken" }, 409);
  }
  const role = first ? "admin" : body.role === "admin" ? "admin" : "user";
  const user = await createUser({ username, password, role, restrictions: body.restrictions as never });
  if (first) {
    // Auto-login the very first admin so setup flows straight into the app.
    const res = await login(username, password);
    if (res) setCookie(c, SESSION_COOKIE, res.token, cookieOpts(c));
  }
  return c.json({ user: publicUser(user) });
});
// Sliding-window brute-force guard for login: cap failed attempts per client IP.
// argon2id already makes each guess slow, but an unthrottled public endpoint
// still invites credential stuffing — 10 failures/minute then 429.
const loginFails = new Map<string, number[]>();
const LOGIN_MAX = 10, LOGIN_WINDOW_MS = 60_000;
app.post("/api/auth/login", async (c) => {
  const ip = clientIp(c) || "unknown";
  const now = Date.now();
  const recent = (loginFails.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_MAX) return c.json({ error: "too many attempts — wait a minute" }, 429);
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const res = await login(String(body.username ?? ""), String(body.password ?? ""));
  if (!res) {
    recent.push(now);
    loginFails.set(ip, recent);
    if (loginFails.size > 5000) loginFails.clear(); // crude unbounded-growth backstop
    return c.json({ error: "invalid username or password" }, 401);
  }
  loginFails.delete(ip); // success clears the counter
  setCookie(c, SESSION_COOKIE, res.token, cookieOpts(c));
  return c.json({ user: publicUser(res.user) });
});
app.post("/api/auth/logout", (c) => {
  logout(getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// Everything under /api below this line requires a valid session.
app.use("/api/*", async (c, next) => {
  const user = userForToken(getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
});

app.get("/api/health", (c) => c.json({ name: "Phospharr", version: VERSION, status: "ok" }));

// Real liveness/readiness probe for the container HEALTHCHECK + autoheal —
// exercises DB writes, EPG snapshot freshness, and loop heartbeats. Leave
// /api/health above in place; other things may still call it.
//
// Deliberately unauthenticated (registered above the /api/* session gate:
// the container HEALTHCHECK curls it long before any session exists) but it
// performs a DB write every call and its response leaks internals (loop
// names, EPG snapshot age) — so it's gated by the same LAN policy as the
// tuner/stream export routes (see tunerDenied above) instead of being left
// open to whoever can reach the container. Off-network is refused BEFORE
// healthzChecks() runs, so a denied request never touches the DB.
app.get("/healthz", async (c) => {
  if (!isLocalIp(clientIp(c)) && !externalAllowed()) return c.text("off-network access is disabled (Settings → Network Access)", 403);
  const r = await healthzChecks({ snapshotAgeMs, loops: loopStates, maxSnapshotAgeMs: 3 * 3600_000 });
  return c.json(r, r.ok ? 200 : 503);
});

// ─── Analytics ───
app.get("/api/analytics", (c) => ensureAdmin(c) ?? c.json(getAnalytics()));
// Recently-watched channel ids — powers the Home "Jump back in" row, scoped to
// the signed-in user (this route is behind the /api/* auth gate).
app.get("/api/recent", (c) => c.json(recentChannels(c.get("user")?.id, 14)));

// ─── Settings + capabilities ───
app.get("/api/capabilities", async (c) => c.json(await capabilities()));
// Every category + channel count + whether the admin has hidden the whole group.
app.get("/api/categories", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  return c.json(await listCategories());
});

app.get("/api/settings", async (c) => {
  const isAdmin = c.get("user")?.role === "admin";
  // Strip downstream API keys — those are managed (and redacted) via the
  // dedicated /api/epg/downstream endpoints, never leaked through settings.
  const settings = { ...(await getSettings()) };
  settings["epg.downstream"] = (settings["epg.downstream"] ?? []).map(({ apiKey, ...s }) => ({ ...s, apiKey: "" }));
  // The master stream key grants FULL, restriction-free access (a valid key = the
  // whole lineup via ?key=…). Never hand it to a non-admin, or a restricted/child
  // account could read it here and stream anything it isn't allowed to see.
  if (!isAdmin) settings["access.streamKey"] = "";
  return c.json({ settings, envLocked: envLockedKeys() });
});
app.patch("/api/settings", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const body = (await c.req.json().catch(() => ({}))) as Partial<Settings>;
  for (const [k, v] of Object.entries(body)) {
    try {
      await setSetting(k as keyof Settings, v as never);
    } catch {
      /* skip unknown keys */
    }
  }
  // Content-filter changes (adult / categories / dedupe) re-apply to the lineup now.
  if ("content.hideAdult" in body || "content.hiddenCategories" in body || "content.hiddenMarkets" in body || "content.dedupeLocals" in body || "content.hideNoStream" in body) await reconcileAutoHides();
  return c.json({ settings: await getSettings(), envLocked: envLockedKeys() });
});

// Channels + health + source counts (the guide is served separately).
// Non-admins get a lineup filtered to what their restrictions allow.
app.get("/api/view", async (c) => c.json(await buildView(c.get("user"))));

// Per-user favorites — every signed-in user gets their own stars (the old
// channels.isFavorite is only a legacy fallback for pre-profile data).
app.post("/api/favorites/:channelId", async (c) => {
  const u = c.get("user");
  if (!u) return c.json({ error: "sign in" }, 401);
  const channelId = Number(c.req.param("channelId"));
  if (!Number.isFinite(channelId)) return c.json({ error: "bad channel id" }, 400);
  const b = (await c.req.json().catch(() => ({}))) as { on?: boolean };
  if (b.on) await db.insert(userFavorites).values({ userId: u.id, channelId }).onConflictDoNothing();
  else await db.delete(userFavorites).where(and(eq(userFavorites.userId, u.id), eq(userFavorites.channelId, channelId)));
  return c.json({ ok: true, on: !!b.on });
});

// Full detail for one program (on-demand — keeps the guide snapshot lean).
app.get("/api/program", async (c) => {
  const canonicalId = c.req.query("canonicalId");
  const at = new Date(Number(c.req.query("at")));
  if (!canonicalId || Number.isNaN(at.getTime())) return c.json(null);
  const [row] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.canonicalId, canonicalId), lte(programs.startTime, at), gt(programs.endTime, at)))
    .limit(1);
  return c.json(row ?? null);
});

// The full guide — a precomputed, gzip-compressed snapshot served from memory
// with an ETag. Unchanged requests get a 304; nothing hits the DB.
app.get("/api/guide", async (c) => {
  const snap = await getGuideSnapshot();
  if (c.req.header("if-none-match") === snap.etag) {
    return new Response(null, { status: 304, headers: { ETag: snap.etag } });
  }
  return new Response(snap.gzip, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      ETag: snap.etag,
      "Cache-Control": "no-cache",
    },
  });
});

// ─── Stream access control ───
// /stream + /watch + HDHR are NEVER open: a request must carry a valid session
// (the web player's cookie) OR the stream key (devices use ?key=… ; HDHR tuners
// use the /t/<key>/ path so Plex/Jellyfin — which derive URLs from the base —
// keep the key on every call). The key is auto-generated on first boot.
const STREAM_HEADERS = { "Content-Type": "video/mp2t", "Cache-Control": "no-cache, no-store", Connection: "keep-alive" } as const;
function streamKey(): string { return String(cachedSetting("access.streamKey") || ""); }
// The key is required; the LAN policy is an ADDITIONAL gate — off-network clients
// are refused (403) unless the admin opted into external access.
function streamAuth(c: Context<Env>): { ok: boolean; user?: User; status?: 401 | 403 } {
  const user = userForToken(getCookie(c, SESSION_COOKIE));
  if (user) return { ok: true, user }; // signed-in web user, any network
  const k = streamKey();
  if (!k || c.req.query("key") !== k) return { ok: false, status: 401 };
  if (isLocalIp(clientIp(c)) || externalAllowed()) return { ok: true };
  return { ok: false, status: 403 }; // valid key but off-network and not opted in
}
async function serveStream(c: Context<Env>, channelId: number, transcode: boolean, user?: User) {
  const ch = db.select({ category: channels.category, isHidden: channels.isHidden }).from(channels).where(eq(channels.id, channelId)).get();
  // Hidden channels (adult, hidden categories, dupes, rule-hidden) aren't part of
  // the lineup, so they aren't playable either — even by a stale or direct id.
  if (!ch || ch.isHidden) return c.text("not found", 404);
  // A restricted (non-admin) viewer can't stream a channel they aren't allowed to see.
  if (user && user.role !== "admin") {
    if (!channelVisible({ id: channelId, category: ch.category ?? null }, user.restrictions)) return c.text("forbidden", 403);
  }
  if (transcode && !(await getSetting("features.transcode"))) return c.text("transcode disabled", 503);
  const body = transcode ? await transcoder.open(channelId, c.req.raw.signal) : await muxer.open(channelId, c.req.raw.signal);
  if (!body) return c.text(transcode ? "transcoder unavailable or no playable source" : "all tuners busy or no playable source", 503);
  trackSession(c, channelId, transcode ? "transcode" : "passthrough", user?.id);
  // Real watches (not tile previews) prime the surf ring around this channel.
  if (c.req.query("as") !== "preview") prewarm.onTune(channelId);
  return new Response(body, { headers: STREAM_HEADERS });
}

// Multiplexed MPEG-TS passthrough (web player via cookie, or ?key= for direct).
app.get("/stream/:channelId", async (c) => {
  const channelId = Number(c.req.param("channelId"));
  if (!Number.isFinite(channelId)) return c.text("bad channel id", 400);
  const auth = streamAuth(c);
  if (!auth.ok) return c.text(auth.status === 403 ? "off-network access is disabled" : "unauthorized — sign in, or append ?key=<stream key>", auth.status ?? 401);
  return serveStream(c, channelId, false, auth.user);
});
// Browser-friendly variant: video copy + audio→AAC (AC-3/HEVC channels).
app.get("/watch/:channelId", async (c) => {
  const channelId = Number(c.req.param("channelId"));
  if (!Number.isFinite(channelId)) return c.text("bad channel id", 400);
  const auth = streamAuth(c);
  if (!auth.ok) return c.text("unauthorized", auth.status ?? 401);
  return serveStream(c, channelId, true, auth.user);
});

// ── Mosaic compositor: one server-built MPEG-TS of the grid (low-latency, castable) ──
app.get("/mosaic/live.ts", (c) => {
  const auth = streamAuth(c);
  if (!auth.ok) return c.text(auth.status === 403 ? "off-network access is disabled" : "unauthorized — sign in, or append ?key=<stream key>", auth.status ?? 401);
  const body = compositor.open(c.req.raw.signal);
  if (!body) return c.text("mosaic has no channels selected", 409);
  return new Response(body, { headers: STREAM_HEADERS });
});
// The mosaic tab drives the composite: which channels, layout, focused tile, audio tile.
app.post("/api/mosaic/compose", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const b = (await c.req.json().catch(() => ({}))) as Partial<{ channels: (number | null)[]; layout: string; focus: number | null; audio: number; names: string[] }>;
  const patch: Partial<import("../proxy/compositor.ts").MosaicState> = {};
  if (Array.isArray(b.channels)) patch.channels = b.channels.map((x) => (x == null ? (null as unknown as number) : Number(x)));
  if (b.layout === "2up" || b.layout === "2x2" || b.layout === "3x3") patch.layout = b.layout;
  if ("focus" in b) patch.focus = b.focus == null ? null : Number(b.focus);
  if (typeof b.audio === "number") patch.audio = b.audio;
  if (Array.isArray(b.names)) patch.names = b.names.map((x) => String(x));
  compositor.setState(patch);
  return c.json(compositor.status());
});

// Shared mosaic state for the TV display page to poll. NOT under /api/* (which is
// session-gated) so a TV browser can read it with just the stream key, like
// /stream. Enriched with channel render info. Controller writes via /compose above.
app.get("/mosaic/state", (c) => {
  const auth = streamAuth(c);
  if (!auth.ok) return c.text("unauthorized", auth.status ?? 401);
  const st = compositor.getState();
  const tiles = st.channels.filter((id): id is number => id != null).map((id) => {
    const ch = db.select({ id: channels.id, name: channels.name, number: channels.number, logoUrl: channels.logoUrl }).from(channels).where(eq(channels.id, id)).get();
    return ch ?? { id, name: "#" + id, number: null, logoUrl: null };
  });
  return c.json({ layout: st.layout, focus: st.focus, audio: st.audio, tiles });
});
// The TV display: a clean fullscreen mosaic that mirrors the shared state, playing
// tiles straight from the muxer (no transcode). Open this on a browser by the TV.
app.get("/mosaic/tv", (c) => {
  const auth = streamAuth(c);
  if (!auth.ok) return c.text("unauthorized — append ?key=<stream key>", auth.status ?? 401);
  return new Response(Bun.file(`${publicDir}/mosaictv.html`), { headers: { "Content-Type": "text/html", "Cache-Control": noStore } });
});

// Timeshift (pause / rewind live): same multiplexed TS, but replayed from a
// rolling buffer starting `behind` seconds in the past, then running into live.
app.get("/timeshift/:channelId", async (c) => {
  const channelId = Number(c.req.param("channelId"));
  if (!Number.isFinite(channelId)) return c.text("bad channel id", 400);
  const auth = streamAuth(c);
  if (!auth.ok) return c.text(auth.status === 403 ? "off-network access is disabled" : "unauthorized", auth.status ?? 401);
  if (!(await getSetting("features.timeshift"))) return c.text("timeshift disabled", 503);
  if (auth.user && auth.user.role !== "admin") {
    const ch = db.select({ category: channels.category }).from(channels).where(eq(channels.id, channelId)).get();
    if (!channelVisible({ id: channelId, category: ch?.category ?? null }, auth.user.restrictions)) return c.text("forbidden", 403);
  }
  const behind = Math.max(0, Number(c.req.query("behind")) || 0);
  const body = timeshift.open(channelId, behind, c.req.raw.signal);
  trackSession(c, channelId, "passthrough", auth.user?.id);
  return new Response(body, { headers: STREAM_HEADERS });
});
// How much rewind buffer is available (seconds behind live) for a channel.
app.get("/api/timeshift/:channelId", (c) => {
  const channelId = Number(c.req.param("channelId"));
  if (!Number.isFinite(channelId)) return c.json({ error: "bad id" }, 400);
  return c.json({ windowSec: timeshift.windowSec(channelId), enabled: !!cachedSetting("features.timeshift") });
});

// A tile intermediate for the mosaic compositor: whole-packet MPEG-TS that
// always flows — the tile's normalized live video, or its labelled slate while
// the channel is down/dialing. Served by tilefeed.ts; local-only by design.
app.get("/tile/:slot", (c) => {
  const slot = Number(c.req.param("slot"));
  if (!Number.isFinite(slot) || slot < 0) return c.text("bad slot", 400);
  const auth = streamAuth(c);
  if (!auth.ok) return c.text("unauthorized", auth.status ?? 401);
  const body = tileFeeds.openSlot(slot);
  if (!body) return c.text("no such tile", 404);
  return new Response(body, { headers: STREAM_HEADERS });
});

// Internal keyframe-aligned feed the tile normalizers pull (so each ffmpeg
// input starts decoding at a clean keyframe instead of waiting/stalling mid-GOP).
app.get("/mosaicfeed/:channelId", async (c) => {
  const channelId = Number(c.req.param("channelId"));
  if (!Number.isFinite(channelId)) return c.text("bad channel id", 400);
  const auth = streamAuth(c);
  if (!auth.ok) return c.text("unauthorized", auth.status ?? 401);
  const signal = c.req.raw.signal;
  const body = await muxer.open(channelId, signal);
  if (!body) return c.text("no playable source", 503);
  // Persistent: a clean upstream EOF (provider drop, mux failover) re-dials the
  // channel instead of ending the input — a dead tile heals instead of staying
  // black until the next layout change.
  return new Response(persistentKeyframeFeed(() => muxer.open(channelId, signal), body, signal), { headers: STREAM_HEADERS });
});
// Live-edge feed (no keyframe preroll/backlog) — the compositor uses this so the
// cast tracks live (~1-2s) instead of starting a GOP behind.
app.get("/livefeed/:channelId", async (c) => {
  const channelId = Number(c.req.param("channelId"));
  if (!Number.isFinite(channelId)) return c.text("bad channel id", 400);
  const auth = streamAuth(c);
  if (!auth.ok) return c.text("unauthorized", auth.status ?? 401);
  const body = await muxer.open(channelId, c.req.raw.signal, { preroll: false });
  if (!body) return c.text("no playable source", 503);
  return new Response(body, { headers: STREAM_HEADERS });
});

// Mosaic status for the app: encode + per-tile health. The stream key (for
// building castable/shareable keyed links to keyless devices) is admin-only —
// it grants full access, so restricted users get "" and cast in-browser via
// their session cookie instead.
app.get("/api/mosaic/status", (c) => {
  const isAdmin = c.get("user")?.role === "admin";
  return c.json({ ...compositor.status(), key: isAdmin ? String(cachedSetting("access.streamKey") || "") : "" });
});

// ─── Exports under /t/<stream key>/ so the key rides every derived URL. Point
// Plex/Jellyfin at  http://<host>:7777/t/<key>  (HDHR), or use the M3U/XMLTV
// URLs. All gated by the LAN policy: off-network → 403 unless external is on. ───
function tunerKeyOk(c: Context<Env>): boolean {
  const k = streamKey();
  return !!k && c.req.param("key") === k;
}
// Returns a Response to short-circuit (404 bad key, 403 off-network), or null to proceed.
function tunerDenied(c: Context<Env>): Response | null {
  if (!tunerKeyOk(c)) return c.text("not found", 404);
  if (!isLocalIp(clientIp(c)) && !externalAllowed()) return c.text("off-network access is disabled (Settings → Network Access)", 403);
  return null;
}
app.get("/t/:key/discover.json", async (c) => {
  const d = tunerDenied(c); if (d) return d;
  if (!(await getSetting("features.hdhr"))) return c.notFound();
  return c.json(hdhr.discover(`${baseUrl(c)}/t/${c.req.param("key")}`));
});
app.get("/t/:key/lineup_status.json", (c) => tunerDenied(c) ?? c.json(hdhr.lineupStatus()));
app.get("/t/:key/lineup.json", async (c) => {
  const d = tunerDenied(c); if (d) return d;
  if (!(await getSetting("features.hdhr"))) return c.notFound();
  return c.json(hdhr.lineupRows(`${baseUrl(c)}/t/${c.req.param("key")}`));
});
app.get("/t/:key/stream/:channelId", async (c) => {
  const d = tunerDenied(c); if (d) return d;
  const channelId = Number(c.req.param("channelId"));
  if (!Number.isFinite(channelId)) return c.text("bad channel id", 400);
  return serveStream(c, channelId, false); // a valid tuner key = full lineup access
});
// The live mosaic composite, as a tunable channel for HDHR/M3U consumers.
app.get("/t/:key/mosaic.ts", (c) => {
  const d = tunerDenied(c); if (d) return d;
  const body = compositor.open(c.req.raw.signal);
  if (!body) return c.text("mosaic has no channels selected", 503);
  return new Response(body, { headers: STREAM_HEADERS });
});
// ── Tuner-group split (tuner.groups): each group is its own playlist + EPG —
// register it as a SECOND M3U tuner in Emby/Jellyfin with its own XMLTV — and
// the MAIN export excludes every grouped category, so the split is disjoint (a
// channel never shows up under both tuners). canonicalId stays the tvg-id
// everywhere, so favorites/recordings keyed on channel identity survive a
// channel moving between the main lineup and a group. ──
// Slug/group resolution lives in src/tuner/hdhr.ts alongside the playlist
// builder: the downstream-sync verifier (src/sync/converge.ts) has to work out
// which of these playlists each Emby tuner host subscribed to, and it must get
// the same answer these routes serve.
const { groupSlug, tunerGroups, groupedCategories } = hdhr;
const M3U_HEADERS = { "Content-Type": "audio/x-mpegurl; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const XMLTV_HEADERS = { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

// M3U playlist (Jellyfin M3U tuner, TiviMate, …) — stream URLs carry the key path.
app.get("/t/:key/playlist.m3u", async (c) => {
  const d = tunerDenied(c); if (d) return d;
  return new Response(await hdhr.playlistM3U(`${baseUrl(c)}/t/${c.req.param("key")}`, { exclude: await groupedCategories() }), { headers: M3U_HEADERS });
});
// XMLTV guide export for the same consumers (channel icons point at our logo cache).
app.get("/t/:key/epg.xml", async (c) => {
  const d = tunerDenied(c); if (d) return d;
  return new Response(await exportXmltv(`${baseUrl(c)}/t/${c.req.param("key")}`, { exclude: await groupedCategories() }), { headers: XMLTV_HEADERS });
});
// Per-group exports. Stream/logo URLs still route via the plain /t/<key> paths —
// only the lineup is scoped, playback endpoints are shared.
app.get("/t/:key/g/:group/playlist.m3u", async (c) => {
  const d = tunerDenied(c); if (d) return d;
  const g = (await tunerGroups()).find((x) => groupSlug(x.name) === c.req.param("group"));
  if (!g) return c.text("unknown tuner group", 404);
  return new Response(await hdhr.playlistM3U(`${baseUrl(c)}/t/${c.req.param("key")}`, { include: g.categories }), { headers: M3U_HEADERS });
});
app.get("/t/:key/g/:group/epg.xml", async (c) => {
  const d = tunerDenied(c); if (d) return d;
  const g = (await tunerGroups()).find((x) => groupSlug(x.name) === c.req.param("group"));
  if (!g) return c.text("unknown tuner group", 404);
  return new Response(await exportXmltv(`${baseUrl(c)}/t/${c.req.param("key")}`, { include: g.categories }), { headers: XMLTV_HEADERS });
});
// Cached channel logos — fetched from the provider once, then served locally.
app.get("/t/:key/logo/:channelId", async (c) => {
  const d = tunerDenied(c); if (d) return d;
  const channelId = Number(c.req.param("channelId"));
  if (!Number.isFinite(channelId)) return c.text("bad channel id", 400);
  const logo = await getLogo(channelId);
  if (!logo) return c.text("no logo", 404);
  return new Response(logo.bytes, {
    headers: { "Content-Type": logo.type, "Cache-Control": "public, max-age=604800, immutable", "X-Robots-Tag": "noindex" },
  });
});

// ─── Providers ───
app.get("/api/providers", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const rows = await db.select().from(providers);
  const counts = await db
    .select({ providerId: streams.providerId, n: sql<number>`count(distinct ${streams.channelId})` })
    .from(streams)
    .groupBy(streams.providerId);
  const byId = new Map(counts.map((r) => [r.providerId, Number(r.n)]));
  const snap = pool.snapshot();
  // Never leak the password to the client.
  return c.json(rows.map(({ password, ...p }) => ({
    ...p,
    hasPassword: !!password,
    channels: byId.get(p.id) ?? 0,
    slots: snap[p.id] ?? { max: p.maxConnections, used: 0 },
  })));
});

/** Normalize a mirror-hosts input (array or newline/comma string) → clean list or null. */
function normHosts(v: unknown): string[] | null {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,]+/) : [];
  const clean = arr.map((s) => String(s).trim()).filter(Boolean);
  return clean.length ? clean : null;
}

app.patch("/api/providers/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const allowed = ["name", "url", "username", "password", "maxConnections", "epgUrl", "priority", "enabled", "proxyUrl"];
  const updates: Record<string, unknown> = {};
  for (const k of allowed) if (k in body && body[k] !== "") updates[k] = body[k];
  if ("mirrorHosts" in body) updates.mirrorHosts = normHosts(body.mirrorHosts); // array or newline string → list (null clears)
  if (!Object.keys(updates).length) return c.json({ error: "nothing to update" }, 400);
  const [row] = await db.update(providers).set(updates).where(eq(providers.id, id)).returning();
  if (!row) return c.json({ error: "not found" }, 404);
  if ("maxConnections" in updates) pool.setBudget(row.id, row.maxConnections);
  const { password, ...safe } = row;
  return c.json({ ...safe, hasPassword: !!password });
});

app.delete("/api/providers/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  await db.delete(providers).where(eq(providers.id, id)); // cascades to its streams
  return c.json({ ok: true });
});

app.post("/api/providers", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const body = await c.req.json();
  const [row] = await db
    .insert(providers)
    .values({
      name: body.name,
      type: body.type,
      url: body.url,
      username: body.username ?? null,
      password: body.password ?? null,
      maxConnections: body.maxConnections ?? 1,
      epgUrl: body.epgUrl ?? null,
      priority: body.priority ?? 100,
      proxyUrl: body.proxyUrl || null,
      mirrorHosts: normHosts(body.mirrorHosts),
    })
    .returning();
  pool.setBudget(row.id, row.maxConnections);
  return c.json(row, 201);
});

// ─── VPNs (admin) — Phospharr dials these itself; no Gluetun. Configs/keys are
// write-only: they go in but never come back out to the client. ───
function safeVpn(v: typeof vpns.$inferSelect) {
  return { id: v.id, name: v.name, kind: v.kind, autostart: v.autostart, createdAt: v.createdAt, ...vpnStatus(v.id), ...parseNordInfo(v.config) };
}
app.get("/api/vpns", (c) =>
  ensureAdmin(c) ?? c.json(db.select().from(vpns).orderBy(vpns.id).all().map(safeVpn)));

app.post("/api/vpns", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const name = String(body.name ?? "").trim();
  const kind = body.kind === "openvpn" ? "openvpn" : "wireguard";
  const config = String(body.config ?? "").trim();
  if (!name || !config) return c.json({ error: "name and config are required" }, 400);
  const [row] = await db.insert(vpns).values({
    name, kind, config,
    username: body.username ? String(body.username) : null,
    password: body.password ? String(body.password) : null,
    autostart: body.autostart !== false,
    createdAt: new Date(),
  }).returning();
  if (row.autostart) await startVpn(row.id);
  return c.json(safeVpn(row), 201);
});

app.patch("/api/vpns/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const updates: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
  if (typeof body.config === "string" && body.config.trim()) updates.config = body.config.trim();
  if ("username" in body) updates.username = body.username ? String(body.username) : null;
  if ("password" in body) updates.password = body.password ? String(body.password) : null;
  if (typeof body.autostart === "boolean") updates.autostart = body.autostart;
  if (!Object.keys(updates).length) return c.json({ error: "nothing to update" }, 400);
  const [row] = await db.update(vpns).set(updates).where(eq(vpns.id, id)).returning();
  if (!row) return c.json({ error: "not found" }, 404);
  // Re-dial so config/credential changes take effect; honor autostart.
  stopVpn(id);
  if (row.autostart) await startVpn(id);
  return c.json(safeVpn(row));
});

app.delete("/api/vpns/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  stopVpn(id);
  await db.delete(vpns).where(eq(vpns.id, id));
  // Any provider pinned to this VPN now resolves to blocked (fail-closed), not direct.
  return c.json({ ok: true });
});

app.post("/api/vpns/:id/restart", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  stopVpn(id);
  await startVpn(id);
  return c.json(vpnStatus(id));
});

// Where does this VPN actually exit? Looks up the public IP/geo *through the
// tunnel*, so the UI can prove traffic is leaving from the expected country.
const vpnEgressCache = new Map<number, { at: number; data: unknown }>();
app.get("/api/vpns/:id/egress", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  const proxy = vpnProxyUrl(id);
  if (!proxy) return c.json({ ok: false, error: "tunnel is not up" });
  const hit = vpnEgressCache.get(id);
  if (hit && Date.now() - hit.at < 30_000) return c.json(hit.data);
  try {
    const r = await fetch("http://ip-api.com/json?fields=status,country,countryCode,city,isp,query", { proxy, signal: AbortSignal.timeout(12_000) });
    const j = (await r.json()) as { status: string; country: string; countryCode: string; city: string; isp: string; query: string };
    if (j.status !== "success") return c.json({ ok: false, error: "lookup failed" });
    const data = { ok: true, ip: j.query, country: j.country, countryCode: j.countryCode, city: j.city, org: j.isp };
    vpnEgressCache.set(id, { at: Date.now(), data });
    return c.json(data);
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// NordVPN location list (countries + their cities) for the picker.
app.get("/api/nord/countries", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  try { return c.json(await nordCountries()); }
  catch { return c.json({ error: "Couldn't reach NordVPN's server list." }, 502); }
});

// Change where a NordVPN tunnel exits: pick a country (+ optional city), we swap
// in a recommended OpenVPN-TCP server (same login/certs) and reconnect.
app.post("/api/vpns/:id/location", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  const v = db.select().from(vpns).where(eq(vpns.id, id)).get();
  if (!v) return c.json({ error: "not found" }, 404);
  if (!isNordConfig(v.config)) return c.json({ error: "Location picker only works for NordVPN configs." }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { countryId?: number; cityId?: number };
  if (!body.countryId) return c.json({ error: "countryId is required" }, 400);
  let rec;
  try { rec = await nordRecommend(Number(body.countryId), body.cityId ? Number(body.cityId) : undefined); }
  catch { return c.json({ error: "NordVPN lookup failed" }, 502); }
  if (!rec) return c.json({ error: "No server found for that location." }, 404);
  const config = setLocationComment(setNordServer(v.config, rec.hostname), rec.label);
  const [row] = await db.update(vpns).set({ config }).where(eq(vpns.id, id)).returning();
  vpnEgressCache.delete(id); // exit IP changes with the server
  stopVpn(id);
  if (row.autostart) await startVpn(id);
  return c.json(safeVpn(row));
});

// Clone a VPN (same config + credentials) so several locations can run at once,
// each pinned to a different source.
app.post("/api/vpns/:id/duplicate", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  const v = db.select().from(vpns).where(eq(vpns.id, id)).get();
  if (!v) return c.json({ error: "not found" }, 404);
  const [row] = await db.insert(vpns).values({
    name: `${v.name} copy`, kind: v.kind, config: v.config,
    username: v.username, password: v.password, autostart: v.autostart, createdAt: new Date(),
  }).returning();
  if (row.autostart) await startVpn(row.id);
  return c.json(safeVpn(row), 201);
});

// Dry-run a source's credentials/URL WITHOUT saving — returns a preview (channel
// count, categories, EPG presence) so the user can sanity-check before importing.
// Categories a single provider contributes to (for per-source management).
app.get("/api/providers/:id/categories", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  return c.json(await listProviderCategories(Number(c.req.param("id"))));
});

app.post("/api/providers/test", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const b = (await c.req.json().catch(() => ({}))) as Record<string, string>;
  const type = b.type === "xtream" ? "xtream" : "m3u";
  const url = String(b.url ?? "").trim();
  if (!url) return c.json({ ok: false, error: "Enter the URL first." });
  // Resolve a VPN reference the same way the real sync does, so the test exits
  // through the chosen tunnel too.
  let proxy = b.proxyUrl || undefined;
  const vpnMatch = proxy?.match(/^vpn:(\d+)$/);
  if (vpnMatch) proxy = vpnProxyUrl(Number(vpnMatch[1])); // undefined if the tunnel is down
  const opts = egress(proxy);
  try {
    let entries;
    if (type === "xtream") {
      if (!b.username || !b.password) return c.json({ ok: false, error: "Xtream needs a username and password." });
      entries = await fetchXtream(url, String(b.username), String(b.password), opts);
    } else {
      entries = await fetchM3U(url, opts);
    }
    const cats = new Map<string, number>();
    let withEpg = 0;
    for (const e of entries) {
      cats.set(e.groupTitle || "Uncategorized", (cats.get(e.groupTitle || "Uncategorized") ?? 0) + 1);
      if (e.tvgId) withEpg++;
    }
    const categories = [...cats.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    return c.json({
      ok: true,
      channelCount: entries.length,
      withEpg,
      totalCategories: categories.length,
      categories: categories.slice(0, 30),
    });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/providers/:id/sync", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  const result = await syncProvider(id);
  // Radarr/Sonarr-style: once the lineup sync lands, nudge downstream media
  // servers so the new/removed channels + guide show up now (fire-and-forget).
  // Then let the convergence ladder follow up: if Emby's cached lineup doesn't
  // actually move, it escalates on a later pass (src/sync/converge.ts).
  void refreshDownstreamGuides()
    .catch(() => {})
    .then(() => convergeAll())
    .catch((e) => console.error("[sync] converge", e));
  return c.json(result);
});

// ─── Channels ───
app.get("/api/channels", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const includeHidden = c.req.query("hidden") === "true";
  const rows = includeHidden
    ? await db.select().from(channels).orderBy(channels.number)
    : await db.select().from(channels).where(eq(channels.isHidden, false)).orderBy(channels.number);
  return c.json(rows);
});

app.patch("/api/channels/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const allowed = ["name", "number", "category", "isHidden", "isFavorite", "logoUrl", "kind", "genre"];
  const updates: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) updates[k] = body[k];
  // A manual kind/genre edit locks the channel's taxonomy so the classifier
  // never clobbers it on re-sync.
  if ("kind" in body || "genre" in body) updates.taxLocked = true;
  const [row] = await db.update(channels).set(updates).where(eq(channels.id, id)).returning();
  return c.json(row);
});

// Re-classify every non-locked channel, then renumber the whole lineup into
// cable-style blocks (see src/content/lineup.ts). Admin-triggered — numbers are
// otherwise sticky across syncs.
app.post("/api/lineup/reflow", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const { classifyAll, reflowLineup } = await import("../content/lineup.ts");
  const classified = await classifyAll();
  const { channels: renumbered } = await reflowLineup();
  return c.json({ classified, renumbered });
});

app.get("/api/channels/:id/sources", async (c) => {
  // ADMIN ONLY: streams.url embeds the provider's username/password (Xtream URLs
  // are {base}/live/{user}/{pass}/{id}.ts). Without this gate any low-privilege
  // user could enumerate channels and harvest the paid-account credentials.
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  return c.json(await db.select().from(streams).where(eq(streams.channelId, id)));
});

// ─── Guide (EPG) ───
app.get("/api/guide/:canonicalId/now", async (c) => {
  const canonicalId = c.req.param("canonicalId");
  return c.json(await nowNext(canonicalId));
});

// ─── Watch-party chat: an ephemeral WebSocket room per channel ───
import { chat } from "../chat.ts";
chat.setWatchingFn((channelId) => muxer.viewers(channelId));
let chatSeq = 0;
app.get("/ws/chat/:channelId", upgradeWebSocket((c) => {
  // WS routes sit outside the /api/* session middleware — resolve the user here.
  const user = userForToken(getCookie(c, SESSION_COOKIE));
  const channelId = Number(c.req.param("channelId"));
  const id = ++chatSeq;
  return {
    onOpen(_evt, ws) {
      if (!user || !Number.isFinite(channelId)) { ws.close(); return; }
      chat.join(channelId, { id, name: user.username, send: (json) => ws.send(json) });
    },
    onMessage(evt) {
      if (!user) return;
      chat.message(channelId, id, String(evt.data));
    },
    onClose() {
      chat.leave(channelId, id);
    },
  };
}));

// ─── HLS: native playback for MSE-less devices (iOS Safari, Cast, AirPlay) ───
app.get("/hls/:channelId/index.m3u8", async (c) => {
  const auth = streamAuth(c);
  if (!auth.ok) return c.text("unauthorized", auth.status ?? 401);
  const channelId = Number(c.req.param("channelId"));
  if (!Number.isFinite(channelId)) return c.text("bad channel id", 400);
  const { playlist } = await import("../proxy/hls.ts");
  let text = await playlist(channelId);
  if (!text) return c.text("channel unavailable", 503);
  // Key-based clients (no cookie): segment fetches need the key too — append it
  // to every URI line so the playlist is self-sufficient.
  const key = c.req.query("key");
  if (key) text = text.split("\n").map((l) => {
    if (l.startsWith("#EXT-X-MAP:")) return l.replace(/URI="([^"]+)"/, (_, u) => `URI="${u}?key=${encodeURIComponent(key)}"`);
    return l && !l.startsWith("#") ? l + "?key=" + encodeURIComponent(key) : l;
  }).join("\n");
  return c.text(text, 200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" });
});
app.get("/hls/:channelId/:file", async (c) => {
  const auth = streamAuth(c);
  if (!auth.ok) return c.text("unauthorized", auth.status ?? 401);
  const channelId = Number(c.req.param("channelId"));
  const { segment } = await import("../proxy/hls.ts");
  const f = segment(channelId, c.req.param("file"));
  if (!f) return c.text("not found", 404);
  return new Response(f, { headers: { "Content-Type": c.req.param("file").endsWith(".mp4") ? "video/mp4" : "video/iso.segment", "Cache-Control": "no-store" } });
});

// ─── VOD: movie + series catalogs (browse, detail, playback) ───
const vodPage = (q: string | undefined, cat: string | undefined, offset: number, limit: number) => ({
  q: (q ?? "").trim(), cat: (cat ?? "").trim(), offset: Math.max(0, offset || 0), limit: Math.min(120, Math.max(1, limit || 60)),
});
app.get("/api/vod/movies", async (c) => {
  if (!c.get("user")) return c.json({ error: "sign in" }, 401);
  const { q, cat, offset, limit } = vodPage(c.req.query("q"), c.req.query("cat"), Number(c.req.query("offset")), Number(c.req.query("limit")));
  const where = and(
    q ? sql`${vodMovies.name} LIKE ${"%" + q + "%"}` : sql`1=1`,
    cat ? eq(vodMovies.category, cat) : sql`1=1`,
  );
  const [items, [{ n: total }]] = await Promise.all([
    db.select().from(vodMovies).where(where).orderBy(vodMovies.name).limit(limit).offset(offset),
    db.select({ n: sql<number>`COUNT(*)` }).from(vodMovies).where(where),
  ]);
  return c.json({ items, total });
});
app.get("/api/vod/series", async (c) => {
  if (!c.get("user")) return c.json({ error: "sign in" }, 401);
  const { q, cat, offset, limit } = vodPage(c.req.query("q"), c.req.query("cat"), Number(c.req.query("offset")), Number(c.req.query("limit")));
  const where = and(
    q ? sql`${vodSeries.name} LIKE ${"%" + q + "%"}` : sql`1=1`,
    cat ? eq(vodSeries.category, cat) : sql`1=1`,
  );
  const [items, [{ n: total }]] = await Promise.all([
    db.select().from(vodSeries).where(where).orderBy(vodSeries.name).limit(limit).offset(offset),
    db.select({ n: sql<number>`COUNT(*)` }).from(vodSeries).where(where),
  ]);
  return c.json({ items, total });
});
app.get("/api/vod/categories", async (c) => {
  if (!c.get("user")) return c.json({ error: "sign in" }, 401);
  const [movies, series] = await Promise.all([
    db.select({ cat: vodMovies.category, n: sql<number>`COUNT(*)` }).from(vodMovies).groupBy(vodMovies.category).orderBy(sql`COUNT(*) DESC`),
    db.select({ cat: vodSeries.category, n: sql<number>`COUNT(*)` }).from(vodSeries).groupBy(vodSeries.category).orderBy(sql`COUNT(*) DESC`),
  ]);
  return c.json({ movies: movies.filter((r) => r.cat), series: series.filter((r) => r.cat) });
});
app.get("/api/vod/movies/:id/info", async (c) => {
  if (!c.get("user")) return c.json({ error: "sign in" }, 401);
  const id = Number(c.req.param("id"));
  await ensureMovieInfo(id).catch(() => { /* provider hiccup — serve what we have */ });
  const [row] = await db.select().from(vodMovies).where(eq(vodMovies.id, id));
  return row ? c.json(row) : c.json({ error: "not found" }, 404);
});
app.get("/api/vod/series/:id", async (c) => {
  if (!c.get("user")) return c.json({ error: "sign in" }, 401);
  const id = Number(c.req.param("id"));
  await ensureEpisodes(id).catch(() => { /* provider hiccup — serve cache */ });
  const [row] = await db.select().from(vodSeries).where(eq(vodSeries.id, id));
  if (!row) return c.json({ error: "not found" }, 404);
  const eps = await db.select().from(vodEpisodes).where(eq(vodEpisodes.seriesRowId, id)).orderBy(asc(vodEpisodes.season), asc(vodEpisodes.episode));
  return c.json({ ...row, episodes: eps });
});
// Resume positions. Report during playback (kind=movie|episode, refId, position).
app.post("/api/vod/progress", async (c) => {
  const u = c.get("user");
  if (!u) return c.json({ error: "sign in" }, 401);
  const b = (await c.req.json().catch(() => ({}))) as Partial<{ kind: "movie" | "episode"; refId: number; positionSec: number; durationSec: number }>;
  if ((b.kind !== "movie" && b.kind !== "episode") || !b.refId) return c.json({ error: "kind + refId required" }, 400);
  const pos = Math.max(0, Math.floor(b.positionSec ?? 0));
  // Near the end → treat as finished: drop the row so it leaves Continue Watching.
  if (b.durationSec && pos > b.durationSec * 0.95) {
    await db.delete(vodProgress).where(and(eq(vodProgress.userId, u.id), eq(vodProgress.kind, b.kind), eq(vodProgress.refId, Number(b.refId))));
    return c.json({ ok: true, cleared: true });
  }
  await db
    .insert(vodProgress)
    .values({ userId: u.id, kind: b.kind, refId: Number(b.refId), positionSec: pos, durationSec: b.durationSec ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [vodProgress.userId, vodProgress.kind, vodProgress.refId], set: { positionSec: pos, durationSec: b.durationSec ?? null, updatedAt: new Date() } });
  return c.json({ ok: true });
});
// One item's saved position (the player resumes from here).
app.get("/api/vod/progress/:kind/:refId", async (c) => {
  const u = c.get("user");
  if (!u) return c.json({ error: "sign in" }, 401);
  const kind = c.req.param("kind");
  if (kind !== "movie" && kind !== "episode") return c.json({ error: "bad kind" }, 400);
  const [row] = await db.select().from(vodProgress).where(and(eq(vodProgress.userId, u.id), eq(vodProgress.kind, kind), eq(vodProgress.refId, Number(c.req.param("refId")))));
  return c.json(row ?? { positionSec: 0 });
});
// Continue Watching row (Home): most-recent in-progress items enriched for display.
app.get("/api/vod/continue", async (c) => {
  const u = c.get("user");
  if (!u) return c.json([]);
  const rows = await db.select().from(vodProgress).where(eq(vodProgress.userId, u.id)).orderBy(sql`${vodProgress.updatedAt} DESC`).limit(20);
  const out = [];
  for (const r of rows) {
    if (r.kind === "movie") {
      const [m] = await db.select().from(vodMovies).where(eq(vodMovies.id, r.refId));
      if (m) out.push({ kind: "movie", refId: m.id, name: m.name, posterUrl: m.posterUrl, positionSec: r.positionSec, durationSec: r.durationSec });
    } else {
      const [e] = await db.select().from(vodEpisodes).where(eq(vodEpisodes.id, r.refId));
      if (e) {
        const [s] = await db.select().from(vodSeries).where(eq(vodSeries.id, e.seriesRowId));
        if (s) out.push({ kind: "episode", refId: e.id, seriesId: s.id, name: s.name + " · S" + e.season + "E" + e.episode, posterUrl: s.posterUrl, positionSec: r.positionSec, durationSec: r.durationSec });
      }
    }
  }
  return c.json(out);
});
app.post("/api/vod/sync", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const provs = await db.select().from(providers).where(eq(providers.enabled, true));
  const results = [];
  for (const p of provs) if (p.type === "xtream") results.push({ providerId: p.id, ...(await syncVod(p.id)) });
  // Rebuild the Emby/Jellyfin .strm library and, if it changed, trigger a scan
  // (Radarr-style; fire-and-forget, gated on features.vodLibrary inside).
  void (async () => {
    const lib = await rebuildVodLibrary();
    if (!lib.skipped && (lib.written || lib.pruned)) await scanDownstreamLibraries();
  })().catch(() => {});
  return c.json(results);
});

// Manually rebuild the VOD .strm library (and scan Emby) without a full re-sync.
app.post("/api/vod/library/rebuild", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const lib = await rebuildVodLibrary();
  if (!lib.skipped) await scanDownstreamLibraries().catch(() => {});
  return c.json(lib);
});

// VOD playback: remux the provider file (video copy, audio → AAC, MPEG-TS out)
// so MKV/AVI — most of a typical catalog — play in the browser via mpegts.js.
// ?t=<seconds> seeks (ffmpeg -ss before the input = fast keyframe seek). The
// provider connection counts against the slot pool for the whole playback.
const VOD_FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
/**
 * VOD byte passthrough — what makes a mirrored episode SEEKABLE.
 *
 * The remux path below pipes the upstream through ffmpeg into an unbounded
 * MPEG-TS stream: no Content-Length, no byte ranges, so a media server gets no
 * scrubber, no rewind and no resume position. The upstream is a plain MP4 whose
 * CDN answers `206 Partial Content` with a real `Content-Range` — measured on
 * the live provider — so all of that capability was being thrown away in the
 * remux. Relaying the bytes (and the Range header) instead gives Emby/Jellyfin
 * native seek, pause, rewind and continue-watching, and costs no ffmpeg process
 * per stream. When a client can't handle the container, the media server
 * transcodes it itself — which is what it is good at.
 *
 * The provider slot is still held for the life of the response, and the request
 * still goes through the provider's egress (fail-closed VPN) exactly as before.
 */
async function serveVodPassthrough(c: Context<Env>, eg: { proxy?: string }, url: string, release: () => void) {
  const range = c.req.header("range");
  let up: Response;
  try {
    up = await fetch(url, {
      method: c.req.method === "HEAD" ? "HEAD" : "GET",
      headers: range ? { Range: range } : undefined,
      redirect: "follow", // the provider 302s to its CDN; the CDN is what serves ranges
      signal: c.req.raw.signal,
      ...(eg.proxy ? { proxy: eg.proxy } : {}),
    });
  } catch {
    release();
    return null; // caller falls back to the remux path
  }
  if (!up.ok && up.status !== 206) { release(); return null; }

  // Relay exactly what the CDN said about size/ranges — that is the whole point.
  const h = new Headers({ "Cache-Control": "no-store" });
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = up.headers.get(k);
    if (v) h.set(k, v);
  }
  if (!h.has("accept-ranges")) h.set("Accept-Ranges", "bytes"); // CDN honours ranges even when it forgets to advertise
  if (!up.body || c.req.method === "HEAD") { release(); return new Response(null, { status: up.status, headers: h }); }

  // Hold the slot until the body genuinely finishes, and let go the moment the
  // viewer walks away — a seeking client opens a NEW ranged request per scrub,
  // so a slot leaked per seek would exhaust the provider's connections fast.
  const body = up.body.pipeThrough(new TransformStream({ flush: release }));
  c.req.raw.signal.addEventListener("abort", release, { once: true });
  return new Response(body, { status: up.status, headers: h });
}

async function serveVod(c: Context<Env>, kind: "movie" | "series", providerId: number, streamId: number, ext: string) {
  const [prov] = await db.select().from(providers).where(eq(providers.id, providerId));
  if (!prov) return c.text("provider gone", 404);
  const eg = providerEgress(prov.id);
  if (eg.blocked) return c.text("VPN for this source is down", 503);
  if (!pool.acquire(prov.id)) return c.text("all tuners busy", 503);
  const t = Math.max(0, Number(c.req.query("t")) || 0);
  // tc=1: the browser couldn't decode the copied video (HEVC / 10-bit) — re-encode
  // to H.264, on the GPU when available (same encoder the mosaic compositor uses).
  const tc = c.req.query("tc") === "1";
  const venc = !tc
    ? ["-c:v", "copy"]
    : process.env.PHOSPHARR_CAST_ENCODER === "h264_nvenc"
      ? ["-c:v", "h264_nvenc", "-preset", "p4", "-b:v", "8M", "-pix_fmt", "yuv420p"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p"];
  const url = vodUpstreamUrl(prov, kind, streamId, ext);
  let released = false;
  const release = () => { if (!released) { released = true; pool.release(prov.id); } };

  // Default to the seekable byte passthrough. Remux only where it earns its
  // keep: `tc=1` (client can't decode the codec), `t=` (Phospharr's own player
  // asks ffmpeg to start mid-file, since it can't send a byte offset it doesn't
  // know), or an explicit `remux=1` escape hatch. A passthrough that can't
  // reach the CDN returns null and falls through to remux rather than failing.
  const forceRemux = tc || t > 0 || c.req.query("remux") === "1";
  if (!forceRemux) {
    const passthrough = await serveVodPassthrough(c, eg as { proxy?: string }, url, release);
    if (passthrough) return passthrough;
    if (!pool.acquire(prov.id)) return c.text("all tuners busy", 503); // re-take: the failed attempt released it
    released = false;
  }

  const args = [
    "-hide_banner", "-loglevel", "error",
    ...("proxy" in eg && eg.proxy ? ["-http_proxy", eg.proxy] : []),
    ...(t > 0 ? ["-ss", String(t)] : []),
    // tight probe: don't sniff megabytes of a remote MKV before the first frame
    "-analyzeduration", "2000000", "-probesize", "2000000", "-fflags", "+genpts",
    "-i", url,
    "-map", "0:v:0", "-map", "0:a:0?",
    ...venc, "-c:a", "aac", "-ac", "2", "-b:a", "160k",
    "-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "pipe:1",
  ];
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([VOD_FFMPEG, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    release();
    return c.text("ffmpeg unavailable", 503);
  }
  void proc.exited.then(release);
  c.req.raw.signal.addEventListener("abort", () => { try { proc.kill(); } catch { /* gone */ } release(); }, { once: true });
  return new Response(proc.stdout as ReadableStream<Uint8Array>, { headers: STREAM_HEADERS });
}
app.get("/vod/play/movie/:id", async (c) => {
  const auth = streamAuth(c);
  if (!auth.ok) return c.text("unauthorized", auth.status ?? 401);
  const [m] = await db.select().from(vodMovies).where(eq(vodMovies.id, Number(c.req.param("id"))));
  if (!m) return c.text("not found", 404);
  return serveVod(c, "movie", m.providerId, m.streamId, m.ext);
});
app.get("/vod/play/episode/:id", async (c) => {
  const auth = streamAuth(c);
  if (!auth.ok) return c.text("unauthorized", auth.status ?? 401);
  const [e] = await db.select().from(vodEpisodes).where(eq(vodEpisodes.id, Number(c.req.param("id"))));
  if (!e) return c.text("not found", 404);
  const [s] = await db.select().from(vodSeries).where(eq(vodSeries.id, e.seriesRowId));
  if (!s) return c.text("series gone", 404);
  return serveVod(c, "series", s.providerId, e.streamId, e.ext);
});
// Stable episode playback: series ROW id + season/episode. Episode row ids are
// wiped and reissued on every episode refetch, so any URL persisted into a
// .strm (the mirror tree, and especially stubs Sonarr has imported — nothing
// ever rewrites those) must use this composite key instead. Self-heals: a miss
// pulls the episode list fresh before giving up.
app.get("/vod/play/ep/:sid/:season/:episode", async (c) => {
  const auth = streamAuth(c);
  if (!auth.ok) return c.text("unauthorized", auth.status ?? 401);
  const sid = Number(c.req.param("sid")), season = Number(c.req.param("season")), episode = Number(c.req.param("episode"));
  if (!Number.isFinite(sid) || !Number.isFinite(season) || !Number.isFinite(episode)) return c.text("bad request", 400);
  const find = () => db.select().from(vodEpisodes)
    .where(and(eq(vodEpisodes.seriesRowId, sid), eq(vodEpisodes.season, season), eq(vodEpisodes.episode, episode)))
    .orderBy(asc(vodEpisodes.id));
  let [e] = await find();
  if (!e) {
    try { await ensureEpisodes(sid, 60_000); } catch { /* provider hiccup */ }
    [e] = await find();
  }
  if (!e) return c.text("not found", 404);
  const [s] = await db.select().from(vodSeries).where(eq(vodSeries.id, sid));
  if (!s) return c.text("series gone", 404);
  return serveVod(c, "series", s.providerId, e.streamId, e.ext);
});

// ─── Custom live channels (esports, streamers — Twitch/YouTube/Kick/direct) ───
import { resolverFor, probeSource } from "../proxy/source.ts";
import { assignNumbersInBlocks } from "../content/lineup.ts";
import { pool as slotPool } from "../scheduler/pool.ts";

// The synthetic "Custom" provider that owns every user-added live stream. Local
// resolver processes aren't provider-connection-capped, so give it generous slots.
async function customProviderId(): Promise<number> {
  const existing = db.select().from(providers).where(eq(providers.type, "custom")).get();
  if (existing) return existing.id;
  const [row] = await db.insert(providers).values({ name: "Custom", type: "custom", url: "custom://local", maxConnections: 20, enabled: true }).returning();
  slotPool.setBudget(row.id, 20);
  return row.id;
}

app.get("/api/custom-channels", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const rows = await db.select().from(channels).where(eq(channels.kind, "live")).orderBy(channels.number);
  return c.json(rows);
});
// Twitch discovery: browse popular live channels + search (public GQL, no creds).
app.get("/api/discover/twitch", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const { topStreams, searchChannels } = await import("../discover/twitch.ts");
  const q = c.req.query("q");
  const items = q && q.trim() ? await searchChannels(q.trim()) : await topStreams();
  return c.json(items);
});

// Test a URL before saving — resolves it briefly and reports ok / the real error.
app.post("/api/custom-channels/probe", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const b = (await c.req.json().catch(() => ({}))) as { url?: string };
  const url = (b.url ?? "").trim();
  if (!/^https?:\/\//.test(url)) return c.json({ ok: false, error: "enter an http(s) URL" });
  return c.json(await probeSource(url));
});
app.post("/api/custom-channels", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const b = (await c.req.json().catch(() => ({}))) as Partial<{ name: string; url: string; logoUrl: string; category: string; now: string }>;
  const name = (b.name ?? "").trim();
  const url = (b.url ?? "").trim();
  if (!name || !/^https?:\/\//.test(url)) return c.json({ error: "name and an http(s) URL are required" }, 400);
  const pid = await customProviderId();
  const canonicalId = "live." + name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40) + "." + Date.now().toString(36);
  const [ch] = await db.insert(channels).values({
    canonicalId, name, logoUrl: b.logoUrl?.trim() || null, category: b.category?.trim() || "Live",
    kind: "live", genre: "Sports", taxLocked: true, customNow: b.now?.trim() || null,
  }).returning();
  await db.insert(streams).values({
    channelId: ch.id, providerId: pid, url, rawName: name, health: "unknown",
    resolver: resolverFor(url), qualityScore: 500,
  });
  await assignNumbersInBlocks([ch.id]);
  const [full] = await db.select().from(channels).where(eq(channels.id, ch.id));
  return c.json(full);
});
app.patch("/api/custom-channels/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  const b = (await c.req.json().catch(() => ({}))) as Partial<{ name: string; now: string; logoUrl: string; category: string }>;
  const upd: Record<string, unknown> = {};
  if (typeof b.name === "string") upd.name = b.name.trim();
  if ("now" in b) upd.customNow = (b.now ?? "").trim() || null;
  if (typeof b.logoUrl === "string") upd.logoUrl = b.logoUrl.trim() || null;
  if (typeof b.category === "string") upd.category = b.category.trim() || null;
  const [row] = await db.update(channels).set(upd).where(and(eq(channels.id, id), eq(channels.kind, "live"))).returning();
  return row ? c.json(row) : c.json({ error: "not found" }, 404);
});
app.delete("/api/custom-channels/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  const ch = db.select().from(channels).where(and(eq(channels.id, id), eq(channels.kind, "live"))).get();
  if (!ch) return c.json({ error: "not found" }, 404);
  await db.delete(channels).where(eq(channels.id, id)); // streams cascade
  return c.json({ ok: true });
});

// ─── Reminders ("tell me when this starts") ───
app.get("/api/reminders", async (c) => {
  const u = c.get("user");
  if (!u) return c.json({ error: "sign in" }, 401);
  // lazy GC: reminders whose program started >5 min ago are spent
  await db.delete(reminders).where(and(eq(reminders.userId, u.id), lt(reminders.startTime, new Date(Date.now() - 5 * 60_000))));
  return c.json(await db.select().from(reminders).where(eq(reminders.userId, u.id)).orderBy(asc(reminders.startTime)));
});
app.post("/api/reminders", async (c) => {
  const u = c.get("user");
  if (!u) return c.json({ error: "sign in" }, 401);
  const b = (await c.req.json().catch(() => ({}))) as Partial<{ channelId: number; title: string; startTime: number }>;
  if (!b.channelId || !b.title || !b.startTime) return c.json({ error: "channelId, title, startTime required" }, 400);
  const [row] = await db
    .insert(reminders)
    .values({ userId: u.id, channelId: Number(b.channelId), title: String(b.title), startTime: new Date(Number(b.startTime)), createdAt: new Date() })
    .returning();
  return c.json(row);
});
app.delete("/api/reminders/:id", async (c) => {
  const u = c.get("user");
  if (!u) return c.json({ error: "sign in" }, 401);
  await db.delete(reminders).where(and(eq(reminders.id, Number(c.req.param("id"))), eq(reminders.userId, u.id)));
  return c.json({ ok: true });
});

// ─── DVR ───
app.get("/api/dvr", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  return c.json(await dvrOverview());
});
app.post("/api/dvr/record", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const b = (await c.req.json().catch(() => ({}))) as Partial<{ channelId: number; canonicalId: string; title: string; subtitle: string; startTime: number; endTime: number }>;
  if (!b.channelId || !b.title || !b.startTime || !b.endTime) return c.json({ error: "channelId, title, startTime, endTime required" }, 400);
  const row = await scheduleRecording({
    channelId: Number(b.channelId), canonicalId: b.canonicalId ?? null, title: String(b.title),
    subtitle: b.subtitle ?? null, startTime: new Date(Number(b.startTime)), endTime: new Date(Number(b.endTime)),
  });
  if (!row) return c.json({ error: "already scheduled" }, 409);
  return c.json(row);
});
app.delete("/api/dvr/recordings/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  return c.json({ ok: await cancelRecording(Number(c.req.param("id"))) });
});
app.post("/api/dvr/rules", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const b = (await c.req.json().catch(() => ({}))) as Partial<{ titleMatch: string; canonicalId: string }>;
  if (!b.titleMatch?.trim()) return c.json({ error: "titleMatch required" }, 400);
  const [row] = await db.insert(dvrRules).values({ titleMatch: b.titleMatch.trim(), canonicalId: b.canonicalId ?? null, createdAt: new Date() }).returning();
  return c.json(row);
});
app.delete("/api/dvr/rules/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  await deleteRule(Number(c.req.param("id")), c.req.query("cancel") === "1");
  return c.json({ ok: true });
});
// Recording playback (session cookie or stream key) with Range support so the
// player can seek. Raw MPEG-TS — mpegts.js/VLC/ffmpeg all take it directly.
app.get("/dvr/:id", async (c) => {
  const auth = streamAuth(c);
  if (!auth.ok) return c.text("unauthorized", auth.status ?? 401);
  const rec = db.select().from(recordings).where(eq(recordings.id, Number(c.req.param("id")))).get();
  if (!rec?.filePath) return c.text("not found", 404);
  // A restricted (non-admin) viewer can't play a recording of a channel they
  // aren't allowed to see — an adult/hidden channel's DVR is off-limits too.
  if (auth.user && auth.user.role !== "admin") {
    const ch = db.select({ category: channels.category, isHidden: channels.isHidden }).from(channels).where(eq(channels.id, rec.channelId)).get();
    if (ch && (ch.isHidden || !channelVisible({ id: rec.channelId, category: ch.category ?? null }, auth.user.restrictions))) return c.text("forbidden", 403);
  }
  const f = Bun.file(rec.filePath);
  if (!(await f.exists())) return c.text("file missing", 404);
  const size = f.size;
  const range = c.req.header("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size) return c.text("range", 416);
    return new Response(f.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Type": "video/mp2t", "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(f, { headers: { "Content-Type": "video/mp2t", "Accept-Ranges": "bytes", "Content-Length": String(size) } });
});

app.post("/api/epg/sync", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const body = await c.req.json().catch(() => ({}));
  // Explicit urls win; otherwise derive one per enabled provider.
  const urls: string[] = body.urls?.length ? body.urls : await providerEpgUrls(body.providerId ? Number(body.providerId) : undefined);
  if (urls.length === 0) return c.json({ error: "no EPG sources available" }, 400);
  const results = await syncEpgFromUrls(urls);
  // Ours is fresh — nudge downstream media servers (Emby/Plex/Jellyfin) to reload.
  const downstream = await refreshDownstreamGuides().catch(() => []);
  return c.json({ results, downstream });
});

// ─── Downstream guide sync: media servers we push a guide-refresh to ───
// API keys are secrets — never returned. The UI sends "hasKey" back untouched;
// a real apiKey only travels client→server when the admin (re)enters it.
const redactDownstream = (list: import("../settings.ts").DownstreamServer[]) =>
  (list ?? []).map(({ apiKey, ...rest }) => ({ ...rest, hasKey: !!apiKey }));
app.get("/api/epg/downstream", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const list = await getSetting("epg.downstream");
  return c.json({ servers: redactDownstream(list), results: downstreamResults() });
});
app.put("/api/epg/downstream", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const body = (await c.req.json().catch(() => ({}))) as { servers?: (Partial<import("../settings.ts").DownstreamServer> & { hasKey?: boolean })[] };
  const existing = await getSetting("epg.downstream");
  const byId = new Map(existing.map((s) => [s.id, s]));
  const next: import("../settings.ts").DownstreamServer[] = (body.servers ?? []).map((s) => {
    const id = String(s.id || (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)));
    const type = s.type === "plex" || s.type === "jellyfin" || s.type === "emby" ? s.type : "emby";
    // A blank apiKey with hasKey=true means "keep the stored secret" (the UI
    // never received it to echo back); a non-empty apiKey replaces it.
    const apiKey = s.apiKey ? String(s.apiKey) : (s.hasKey ? (byId.get(id)?.apiKey ?? "") : "");
    return { id, type, name: String(s.name ?? "").trim(), url: String(s.url ?? "").trim(), apiKey, enabled: s.enabled !== false };
  });
  await setSetting("epg.downstream", next);
  return c.json({ servers: redactDownstream(next) });
});
// Fire a guide refresh at ONE server now (the Test button). Uses the stored key.
app.post("/api/epg/downstream/:id/test", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const list = await getSetting("epg.downstream");
  const server = list.find((s) => s.id === c.req.param("id"));
  if (!server) return c.json({ error: "not found" }, 404);
  return c.json(await refreshOne(server));
});

// ─── Self-healing sync status (Task 11): surfaces Task 6's convergence ladder
// + Task 9's reconciler to the operator. INNER JOIN against `epg.downstream`
// (not a raw dump of `sync_state`) so a stale row from a removed server never
// renders, and — same mechanism — the reconciler's synthetic "vod-mirror"
// entry (VOD_MIRROR_ID, a global check, not a real Emby server) can never
// appear here either, since it is never a configured downstream server.
// Cheap by construction: syncStates()/loopStates() are local reads (sync_state
// table + in-memory heartbeat registry) and the favorites count is one
// indexed GROUP BY — nothing here calls Emby or does real reconcile work, so
// the Manage card can poll this every 60s with no cost to Emby or the DB.
app.get("/api/sync/status", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const configured = (await getSetting("epg.downstream")) ?? [];
  const states = new Map(syncStates().map((s) => [s.serverId, s]));
  const favRows = db
    .select({ serverId: downstreamFavorites.serverId, n: sql<number>`count(distinct ${downstreamFavorites.channelId})` })
    .from(downstreamFavorites)
    .groupBy(downstreamFavorites.serverId)
    .all();
  const favorites = new Map(favRows.map((r) => [r.serverId, Number(r.n)]));
  const servers = configured.map((s) => {
    const st = states.get(s.id) ?? {
      serverId: s.id, state: "unknown" as const, fingerprint: "", lastReaddAt: null,
      lastAction: "", lastActionAt: 0, lastError: null, readdFailures: 0,
      needsAttention: false, pendingReadd: false, scopeFailures: {} as Record<string, number>,
    };
    return { ...st, name: s.name || s.url, favorites: favorites.get(s.id) ?? 0 };
  });
  // The reconciler beats its watchdog heartbeat at the START of every 5-minute
  // tick (src/sync/reconciler.ts's tick()), before the pass runs — "last run"
  // here means "last tick started", not "last tick finished". Reusing the
  // watchdog registry avoids adding a second, redundant timestamp store.
  const reconciler = { lastRunAt: loopStates().find((l) => l.name === "reconciler")?.lastBeat ?? null };
  return c.json({ servers, reconciler });
});

// Operator "I've fixed it, try again": re-arms converge.ts's rung 4 (the
// destructive tuner delete+re-add) for one server after its 3-strike breaker
// tripped. This is the ONLY way to clear it besides editing the DB by hand.
//
// Destructive-adjacent, so it's guarded three ways: (1) admin-gated like every
// other mutation in this file; (2) 404 unless `id` is a currently configured
// downstream server — never a free-form string that could wedge a bogus
// sync_state row, and this alone already excludes VOD_MIRROR_ID, which is
// never a configured server; (3) 400 unless the breaker is ACTUALLY tripped
// right now (`needsAttention`), so a stray click — or two — can't silently
// re-arm escalation on a server that isn't in trouble. The UI additionally
// disables the button unless tripped and confirms before calling this,
// showing the operator the lastError that tripped it (see public/app.js).
app.post("/api/sync/:id/reset", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = c.req.param("id");
  const configured = (await getSetting("epg.downstream")) ?? [];
  if (!configured.some((s) => s.id === id)) return c.json({ error: "not found" }, 404);
  const st = syncStates().find((s) => s.serverId === id);
  if (!st?.needsAttention) return c.json({ error: "this server's breaker is not tripped — nothing to reset" }, 400);
  resetAttention(id);
  return c.json({ ok: true });
});

// ─── Rules ───
app.get("/api/rules", async (c) => ensureAdmin(c) ?? c.json(await db.select().from(rules)));
app.post("/api/rules", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const body = await c.req.json();
  const [row] = await db
    .insert(rules)
    .values({
      name: body.name,
      type: body.type,
      condition: body.condition,
      action: body.action,
      priority: body.priority ?? 100,
    })
    .returning();
  return c.json(row, 201);
});
app.patch("/api/rules/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const updates: Record<string, unknown> = {};
  for (const k of ["name", "type", "condition", "action", "priority", "enabled"]) if (k in body) updates[k] = body[k];
  const [row] = await db.update(rules).set(updates).where(eq(rules.id, id)).returning();
  return row ? c.json(row) : c.json({ error: "not found" }, 404);
});
app.delete("/api/rules/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  await db.delete(rules).where(eq(rules.id, Number(c.req.param("id"))));
  return c.json({ ok: true });
});
app.post("/api/rules/apply", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  return c.json(await applyRules());
});

// ─── Users (admin only) ───
app.get("/api/users", (c) =>
  ensureAdmin(c) ?? c.json(db.select().from(users).orderBy(users.id).all().map(publicUser)),
);
app.patch("/api/users/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  const target = db.select().from(users).where(eq(users.id, id)).get();
  if (!target) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const updates: Record<string, unknown> = {};
  if (typeof body.username === "string" && body.username.trim()) updates.username = body.username.trim();
  if (body.role === "admin" || body.role === "user") {
    // Don't let the last admin demote themselves out of existence.
    if (target.role === "admin" && body.role === "user") {
      const admins = db.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.role, "admin")).get();
      if ((admins?.n ?? 0) <= 1) return c.json({ error: "can't demote the only admin" }, 400);
    }
    updates.role = body.role;
  }
  if (body.restrictions && typeof body.restrictions === "object") updates.restrictions = body.restrictions;
  if (typeof body.password === "string" && body.password) {
    if (body.password.length < 6) return c.json({ error: "password must be at least 6 characters" }, 400);
    updates.passwordHash = await hashPassword(body.password);
  }
  const [row] = await db.update(users).set(updates).where(eq(users.id, id)).returning();
  return c.json(publicUser(row));
});
app.delete("/api/users/:id", (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  if (c.get("user").id === id) return c.json({ error: "can't delete yourself" }, 400);
  const target = db.select().from(users).where(eq(users.id, id)).get();
  if (!target) return c.json({ error: "not found" }, 404);
  if (target.role === "admin") {
    const admins = db.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.role, "admin")).get();
    if ((admins?.n ?? 0) <= 1) return c.json({ error: "can't delete the only admin" }, 400);
  }
  // Anonymize this user's watch history rather than delete it — keeps the
  // household analytics aggregate intact, and the view_events FK is NO ACTION
  // (SQLite ADD COLUMN can't carry ON DELETE SET NULL), so without this the
  // delete would fail the constraint. Other user-owned rows cascade.
  db.update(viewEvents).set({ userId: null }).where(eq(viewEvents.userId, id)).run();
  db.delete(users).where(eq(users.id, id)).run();
  return c.json({ ok: true });
});

// ─── Share links (admin only) ───
app.get("/api/shares", (c) => ensureAdmin(c) ?? c.json(listShares()));
app.post("/api/shares", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const b = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const channelId = Number(b.channelId);
  if (!Number.isFinite(channelId)) return c.json({ error: "channelId required" }, 400);
  if (!db.select().from(channels).where(eq(channels.id, channelId)).get()) return c.json({ error: "no such channel" }, 404);
  const share = await createShare({
    channelId,
    label: typeof b.label === "string" ? b.label : null,
    expiresInHours: Number(b.expiresInHours) || 24,
    maxConcurrent: Number(b.maxConcurrent) || 2,
    createdBy: c.get("user").id,
  });
  return c.json(share, 201);
});
app.post("/api/shares/:id/revoke", (c) => ensureAdmin(c) ?? c.json({ ok: revokeShare(Number(c.req.param("id"))) }));
app.delete("/api/shares/:id", (c) => ensureAdmin(c) ?? c.json({ ok: deleteShare(Number(c.req.param("id"))) }));

// ─── Diagnostics ───
app.get("/api/status", (c) =>
  c.json({ pool: pool.snapshot(), totalFree: pool.totalFree(), active: muxer.stats() }),
);

// ─── Torznab indexer (Sonarr-facing VOD catalog; gated on vod.indexer.enabled) ───
import { torznab } from "./torznab.ts";
app.route("/", torznab);

export default app;
