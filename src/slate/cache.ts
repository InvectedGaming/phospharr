import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/** Where the built reel cache lives in the running container.
 *
 * NOT related to proxy/tilefeed.ts's `slateFor`/`tile.slate` — that is an
 * unrelated per-mosaic-tile placeholder card. Same word, two independent
 * features; don't conflate them. */
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

export interface ReelEntry { file: string; bytes: number; totalSec: number; tailStartByte: number }

/**
 * How many distinct reels we keep per family.
 *
 * One reel meant every tune inside a rebuild window replayed the same memes —
 * the random start offset varied the entry point but not the content, so it read
 * as "the same memes again". Each build now writes a fresh slot and rotates, and
 * loadReel hands out a different slot per tune, so you cycle RING_SIZE distinct
 * meme sets before anything repeats.
 *
 * Six is a deliberate ceiling: reels are ~20s of low-bitrate video (a few MB
 * each, two families), so the disk cost is trivial, but every slot is an extra
 * meme-API call and ffmpeg encode over the ring's lifetime.
 */
export const RING_SIZE = 6;

export interface ReelManifest {
  builtAt: number;
  /** Newest first. Older single-entry manifests are rejected by readManifest
   *  (see there) and simply rebuilt — the cache is disposable. */
  families: Record<string, ReelEntry[]>;
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
    // `typeof null === "object"` — a `families: null` manifest must NOT read
    // as "warm cache, skip the boot build" (startSlateBuilder's manifest
    // check would otherwise treat it as present and never rebuild).
    if (!parsed || typeof parsed !== "object" || !parsed.families || typeof parsed.families !== "object") return null;
    // Every family must carry an ARRAY of slots. A manifest written before the
    // ring existed holds a bare object per family; treating that as a one-slot
    // ring would work, but rejecting it is better — it costs one rebuild and
    // keeps exactly one shape in play rather than two forever.
    for (const v of Object.values(parsed.families)) if (!Array.isArray(v) || v.length === 0) return null;
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
/**
 * Round-robin cursor per family, so consecutive tunes serve different reels
 * rather than replaying whichever slot happens to be first.
 *
 * In-memory and per-process: a restart begins at slot 0 again, which is fine —
 * the goal is that CONSECUTIVE tunes differ, not that the sequence is globally
 * unique. Deliberately not random: random repeats itself roughly one tune in
 * RING_SIZE, which is exactly the "same memes again" complaint this fixes.
 */
const cursor = new Map<string, number>();

function nextSlot(family: string, ring: ReelEntry[]): ReelEntry | null {
  if (!ring.length) return null;
  const at = (cursor.get(family) ?? -1) + 1;
  cursor.set(family, at);
  return ring[at % ring.length] ?? null;
}

/** Test-only: forget the round-robin positions. */
export function _resetReelCursor(): void {
  cursor.clear();
}

export async function loadReel(
  family: string,
  dir: string = SLATE_DIR,
): Promise<{ data: Uint8Array; totalSec: number; tailStartByte: number } | null> {
  try {
    const man = await readManifest(dir);
    if (!man) return null;
    const ring = man.families[family];
    if (!ring || !ring.length) return null;
    const entry = nextSlot(family, ring);
    if (!entry) return null;
    const file = Bun.file(join(dir, entry.file));
    if (!(await file.exists())) return null;
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length === 0) return null;
    // The manifest's recorded byte count is what buildReelOnce measured right
    // after composing this exact file — a mismatch means the file on disk was
    // truncated, replaced, or otherwise doesn't match what the manifest
    // describes, and must not be served as if it does.
    if (data.length !== entry.bytes) return null;
    return { data, totalSec: entry.totalSec, tailStartByte: entry.tailStartByte };
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
