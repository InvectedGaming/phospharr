import { eq } from "drizzle-orm";
import { db } from "./db/index.ts";
import { settings as settingsTable } from "./db/schema.ts";

/**
 * Settings + feature flags. Lets Cathode run lean (live-only) or full (DVR) on
 * the same codebase. Precedence: env var → DB (UI-editable) → code default.
 *
 * Heavy/disk features default OFF so a fresh install is light and "just works";
 * a NAS turns DVR on. Env vars let headless/Docker deploys pin features.
 */

const projectRoot = new URL("..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/$/, "");

export interface Settings {
  "features.hdhr": boolean; // HDHomeRun emulation (Plex/Emby/Jellyfin tuner)
  "features.transcode": boolean; // browser audio transcode (AC-3 → AAC)
  "features.epgAutoRefresh": boolean; // scheduled EPG pulls
  "features.healthProbe": boolean; // probe streams → real health badges
  "features.timeshift": boolean; // rolling buffer → pause / rewind
  "features.dvr": boolean; // record to disk + recordings library
  "dvr.storagePath": string;
  "dvr.retentionDays": number;
  "dvr.maxGB": number;
  "dvr.maxConcurrentRecordings": number;
  "timeshift.windowMinutes": number;
  "epg.refreshHours": number;
  "stream.keepWarmSeconds": number; // hold a channel's upstream this long after the last viewer
  "vpn.endpoints": { name: string; url: string }[]; // named VPN/proxy endpoints sources can pick from
  "access.streamKey": string; // secret gating /stream, /watch, and HDHR (devices use ?key=)
  "access.allowExternal": boolean; // allow tuner/M3U/EPG/stream exports off the local network (with key)
  "access.trustProxy": boolean; // resolve client IP from X-Forwarded-For (set true behind a reverse proxy)
}

const DEFAULTS: Settings = {
  "features.hdhr": true,
  "features.transcode": true,
  "features.epgAutoRefresh": true,
  "features.healthProbe": true,
  "features.timeshift": false,
  "features.dvr": false,
  "dvr.storagePath": `${projectRoot}/dvr`,
  "dvr.retentionDays": 14,
  "dvr.maxGB": 100,
  "dvr.maxConcurrentRecordings": 4,
  "timeshift.windowMinutes": 120,
  "epg.refreshHours": 6,
  "stream.keepWarmSeconds": 5,
  "vpn.endpoints": [],
  "access.streamKey": "", // auto-generated on first boot if unset
  "access.allowExternal": false, // LAN-only by default
  "access.trustProxy": false,
};

// Env overrides (ops/Docker). Present env value wins over DB + default.
const ENV_MAP: Partial<Record<keyof Settings, string>> = {
  "features.hdhr": "CATHODE_HDHR",
  "features.transcode": "CATHODE_TRANSCODE",
  "features.epgAutoRefresh": "CATHODE_EPG_AUTOREFRESH",
  "features.healthProbe": "CATHODE_HEALTH_PROBE",
  "features.timeshift": "CATHODE_TIMESHIFT",
  "features.dvr": "CATHODE_DVR",
  "dvr.storagePath": "CATHODE_DVR_PATH",
  "dvr.retentionDays": "CATHODE_DVR_RETENTION_DAYS",
  "dvr.maxGB": "CATHODE_DVR_MAX_GB",
  "timeshift.windowMinutes": "CATHODE_TIMESHIFT_MINUTES",
  "epg.refreshHours": "CATHODE_EPG_REFRESH_HOURS",
  "stream.keepWarmSeconds": "CATHODE_STREAM_KEEPWARM",
  "access.streamKey": "CATHODE_STREAM_KEY",
  "access.allowExternal": "CATHODE_ALLOW_EXTERNAL",
  "access.trustProxy": "CATHODE_TRUST_PROXY",
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
