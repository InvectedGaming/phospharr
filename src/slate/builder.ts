import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getSetting } from "../settings.ts";
import { composeReel, type ComposeOpts } from "./compose.ts";
import { downloadImage, fetchMemes, pickClean, type Meme } from "./memes.ts";
import { FAMILIES, readManifest, saveManifest, SLATE_DIR, type ReelManifest } from "./cache.ts";

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
 * Gather source images for the reel: memes API → curated `slate.localDir` →
 * none (compose() draws a plain color-background slate). Downloaded meme
 * images land in a temp subdir of `dir`, which the caller removes once every
 * family has been composed from them — localDir images are the admin's own
 * files and are used in place, never deleted.
 */
async function gatherImages(
  deps: BuildDeps,
  want: number,
  subreddits: string[],
  localDir: string,
): Promise<{ source: BuildSource; images: string[]; tmpDir: string | null }> {
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

  return { source: "plain", images: [], tmpDir: null };
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
export async function buildReelOnce(deps: BuildDeps): Promise<{ source: BuildSource }> {
  mkdirSync(deps.dir, { recursive: true });

  const [durationSec, tailSec, memesPerReel, subreddits, localDir] = await Promise.all([
    getSetting("slate.durationSec"),
    getSetting("slate.tailSec"),
    getSetting("slate.memesPerReel"),
    getSetting("slate.subreddits"),
    getSetting("slate.localDir"),
  ]);

  const { source, images, tmpDir } = await gatherImages(deps, memesPerReel, subreddits, localDir);

  try {
    const families: ReelManifest["families"] = {};
    const placements: { finalPath: string; tmpPath: string }[] = [];
    for (const fam of FAMILIES) {
      const finalPath = join(deps.dir, `${fam.key}.ts`);
      const tmpPath = `${finalPath}.tmp`;
      const { bytes, totalSec } = await composeWithFallback(deps.compose, {
        images, out: tmpPath, width: fam.width, height: fam.height, fps: fam.fps, durationSec, tailSec,
      });
      placements.push({ finalPath, tmpPath });
      families[fam.key] = {
        file: `${fam.key}.ts`,
        bytes,
        totalSec,
        tailStartFrac: totalSec > 0 ? durationSec / totalSec : 0,
      };
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
// Arm/tick pattern mirrored from the live-priority-band branch's
// src/content/priorityscheduler.ts (not yet merged to main as of this
// writing): a single setTimeout re-armed from tick()'s `finally`, cadence and
// the feature flag both re-read from settings every tick so the UI can
// change them live, and NO unconditional heavy boot work — that pattern (an
// unconditional pull seconds after every boot) caused an autoheal restart
// loop against /healthz on 2026-09-01. The one addition here is a small
// delayed build shortly after boot, but ONLY when no manifest exists yet, so
// a fresh install doesn't sit with an empty slate cache until the first full
// cadence period elapses.
//
// The build itself deliberately does NOT go through withBigJob (src/scheduler/
// bigjob.ts): it's seconds of ffmpeg work producing a couple of small TS
// files, nothing like the tens-to-hundreds of MB EPG/VOD/lineup transients
// that mutex exists to keep from stacking.

const BOOT_DELAY_MS = 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;

// Mirrors the `running` guard in src/epg/scheduler.ts: the boot-delay build
// and the cadence tick's build are two independent setTimeout chains with no
// other coordination between them, so without this a slow build (or a future
// manual "rebuild now" action) could overlap a second one. The check-and-set
// runs before this function's first `await`, so two synchronous callers can
// never both pass it — JS won't interleave them until a suspension point.
let building = false;

async function runBuildIfEnabled(): Promise<void> {
  if (building) return; // a build is already in flight — never overlap
  building = true;
  try {
    if (!(await getSetting("features.slate"))) return;
    await buildReelOnce({ dir: SLATE_DIR, fetchMemes, downloadImage, compose: composeReel });
  } finally {
    building = false;
  }
}

async function tick(): Promise<void> {
  try {
    await runBuildIfEnabled();
  } catch (e) {
    console.error("[slate] builder tick error:", e instanceof Error ? e.message : e);
  } finally {
    arm();
  }
}

async function arm(): Promise<void> {
  const hours = Math.max(1, Number(await getSetting("slate.refreshHours")) || 6);
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, hours * 3600_000);
  if (typeof timer.unref === "function") timer.unref();
}

// `started` (not `timer`) is what makes startSlateBuilder idempotent. `arm()`
// is async and only assigns `timer` after awaiting getSetting(), so two
// back-to-back synchronous calls would both see `timer === null` and both
// arm a timer + schedule a boot build. `started` is set synchronously, before
// any await, closing that window the same way `building` does above.
let started = false;

/** Start the scheduler. Safe to call more than once — a second call is a no-op. */
export function startSlateBuilder(): void {
  if (started) return; // already started
  started = true;
  void arm();

  const boot = setTimeout(async () => {
    try {
      if (!(await getSetting("features.slate"))) return;
      if (await readManifest(SLATE_DIR)) return; // cache already warm — the regular cadence covers refreshes
      await runBuildIfEnabled();
    } catch (e) {
      console.error("[slate] initial build failed:", e instanceof Error ? e.message : e);
      // tick()'s own cadence will retry regardless of this failing.
    }
  }, BOOT_DELAY_MS);
  if (typeof boot.unref === "function") boot.unref();
}
