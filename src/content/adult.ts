/**
 * Adult-content detection. Most providers bucket adult channels into an explicit
 * category group ("XXX", "Adult", "18+", "For Adults"), so we key off the
 * CATEGORY first (reliable) and only fall back to the strongest name markers —
 * deliberately conservative to avoid false positives like "Adult Swim" or a city
 * named "Sussex". The actual hiding lives in filter.ts (reconcileAutoHides).
 */

// Strong markers anywhere in the category string.
const CAT_RE = /(\bxxx\b|\bporn|hardcore|hentai|fetish|brazzers|playboy|hustler|naughty|\beroti|\bnsfw\b|18\s*\+|\+\s*18|adults?\s*only|for\s+adults?)/i;
// A category that IS just the group name ("Adult", "Adults", "XXX", "18+").
const CAT_EXACT = /^\s*(adults?|xxx+|porn|18\s*\+|\+\s*18)\s*$/i;
// On the NAME, only the unambiguous markers — NOT "hardcore" ("Hardcore Pawn" is
// a reality show), "adult" ("Adult Swim"), or substrings ("Sussex").
const NAME_RE = /(\bxxx\b|\bporn\b)/i;

export function isAdult(category: string | null | undefined, name: string | null | undefined): boolean {
  const cat = category ?? "";
  if (CAT_EXACT.test(cat) || CAT_RE.test(cat)) return true;
  if (NAME_RE.test(name ?? "")) return true;
  return false;
}
