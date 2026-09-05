import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getSetting } from "../settings.ts";
import { composeReel, type ComposeOpts } from "./compose.ts";
import { downloadImage, fetchMemes, pickClean, type Meme } from "./memes.ts";
import { FAMILIES, RING_SIZE, readManifest, saveManifest, SLATE_DIR, type ReelManifest } from "./cache.ts";
import { SYNC, PKT, isKeyframe, patPmtPid, pmtVideoPids } from "../proxy/ts.ts";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB cap — same convention as memes.ts's downloadImage
const IMAGE_EXT = /\.(png|jpe?g)$/i;

export type BuildSource = "memes" | "localDir" | "plain";

export interface BuildDeps {
  dir: string;
  fetchMemes: (count: number, subreddits: string[]) => Promise<Meme[]>;
  downloadImage: (url: string, dest: string, maxBytes: number) => Promise<boolean>;
  compose: (o: ComposeOpts) => Promise<{ bytes: number; totalSec: number }>;
}

function extFor(url: string): string {
  const m = /\.(png|jpe?g)(?:$|\?)/i.exec(url);
  return m ? `.${m[1].toLowerCase()}` : ".jpg";
}

/**
 * Try the GPU encoder first (what we run in prod); on ANY throw retry once
 * with libx264 (CPU). compose.ts's own doc says the caller owns this
 * fallback — this is that caller. A second throw is real trouble (bad args,
 * disk full, no ffmpeg…) and propagates: buildReelOnce must leave the
 * previous manifest untouched rather than paper over a broken build.
 */
async function composeWithFallback(
  compose: BuildDeps["compose"],
  o: Omit<ComposeOpts, "encoder">,
): Promise<{ bytes: number; totalSec: number }> {
  try {
    return await compose({ ...o, encoder: "h264_nvenc" });
  } catch {
    return await compose({ ...o, encoder: "libx264" });
  }
}

/**
 * Gather source images for the reel: curated `slate.localDir` → memes API →
 * none (compose() draws a plain color-background slate). `slate.localDir` is
 * the escape hatch (spec: "used when set or when the API fails") — an
 * operator who pointed it at a folder did so specifically to keep Reddit off
 * the family TV, so a non-empty, non-image-empty localDir wins outright and
 * the meme fetch is skipped entirely, not just preferred. The API path only
 * runs when localDir is unset, empty, or contains no usable images.
 * Downloaded meme images land in a temp subdir of `dir`, which the caller
 * removes once every family has been composed from them — localDir images
 * are the admin's own files and are used in place, never deleted.
 */
async function gatherImages(
  deps: BuildDeps,
  want: number,
  subreddits: string[],
  localDir: string,
): Promise<{ source: BuildSource; images: string[]; tmpDir: string | null }> {
  if (localDir) {
    let names: string[] = [];
    try { names = readdirSync(localDir); } catch { names = []; }
    const images = names
      .filter((n) => IMAGE_EXT.test(n))
      .sort()
      .slice(0, want)
      .map((n) => join(localDir, n));
    if (images.length > 0) return { source: "localDir", images, tmpDir: null };
  }

  const fetched = await deps.fetchMemes(want + 3, subreddits).catch(() => [] as Meme[]);
  const clean = pickClean(fetched, want);
  if (clean.length > 0) {
    const tmpDir = mkdtempSync(join(deps.dir, "dl-"));
    const images: string[] = [];
    for (let i = 0; i < clean.length; i++) {
      const dest = join(tmpDir, `img${i}${extFor(clean[i].url)}`);
      const ok = await deps.downloadImage(clean[i].url, dest, MAX_IMAGE_BYTES).catch(() => false);
      if (ok) images.push(dest);
    }
    if (images.length > 0) return { source: "memes", images, tmpDir };
    rmSync(tmpDir, { recursive: true, force: true }); // nothing landed — don't leak the empty temp dir
  }

  return { source: "plain", images: [], tmpDir: null };
}

/**
 * Scan a freshly composed reel for the byte offset to loop from: the aligned
 * time-fraction position (durationSec/totalSec of the file, 188-aligned),
 * advanced forward to the first packet at or after that point where
 * isKeyframe() reports a decodable start. Landing exactly on a keyframe is
 * what makes the loop restart clean instead of mid-GOP/mid-countdown — the
 * bug this replaces: the old tailStartFrac was a TIME fraction consumed as a
 * BYTE fraction over VBR output, so it wasn't even byte-accurate over the
 * uneven bitrate, let alone keyframe-aligned.
 *
 * A single forward pass tracks PAT/PMT (needed to know which PID carries
 * video and to read the random_access_indicator on it — same primitives
 * TsPreroll uses live) so it can resolve keyframes anywhere in the file, not
 * just after the first PAT/PMT repeat following the search start.
 */
