import { Hono } from "hono";
import { and, eq, gt, lte, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { providers, channels, streams, rules, programs, vpns } from "../db/schema.ts";
import { startVpn, stopVpn, vpnStatus } from "../net/tunnel.ts";
import { syncProvider } from "../ingest/sync.ts";
import { fetchM3U } from "../ingest/m3u.ts";
import { fetchXtream } from "../ingest/xtream.ts";
import { egress } from "../net/egress.ts";
import { vpnSocksUrl } from "../net/tunnel.ts";
import { syncEpgFromUrls, nowNext, providerEpgUrls } from "../epg/merge.ts";
import { applyRules } from "../rules/engine.ts";
import { reconcileAutoHides, listCategories, listProviderCategories } from "../content/filter.ts";
import { muxer } from "../proxy/muxer.ts";
import { timeshift } from "../proxy/timeshift.ts";
import { transcoder } from "../proxy/transcode.ts";
import { pool } from "../scheduler/pool.ts";
import * as hdhr from "../tuner/hdhr.ts";
import { clientIp, isLocalIp, externalAllowed } from "../net/access.ts";
import { exportXmltv } from "../epg/export.ts";
import { buildView } from "./view.ts";
import { getGuideSnapshot } from "../epg/snapshot.ts";
import { getSettings, getSetting, setSetting, cachedSetting, envLockedKeys, capabilities, type Settings } from "../settings.ts";
import { recordView, getAnalytics, recentChannels } from "../analytics.ts";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  SESSION_COOKIE, userForToken, userCount, createUser, login, logout, publicUser, hashPassword, channelVisible,
} from "../auth.ts";
import { users } from "../db/schema.ts";
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
function trackSession(c: Context, channelId: number, source: "passthrough" | "transcode") {
  const kind = c.req.query("as") === "preview" ? "preview" : "watch";
  const startedAt = Date.now();
  c.req.raw.signal.addEventListener(
    "abort",
    () => recordView({ channelId, kind, source, startedAt, endedAt: Date.now() }),
    { once: true },
  );
}

export const app = new Hono<Env>();

const COOKIE_OPTS = { httpOnly: true, sameSite: "Lax" as const, path: "/", maxAge: 30 * 24 * 3600 };
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
app.get("/", () => new Response(Bun.file(`${publicDir}/index.html`), { headers: { "Content-Type": "text/html", "Cache-Control": noStore } }));
app.get("/app.js", () => new Response(Bun.file(`${publicDir}/app.js`), { headers: { "Content-Type": "text/javascript", "Cache-Control": noStore } }));
app.get("/vendor/mpegts.js", () =>
  new Response(Bun.file(`${publicDir}/vendor/mpegts.js`), {
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
    if (res) setCookie(c, SESSION_COOKIE, res.token, COOKIE_OPTS);
  }
  return c.json({ user: publicUser(user) });
});
app.post("/api/auth/login", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const res = await login(String(body.username ?? ""), String(body.password ?? ""));
  if (!res) return c.json({ error: "invalid username or password" }, 401);
  setCookie(c, SESSION_COOKIE, res.token, COOKIE_OPTS);
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

app.get("/api/health", (c) => c.json({ name: "Phospharr", version: "0.1.0", status: "ok" }));

// ─── Analytics ───
app.get("/api/analytics", (c) => ensureAdmin(c) ?? c.json(getAnalytics()));
// Recently-watched channel ids — powers the Home "Jump back in" row (any user).
app.get("/api/recent", (c) => c.json(recentChannels(14)));

// ─── Settings + capabilities ───
app.get("/api/capabilities", async (c) => c.json(await capabilities()));
// Every category + channel count + whether the admin has hidden the whole group.
app.get("/api/categories", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  return c.json(await listCategories());
});

app.get("/api/settings", async (c) => c.json({ settings: await getSettings(), envLocked: envLockedKeys() }));
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
  if ("content.hideAdult" in body || "content.hiddenCategories" in body || "content.hiddenMarkets" in body || "content.dedupeLocals" in body) await reconcileAutoHides();
  return c.json({ settings: await getSettings(), envLocked: envLockedKeys() });
});

