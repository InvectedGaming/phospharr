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