function findTailStartByte(data: Uint8Array, durationSec: number, totalSec: number): number {
  const end = data.length - (data.length % PKT);
  const approx = totalSec > 0 ? Math.floor((end * durationSec) / totalSec / PKT) * PKT : 0;
  let pmtPid = -1;
  const videoPids = new Set<number>();
  for (let off = 0; off < end; off += PKT) {
    const p = data.subarray(off, off + PKT);
    if (p[0] !== SYNC) continue; // defensive; our own compose output is always packet-aligned
    const pid = ((p[1]! & 0x1f) << 8) | p[2]!;
    if (pid === 0) { const m = patPmtPid(p); if (m >= 0) pmtPid = m; }
    else if (pid === pmtPid) pmtVideoPids(p, videoPids);
    if (off >= approx && isKeyframe(p, pid, videoPids)) return off;
  }
  // No keyframe found at/after the aligned fraction offset before EOF —
  // shouldn't happen for our own 1s-closed-GOP encode, but ffmpeg output
  // isn't a guarantee. Fall back to the aligned fraction itself: still
  // 188-aligned, just not keyframe-guaranteed. SlateFeeder aligns/clamps it
  // again defensively regardless.
  return approx;
}

/**
 * Build one reel per FAMILIES entry from the SAME source images and cache
 * them atomically as ONE batch. Every family is first composed to
 * `<family>.ts.tmp`; only once EVERY family has succeeded do we rename all of
 * them into place and write the manifest (also atomically — see cache.ts's
 * saveManifest), in that order. This two-phase shape matters: renaming a
 * family in as soon as ITS OWN compose succeeds would let an early family's
 * fresh bytes land on disk under the OLD manifest's (now stale) entry for it
 * if a LATER family then throws — loadReel() trusts the manifest completely,
 * so a half-updated cache like that is a silent correctness bug, not just an
 * incomplete build. If any family's compose throws (after the nvenc→libx264
 * retry), buildReelOnce rejects and NOTHING from this run is placed: the
 * previous manifest and every previously-placed family file are untouched.
 * A failed family's own `.tmp` file can be left orphaned on disk in that
 * case — harmless; the next build's `ffmpeg -y` overwrites it.
 */
/** Lowest slot number not currently in the ring, else the oldest slot's number
 *  (so a full ring overwrites its least-recent member). Keyed off the first
 *  family — every family is built in the same batch, so their slots agree. */
function nextFreeSlot(prev: ReelManifest["families"]): number {
  const ring = prev[FAMILIES[0]!.key] ?? [];
  const used = new Set(ring.map((e) => Number(/\.(\d+)\.ts$/.exec(e.file)?.[1] ?? -1)));
  for (let i = 0; i < RING_SIZE; i++) if (!used.has(i)) return i;
  const oldest = ring[ring.length - 1]?.file ?? "";
  return Number(/\.(\d+)\.ts$/.exec(oldest)?.[1] ?? 0);
}

