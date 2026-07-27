import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels, streams } from "../db/schema.ts";
import { pool } from "../scheduler/pool.ts";
import { makeCategoryFilter } from "../content/filter.ts";
import { VERSION } from "../version.ts";

// Channel 1: the live mosaic composite. ALWAYS listed — tuner consumers (Emby,
// Plex) cache the lineup and refresh rarely, so a channel that appears only
// while composed would effectively never exist for them. Tuning it before the
// app has composed anything returns 503 until channels are picked in Mosaic.
const MOSAIC_NUMBER = 1;

/**
 * HDHomeRun emulation. Makes Phospharr look like an HDHR tuner so Plex, Jellyfin,
 * Emby, and TVs can consume the lineup natively.
 *
 *   /discover.json   device identity + tuner count
 *   /lineup.json     the channel lineup with stream URLs
 *   /lineup_status.json
 */

const DEVICE_ID = "PHOSPHARR1";
// Report the REAL capacity (sum of provider connection budgets) so Emby/Plex
// schedule DVR against what we can actually serve instead of over-subscribing
// and erroring mid-recording. Env still overrides for odd setups.
function tunerCount(): number {
  if (process.env.HDHR_TUNER_COUNT) return Number(process.env.HDHR_TUNER_COUNT);
  const snap = pool.snapshot();
  const total = Object.values(snap).reduce((n, s) => n + s.max, 0);
  return Math.max(1, total);
}

export function discover(baseUrl: string) {
  return {
    FriendlyName: "Phospharr",
    Manufacturer: "Phospharr",
    ModelNumber: "HDTC-2US",
    FirmwareName: "phospharr_atsc",
    FirmwareVersion: VERSION,
    DeviceID: DEVICE_ID,
    DeviceAuth: "phospharr",
    BaseURL: baseUrl,
    LineupURL: `${baseUrl}/lineup.json`,
    TunerCount: tunerCount(),
  };
}

export function lineupStatus() {
  return {
    ScanInProgress: 0,
    ScanPossible: 1,
    Source: "Cable",
    SourceList: ["Cable"],
  };
}

// Tuner consumers (Emby/Plex/Jellyfin) get only channels with at least one
// not-provably-dead source — a channel every source of which the health probe
// has marked dead would just spin forever in their players. The app UI still
// shows such channels (with a dead badge) so they can be watched for recovery.
const hasUsableSource = sql`exists (select 1 from ${streams} where ${streams.channelId} = ${channels.id} and ${ne(streams.health, "dead")})`;

export async function lineup(baseUrl: string) {
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.isHidden, false), isNotNull(channels.number), hasUsableSource))
    .orderBy(channels.number);

  const list = rows.map((ch) => ({
    GuideNumber: String(ch.number),
    GuideName: ch.name,
    URL: `${baseUrl}/stream/${ch.id}`,
    HD: 1,
  }));
  list.unshift({ GuideNumber: String(MOSAIC_NUMBER), GuideName: "Mosaic", URL: `${baseUrl}/mosaic.ts`, HD: 1 });
  return list;
}

/**
 * M3U playlist for players/consumers that ingest M3U+XMLTV (TiviMate, Jellyfin's
 * M3U tuner, etc.). tvg-id is the channel's canonicalId so it binds to the XMLTV
 * export's <channel id>. Stream URLs sit under the same /t/<key> base.
 */
export async function playlistM3U(baseUrl: string, catFilter?: { include?: string[]; exclude?: string[] }): Promise<string> {
  const pass = makeCategoryFilter(catFilter?.include, catFilter?.exclude);
  const rows = (await db
    .select()
    .from(channels)
    .where(and(eq(channels.isHidden, false), isNotNull(channels.number), hasUsableSource))
    .orderBy(channels.number)).filter((ch) => pass(ch.category));
  const out = ["#EXTM3U"];
  if (!catFilter?.include?.length) { // the mosaic belongs to the main lineup, not a category split
    out.push(`#EXTINF:-1 tvg-id="phospharr.mosaic" tvg-chno="${MOSAIC_NUMBER}" tvg-name="Mosaic" group-title="Phospharr",Mosaic`);
    out.push(`${baseUrl}/mosaic.ts`);
  }
  for (const ch of rows) {
    const tvgId = ch.canonicalId ?? ch.epgChannelId ?? String(ch.id);
    // Clean taxonomy group (Emby/TiviMate group channels by this) — falls back
    // to the raw provider category for channels that predate the classifier.
    const group = ch.kind === "loop" ? `24/7 ${ch.genre ?? ""}`.trim()
      : ch.kind === "local" ? "Locals"
      : ch.kind === "intl" ? "International"
      : ch.genre ?? ch.category ?? "";
    const attrs = [
      `tvg-id="${xmlAttr(tvgId)}"`,
      `tvg-chno="${ch.number}"`,
      `tvg-name="${xmlAttr(ch.name)}"`,
      // our cached logo proxy, not the provider's flaky CDN
      ch.logoUrl ? `tvg-logo="${xmlAttr(`${baseUrl}/logo/${ch.id}`)}"` : "",
      group ? `group-title="${xmlAttr(group)}"` : "",
    ].filter(Boolean).join(" ");
    out.push(`#EXTINF:-1 ${attrs},${ch.name}`);
    out.push(`${baseUrl}/stream/${ch.id}`);
  }
  return out.join("\n") + "\n";
}

function xmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
