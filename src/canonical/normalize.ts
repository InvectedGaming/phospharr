/**
 * Name normalization: turn messy provider names into clean display names + a
 * stable matching slug, and extract signals (quality, country) along the way.
 *
 *   "US| ESPN HD [1080]"  ->  { display: "ESPN", slug: "espn", resolution: 1080, country: "us" }
 *   "UK: Sky Sports F1 FHD" -> { display: "Sky Sports F1", slug: "skysportsf1", resolution: 1080, country: "uk" }
 */

export interface NormalizedName {
  display: string;
  slug: string;
  resolution?: number;
  country?: string;
}

// Quality tags → vertical resolution hint.
const QUALITY: Array<[RegExp, number]> = [
  [/\b(4k|uhd|2160p?)\b/i, 2160],
  [/\b(fhd|1080p?)\b/i, 1080],
  [/\b(hd|720p?)\b/i, 720],
  [/\b(sd|480p?)\b/i, 480],
];

// Leading country/region prefixes like "US|", "UK:", "US -", "[USA]".
const COUNTRY_PREFIX = /^\s*[\[(]?\s*(us|usa|uk|ca|au|nz|de|fr|es|it|nl|pt|in|ar|mx|br)\b\s*[\])]?\s*[|:\-]\s*/i;

// Junk tokens stripped anywhere.
const JUNK = [
  /\bvip\b/gi,
  /\bplus\b/gi,
  /\b24\/7\b/gi,
  /\braw\b/gi,
  /\bbackup\b/gi,
  /\bfeed\b/gi,
  /[\[(].*?[\])]/g, // anything in brackets/parens
];

export function normalizeName(raw: string): NormalizedName {
  let s = raw.trim();

  // Country prefix
  let country: string | undefined;
  const cm = s.match(COUNTRY_PREFIX);
  if (cm) {
    country = cm[1].toLowerCase().replace("usa", "us");
    s = s.replace(COUNTRY_PREFIX, "");
  }

  // Resolution (read before stripping)
  let resolution: number | undefined;
  for (const [re, val] of QUALITY) {
    if (re.test(s)) {
      resolution = val;
      break;
    }
  }

  // Strip quality words + junk
  for (const [re] of QUALITY) s = s.replace(re, " ");
  for (const re of JUNK) s = s.replace(re, " ");

  // Collapse separators/whitespace
  s = s.replace(/[_|]+/g, " ").replace(/\s+/g, " ").trim();
  // Trim trailing separators left behind
  s = s.replace(/[\-:|]+$/, "").trim();

  const display = s || raw.trim();
  const slug = display.toLowerCase().replace(/[^a-z0-9]/g, "");

  return { display, slug, resolution, country };
}
