import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/** Where the built reel cache lives in the running container. */
export const SLATE_DIR = "/data/slate";

export interface ReelFamily { key: string; width: number; height: number; fps: number }

/** The two resolution/frame-rate families we pre-render a reel for. Picking
 *  the family from the requested stream's resolution (see `familyFor`) means
 *  the muxer never has to transcode the slate to match — it splices the
 *  matching pre-built TS in directly. */
export const FAMILIES: ReelFamily[] = [
  { key: "1080p25", width: 1920, height: 1080, fps: 25 },
  { key: "720p30", width: 1280, height: 720, fps: 30 },
];

/** Pick the pre-built family for a given vertical resolution. `null` (unknown
 *  resolution) falls to the smaller/cheaper family. */
export function familyFor(resolution: number | null): string {
  return resolution != null && resolution >= 1080 ? "1080p25" : "720p30";
}

export interface ReelManifest {
  builtAt: number;
  families: Record<string, { file: string; bytes: number; totalSec: number; tailStartFrac: number }>;
}

function manifestPath(dir: string): string {
  return join(dir, "manifest.json");
}

/** Read the manifest. `null` on anything missing/corrupt — never throws;
 *  callers (including the muxer's live tune path) treat that as "no cache
 *  yet, skip the slate". */
export async function readManifest(dir: string = SLATE_DIR): Promise<ReelManifest | null> {
  try {
    const raw = await Bun.file(manifestPath(dir)).text();
    const parsed = JSON.parse(raw) as ReelManifest;
    if (!parsed || typeof parsed !== "object" || typeof parsed.families !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write the manifest atomically: temp file + rename, so a reader never sees
 *  a partially-written file. */
export async function saveManifest(man: ReelManifest, dir: string = SLATE_DIR): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const final = manifestPath(dir);
  const tmp = `${final}.tmp`;
  await Bun.write(tmp, JSON.stringify(man));
  renameSync(tmp, final);
}

/**
 * Load a pre-built reel for `family` from the cache. Reads the manifest AND
 * the backing file; returns `null` on anything missing or corrupt — this is
 * called from the muxer's live tune path, which must never throw on a bad or
 * absent cache (that would take down the tune instead of just skipping the
 * slate).
 */
export async function loadReel(
  family: string,
  dir: string = SLATE_DIR,
): Promise<{ data: Uint8Array; totalSec: number; tailStartFrac: number } | null> {
  try {
    const man = await readManifest(dir);
    if (!man) return null;
    const entry = man.families[family];
    if (!entry) return null;
    const file = Bun.file(join(dir, entry.file));
    if (!(await file.exists())) return null;
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length === 0) return null;
    return { data, totalSec: entry.totalSec, tailStartFrac: entry.tailStartFrac };
  } catch {
    return null;
  }
}

// Re-exported so callers that only need to ensure the cache directory exists
// (e.g. the builder writing into a custom dir in tests) don't need their own
// fs import for this one thing.
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
