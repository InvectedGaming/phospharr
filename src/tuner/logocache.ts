import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels } from "../db/schema.ts";

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
  if (!ch?.logoUrl) return null;
  try {
    const res = await fetch(ch.logoUrl, {
      redirect: "follow",
      headers: { "User-Agent": "Phospharr/1.0" },
      signal: AbortSignal.timeout(8000),
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
