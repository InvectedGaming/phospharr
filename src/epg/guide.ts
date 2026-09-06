import { and, eq, isNotNull } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { channels } from "../db/schema.ts";
import { makeCategoryFilter } from "../content/filter.ts";

/**
 * The guide as phospharr believes it to be: every channel a tuner consumer can
 * see, and for each, the programmes in a rolling window — real EPG rows where
 * we have them, hour-aligned synthetic filler where we don't.
 *
 * This is the ONE place those rows are assembled. The XMLTV export renders
 * them; the Emby guide push sends them. That is what guarantees the invariant
 * the push relies on — anything pushed is also exported — so Emby's nightly
 * refresh finds exactly what the push wrote and reconciles instead of pruning.
 */
export const WINDOW_BEHIND = 2 * 3600;
export const WINDOW_AHEAD = 48 * 3600;
const FILL_BLOCK = 4 * 3600;

export interface GuideProgram {
  start: number; end: number; title: string; subtitle: string | null; description: string | null;
  /** Emby colour keyword: Sports / News / Movie / Kids / Series. */
  category: string;
  /** The programme's own category when it differs from `category`. */
  extraCategory: string | null;
  season: number | null; episode: number | null; iconUrl: string | null;
}
export interface GuideChannel { id: number | null; canonicalId: string; name: string; iconUrl: string | null }
export interface GuideRows { channels: GuideChannel[]; programs: Map<string, GuideProgram[]>; windowStart: number; windowEnd: number }

/** The category vocabulary Emby (and Jellyfin) recognise for guide cell colours. */
export function embyCategory(programCategory: string | null, channelGenre: string | null): string {
  const t = ((programCategory ?? "") + " " + (channelGenre ?? "")).toLowerCase();
  if (/sport/.test(t)) return "Sports";
  if (/news/.test(t)) return "News";
  if (/kids|child|animation|cartoon/.test(t)) return "Kids";
  if (/movie|film|cinema/.test(t)) return "Movie";
  return "Series";
}

const progStmt = sqlite.prepare(
  "SELECT canonical_id, title, subtitle, description, start_time, end_time, category, season, episode, icon_url FROM programs WHERE end_time > ? AND start_time < ? ORDER BY canonical_id, start_time",
);

export function guideRows(opts: { catFilter?: { include?: string[]; exclude?: string[] }; logoBase?: string; now?: number } = {}): GuideRows {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const windowStart = now - WINDOW_BEHIND, windowEnd = now + WINDOW_AHEAD;
  const pass = makeCategoryFilter(opts.catFilter?.include, opts.catFilter?.exclude);
  const rows = db
    .select({ id: channels.id, name: channels.name, canonicalId: channels.canonicalId, logoUrl: channels.logoUrl, genre: channels.genre, kind: channels.kind, customNow: channels.customNow, category: channels.category })
    .from(channels)
    .where(and(eq(channels.isHidden, false), isNotNull(channels.canonicalId)))
    .all()
    .filter((ch) => pass(ch.category));

  const out: GuideChannel[] = [];
  const seen = new Set<string>();
  const genreBy = new Map<string, string | null>();
  const fillTitleBy = new Map<string, string>();
  // Channel 1, the always-listed mosaic — no DB row; main lineup only, mirroring playlistM3U's split.
  if (!opts.catFilter?.include?.length) {
    seen.add("phospharr.mosaic");
    out.push({ id: null, canonicalId: "phospharr.mosaic", name: "Mosaic", iconUrl: null });
    fillTitleBy.set("phospharr.mosaic", "Mosaic — compose in Phospharr");
  }
  for (const ch of rows) {
    if (!ch.canonicalId || seen.has(ch.canonicalId)) continue;
    seen.add(ch.canonicalId);
    genreBy.set(ch.canonicalId, ch.genre);
    // For live/custom channels the filler title is the editable "now" text so
    // Emby shows what's actually on the stream (liveness writes the Twitch title here).
    fillTitleBy.set(ch.canonicalId, ch.kind === "live" && ch.customNow ? ch.customNow : ch.name);
    const iconUrl = ch.logoUrl ? (opts.logoBase ? `${opts.logoBase}/logo/${ch.id}` : ch.logoUrl) : null;
    out.push({ id: ch.id, canonicalId: ch.canonicalId, name: ch.name, iconUrl });
  }

  const programs = new Map<string, GuideProgram[]>();
  const real = progStmt.all(windowStart, windowEnd) as Array<{
    canonical_id: string; title: string; subtitle: string | null; description: string | null;
    start_time: number; end_time: number; category: string | null; season: number | null; episode: number | null; icon_url: string | null;
  }>;
  for (const p of real) {
    if (!seen.has(p.canonical_id)) continue;
    const category = embyCategory(p.category, genreBy.get(p.canonical_id) ?? null);
    const list = programs.get(p.canonical_id) ?? programs.set(p.canonical_id, []).get(p.canonical_id)!;
    list.push({
      start: p.start_time, end: p.end_time, title: p.title, subtitle: p.subtitle, description: p.description,
      category, extraCategory: p.category && p.category !== category ? p.category : null,
      season: p.season, episode: p.episode, iconUrl: p.icon_url,
    });
  }

  // Synthetic filler for channels with no real guide data — overwhelmingly 24/7
  // loops the provider publishes no schedule for. Hour-aligned 4h blocks titled
  // with the channel (or its "now" text) so the guide is never a blank row.
  const fillStart = Math.floor(windowStart / 3600) * 3600;
  for (const cid of seen) {
    if (programs.has(cid)) continue;
    const title = fillTitleBy.get(cid) ?? cid;
    const category = embyCategory(null, genreBy.get(cid) ?? null);
    const list: GuideProgram[] = [];
    for (let t = fillStart; t < windowEnd; t += FILL_BLOCK) {
      list.push({ start: t, end: t + FILL_BLOCK, title, subtitle: null, description: null, category, extraCategory: "24/7", season: null, episode: null, iconUrl: null });
    }
    programs.set(cid, list);
  }
  return { channels: out, programs, windowStart, windowEnd };
}
