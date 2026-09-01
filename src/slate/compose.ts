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
  // shadowcolor=black@0.0 is an invisible no-op — it exists only to make the
  // option count preceding `text=` ODD. Verified in this image's ffmpeg
  // (6.0.1-Jellyfin): drawtext's option parser mis-splits a `text` value that
  // contains escaped colons (our %{eif\:...\:d} countdown expr) whenever an
  // EVEN number of key=value options precede it, throwing the nonsensical
  // "Both text and text file provided" error. Odd count avoids it entirely.
  const common = `fontfile=${FONT}:fontcolor=white:fontsize=${fontsize}:x=(w-text_w)/2:y=h-text_h-${Math.round(o.height / 14)}:${box}:shadowcolor=black@0.0`;
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
