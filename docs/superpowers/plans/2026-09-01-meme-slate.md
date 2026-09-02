# Meme Slate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a cold channel tune, instantly serve a pre-built ~20s meme reel with a countdown banner, splicing the live feed in at its first keyframe.

**Architecture:** A background builder fetches memes (meme-api.com), composes a paced single-program TS reel with ffmpeg (countdown banner via drawtext), and caches it per parameter family. On cold viewer attach, the muxer's `ChannelMux` pumps reel bytes at real-time pace; when the live upstream's first keyframe lands in `TsPreroll`, the slate stops and `preroll()` is pushed — the exact keyframe-alignment mechanics the failover path already uses (which does NO discontinuity flagging or PTS rewriting; production Emby tolerates raw source switches daily).

**Tech Stack:** TypeScript, Bun (`bun test`), ffmpeg (drawtext + h264_nvenc with libx264 fallback), MPEG-TS.

**Spec:** `docs/superpowers/specs/2026-09-01-meme-slate-design.md`

## Global Constraints

- **The meme API must never affect the tune path.** All fetching/composition happens in a background job; tune-time reads come only from the local reel cache.
- **Slate only on channels whose probed `streams.codec === "h264"`.** A slate→live codec change is the one thing failover never exercises. (Lineup: 5,902 h264, 1,063 hevc, 2,161 unprobed — unprobed channels get today's behavior.)
- **`features.slate` defaults `false`.** Zero behavior change until enabled.
- Tests run WITHOUT a GPU: `docker run --rm -e TZ=UTC -v "$PWD":/app -w /app --entrypoint bun phospharr-phospharr test <file>`. Any test that encodes must pass `encoder: "libx264"`; production uses `h264_nvenc` with automatic libx264 fallback (precedent: the tile-nvenc-fallback branch).
- Fontfile must be explicit in drawtext: `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf` (verified present; fontconfig alone fails in this image).
- Pure units take injected collaborators (fetch, clock/tick, push) — no `Date.now()`/`fetch` hard-wired where a test needs control.
- Test imports: `import { describe, expect, test } from "bun:test";`, source with explicit `.ts`.
- Reel cache lives at `/data/slate/` (persistent bind). Writes are atomic (tmp + rename).
- Follow existing comment style; the muxer edit especially must read like the surrounding code.

---

### Task 1: Reel composer (`src/slate/compose.ts`)

**Files:**
- Create: `src/slate/compose.ts`
- Test: `tests/slatecompose.test.ts`

**Interfaces:**
- Produces: `interface ComposeOpts { images: string[]; out: string; width: number; height: number; fps: number; durationSec: number; tailSec: number; encoder?: "h264_nvenc" | "libx264"; }` and `composeReel(o: ComposeOpts): Promise<{ bytes: number; totalSec: number }>` — throws on ffmpeg failure; caller owns fallback/atomicity.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -e TZ=UTC -v "$PWD":/app -w /app --entrypoint bun phospharr-phospharr test tests/slatecompose.test.ts`
Expected: FAIL — cannot resolve `../src/slate/compose.ts`

- [ ] **Step 3: Write minimal implementation**

```ts
import { statSync } from "node:fs";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const BG = "0x101418";

export interface ComposeOpts {
  images: string[]; // local files; empty = plain slate (color background)
  out: string;
  width: number; height: number; fps: number;
  durationSec: number; // countdown length
  tailSec: number;     // "any second now…" hold segment (the loop point)
  encoder?: "h264_nvenc" | "libx264";
}

/**
 * Compose the buffering reel: N images (durationSec split evenly) plus a tail
 * segment, banner with a live countdown that floors into "any second now…".
 * Single-program TS, 1s closed GOP so a splice-out point is always near.
 * Encoder failures throw — the BUILDER owns nvenc→libx264 fallback and
 * atomic placement; this stays a dumb one-shot.
 */
export async function composeReel(o: ComposeOpts): Promise<{ bytes: number; totalSec: number }> {
  const totalSec = o.durationSec + o.tailSec;
  const enc = o.encoder ?? "h264_nvenc";
  const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];

  const n = o.images.length;
  if (n > 0) {
    const seg = o.durationSec / n;
    for (const img of o.images) args.push("-loop", "1", "-t", String(seg), "-i", img);
    // Tail reuses the last image so the loop point is visually stable.
    args.push("-loop", "1", "-t", String(o.tailSec), "-i", o.images[n - 1]);
  } else {
    args.push("-f", "lavfi", "-t", String(totalSec), "-i", `color=c=${BG}:s=${o.width}x${o.height}:r=${o.fps}`);
  }
  args.push("-f", "lavfi", "-t", String(totalSec), "-i", "anullsrc=r=48000:cl=stereo");

  // Scale/pad each visual input, concat, then draw the banner over the WHOLE
  // timeline so the countdown expression sees continuous t.
  const inputs = Math.max(n > 0 ? n + 1 : 1, 1);
  const fit = `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,` +
    `pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=${BG},setsar=1,fps=${o.fps},format=yuv420p`;
  const chains: string[] = [];
  for (let i = 0; i < inputs; i++) chains.push(`[${i}:v]${fit}[v${i}]`);
  const concat = inputs > 1
    ? `${Array.from({ length: inputs }, (_, i) => `[v${i}]`).join("")}concat=n=${inputs}:v=1:a=0[vc]`
    : `[v0]null[vc]`;
  const fontsize = Math.max(16, Math.round(o.height / 15));
  const box = `box=1:boxcolor=black@0.55:boxborderw=${Math.round(fontsize / 2)}`;
  const common = `fontfile=${FONT}:fontcolor=white:fontsize=${fontsize}:x=(w-text_w)/2:y=h-text_h-${Math.round(o.height / 14)}:${box}`;
  const banner =
    `[vc]drawtext=${common}:text=Adding a buffer... %{eif\\:max(0\\,${o.durationSec}-t)\\:d}s:enable='lt(t,${o.durationSec})',` +
    `drawtext=${common}:text=any second now...:enable='gte(t,${o.durationSec})'[vout]`;
  args.push("-filter_complex", `${chains.join(";")};${concat};${banner}`);

  args.push(
    "-map", "[vout]", "-map", `${inputs}:a`,
    "-c:v", enc, ...(enc === "h264_nvenc" ? ["-preset", "p4"] : ["-preset", "veryfast"]),
    "-g", String(o.fps), "-bf", "0", // 1s closed GOP, no B-frames: splice-friendly
    "-c:a", "aac", "-b:a", "96k",
    "-t", String(totalSec), "-f", "mpegts", o.out,
  );

  const proc = Bun.spawn(["ffmpeg", ...args], { stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 120_000);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`);
  }
  return { bytes: statSync(o.out).size, totalSec };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker run --rm -e TZ=UTC -v "$PWD":/app -w /app --entrypoint bun phospharr-phospharr test tests/slatecompose.test.ts`
Expected: PASS (3 tests). If drawtext escaping fails, fix the filter string — do NOT weaken the assertions.

- [ ] **Step 5: Commit**

```bash
git add src/slate/compose.ts tests/slatecompose.test.ts
git commit -m "feat(slate): reel composer — images + countdown banner to spliceable TS"
```

---

### Task 2: Settings keys

**Files:**
- Modify: `src/settings.ts` (Settings interface, DEFAULTS, ENV_MAP — append after the priority.* block, matching its style)
- Test: `tests/slatesettings.test.ts`

**Interfaces:**
- Produces settings keys readable via existing `getSetting(key)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { getSetting } from "../src/settings.ts";

describe("slate settings", () => {
  test("ships disabled with the spec's defaults", async () => {
    expect(await getSetting("features.slate")).toBe(false);
    expect(await getSetting("slate.durationSec")).toBe(20);
    expect(await getSetting("slate.tailSec")).toBe(6);
    expect(await getSetting("slate.refreshHours")).toBe(6);
    expect(await getSetting("slate.memesPerReel")).toBe(5);
    expect(await getSetting("slate.subreddits")).toEqual([]);
    expect(await getSetting("slate.localDir")).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails** (unknown keys). Then add to `Settings`:

```ts
  "features.slate": boolean; // meme/countdown buffering reel on cold channel tunes
  "slate.durationSec": number; // countdown length baked into the reel
  "slate.tailSec": number; // loopable "any second now…" hold segment
  "slate.refreshHours": number; // reel rebuild cadence
  "slate.memesPerReel": number;
  "slate.subreddits": string[]; // pin the meme pool (e.g. ["wholesomememes"]); empty = API default
  "slate.localDir": string; // curated image folder; used when set or when the API fails
```

`DEFAULTS`: `false, 20, 6, 6, 5, [], ""`. `ENV_MAP`: only `"features.slate": "PHOSPHARR_SLATE"` and `"slate.refreshHours": "PHOSPHARR_SLATE_REFRESH_HOURS"` — the rest stay UI-editable (an env var shows a setting as locked).

- [ ] **Step 3: Run to verify pass, commit**

```bash
git add src/settings.ts tests/slatesettings.test.ts
git commit -m "feat(slate): settings keys, shipped disabled"
```

---

### Task 3: Meme source (`src/slate/memes.ts`)

**Files:**
- Create: `src/slate/memes.ts`
- Test: `tests/slatememes.test.ts`

**Interfaces:**
- Produces: `interface Meme { url: string; nsfw: boolean; spoiler: boolean; title: string; subreddit: string }`, `pickClean(memes: Meme[], want: number): Meme[]`, `fetchMemes(count: number, subreddits: string[], f?: typeof fetch): Promise<Meme[]>`, `downloadImage(url: string, dest: string, maxBytes: number, f?: typeof fetch): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { pickClean, fetchMemes, downloadImage } from "../src/slate/memes.ts";

const m = (o: Partial<ReturnType<typeof Object>> & { url: string }) =>
  ({ nsfw: false, spoiler: false, title: "t", subreddit: "memes", ...o }) as never;

describe("pickClean", () => {
  test("drops nsfw, spoiler, gifs, and off-host urls; dedupes; caps at want", () => {
    const out = pickClean([
      m({ url: "https://i.redd.it/a.png" }),
      m({ url: "https://i.redd.it/b.jpg", nsfw: true }),
      m({ url: "https://i.redd.it/c.jpg", spoiler: true }),
      m({ url: "https://i.redd.it/d.gif" }),
      m({ url: "https://evil.example.com/e.png" }),
      m({ url: "https://i.redd.it/a.png" }), // dupe
      m({ url: "https://preview.redd.it/f.jpeg" }),
      m({ url: "https://i.redd.it/g.png" }),
    ], 2);
    expect(out.map((x) => x.url)).toEqual(["https://i.redd.it/a.png", "https://preview.redd.it/f.jpeg"]);
  });
  test("fewer clean than want is fine", () => {
    expect(pickClean([m({ url: "https://i.redd.it/a.png" })], 5)).toHaveLength(1);
  });
});

describe("fetchMemes", () => {
  test("hits /gimme/{count} and unwraps the memes array", async () => {
    let hit = "";
    const fake = (async (u: RequestInfo) => {
      hit = String(u);
      return new Response(JSON.stringify({ count: 1, memes: [m({ url: "https://i.redd.it/a.png" })] }));
    }) as typeof fetch;
    const out = await fetchMemes(8, [], fake);
    expect(hit).toBe("https://meme-api.com/gimme/8");
    expect(out).toHaveLength(1);
  });
  test("subreddit pinning changes the path", async () => {
    let hit = "";
    const fake = (async (u: RequestInfo) => { hit = String(u); return new Response(JSON.stringify({ memes: [] })); }) as typeof fetch;
    await fetchMemes(8, ["wholesomememes"], fake);
    expect(hit).toBe("https://meme-api.com/gimme/wholesomememes/8");
  });
  test("API failure returns [], never throws", async () => {
    const fake = (async () => { throw new Error("down"); }) as typeof fetch;
    expect(await fetchMemes(8, [], fake)).toEqual([]);
  });
});

describe("downloadImage", () => {
  test("rejects non-image content-type and oversize bodies", async () => {
    const html = (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    expect(await downloadImage("https://i.redd.it/a.png", "/tmp/x1", 1000, html)).toBe(false);
    const big = (async () => new Response(new Uint8Array(2048), { headers: { "content-type": "image/png" } })) as typeof fetch;
    expect(await downloadImage("https://i.redd.it/a.png", "/tmp/x2", 1000, big)).toBe(false);
  });
  test("writes a good image and returns true", async () => {
    const ok = (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })) as typeof fetch;
    expect(await downloadImage("https://i.redd.it/a.png", "/tmp/slate-dl-test.png", 1000, ok)).toBe(true);
    expect((await Bun.file("/tmp/slate-dl-test.png").arrayBuffer()).byteLength).toBe(3);
  });
});
```

- [ ] **Step 2: fail → Step 3: implement**

```ts
/**
 * Meme source: meme-api.com (D3vd/Meme_Api). No key. One request per reel.
 * Everything here is BACKGROUND-only — the tune path never touches the network.
 */
export interface Meme { url: string; nsfw: boolean; spoiler: boolean; title: string; subreddit: string }

const HOSTS = new Set(["i.redd.it", "preview.redd.it"]);

/** Filter to family-TV-safe(ish), static, on-host, deduped images. */
export function pickClean(memes: Meme[], want: number): Meme[] {
  const seen = new Set<string>();
  const out: Meme[] = [];
  for (const m of memes) {
    if (m.nsfw || m.spoiler) continue; // Reddit's own flagging — imperfect, accepted in the spec
    if (!m.url || m.url.toLowerCase().endsWith(".gif")) continue;
    let host = "";
    try { host = new URL(m.url).hostname; } catch { continue; }
    if (!HOSTS.has(host)) continue;
    if (seen.has(m.url)) continue;
    seen.add(m.url);
    out.push(m);
    if (out.length >= want) break;
  }
  return out;
}

export async function fetchMemes(count: number, subreddits: string[], f: typeof fetch = fetch): Promise<Meme[]> {
  const sub = subreddits[0] ? `${encodeURIComponent(subreddits[0])}/` : "";
  try {
    const r = await f(`https://meme-api.com/gimme/${sub}${count}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return [];
    const d = (await r.json()) as { memes?: Meme[] } & Meme;
    return d.memes ?? (d.url ? [d] : []);
  } catch {
    return []; // builder falls back to localDir / previous reel / plain slate
  }
}

export async function downloadImage(url: string, dest: string, maxBytes: number, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return false;
    if (!(r.headers.get("content-type") ?? "").startsWith("image/")) return false;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > maxBytes) return false;
    await Bun.write(dest, buf);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: pass → Step 5: commit** `feat(slate): meme source with nsfw/host/size gates`

---

### Task 4: Reel cache + builder (`src/slate/cache.ts`, `src/slate/builder.ts`)

**Files:**
- Create: `src/slate/cache.ts`, `src/slate/builder.ts`
- Test: `tests/slatebuilder.test.ts`

**Interfaces:**
- `cache.ts` produces: `interface ReelManifest { builtAt: number; families: Record<string, { file: string; bytes: number; totalSec: number; tailStartFrac: number }> }`, `FAMILIES = [{ key: "1080p25", width: 1920, height: 1080, fps: 25 }, { key: "720p30", width: 1280, height: 720, fps: 30 }]`, `familyFor(resolution: number | null): string` (≥1080 → 1080p25 else 720p30), `loadReel(family: string): Promise<{ data: Uint8Array; totalSec: number; tailStartFrac: number } | null>`, `saveManifest/readManifest`, `SLATE_DIR = "/data/slate"`.
- `builder.ts` produces: `buildReelOnce(deps): Promise<{ source: "memes" | "localDir" | "plain" }>` (deps: `{ fetchMemes, downloadImage, compose, dir }` all injectable) and `startSlateBuilder(): void` (arm/tick pattern copied from `src/content/priorityscheduler.ts` — settings re-read each tick, NO unconditional heavy boot work; one small delayed build ~60s after boot ONLY if no manifest exists yet).

Key behaviors (encode in tests): fallback chain memes → `slate.localDir` images → plain; compose failures with `h264_nvenc` retry once with `libx264`; atomic placement (`.tmp` then rename); `tailStartFrac = durationSec / totalSec` recorded in the manifest (the feeder loops from this fraction of the file — byte-level approximation is fine, GOP is 1s).

- [ ] **Step 1: failing test** — drive `buildReelOnce` with injected deps:

```ts
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
```

- [ ] **Steps 2–4: fail → implement → pass.** Implementation notes beyond the obvious: `buildReelOnce` reads `slate.durationSec/tailSec/memesPerReel/subreddits/localDir` via `getSetting`; over-fetches `memesPerReel + 3` and `pickClean`s; downloads to a temp dir inside `dir`; composes EVERY family with the SAME images; nvenc→libx264 retry lives here (wrap the injected compose: call with `h264_nvenc` first — in tests the injected compose ignores encoder, which is fine); writes each family to `<family>.ts.tmp` then renames, manifest last. `startSlateBuilder` mirrors `startPriorityScheduler` exactly (timer-armed tick, settings re-read, try/catch/finally arm, `unref`) and gates on `features.slate`; the build itself does NOT need `withBigJob` (seconds of work, tiny output) — note that in a comment.
- [ ] **Step 5: commit** `feat(slate): reel builder with memes→localDir→plain fallback and atomic cache`

---

### Task 5: Slate feeder (`src/slate/feeder.ts`)

**Files:**
- Create: `src/slate/feeder.ts`
- Test: `tests/slatefeeder.test.ts`

**Interfaces:**
- Produces: `class SlateFeeder { constructor(o: { data: Uint8Array; totalSec: number; tailStartFrac: number; tickMs?: number; push: (c: Uint8Array) => void }); start(): void; stop(): void }` — paces `data` at real time (`bytesPerTick = data.length / totalSec * tickMs/1000`, sliced to 188-byte TS packet boundaries), and on reaching the end loops from `floor(data.length * tailStartFrac / 188) * 188`.

- [ ] **Step 1: failing test**

```ts
import { describe, expect, test } from "bun:test";
import { SlateFeeder } from "../src/slate/feeder.ts";

const reel = (packets: number) => {
  const d = new Uint8Array(packets * 188);
  for (let i = 0; i < packets; i++) d[i * 188] = 0x47;
  return d;
};

describe("SlateFeeder", () => {
  test("pushes packet-aligned chunks at a real-time pace", async () => {
    const chunks: Uint8Array[] = [];
    // 100 packets over 1s, ticking every 50ms → ~5 packets per tick.
    const f = new SlateFeeder({ data: reel(100), totalSec: 1, tailStartFrac: 0.5, tickMs: 50, push: (c) => chunks.push(c) });
    f.start();
    await new Promise((r) => setTimeout(r, 320));
    f.stop();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total % 188).toBe(0);
    expect(total).toBeGreaterThan(188 * 15); // ~30 expected; generous lower bound
    expect(total).toBeLessThan(188 * 60);    // and it must NOT dump the whole reel
    for (const c of chunks) expect(c[0]).toBe(0x47);
  });

  test("loops from the tail fraction instead of stopping", async () => {
    const chunks: Uint8Array[] = [];
    const f = new SlateFeeder({ data: reel(10), totalSec: 0.1, tailStartFrac: 0.5, tickMs: 20, push: (c) => chunks.push(c) });
    f.start();
    await new Promise((r) => setTimeout(r, 300));
    f.stop();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeGreaterThan(10 * 188); // wrapped at least once
  });

  test("stop() stops; push after stop never happens", async () => {
    let n = 0;
    const f = new SlateFeeder({ data: reel(100), totalSec: 1, tailStartFrac: 0.5, tickMs: 20, push: () => n++ });
    f.start(); await new Promise((r) => setTimeout(r, 60)); f.stop();
    const at = n;
    await new Promise((r) => setTimeout(r, 80));
    expect(n).toBe(at);
  });
});
```

- [ ] **Steps 2–4: fail → implement → pass.** Implementation: `setInterval(tickMs, unref)`; per tick compute target position from elapsed real time (not per-tick increments — drift-free), slice `[pos, target)` aligned down to 188, push if non-empty; on `pos >= data.length` set `pos = tailStart` and reset the pacing epoch so the tail replays at real time.
- [ ] **Step 5: commit** `feat(slate): real-time paced reel feeder with loopable tail`

---

### Task 6: Muxer integration

**Files:**
- Modify: `src/proxy/muxer.ts` (ChannelMux: slate start on cold attach, splice in `fanout`, cleanup in teardown paths)
- Create: `src/slate/gate.ts` (the tiny decision helper, so the splice rule is unit-tested)
- Test: `tests/slategate.test.ts`

**Interfaces:**
- `gate.ts` produces: `slateEligible(o: { enabled: boolean; codec: string | null; reel: boolean; preroll: Uint8Array | null }): boolean` — true only when the feature is on, `codec === "h264"`, a reel is cached, and the mux has NO preroll yet (cold).

- [ ] **Step 1: failing test**

```ts
import { describe, expect, test } from "bun:test";
import { slateEligible } from "../src/slate/gate.ts";

const base = { enabled: true, codec: "h264", reel: true, preroll: null };
describe("slateEligible", () => {
  test("cold h264 channel with a reel and the flag on", () => {
    expect(slateEligible(base)).toBe(true);
  });
  test("every other combination declines", () => {
    expect(slateEligible({ ...base, enabled: false })).toBe(false);
    expect(slateEligible({ ...base, codec: "hevc" })).toBe(false);
    expect(slateEligible({ ...base, codec: null })).toBe(false); // unprobed: unknown risk, skip
    expect(slateEligible({ ...base, reel: false })).toBe(false);
    expect(slateEligible({ ...base, preroll: new Uint8Array(188) })).toBe(false); // warm: TsPreroll already handles it
  });
});
```

- [ ] **Step 2: fail → Step 3: implement.** `gate.ts` is four `&&`s with the doc comment explaining each. Then the muxer edit, kept minimal and in the file's own voice:

In `ChannelMux` add fields `private slate: SlateFeeder | null = null;` and import `SlateFeeder`, `loadReel`, `familyFor`, `slateEligible`, `getSetting`.

In `attach()`, after the existing preroll replay block:

```ts
    // Cold channel + slate enabled: show the buffering reel instantly instead of
    // a silent open socket. The reel stops the moment the upstream's first
    // keyframe lands in the preroll buffer (see fanout) — same keyframe-boundary
    // switch a failover does, and failover does no timestamp surgery either.
    if (sendPreroll && !this.slate && this.pre.preroll() == null) void this.maybeStartSlate();
```

New private method:

```ts
  private async maybeStartSlate(): Promise<void> {
    if (this.slate || this.stopping) return;
    const enabled = Boolean(await getSetting("features.slate"));
    if (!slateEligible({ enabled, codec: this.stream.codec ?? null, reel: true, preroll: this.pre.preroll() })) return;
    const reel = await loadReel(familyFor(this.stream.resolution ?? null));
    if (!reel || this.slate || this.stopping || this.pre.preroll() != null) return; // live won the race
    this.slate = new SlateFeeder({
      ...reel,
      push: (chunk) => { for (const sub of this.subs.values()) { try { sub.push(chunk); } catch { this.detach(sub.id); } } },
    });
    this.slate.start();
    console.log(`[slate] channel ${this.channelId}: reel up while dialing source ${this.stream.id}`);
  }
```

In `fanout()`, before the normal push loop:

```ts
    if (this.slate) {
      // Hold live bytes back until a decodable start exists, then hand every
      // viewer [preroll GOP] and fall through to live — the region just pushed
      // into `pre` is contained in that preroll, so nothing is lost or doubled.
      const pre = this.pre.preroll();
      if (!pre) return;
      this.slate.stop(); this.slate = null;
      console.log(`[slate] channel ${this.channelId}: live keyframe — splicing`);
      for (const sub of this.subs.values()) { try { sub.push(pre); } catch { this.detach(sub.id); } }
      return;
    }
```

In `stop()` and the no-alternates teardown path: `this.slate?.stop(); this.slate = null;` (find every place the mux dies; a feeder ticking after teardown is a leak).

**Check `stream.codec`/`stream.resolution` actually exist on the muxer's `Stream` type** (they are columns in `streams`); if the type omits them, extend the select that builds it rather than casting.

- [ ] **Step 4: run `tests/slategate.test.ts` AND the full suite** (muxer is shared, live-TV-critical):
`docker run --rm -e TZ=UTC -v "$PWD":/app -w /app --entrypoint bun phospharr-phospharr test`
Expected: all pass.
- [ ] **Step 5: commit** `feat(slate): serve the reel on cold attach, splice at first live keyframe`

---

### Task 7: Wire the builder + settings UI

**Files:**
- Modify: `src/index.ts` (add `startSlateBuilder()` beside `startPriorityScheduler()`)
- Modify: `public/app.js` (a "Buffering slate" section next to LIVE PRIORITY BAND: toggle `features.slate`; numbers `slate.durationSec`, `slate.refreshHours`, `slate.memesPerReel`; text `slate.localDir`; text for `slate.subreddits` as comma-separated, split/trimmed on save)
- Test: full suite (UI has no harness; `src/index.ts` change is a wiring line)

- [ ] Steps: edit, run full suite, verify `public/app.js` parses (`bun -e 'await import("/app/public/app.js")' || true` — browser-global errors fine, syntax errors not), commit `feat(slate): builder wiring and settings UI`.

---

### Task 8: MILESTONE — splice proof on the real TV (STOP-AND-ASK GATE)

This is the spec's gate: the one untested risk is whether Emby's ffmpeg → the Roku
survives the slate→live switch. Everything is behind `features.slate=false`, so
deploying is inert until the user flips it.

- [ ] Rebuild + deploy phospharr (`docker compose build phospharr && docker compose up -d phospharr` in `/mnt/networked/docker/arrg/phospharr`) — confirm healthy, GPU probe OK, no viewers interrupted.
- [ ] Trigger one reel build and confirm `/data/slate/manifest.json` + both `.ts` files exist and play (`ffprobe` them inside the container).
- [ ] **STOP. Ask the user to:** enable "Buffering slate" in settings, pick a cold h264 channel (not recently watched), tune it on the Roku, and report: did memes+countdown appear within ~3s, and did live video take over cleanly (a one-frame glitch is a pass; a frozen/black screen or player error is a fail)?
- [ ] Record the verdict in the ledger. **Fail ⇒ stop building; the fallback direction is HLS-level insertion in Emby, not more TS surgery** (spec Milestone 1).

## Self-review notes

- Spec coverage: composer w/ countdown+tail (T1), settings (T2, T7), meme source w/ nsfw+host+size gates (T3), background builder + fallback chain + atomic cache (T4), paced feeder + tail loop (T5), cold-attach serve + keyframe splice + h264-only gate (T6), boot wiring + UI (T7), real-TV gate (T8). Out-of-scope items from the spec have no tasks, as intended.
- The spec's "discontinuity indicator" line is superseded by reading the code: failover sets no flags and rewrites nothing; the plan mirrors failover exactly (ledger this as a ruling at execution).
- Type consistency: `SlateFeeder`'s constructor shape matches `loadReel`'s return (`data/totalSec/tailStartFrac`) plus `push`/`tickMs`; `familyFor` takes `resolution: number | null`; `slateEligible` takes the four booleans/values named in both T6 call sites.
