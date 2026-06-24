import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels } from "../db/schema.ts";

/**
 * HDHomeRun emulation. Makes Cathode look like an HDHR tuner so Plex, Jellyfin,
 * Emby, and TVs can consume the lineup natively.
 *
 *   /discover.json   device identity + tuner count
 *   /lineup.json     the channel lineup with stream URLs
 *   /lineup_status.json
 */

const DEVICE_ID = "CATHODE1";
const TUNER_COUNT = Number(process.env.HDHR_TUNER_COUNT ?? 8);

export function discover(baseUrl: string) {
  return {
    FriendlyName: "Cathode",
    Manufacturer: "Cathode",
    ModelNumber: "HDTC-2US",
    FirmwareName: "cathode_atsc",
    FirmwareVersion: "0.1.0",
    DeviceID: DEVICE_ID,
    DeviceAuth: "cathode",
    BaseURL: baseUrl,
    LineupURL: `${baseUrl}/lineup.json`,
    TunerCount: TUNER_COUNT,
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

export async function lineup(baseUrl: string) {
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.isHidden, false), isNotNull(channels.number)))
    .orderBy(channels.number);

  return rows.map((ch) => ({
    GuideNumber: String(ch.number),
    GuideName: ch.name,
    URL: `${baseUrl}/stream/${ch.id}`,
    HD: 1,
  }));
}

/**
 * M3U playlist for players/consumers that ingest M3U+XMLTV (TiviMate, Jellyfin's
 * M3U tuner, etc.). tvg-id is the channel's canonicalId so it binds to the XMLTV
 * export's <channel id>. Stream URLs sit under the same /t/<key> base.
 */
export async function playlistM3U(baseUrl: string): Promise<string> {
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.isHidden, false), isNotNull(channels.number)))
    .orderBy(channels.number);
  const out = ["#EXTM3U"];
  for (const ch of rows) {
    const tvgId = ch.canonicalId ?? ch.epgChannelId ?? String(ch.id);
    const attrs = [
      `tvg-id="${xmlAttr(tvgId)}"`,
      `tvg-chno="${ch.number}"`,
      `tvg-name="${xmlAttr(ch.name)}"`,
      ch.logoUrl ? `tvg-logo="${xmlAttr(ch.logoUrl)}"` : "",
      ch.category ? `group-title="${xmlAttr(ch.category)}"` : "",
    ].filter(Boolean).join(" ");
    out.push(`#EXTINF:-1 ${attrs},${ch.name}`);
    out.push(`${baseUrl}/stream/${ch.id}`);
  }
  return out.join("\n") + "\n";
}

function xmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
