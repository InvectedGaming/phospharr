import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { channels } from "../db/schema.ts";
import { isLocalIp } from "../net/access.ts";
import { providerEgress } from "../net/egress.ts";

// Logo URLs come from the (untrusted) provider playlist. Refuse http(s)-only and
// reject any literal private/loopback/link-local host so a crafted logoUrl like
// http://169.254.169.254/… or http://127.0.0.1:port/… can't turn this fetch into
// an SSRF read of internal services. (DNS names resolving to private ranges are a
// residual gap; routing through the provider proxy below covers proxied sources.)
function logoUrlSafe(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return !isLocalIp(u.hostname.replace(/^\[|\]$/g, ""));
}

// A representative provider for this channel — its egress proxy is used for the
// logo fetch so a VPN-pinned source doesn't leak the host IP to a logo host.
const firstProviderStmt = sqlite.prepare(
  "SELECT provider_id FROM streams WHERE channel_id = ? ORDER BY id LIMIT 1",
);

/**
 * Channel-logo proxy + disk cache. Tuner consumers (Emby/Plex) fetch a logo per
 * channel — 6k+ requests straight at flaky, slow, sometimes geo-blocked provider
 * CDNs. We fetch each logo ONCE, park it next to the DB, and serve it with long
 * cache headers, so lineup art is instant and complete everywhere.
 */

const CACHE_DIR = (() => {
  const dbUrl = process.env.DATABASE_URL;
  const base = dbUrl ? dirname(dbUrl) : new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const dir = join(base, "logo-cache");
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return dir;
})();

// Don't re-hit an upstream that just failed for every guide render.
const negative = new Map<number, number>();
const NEGATIVE_MS = 10 * 60_000;

export interface Logo { bytes: Uint8Array; type: string }

export async function getLogo(channelId: number): Promise<Logo | null> {
  const file = join(CACHE_DIR, String(channelId));
  const typeFile = file + ".ct";
  if (existsSync(file) && existsSync(typeFile)) {
    try {
      return { bytes: readFileSync(file), type: readFileSync(typeFile, "utf8") || "image/png" };
    } catch { /* fall through to refetch */ }
  }

  const failedAt = negative.get(channelId);
  if (failedAt && Date.now() - failedAt < NEGATIVE_MS) return null;

  const ch = db.select({ logoUrl: channels.logoUrl }).from(channels).where(eq(channels.id, channelId)).get();
  if (!ch?.logoUrl || !logoUrlSafe(ch.logoUrl)) { negative.set(channelId, Date.now()); return null; }
  // Route the logo fetch through the provider's egress (fail-closed if a pinned
  // VPN tunnel is down — never fall back to a direct connection that leaks the IP).
  const provId = (firstProviderStmt.get(channelId) as { provider_id: number } | undefined)?.provider_id;
  const eg = providerEgress(provId);
  if (eg.blocked) { negative.set(channelId, Date.now()); return null; }
  try {
    const res = await fetch(ch.logoUrl, {
      redirect: "follow",
      headers: { "User-Agent": "Phospharr/1.0" },
      signal: AbortSignal.timeout(8000),
      ...(eg.proxy ? { proxy: eg.proxy } : {}),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > 4_000_000) throw new Error("bad size");
    const type = res.headers.get("content-type")?.split(";")[0] || "image/png";
    writeFileSync(file, bytes);
    writeFileSync(typeFile, type);
    return { bytes, type };
  } catch {
    negative.set(channelId, Date.now());
    return null;
  }
}