export async function buildReelOnce(deps: BuildDeps): Promise<{ source: BuildSource }> {
  mkdirSync(deps.dir, { recursive: true });

  const [rawDurationSec, rawTailSec, rawMemesPerReel, subreddits, localDir] = await Promise.all([
    getSetting("slate.durationSec"),
    getSetting("slate.tailSec"),
    getSetting("slate.memesPerReel"),
    getSetting("slate.subreddits"),
    getSetting("slate.localDir"),
  ]);
  // Clamp against pathological settings-UI input (0, negative, absurdly
  // large) that would otherwise reach ffmpeg/gatherImages and produce a
  // broken or unwatchable reel instead of a validation error the operator
  // could act on.
  const durationSec = Math.max(5, rawDurationSec); // below ~5s the countdown reads as a glitch, not a buffer
  const tailSec = Math.max(2, rawTailSec); // the loop-point hold segment needs at least a beat, or the loop feels like a stutter
  const memesPerReel = Math.min(12, Math.max(1, rawMemesPerReel)); // 0 collapses gatherImages into an unintended plain slate; >12 makes each image's on-screen segment sub-second and the countdown unreadable

  const { source, images, tmpDir } = await gatherImages(deps, memesPerReel, subreddits, localDir);

  try {
    // Rotate: this build becomes the newest slot and the oldest is dropped once
    // the ring is full, so the cache holds RING_SIZE independent meme sets and a
    // tune cycles through them instead of replaying one.
    const prev = (await readManifest(deps.dir))?.families ?? {};
    const slot = nextFreeSlot(prev);
    const families: ReelManifest["families"] = {};
    const placements: { finalPath: string; tmpPath: string }[] = [];
    for (const fam of FAMILIES) {
      const finalPath = join(deps.dir, `${fam.key}.${slot}.ts`);
      const tmpPath = `${finalPath}.tmp`;
      const { bytes, totalSec } = await composeWithFallback(deps.compose, {
        images, out: tmpPath, width: fam.width, height: fam.height, fps: fam.fps, durationSec, tailSec,
      });
      // Read back the just-composed tmp file to scan for the keyframe-aligned
      // loop point — see findTailStartByte's doc comment.
      const composed = new Uint8Array(await Bun.file(tmpPath).arrayBuffer());
      const tailStartByte = findTailStartByte(composed, durationSec, totalSec);
      placements.push({ finalPath, tmpPath });
      const fresh = { file: `${fam.key}.${slot}.ts`, bytes, totalSec, tailStartByte };
      // Newest first, capped at RING_SIZE. Any prior entry that reused this slot
      // number is dropped: its file is about to be overwritten by the rename
      // below, so keeping it would point the manifest at the new bytes under the
      // old entry's (now wrong) byte count, which loadReel rejects.
      const kept = (prev[fam.key] ?? []).filter((e) => e.file !== fresh.file);
      families[fam.key] = [fresh, ...kept].slice(0, RING_SIZE);
    }

    // Every family composed successfully — NOW place them and write the
    // manifest. See the doc comment above for why this can't happen per-family.
    for (const { finalPath, tmpPath } of placements) renameSync(tmpPath, finalPath);
    await saveManifest({ builtAt: Date.now(), families }, deps.dir);
    return { source };
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Scheduler -------------------------------------------------------------
//
// Poll pattern, not a single boot-anchored setTimeout: this host restarts
// often (container updates, autoheal, manual bounces), and a "one 6h
// setTimeout from boot, re-armed after each build" scheduler effectively
// never fires on a host that restarts more often than the cadence — every
// restart resets the clock back to the full interval. A setInterval-style
// tick instead runs every TICK_MS and decides FOR ITSELF whether a build is
// due (feature on, and either no manifest yet or the current one has aged
// past slate.refreshHours) — a restart costs at most one missed tick, not
// the whole cadence, and there is no separate boot-build special case: the
// first tick after `features.slate` goes from off to on (or after a fresh
// install with no manifest) covers it within one poll period.
//
// The build itself deliberately does NOT go through withBigJob (src/scheduler/
// bigjob.ts): it's seconds of ffmpeg work producing a couple of small TS
// files, nothing like the tens-to-hundreds of MB EPG/VOD/lineup transients
// that mutex exists to keep from stacking.

const TICK_MS = 10 * 60_000; // poll cadence — independent of slate.refreshHours, which only gates staleness

let timer: ReturnType<typeof setInterval> | null = null;

// Prevents two ticks from overlapping if a build runs long (or a future
// manual "rebuild now" action lands mid-tick). The check-and-set runs before
// this function's first `await`, so two synchronous callers can never both
// pass it — JS won't interleave them until a suspension point.
let building = false;

async function tick(): Promise<void> {
  if (building) return; // a build is already in flight — never overlap
  building = true;
  try {
    if (!(await getSetting("features.slate"))) return;
    const man = await readManifest(SLATE_DIR);
    const hours = Math.max(1, Number(await getSetting("slate.refreshHours")) || 6);
    // A fresh cache holds ONE reel, so every tune replays it until the ring
    // fills — the exact repetition the ring exists to remove. Build on every
    // tick until all RING_SIZE slots exist (~1h at the 10min poll), then settle
    // to the configured cadence so we stop hammering the meme API and NVENC.
    const ringFull = (man?.families[FAMILIES[0]!.key]?.length ?? 0) >= RING_SIZE;
    if (man && ringFull && Date.now() - man.builtAt <= hours * 3600_000) return; // full and fresh — nothing to do
    await buildReelOnce({ dir: SLATE_DIR, fetchMemes, downloadImage, compose: composeReel });
  } catch (e) {
    console.error("[slate] builder tick error:", e instanceof Error ? e.message : e);
  } finally {
    building = false;
  }
}

// `started` is what makes startSlateBuilder idempotent — set synchronously,
// before any await, so two back-to-back synchronous calls can't both pass it
// and each arm their own interval.
let started = false;

/** Start the scheduler. Safe to call more than once — a second call is a no-op. */
export function startSlateBuilder(): void {
  if (started) return; // already started
  started = true;
  console.log(`[slate] builder polling every ${Math.round(TICK_MS / 60_000)}min — a freshly-enabled flag (or fresh install) produces a reel within one tick, not immediately`);
  timer = setInterval(() => { void tick(); }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}
