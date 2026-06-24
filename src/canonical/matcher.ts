import { normalizeName, type NormalizedName } from "./normalize.ts";

/**
 * Canonical matching: collapse N provider entries into one logical channel.
 *
 * Strategy, cheapest signal first:
 *   1. tvg-id  — if the provider gives a real EPG id, trust it as canonicalId.
 *   2. slug    — exact normalized-slug match groups obvious duplicates.
 *   3. fuzzy   — token + edit-distance similarity catches near-misses
 *                ("Sky Sports F1" vs "Sky Sport F1").
 *
 * canonicalId format: "{slug}.{country}"  e.g. "espn.us". This is the spine
 * EPG, logos, and categories bind to.
 */

export interface MatchInput {
  rawName: string;
  tvgId?: string;
}

export interface MatchResult {
  canonicalId: string;
  display: string;
  resolution?: number;
  norm: NormalizedName;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** 0..1 similarity between two slugs. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / maxLen;
}

const FUZZY_THRESHOLD = 0.86;

/**
 * Resolve a raw entry to a canonicalId, reusing an existing one when the entry
 * is the same channel from a different provider.
 *
 * `known` maps canonicalId -> representative slug, accumulated as you ingest.
 */
export function matchCanonical(input: MatchInput, known: Map<string, string>): MatchResult {
  const norm = normalizeName(input.rawName);
  const country = norm.country ?? "us";

  // 1. Trust a real-looking tvg-id.
  if (input.tvgId && /[a-z]/i.test(input.tvgId) && input.tvgId.includes(".")) {
    const canonicalId = input.tvgId.toLowerCase();
    if (!known.has(canonicalId)) known.set(canonicalId, norm.slug);
    return { canonicalId, display: norm.display, resolution: norm.resolution, norm };
  }

  const candidate = `${norm.slug}.${country}`;

  // 2. Exact slug match against an existing canonical channel.
  if (known.has(candidate)) {
    return { canonicalId: candidate, display: norm.display, resolution: norm.resolution, norm };
  }

  // 3. Fuzzy match against known slugs (same country bucket).
  let best: { id: string; score: number } | null = null;
  for (const [id, slug] of known) {
    if (!id.endsWith(`.${country}`)) continue;
    const score = similarity(norm.slug, slug);
    if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
      best = { id, score };
    }
  }
  if (best) {
    return { canonicalId: best.id, display: norm.display, resolution: norm.resolution, norm };
  }

  // New canonical channel.
  known.set(candidate, norm.slug);
  return { canonicalId: candidate, display: norm.display, resolution: norm.resolution, norm };
}

/** Quality score used to rank streams behind a channel for source selection. */
export function qualityScore(resolution?: number, health?: string): number {
  const res = resolution ?? 0;
  const healthBonus = health === "live" ? 1000 : health === "degraded" ? 200 : 0;
  return res + healthBonus;
}
