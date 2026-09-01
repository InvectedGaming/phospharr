import { describe, expect, test } from "bun:test";
import { buildReelOnce } from "../src/slate/builder.ts";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(man.families["720p30"].tailStartFrac).toBeCloseTo(20 / 26, 2);
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
});
