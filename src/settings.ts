import { eq } from "drizzle-orm";
import { db } from "./db/index.ts";
import { settings as settingsTable } from "./db/schema.ts";

/**
 * Settings + feature flags. Lets Phospharr run lean (live-only) or full (DVR) on
 * the same codebase. Precedence: env var → DB (UI-editable) → code default.
 *
 * Heavy/disk features default OFF so a fresh install is light and "just works";
 * a NAS turns DVR on. Env vars let headless/Docker deploys pin features.
 */

const projectRoot = new URL("..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/$/, "");

// A downstream media server (Emby/Jellyfin/Plex) that consumes our tuner + EPG.
// After Phospharr refreshes its own guide we ping each of these so their cached
// guide follows suit. apiKey is a secret — redacted whenever it leaves the API.
export interface DownstreamServer {
  id: string;
  type: "emby" | "jellyfin" | "plex";
  name: string;
  url: string; // base URL, e.g. http://10.0.0.5:8096
  apiKey: string;
  enabled: boolean;
}

/** A named split of provider categories served as its own playlist + EPG
 *  (`/t/<key>/g/<slug>/…`) and excluded from the main export — so event/PPV
 *  churn can refresh fast (syncMinutes) without re-pulling the whole lineup. */
export interface TunerGroup {
  name: string; // display name; slugified (lowercase, dashes) in the URL
  categories: string[]; // provider category names, matched case-insensitively
  syncMinutes?: number; // scoped fast-sync cadence (xtream providers); omit/0 = no fast sync
}

export interface Settings {
  "features.hdhr": boolean; // HDHomeRun emulation (Plex/Emby/Jellyfin tuner)
  "features.transcode": boolean; // browser audio transcode (AC-3 → AAC)
  "features.epgAutoRefresh": boolean; // scheduled EPG pulls
  "features.healthProbe": boolean; // probe streams → real health badges
  "features.timeshift": boolean; // rolling buffer → pause / rewind
  "features.dvr": boolean; // record to disk + recordings library
  "features.providerAutoSync": boolean; // scheduled re-ingest of provider channel lineups
  "providers.syncHours": number; // re-sync each provider's lineup every N hours
  "features.vodLibrary": boolean; // mirror VOD as .strm files for Emby/Jellyfin to scan
  "vod.libraryPath": string; // where the .strm/.nfo library tree is written
  "vod.publicUrl": string; // absolute base URL Emby uses to reach playback (else BASE_URL)
  "vod.libraryCategories": string[]; // only mirror these VOD categories (empty = all)
  "vod.skipOwned": boolean; // don't mirror a VOD movie already in the Emby/Jellyfin library
  "vod.syncHours": number; // scheduled VOD refresh + library rebuild every N hours (prunes owned)
  "vod.includeSeries": boolean; // also mirror series/episodes (Sonarr-parseable tree under <libraryPath>/Series)
  "vod.seriesCategories": string[]; // only mirror these series categories (empty = all)
  "vod.refreshExisting": boolean; // re-pull episode lists for mirrored series each run so new episodes appear
  "vod.indexer.enabled": boolean; // expose the VOD catalog to Sonarr as a Torznab indexer (/torznab/api)
  "vod.indexer.apiKey": string; // Torznab apikey (auto-generated on first boot if unset)
  "vod.indexer.blackholeWatchPath": string; // where Sonarr's Usenet Blackhole client drops grabbed .nzb files
  "vod.indexer.blackholeCompletePath": string; // where we place the .strm for Sonarr to import (Sonarr's blackhole Watch Folder)
  "vod.indexer.cacheTtlMinutes": number; // per-show provider lookup cache — repeat Sonarr polls inside this window don't refetch
  "vod.indexer.categories": string[]; // only serve these series categories through the indexer (empty = all)
  "dvr.storagePath": string;
  "dvr.retentionDays": number;
  "dvr.maxGB": number;
  "dvr.maxConcurrentRecordings": number;
  "timeshift.windowMinutes": number;
  "epg.refreshHours": number;
  "epg.downstream": DownstreamServer[]; // media servers to nudge after our EPG refresh
  "stream.keepWarmSeconds": number; // hold a channel's upstream this long after the last viewer
  "vpn.endpoints": { name: string; url: string }[]; // named VPN/proxy endpoints sources can pick from
  "access.streamKey": string; // secret gating /stream, /watch, and HDHR (devices use ?key=)
  "access.allowExternal": boolean; // allow tuner/M3U/EPG/stream exports off the local network (with key)
  "access.trustProxy": boolean; // resolve client IP from X-Forwarded-For (set true behind a reverse proxy)
  "tuner.publicUrl": string; // absolute base URL a downstream tuner (Emby) uses to reach US — must match what Emby stored, else the sync layer won't recognize its own tuner hosts (falls back to vod.publicUrl, then BASE_URL)
  "tuner.groups": TunerGroup[]; // split categories into their own playlist+EPG (/t/<key>/g/<slug>/…) with an optional fast sync cadence; the main playlist excludes them
  "content.hideAdult": boolean; // auto-hide adult/XXX channels (on by default)
  "content.hideNoStream": boolean; // auto-hide channels with no attached stream — event channels get theirs back at air time (on by default)
  "content.hiddenCategories": string[]; // whole categories the admin chose to hide
  "content.hiddenMarkets": string[]; // local markets (cities) the admin chose to hide
  "content.dedupeLocals": boolean; // collapse duplicate local stations (same callsign)
  "alerts.webhookUrl": string; // POST target for self-healing alerts ({kind,message,at} JSON); empty = alerts disabled
}

const DEFAULTS: Settings = {
  "features.hdhr": true,
  "features.transcode": true,
  "features.epgAutoRefresh": true,
  "features.healthProbe": true,
  "features.timeshift": true, // pause / rewind / start-over on live TV (rolling buffer)
  "features.dvr": true,
  "features.providerAutoSync": true,
  "providers.syncHours": 12,
  "features.vodLibrary": false, // opt-in — writes a .strm/.nfo tree to disk
  "vod.libraryPath": `${projectRoot}/vod-library`,
  "vod.publicUrl": "",
  "vod.libraryCategories": [],
  "vod.skipOwned": true,
  "vod.syncHours": 24,
  "vod.includeSeries": false, // opt-in — each mirrored series costs a get_series_info call per refresh
  "vod.seriesCategories": [],
  "vod.refreshExisting": true, // default ON — off freezes the catalog and new episodes never appear
  "vod.indexer.enabled": false, // opt-in — exposes an authenticated Torznab endpoint
  "vod.indexer.apiKey": "", // auto-generated on first boot if unset
  "vod.indexer.blackholeWatchPath": `${projectRoot}/blackhole/nzb`,
  "vod.indexer.blackholeCompletePath": `${projectRoot}/blackhole/complete`,
  "vod.indexer.cacheTtlMinutes": 15,
  "vod.indexer.categories": [],
  "dvr.storagePath": `${projectRoot}/dvr`,
  "dvr.retentionDays": 14,
  "dvr.maxGB": 100,
  "dvr.maxConcurrentRecordings": 4,
  "timeshift.windowMinutes": 120,
  "epg.refreshHours": 6,
  "epg.downstream": [],
  "stream.keepWarmSeconds": 5,
  "vpn.endpoints": [],
  "access.streamKey": "", // auto-generated on first boot if unset
  "access.allowExternal": false, // LAN-only by default
  "access.trustProxy": false,
  "tuner.publicUrl": "", // empty = fall back to vod.publicUrl / BASE_URL
  "tuner.groups": [], // e.g. [{ name: "Events", categories: ["PPV FLOSPORTS", "USA MLB"], syncMinutes: 15 }]
  "content.hideAdult": true, // hide adult/XXX channels by default
  "content.hideNoStream": true, // a channel with zero streams can't play — dead guide entries otherwise
  "content.hiddenCategories": [],
  "content.hiddenMarkets": [],
  "content.dedupeLocals": true, // collapse duplicate local stations by default
  "alerts.webhookUrl": "", // opt-in — no alerts fire until an operator sets this
};

// Env overrides (ops/Docker). Present env value wins over DB + default.
const ENV_MAP: Partial<Record<keyof Settings, string>> = {
  "features.hdhr": "PHOSPHARR_HDHR",
  "features.transcode": "PHOSPHARR_TRANSCODE",
  "features.epgAutoRefresh": "PHOSPHARR_EPG_AUTOREFRESH",
  "features.healthProbe": "PHOSPHARR_HEALTH_PROBE",
  "features.timeshift": "PHOSPHARR_TIMESHIFT",
  "features.dvr": "PHOSPHARR_DVR",
  "features.providerAutoSync": "PHOSPHARR_PROVIDER_AUTOSYNC",
  "providers.syncHours": "PHOSPHARR_PROVIDER_SYNC_HOURS",
  "vod.syncHours": "PHOSPHARR_VOD_SYNC_HOURS",
  "features.vodLibrary": "PHOSPHARR_VOD_LIBRARY",
  "vod.libraryPath": "PHOSPHARR_VOD_LIBRARY_PATH",
  "vod.publicUrl": "PHOSPHARR_PUBLIC_URL",
  "vod.includeSeries": "PHOSPHARR_VOD_SERIES",
  "vod.refreshExisting": "PHOSPHARR_VOD_REFRESH_EXISTING",
  "vod.indexer.enabled": "PHOSPHARR_VOD_INDEXER",
  "vod.indexer.apiKey": "PHOSPHARR_VOD_INDEXER_KEY",
  "vod.indexer.blackholeWatchPath": "PHOSPHARR_VOD_INDEXER_NZB_PATH",
  "vod.indexer.blackholeCompletePath": "PHOSPHARR_VOD_INDEXER_COMPLETE_PATH",
  "vod.indexer.cacheTtlMinutes": "PHOSPHARR_VOD_INDEXER_CACHE_TTL",
  "dvr.storagePath": "PHOSPHARR_DVR_PATH",
  "dvr.retentionDays": "PHOSPHARR_DVR_RETENTION_DAYS",
  "dvr.maxGB": "PHOSPHARR_DVR_MAX_GB",
  "timeshift.windowMinutes": "PHOSPHARR_TIMESHIFT_MINUTES",
  "epg.refreshHours": "PHOSPHARR_EPG_REFRESH_HOURS",
  "stream.keepWarmSeconds": "PHOSPHARR_STREAM_KEEPWARM",
  "tuner.publicUrl": "PHOSPHARR_TUNER_URL",
  "access.streamKey": "PHOSPHARR_STREAM_KEY",
  "access.allowExternal": "PHOSPHARR_ALLOW_EXTERNAL",
  "access.trustProxy": "PHOSPHARR_TRUST_PROXY",
  "content.hideAdult": "PHOSPHARR_HIDE_ADULT",
  "content.hideNoStream": "PHOSPHARR_HIDE_NO_STREAM",
  "content.dedupeLocals": "PHOSPHARR_DEDUPE_LOCALS",
  "alerts.webhookUrl": "PHOSPHARR_ALERTS_WEBHOOK_URL",
};

function coerce(key: keyof Settings, raw: string): boolean | number | string {
  const def = DEFAULTS[key];
  if (typeof def === "boolean") return /^(on|true|1|yes|enabled)$/i.test(raw.trim());
  if (typeof def === "number") return Number(raw);
  return raw;
}

let cache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const merged: Settings = { ...DEFAULTS };
  for (const row of await db.select().from(settingsTable)) {
    if (row.key in DEFAULTS) (merged as unknown as Record<string, unknown>)[row.key] = row.value;
  }
  for (const [key, env] of Object.entries(ENV_MAP)) {
    const v = process.env[env];
    // An empty env var (e.g. a Compose `${VAR:-}` default) means "unset" — don't
    // override or lock the setting, so the UI stays editable.
    if (v != null && v !== "") (merged as unknown as Record<string, unknown>)[key] = coerce(key as keyof Settings, v);
  }
  cache = merged;
  return merged;
}

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  return (await getSettings())[key];
}