// Channels + health + source counts (the guide is served separately).
// Non-admins get a lineup filtered to what their restrictions allow.
app.get("/api/view", async (c) => c.json(await buildView(c.get("user"))));

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
  // A restricted (non-admin) viewer can't stream a channel they aren't allowed to see.
  if (user && user.role !== "admin") {
    const ch = db.select({ category: channels.category }).from(channels).where(eq(channels.id, channelId)).get();
    if (!channelVisible({ id: channelId, category: ch?.category ?? null }, user.restrictions)) return c.text("forbidden", 403);
  }
  if (transcode && !(await getSetting("features.transcode"))) return c.text("transcode disabled", 503);
  const body = transcode ? await transcoder.open(channelId, c.req.raw.signal) : await muxer.open(channelId, c.req.raw.signal);
  if (!body) return c.text(transcode ? "transcoder unavailable or no playable source" : "all tuners busy or no playable source", 503);
  trackSession(c, channelId, transcode ? "transcode" : "passthrough");
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
  const body = timeshift.open(channelId, behind);
  trackSession(c, channelId, "passthrough");
  return new Response(body, { headers: STREAM_HEADERS });
});
// How much rewind buffer is available (seconds behind live) for a channel.
app.get("/api/timeshift/:channelId", (c) => {
  const channelId = Number(c.req.param("channelId"));
  if (!Number.isFinite(channelId)) return c.json({ error: "bad id" }, 400);
  return c.json({ windowSec: timeshift.windowSec(channelId), enabled: !!cachedSetting("features.timeshift") });
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
  return c.json(await hdhr.lineup(`${baseUrl(c)}/t/${c.req.param("key")}`));
});
app.get("/t/:key/stream/:channelId", async (c) => {
  const d = tunerDenied(c); if (d) return d;
  const channelId = Number(c.req.param("channelId"));
  if (!Number.isFinite(channelId)) return c.text("bad channel id", 400);
  return serveStream(c, channelId, false); // a valid tuner key = full lineup access
});
// M3U playlist (Jellyfin M3U tuner, TiviMate, …) — stream URLs carry the key path.
app.get("/t/:key/playlist.m3u", async (c) => {
  const d = tunerDenied(c); if (d) return d;
  return new Response(await hdhr.playlistM3U(`${baseUrl(c)}/t/${c.req.param("key")}`), {
    headers: { "Content-Type": "audio/x-mpegurl; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
});
// XMLTV guide export for the same consumers.
app.get("/t/:key/epg.xml", async (c) => {
  const d = tunerDenied(c); if (d) return d;
  return new Response(await exportXmltv(), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
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

app.patch("/api/providers/:id", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const allowed = ["name", "url", "username", "password", "maxConnections", "epgUrl", "priority", "enabled", "proxyUrl"];
  const updates: Record<string, unknown> = {};
  for (const k of allowed) if (k in body && body[k] !== "") updates[k] = body[k];
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
    })
    .returning();
  pool.setBudget(row.id, row.maxConnections);
  return c.json(row, 201);
});

// ─── VPNs (admin) — Phospharr dials these itself; no Gluetun. Configs/keys are
// write-only: they go in but never come back out to the client. ───
function safeVpn(v: typeof vpns.$inferSelect) {
  return { id: v.id, name: v.name, kind: v.kind, autostart: v.autostart, createdAt: v.createdAt, ...vpnStatus(v.id) };
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
  if (vpnMatch) proxy = vpnSocksUrl(Number(vpnMatch[1])); // undefined if the tunnel is down
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
  const allowed = ["name", "number", "category", "isHidden", "isFavorite", "logoUrl"];
  const updates: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) updates[k] = body[k];
  const [row] = await db.update(channels).set(updates).where(eq(channels.id, id)).returning();
  return c.json(row);
});

app.get("/api/channels/:id/sources", async (c) => {
  const id = Number(c.req.param("id"));
  return c.json(await db.select().from(streams).where(eq(streams.channelId, id)));
});

// ─── Guide (EPG) ───
app.get("/api/guide/:canonicalId/now", async (c) => {
  const canonicalId = c.req.param("canonicalId");
  return c.json(await nowNext(canonicalId));
});

app.post("/api/epg/sync", async (c) => {
  const deny = ensureAdmin(c); if (deny) return deny;
  const body = await c.req.json().catch(() => ({}));
  // Explicit urls win; otherwise derive one per enabled provider.
  const urls: string[] = body.urls?.length ? body.urls : await providerEpgUrls(body.providerId ? Number(body.providerId) : undefined);
  if (urls.length === 0) return c.json({ error: "no EPG sources available" }, 400);
  return c.json(await syncEpgFromUrls(urls));
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

export default app;
