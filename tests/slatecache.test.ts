import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReel, readManifest, saveManifest } from "../src/slate/cache.ts";

const newDir = () => mkdtempSync(join(tmpdir(), "slatecache-"));

describe("readManifest", () => {
  test("corrupt JSON returns null, never throws", async () => {
    const dir = newDir();
    writeFileSync(join(dir, "manifest.json"), "{not json");
    expect(await readManifest(dir)).toBeNull();
  });

  test("missing manifest file returns null", async () => {
    const dir = newDir();
    expect(await readManifest(dir)).toBeNull();
  });

  test("families: null is treated as absent, not a warm cache", async () => {
    const dir = newDir();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ builtAt: 1, families: null }));
    expect(await readManifest(dir)).toBeNull();
  });
});

describe("loadReel", () => {
  test("corrupt JSON manifest: returns null, never throws", async () => {
    const dir = newDir();
    writeFileSync(join(dir, "manifest.json"), "{not json");
    expect(await loadReel("720p30", dir)).toBeNull();
  });

  test("manifest missing the requested family key: returns null", async () => {
    const dir = newDir();
    await saveManifest({ builtAt: Date.now(), families: {} }, dir);
    expect(await loadReel("720p30", dir)).toBeNull();
  });

  test("backing file missing entirely: returns null", async () => {
    const dir = newDir();
    await saveManifest(
      { builtAt: Date.now(), families: { "720p30": { file: "720p30.ts", bytes: 10, totalSec: 26, tailStartByte: 188 } } },
      dir,
    );
    expect(await loadReel("720p30", dir)).toBeNull();
  });

  test("file size mismatch vs. manifest's recorded bytes: returns null", async () => {
    const dir = newDir();
    writeFileSync(join(dir, "720p30.ts"), new Uint8Array(10).fill(0x47));
    await saveManifest(
      { builtAt: Date.now(), families: { "720p30": { file: "720p30.ts", bytes: 999, totalSec: 26, tailStartByte: 188 } } },
      dir,
    );
    expect(await loadReel("720p30", dir)).toBeNull();
  });

  test("zero-length backing file: returns null", async () => {
    const dir = newDir();
    writeFileSync(join(dir, "720p30.ts"), new Uint8Array(0));
    await saveManifest(
      { builtAt: Date.now(), families: { "720p30": { file: "720p30.ts", bytes: 0, totalSec: 26, tailStartByte: 188 } } },
      dir,
    );
    expect(await loadReel("720p30", dir)).toBeNull();
  });

  test("families: null manifest: returns null, never throws", async () => {
    const dir = newDir();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ builtAt: 1, families: null }));
    expect(await loadReel("720p30", dir)).toBeNull();
  });

  test("happy path: matching size loads successfully", async () => {
    const dir = newDir();
    writeFileSync(join(dir, "720p30.ts"), new Uint8Array(10).fill(0x47));
    await saveManifest(
      { builtAt: Date.now(), families: { "720p30": { file: "720p30.ts", bytes: 10, totalSec: 26, tailStartByte: 188 } } },
      dir,
    );
    const r = await loadReel("720p30", dir);
    expect(r).not.toBeNull();
    expect(r!.data.length).toBe(10);
    expect(r!.totalSec).toBe(26);
  });
});
