import type { RawEntry } from "./types.ts";

const ATTR_RE = /([a-zA-Z0-9-]+)="([^"]*)"/g;

/** Parse an M3U/M3U8 playlist body into raw entries. */
export function parseM3U(body: string): RawEntry[] {
  const lines = body.split(/\r?\n/);
  const entries: RawEntry[] = [];

  let pending: Partial<RawEntry> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("#EXTINF")) {
      const attrs: Record<string, string> = {};
      let m: RegExpExecArray | null;
      ATTR_RE.lastIndex = 0;
      while ((m = ATTR_RE.exec(trimmed)) !== null) {
        attrs[m[1].toLowerCase()] = m[2];
      }
      // Display name is everything after the last comma on the EXTINF line.
      const commaIdx = trimmed.lastIndexOf(",");
      const displayName = commaIdx >= 0 ? trimmed.slice(commaIdx + 1).trim() : "";

      pending = {
        rawName: displayName || attrs["tvg-name"] || "Unknown",
        logoUrl: attrs["tvg-logo"] || undefined,
        groupTitle: attrs["group-title"] || undefined,
        tvgId: attrs["tvg-id"] || undefined,
        tvgName: attrs["tvg-name"] || undefined,
      };
    } else if (trimmed.startsWith("#")) {
      // Other directives (#EXTGRP, #EXTVLCOPT, etc.) — ignore for now.
      continue;
    } else if (pending) {
      pending.url = trimmed;
      entries.push(pending as RawEntry);
      pending = null;
    }
  }

  return entries;
}

/** Fetch and parse an M3U from a URL. */
export async function fetchM3U(url: string, opts: { proxy?: string } = {}): Promise<RawEntry[]> {
  const res = await fetch(url, { redirect: "follow", ...opts });
  if (!res.ok) throw new Error(`M3U fetch failed (${res.status}) for ${url}`);
  return parseM3U(await res.text());
}
