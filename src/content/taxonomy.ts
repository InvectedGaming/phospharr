/**
 * Channel taxonomy: derive a structured (kind, genre) from the RAW provider
 * group-title + channel name. Deterministic regex cascade — providers bucket
 * consistently ("24/7 Drama", "USA Local - ABC", "USA Sports"), so ~20 rules
 * cover the vast majority; the tail is fixable per-channel in the UI
 * (tax_locked stops the classifier from clobbering manual edits on re-sync).
 *
 *   kind:  network | local | loop | intl | event
 *   genre: one of GENRES below
 */

export type ChannelKind = "network" | "local" | "loop" | "intl" | "event" | "live";

export const GENRES = [
  "Sports", "News", "Movies", "Entertainment", "Drama", "Comedy", "Kids",
  "Documentary", "Reality", "Crime", "Classics", "Action", "Sci-Fi", "Music",
  "Lifestyle", "Locals",
] as const;
export type Genre = (typeof GENRES)[number];

export interface Taxonomy { kind: ChannelKind; genre: Genre }

// Countries that mark a channel as international relative to a US-first lineup.
const INTL_RE = /^\s*(uk|ca|au|nz|ie|de|fr|es|it|nl|pt|be|ch|pl|se|no|dk|fi|gr|tr|mx|br|ar|latin|latino|africa|india|asia|arab)\b/i;

// Foreign BROADCAST BRANDS carried on US feeds ("USA BBC World News", "USA AL
// JAZEERA") — the country prefix says American, the brand says otherwise. In a
// US-first lineup these belong in the International block, not alphabetically
// ahead of CNN in the news block. BBC America is a US cable network — excluded.
const INTL_BRAND_RE = /\b(al ?jazeera|bbc(?!\s*america)|cgtn|france ?24|deutsche welle|dw news|euronews|sky news|russia today|rt news|rt america|trt world|nhk|gb news|cbc news|channel ?news ?asia)\b/i;

// Genre from arbitrary text — most-specific markers first.
function genreOf(text: string): Genre | null {
  const t = text.toLowerCase();
  if (/\b(sport|espn|nfl|nba|mlb|nhl|ufc|wwe|mma|golf|soccer|football|cricket|rugby|tennis|racing|motorsport|nascar|f1|fight)\b/.test(t)) return "Sports";
  if (/\b(news|weather|c-?span|bloomberg|msnbc|cnbc)\b/.test(t)) return "News";
  if (/\b(kids?|cartoon|nick(elodeon)?|disney|junior|boomerang|pbs kids)\b/.test(t)) return "Kids";
  if (/\b(music|stingray|karaoke|mtv|vevo|vh1)\b/.test(t)) return "Music";
  if (/\b(document|discovery|nat ?geo|history|science|animal|nature|planet)\b/.test(t)) return "Documentary";
  if (/\b(crime|investigat|forensic)\b/.test(t)) return "Crime";
  if (/\breality\b/.test(t)) return "Reality";
  if (/\b(classic|retro|throwback|nostalgia)\b/.test(t)) return "Classics";
  if (/\b(sci-?fi|science fiction|horror)\b/.test(t)) return "Sci-Fi";
  if (/\b(action|adventure)\b/.test(t)) return "Action";
  if (/\b(movie|cinema|film|hbo|showtime|starz|cinemax|mgm)\b/.test(t)) return "Movies";
  if (/\bdrama\b/.test(t)) return "Drama"; // after movie/crime so "Crime Drama" lands better
  if (/\bcomedy\b/.test(t)) return "Comedy";
  if (/\b(food|cook|home|garden|travel|lifestyle|diy|hgtv)\b/.test(t)) return "Lifestyle";
  return null;
}

// The big-4-plus network of a LOCAL channel — used to order the locals block.
const LOCAL_NETWORKS = ["ABC", "NBC", "CBS", "FOX", "CW", "PBS", "MYNETWORK", "METV", "ION"] as const;
export function localNetwork(category: string | null | undefined, name: string | null | undefined): string {
  const cat = (category ?? "").toUpperCase();
  const catM = cat.match(/LOCAL\s*-\s*([A-Z]+)/);
  if (catM && catM[1] !== "MISC") return catM[1];
  const nm = " " + (name ?? "").toUpperCase() + " ";
  for (const net of LOCAL_NETWORKS) if (nm.includes(" " + net + " ")) return net;
  return "ZZZ"; // misc — sorts last within the block
}

export function classify(category: string | null | undefined, name: string | null | undefined): Taxonomy {
  const cat = (category ?? "").trim();
  const nm = (name ?? "").trim();
  const both = cat + " " + nm;

  // 24/7 loop channels — a single show on repeat; genre from the group's tail.
  if (/(^|\b)24[\/-]7\b/i.test(cat) || /(^|\b)24[\/-]7\b/i.test(nm)) {
    return { kind: "loop", genre: genreOf(cat) ?? genreOf(nm) ?? "Entertainment" };
  }
  // Pay-per-view / one-off events.
  if (/\b(ppv|pay.?per.?view)\b/i.test(both)) return { kind: "event", genre: "Sports" };
  // Local affiliates: the provider's "Local" groups, or market-tagged names
  // ("TX San Antonio NBC WOAI", "USA FOX 12 KPTV PORTLAND" — 4-letter callsigns).
  if (/\blocal\b/i.test(cat) || /\b[KW][A-Z]{3}\b/.test(nm) || /^[A-Z]{2}\s+[A-Z][a-z]+.*\b(ABC|NBC|CBS|FOX|CW|PBS)\b/.test(nm)) {
    return { kind: "local", genre: "Locals" };
  }
  // International: country-prefixed group or name (non-US), or a foreign brand
  // riding a US feed (Al Jazeera, BBC World, CGTN, …).
  if (INTL_RE.test(cat) || INTL_RE.test(nm)) {
    return { kind: "intl", genre: genreOf(both) ?? "Entertainment" };
  }
  if (INTL_BRAND_RE.test(both)) {
    return { kind: "intl", genre: genreOf(both) ?? "News" };
  }
  // Regular linear networks.
  return { kind: "network", genre: genreOf(both) ?? "Entertainment" };
}
