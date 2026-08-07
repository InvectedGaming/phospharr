import { createHash } from "node:crypto";
import { fingerprintRows } from "../tuner/hdhr.ts";
import type { FingerprintRow } from "../tuner/hdhr.ts";

// JSON.stringify per row (not a plain " "-joined string) so a space inside
// `name` or `category` (e.g. "USA Local - ABC") can never make two different
// lineups collide on the same joined string.
export function computeFingerprint(rows: FingerprintRow[]): string {
  const canonical = rows
    .map((r) => JSON.stringify([r.canonicalId, r.guideNumber, r.name, r.logoUrl, r.category]))
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function currentFingerprint(): string {
  return computeFingerprint(fingerprintRows());
}
