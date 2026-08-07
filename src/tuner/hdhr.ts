import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels, streams } from "../db/schema.ts";
import { pool } from "../scheduler/pool.ts";
import { makeCategoryFilter } from "../content/filter.ts";
import { getSetting, type TunerGroup } from "../settings.ts";
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

// The channel rows both the tuner lineup and the sync fingerprint iterate —
// same filters, same order, single source of truth so the two projections
// below can never drift apart on *which* channels they cover.
function visibleChannelRows() {
  return db
    .select()
    .from(channels)
    .where(and(eq(channels.isHidden, false), isNotNull(channels.number), hasUsableSource))
    .orderBy(channels.number)
    .all();
}

export type LineupRow = { GuideNumber: string; GuideName: string; URL: string; HD: number };

/**
 * Row builder for the HDHR lineup — pure extraction of the former lineup()
 * body: same fields, same order, same shape. This is the exact JSON served at
 * /lineup.json (src/api/server.ts) — a live tuner (Emby/Plex) parses it, so do
 * not add fields here. baseUrl is per-request (see server.ts's baseUrl(c));
 * there is no request-less default because nothing needs one — the fingerprint
 * projection (fingerprintRows(), below) doesn't hash URLs at all.
 */
export function lineupRows(baseUrl: string): LineupRow[] {
  const list: LineupRow[] = visibleChannelRows().map((ch) => ({
    GuideNumber: String(ch.number),
    GuideName: ch.name,
    URL: `${baseUrl}/stream/${ch.id}`,
    HD: 1,
  }));
  list.unshift({ GuideNumber: String(MOSAIC_NUMBER), GuideName: "Mosaic", URL: `${baseUrl}/mosaic.ts`, HD: 1 });
  return list;
}

// The spec's drift-detection tuple: (canonicalId, guideNumber, name, logoUrl,
// category) — deliberately NOT the URL (host-dependent, not meaningful
// identity) and NOT a `hidden` flag (hiding a channel already changes the row
// set via visibleChannelRows()'s isHidden filter, no separate field needed).
// canonicalId falls back to the numeric id for legacy/custom channels that
// predate canonicalId assignment, so every row still has a stable identity.
export type FingerprintRow = { canonicalId: string; guideNumber: string; name: string; logoUrl: string; category: string };

/**
 * The rows the sync fingerprint hashes — the LINEUP DEFINITION.
 *
 * Deliberately does NOT filter on `hasUsableSource`, and that is the point.
 * The health probe continuously re-tests thousands of streams, so a channel
 * whose only source is momentarily marked dead leaves the served set and
 * returns minutes later. Measured on the live install: the source-filtered set
 * churned twice in seven minutes (one channel out, another in), which reset the
 * ladder's 10-minute verify window every time — `verify` NEVER ran, the server
 * sat permanently "converging", and it pushed a full guide refresh downstream
 * every ~5 minutes for nothing. The same window measured against the projection
 * below: zero changes.
 *
 * The split is intentional:
 *   fingerprint  = "did the lineup DEFINITION change?" — adds, removes, hides,
 *                  renumbers, renames, logos, categories. Cheap and stable, and
 *                  exactly the drift the spec names.
 *   verifyLineup = "does the downstream server match what we actually SERVE?" —
 *                  that one uses the source-filtered playlist rows and already
 *                  carries a tolerance sized for this churn.
 * Transient source health belongs in the second, never the first.
 */
export function fingerprintRows(): FingerprintRow[] {
  return db
    .select()
    .from(channels)
    .where(and(eq(channels.isHidden, false), isNotNull(channels.number)))
    .orderBy(channels.number)
    .all()
    .map((ch) => ({
      canonicalId: ch.canonicalId ?? String(ch.id),
      guideNumber: String(ch.number),
      name: ch.name,
      logoUrl: ch.logoUrl ?? "",
      category: ch.category ?? "",
    }));
}

/**
 * M3U playlist for players/consumers that ingest M3U+XMLTV (TiviMate, Jellyfin's
 * M3U tuner, etc.). tvg-id is the channel's canonicalId so it binds to the XMLTV
 * export's <channel id>. Stream URLs sit under the same /t/<key> base.
 */
export type CategoryFilter = { include?: string[]; exclude?: string[] };

/**
 * The channel rows ONE playlist emits — the main export (`exclude` = every
 * grouped category) or a single tuner group's (`include` = its categories).
 *
 * Shared with `playlistNames()` below so the downstream-sync verifier can ask
 * "which channels does the playlist Emby actually subscribed to contain?" and
 * get the same answer the HTTP route would serve. Comparing Emby's channel list
 * against `lineupRows()` instead would compare two different populations —
 * grouped categories live on a second tuner host — and read as permanent drift.
 */
function playlistChannelRows(catFilter?: CategoryFilter) {
  const pass = makeCategoryFilter(catFilter?.include, catFilter?.exclude);
  return visibleChannelRows().filter((ch) => pass(ch.category));
}

/** The channel NAMES one playlist emits, mosaic included exactly as the M3U
 *  includes it (main export only, never a category split). */
export function playlistNames(catFilter?: CategoryFilter): string[] {
  return playlistNamesFor([catFilter ?? {}])[0]!;
}

/**
 * The same, for several playlists at once, off a SINGLE `visibleChannelRows()`
 * read. The downstream verifier asks for one scope per registered Emby tuner
 * host and runs on every EPG tick; each `visibleChannelRows()` is a full
 * `channels` scan plus a correlated `exists` subquery over `streams`, so doing
 * it per scope doubled (or worse) the cost of every verify for nothing.
 */
export function playlistNamesFor(filters: CategoryFilter[]): string[][] {
  if (!filters.length) return [];
  const rows = visibleChannelRows();
  return filters.map((f) => {
    const pass = makeCategoryFilter(f.include, f.exclude);
    const names = rows.filter((ch) => pass(ch.category)).map((ch) => ch.name);
    if (!f.include?.length) names.push("Mosaic");
    return names;
  });
}

/** URL slug for a tuner group — the `<slug>` in `/t/<key>/g/<slug>/…`. */
export const groupSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Configured tuner groups, minus incomplete ones (no name or no categories),
 *  which serve no playlist and therefore aren't registrable in Emby. */
export async function tunerGroups(): Promise<TunerGroup[]> {
  return ((await getSetting("tuner.groups")) ?? []).filter((g) => g?.name && g.categories?.length);
}

/** Every category served by a group — i.e. everything the MAIN export excludes. */
export async function groupedCategories(): Promise<string[]> {
  return (await tunerGroups()).flatMap((g) => g.categories);
}

export async function playlistM3U(baseUrl: string, catFilter?: CategoryFilter): Promise<string> {
  const rows = playlistChannelRows(catFilter);
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
