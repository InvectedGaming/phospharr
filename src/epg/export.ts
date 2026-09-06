import { guideRows } from "./guide.ts";

function esc(s: string): string { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function xmltvTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

/** XMLTV for external consumers (Emby, Jellyfin, TiviMate, …). A pure rendering
 *  of guideRows() — see src/epg/guide.ts for what is exported and why. */
export async function exportXmltv(logoBase?: string, catFilter?: { include?: string[]; exclude?: string[] }): Promise<string> {
  const g = guideRows({ catFilter, logoBase });
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Phospharr">'];
  for (const ch of g.channels) {
    parts.push(
      `<channel id="${esc(ch.canonicalId)}"><display-name>${esc(ch.name)}</display-name>` +
        (ch.iconUrl ? `<icon src="${esc(ch.iconUrl)}"/>` : "") + "</channel>",
    );
  }
  for (const ch of g.channels) {
    for (const p of g.programs.get(ch.canonicalId) ?? []) {
      // xmltv_ns is 0-based: "season-1 . episode-1 ."
      const ep = p.season != null && p.episode != null ? `${p.season - 1}.${p.episode - 1}.` : null;
      parts.push(
        `<programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.end)}" channel="${esc(ch.canonicalId)}">` +
          `<title>${esc(p.title)}</title>` +
          (p.subtitle ? `<sub-title>${esc(p.subtitle)}</sub-title>` : "") +
          (p.description ? `<desc>${esc(p.description)}</desc>` : "") +
          `<category>${p.category}</category>` +
          (p.extraCategory ? `<category>${esc(p.extraCategory)}</category>` : "") +
          (ep ? `<episode-num system="xmltv_ns">${ep}</episode-num>` : "") +
          (p.iconUrl ? `<icon src="${esc(p.iconUrl)}"/>` : "") +
          "</programme>",
      );
    }
  }
  parts.push("</tv>");
  return parts.join("\n");
}
