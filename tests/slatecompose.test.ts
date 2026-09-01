import { describe, expect, test } from "bun:test";
import { composeReel } from "../src/slate/compose.ts";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A tiny valid 1x1 PNG for image-input coverage.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("composeReel", () => {
  test("plain slate (no images): produces a playable-sized TS of the right duration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slate-"));
    const out = join(dir, "reel.ts");
    const r = await composeReel({
      images: [], out, width: 320, height: 180, fps: 25,
      durationSec: 4, tailSec: 2, encoder: "libx264",
    });
    expect(r.totalSec).toBe(6);
    expect(r.bytes).toBeGreaterThan(50_000); // real video, not a stub
    expect(statSync(out).size).toBe(r.bytes);
    // TS sync byte at packet 0 — it is actually MPEG-TS.
    const fd = await Bun.file(out).arrayBuffer();
    expect(new Uint8Array(fd)[0]).toBe(0x47);
  }, 120_000);

  test("with images: same contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slate-"));
    const img = join(dir, "m.png");
    writeFileSync(img, PNG_1x1);
    const out = join(dir, "reel.ts");
    const r = await composeReel({
      images: [img, img], out, width: 320, height: 180, fps: 25,
      durationSec: 4, tailSec: 2, encoder: "libx264",
    });
    expect(r.totalSec).toBe(6);
    expect(r.bytes).toBeGreaterThan(50_000);
  }, 120_000);

  test("ffmpeg failure throws (bad image path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slate-"));
    await expect(composeReel({
      images: [join(dir, "missing.png")], out: join(dir, "reel.ts"),
      width: 320, height: 180, fps: 25, durationSec: 4, tailSec: 2, encoder: "libx264",
    })).rejects.toThrow();
  }, 60_000);
});
