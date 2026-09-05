import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReel, saveManifest, RING_SIZE, _resetReelCursor, type ReelEntry } from "../src/slate/cache.ts";

const dirs: string[] = [];
const newDir = () => { const d = mkdtempSync(join(tmpdir(), "ring-")); dirs.push(d); return d; };
afterEach(() => { _resetReelCursor(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Write `n` reel files whose CONTENT differs, so a test can tell which slot was served. */
function ringOf(dir: string, n: number): ReelEntry[] {
  const out: ReelEntry[] = [];
  for (let i = 0; i < n; i++) {
    const file = `720p30.${i}.ts`;
    const body = new Uint8Array(188 * (i + 2)).fill(0x40 + i); // distinct bytes per slot
    writeFileSync(join(dir, file), body);
    out.push({ file, bytes: body.length, totalSec: 26, tailStartByte: 188 });
  }
  return out;
}

describe("a tune serves a different reel each time", () => {
  test("consecutive tunes cycle every slot before repeating", async () => {
    const dir = newDir();
    await saveManifest({ builtAt: Date.now(), families: { "720p30": ringOf(dir, 4) } }, dir);

    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await loadReel("720p30", dir);
      expect(r).not.toBeNull();
      seen.push(r!.data[0]!); // first byte identifies the slot
    }
    expect(new Set(seen).size).toBe(4); // four tunes, four different reels — the point of the change
  });

  test("wraps around after the ring is exhausted", async () => {
    const dir = newDir();
    await saveManifest({ builtAt: Date.now(), families: { "720p30": ringOf(dir, 3) } }, dir);
    const first = (await loadReel("720p30", dir))!.data[0];
    await loadReel("720p30", dir);
    await loadReel("720p30", dir);
    expect((await loadReel("720p30", dir))!.data[0]).toBe(first!); // 4th tune == 1st
  });

  test("a single-slot ring still works — it just repeats", async () => {
    const dir = newDir();
    await saveManifest({ builtAt: Date.now(), families: { "720p30": ringOf(dir, 1) } }, dir);
    expect(await loadReel("720p30", dir)).not.toBeNull();
    expect(await loadReel("720p30", dir)).not.toBeNull();
  });

  test("families advance independently — one does not skip the other's memes", async () => {
    const dir = newDir();
    const ring = ringOf(dir, 3);
    await saveManifest({ builtAt: Date.now(), families: { "720p30": ring, "1080p25": ring } }, dir);
    const a1 = (await loadReel("720p30", dir))!.data[0];
    const b1 = (await loadReel("1080p25", dir))!.data[0];
    expect(a1).toBe(b1!); // each family starts at its own slot 0
  });

  test("a truncated file is skipped as before, not served", async () => {
    const dir = newDir();
    const ring = ringOf(dir, 2);
    writeFileSync(join(dir, ring[0]!.file), new Uint8Array(5)); // now shorter than the manifest says
    await saveManifest({ builtAt: Date.now(), families: { "720p30": ring } }, dir);
    expect(await loadReel("720p30", dir)).toBeNull(); // slot 0 is corrupt → refuse
  });

  test("RING_SIZE is the documented ceiling", () => {
    expect(RING_SIZE).toBeGreaterThan(1);
  });
});