/** Synchronous read of the last-loaded settings (falls back to defaults). For
 * hot paths like the muxer teardown timer that can't await. Primed at boot. */
export function cachedSetting<K extends keyof Settings>(key: K): Settings[K] {
  return (cache ?? DEFAULTS)[key];
}

/** Keys currently pinned by an env var — the UI shows these as locked. */
export function envLockedKeys(): (keyof Settings)[] {
  return (Object.entries(ENV_MAP) as [keyof Settings, string][])
    .filter(([, env]) => process.env[env] != null && process.env[env] !== "")
    .map(([k]) => k);
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  if (!(key in DEFAULTS)) throw new Error(`unknown setting ${key}`);
  if (envLockedKeys().includes(key)) return; // env wins; ignore writes
  await db
    .insert(settingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
  cache = null; // invalidate
}

export async function deleteSetting(key: keyof Settings): Promise<void> {
  await db.delete(settingsTable).where(eq(settingsTable.key, key));
  cache = null;
}

/**
 * Drop the in-memory settings cache without touching the table.
 *
 * For code that writes the `settings` table directly — chiefly tests restoring
 * a key verbatim. `setSetting` deliberately refuses to write env-locked keys, so
 * it cannot be used to put one back; a raw write plus this call can.
 */
export function _invalidateSettingsCache(): void {
  cache = null;
}

export async function capabilities() {
  const s = await getSettings();
  return {
    features: {
      hdhr: s["features.hdhr"],
      transcode: s["features.transcode"],
      epgAutoRefresh: s["features.epgAutoRefresh"],
      healthProbe: s["features.healthProbe"],
      timeshift: s["features.timeshift"],
      dvr: s["features.dvr"],
    },
    envLocked: envLockedKeys(),
  };
}
