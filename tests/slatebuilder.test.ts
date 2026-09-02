import { describe, expect, test, mock } from "bun:test";
import { buildReelOnce } from "../src/slate/builder.ts";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSetting, deleteSetting } from "../src/settings.ts";

const okCompose = async (o: { out: string; durationSec: number; tailSec: number }) => {
  writeFileSync(o.out, new Uint8Array(1000).fill(0x47));
  return { bytes: 1000, totalSec: o.durationSec + o.tailSec };
};

describe("buildReelOnce", () => {
  test("happy path: memes fetched, images downloaded, both families composed, manifest written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slateb-"));
    const r = await buildReelOnce({
      dir,
      fetchMemes: async () => [{ url: "https://i.redd.it/a.png", nsfw: false, spoiler: false, title: "", subreddit: "" }],
      downloadImage: async (_u, dest) => { writeFileSync(dest, new Uint8Array([1])); return true; },
      compose: okCompose as never,
    });
    expect(r.source).toBe("memes");
    const man = JSON.parse(await Bun.file(join(dir, "manifest.json")).text());
    expect(Object.keys(man.families).sort()).toEqual(["1080p25", "720p30"]);
    // okCompose's fake output is 0x47-filled but carries no real PAT/PMT/video
    // PIDs, so the scanner never finds a keyframe and falls back to the
    // aligned time-fraction byte offset — still 188-aligned and non-zero.
    expect(man.families["720p30"].tailStartByte % 188).toBe(0);
    expect(man.families["720p30"].tailStartByte).toBeGreaterThan(0);
    expect(existsSync(join(dir, "720p30.ts"))).toBe(true);
  });

  test("no memes and no localDir: plain slate still builds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slateb-"));
    const r = await buildReelOnce({
      dir, fetchMemes: async () => [], downloadImage: async () => false, compose: okCompose as never,
    });
    expect(r.source).toBe("plain");
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
  });

  test("compose failure leaves the previous manifest untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slateb-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ builtAt: 1, families: {} }));
    await expect(buildReelOnce({
      dir, fetchMemes: async () => [], downloadImage: async () => false,
      compose: (async () => { throw new Error("nvenc busy"); }) as never,
    })).rejects.toThrow();
    expect(JSON.parse(await Bun.file(join(dir, "manifest.json")).text()).builtAt).toBe(1);
  });

  test("partial family failure: earlier family's placed file is not replaced, manifest untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slateb-"));
    // Pre-existing manifest + a real 1080p25.ts already on disk (the "previous
    // good build"). FAMILIES composes 1080p25 first, 720p30 second — this
    // mock succeeds for 1080p25 and throws for 720p30, so a per-family
    // (rather than whole-batch) placement would clobber the sentinel below.
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ builtAt: 1, families: {} }));
    writeFileSync(join(dir, "1080p25.ts"), "SENTINEL");
    const compose = (async (o: { out: string; width: number; durationSec: number; tailSec: number }) => {
      if (o.width === 1920) {
        writeFileSync(o.out, new Uint8Array(500).fill(0x47));
        return { bytes: 500, totalSec: o.durationSec + o.tailSec };
      }
      throw new Error("boom");
    }) as never;
    await expect(buildReelOnce({
      dir, fetchMemes: async () => [], downloadImage: async () => false, compose,
    })).rejects.toThrow();
    expect(JSON.parse(await Bun.file(join(dir, "manifest.json")).text()).builtAt).toBe(1);
    expect(await Bun.file(join(dir, "1080p25.ts")).text()).toBe("SENTINEL");
  });

  test("localDir set with images: used outright, meme fetch skipped entirely (spec: curated escape hatch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slateb-"));
    const localDir = mkdtempSync(join(tmpdir(), "slatelocal-"));
    writeFileSync(join(localDir, "a.png"), new Uint8Array([1]));
    const fetchMemes = mock(async () => [{ url: "https://i.redd.it/a.png", nsfw: false, spoiler: false, title: "", subreddit: "" }]);
    await setSetting("slate.localDir", localDir);
    try {
      const r = await buildReelOnce({
        dir,
        fetchMemes,
        downloadImage: async (_u, dest) => { writeFileSync(dest, new Uint8Array([1])); return true; },
        compose: okCompose as never,
      });
      expect(r.source).toBe("localDir");
      expect(fetchMemes).not.toHaveBeenCalled();
    } finally {
      await deleteSetting("slate.localDir"); // restore the default ("") for other suites sharing this test DB
    }
  });
});
