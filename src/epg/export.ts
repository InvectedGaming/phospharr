import { and, eq, isNotNull } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { channels } from "../db/schema.ts";

/**
 * XMLTV export for external consumers (TiviMate, Jellyfin M3U tuner, …). Channel
 * ids are canonicalIds so they bind to the M3U playlist's tvg-id. Bounded to a
 * rolling window to keep the payload sane.
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

const progStmt = sqlite.prepare(
  "SELECT canonical_id, title, description, start_time, end_time, category FROM programs WHERE end_time > ? AND start_time < ? ORDER BY canonical_id, start_time",
);

export async function exportXmltv(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const chans = db
    .select({ name: channels.name, canonicalId: channels.canonicalId, logoUrl: channels.logoUrl })
    .from(channels)
    .where(and(eq(channels.isHidden, false), isNotNull(channels.canonicalId)))
    .all();

  const seen = new Set<string>();
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Phospharr">'];
  for (const ch of chans) {
    if (!ch.canonicalId || seen.has(ch.canonicalId)) continue;
    seen.add(ch.canonicalId);
    parts.push(
      `<channel id="${esc(ch.canonicalId)}"><display-name>${esc(ch.name)}</display-name>` +
        (ch.logoUrl ? `<icon src="${esc(ch.logoUrl)}"/>` : "") +
        "</channel>",
    );
  }

  const rows = progStmt.all(now - WINDOW_BEHIND, now + WINDOW_AHEAD) as Array<{
    canonical_id: string; title: string; description: string | null;
    start_time: number; end_time: number; category: string | null;
  }>;
  for (const p of rows) {
    if (!seen.has(p.canonical_id)) continue; // only channels we actually exported
    parts.push(
      `<programme start="${xmltvTime(p.start_time)}" stop="${xmltvTime(p.end_time)}" channel="${esc(p.canonical_id)}">` +
        `<title>${esc(p.title)}</title>` +
        (p.description ? `<desc>${esc(p.description)}</desc>` : "") +
        (p.category ? `<category>${esc(p.category)}</category>` : "") +
        "</programme>",
    );
  }
  parts.push("</tv>");
  return parts.join("\n");
}
