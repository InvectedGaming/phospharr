import { and, eq, isNotNull } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { channels } from "../db/schema.ts";
import { makeCategoryFilter } from "../content/filter.ts";

/**
 * XMLTV export for external consumers (Emby, Jellyfin, TiviMate, …). Channel
 * ids are canonicalIds so they bind to the M3U playlist's tvg-id. Bounded to a
 * rolling window to keep the payload sane.
 *
 * Enriched for consumer UIs: sub-titles, season/episode (xmltv_ns), programme
 * icons, and a FIRST <category> drawn from the keyword set Emby color-codes its
 * guide with (Sports / News / Movie / Kids / Series) — mapped from the
 * programme's own category, else the channel's taxonomy genre. The original
 * category is kept as a second <category>.
 */

const WINDOW_BEHIND = 2 * 3600;
const WINDOW_AHEAD = 48 * 3600;

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function xmltvTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

// The category vocabulary Emby (and Jellyfin) recognize for guide cell colors.
function embyCategory(programCategory: string | null, channelGenre: string | null): string {
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

export async function exportXmltv(logoBase?: string, catFilter?: { include?: string[]; exclude?: string[] }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const pass = makeCategoryFilter(catFilter?.include, catFilter?.exclude);
  const chans = db
    .select({ id: channels.id, name: channels.name, canonicalId: channels.canonicalId, logoUrl: channels.logoUrl, genre: channels.genre, kind: channels.kind, customNow: channels.customNow, category: channels.category })
    .from(channels)
    .where(and(eq(channels.isHidden, false), isNotNull(channels.canonicalId)))
    .all()
    .filter((ch) => pass(ch.category));

  const seen = new Set<string>();
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Phospharr">'];
  // Channel 1, the always-listed mosaic composite — no DB row; gets filler
  // blocks below so tuner consumers show a titled guide instead of a blank.
  // It belongs to the main lineup only, mirroring playlistM3U's split.
  if (!catFilter?.include?.length) {
    seen.add("phospharr.mosaic");
    parts.push('<channel id="phospharr.mosaic"><display-name>Mosaic</display-name></channel>');
  }
  const genreByCanonical = new Map<string, string | null>();
  for (const ch of chans) {
    if (!ch.canonicalId || seen.has(ch.canonicalId)) continue;
    seen.add(ch.canonicalId);
    genreByCanonical.set(ch.canonicalId, ch.genre);
    // With a logoBase (the tuner's /t/<key> root), point icons at our cached
    // logo proxy — instant, complete art instead of 6k flaky provider URLs.
    const icon = ch.logoUrl ? (logoBase ? `${logoBase}/logo/${ch.id}` : ch.logoUrl) : null;
    parts.push(
      `<channel id="${esc(ch.canonicalId)}"><display-name>${esc(ch.name)}</display-name>` +
        (icon ? `<icon src="${esc(icon)}"/>` : "") +
        "</channel>",
    );
  }

  const rows = progStmt.all(now - WINDOW_BEHIND, now + WINDOW_AHEAD) as Array<{
    canonical_id: string; title: string; subtitle: string | null; description: string | null;
    start_time: number; end_time: number; category: string | null;
    season: number | null; episode: number | null; icon_url: string | null;
  }>;
  const covered = new Set<string>();
  for (const p of rows) {
    if (!seen.has(p.canonical_id)) continue; // only channels we actually exported
    covered.add(p.canonical_id);
    const emby = embyCategory(p.category, genreByCanonical.get(p.canonical_id) ?? null);
    // xmltv_ns is 0-based: "season-1 . episode-1 ."
    const ep = p.season != null && p.episode != null ? `${p.season - 1}.${p.episode - 1}.` : null;
    parts.push(
      `<programme start="${xmltvTime(p.start_time)}" stop="${xmltvTime(p.end_time)}" channel="${esc(p.canonical_id)}">` +
        `<title>${esc(p.title)}</title>` +
        (p.subtitle ? `<sub-title>${esc(p.subtitle)}</sub-title>` : "") +
        (p.description ? `<desc>${esc(p.description)}</desc>` : "") +
        `<category>${emby}</category>` +
        (p.category && p.category !== emby ? `<category>${esc(p.category)}</category>` : "") +
        (ep ? `<episode-num system="xmltv_ns">${ep}</episode-num>` : "") +
        (p.icon_url ? `<icon src="${esc(p.icon_url)}"/>` : "") +
        "</programme>",
    );
  }

  // Synthetic filler for channels with no real guide data — overwhelmingly 24/7
  // loop channels the provider publishes no schedule for. Without it, Emby /
  // Jellyfin render blank "No information" rows that read like broken EPG
  // mapping. Emit hour-aligned 4h blocks titled with the channel name so the
  // guide is fully populated and the channel is identifiable at a glance. The
  // first category is the Emby color keyword from the channel's genre, so even
  // filler rows are color-coded (a 24/7 Kids loop reads as Kids).
  // For live/custom channels the filler title is the editable "now" text (falls
  // back to the channel name) so Emby/Jellyfin show what's on the stream.
  const nameByCanonical = new Map(chans.map((c) => [c.canonicalId!, (c.kind === "live" && c.customNow) ? c.customNow : c.name]));
  nameByCanonical.set("phospharr.mosaic", "Mosaic — compose in Phospharr");
  const blockSec = 4 * 3600;
  const fillStart = Math.floor((now - WINDOW_BEHIND) / 3600) * 3600;
  for (const cid of seen) {
    if (covered.has(cid)) continue;
    const title = nameByCanonical.get(cid) ?? cid;
    const emby = embyCategory(null, genreByCanonical.get(cid) ?? null);
    for (let t = fillStart; t < now + WINDOW_AHEAD; t += blockSec) {
      parts.push(
        `<programme start="${xmltvTime(t)}" stop="${xmltvTime(t + blockSec)}" channel="${esc(cid)}">` +
          `<title>${esc(title)}</title><category>${emby}</category><category>24/7</category></programme>`,
      );
    }
  }
  parts.push("</tv>");
  return parts.join("\n");
}
