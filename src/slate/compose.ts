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
  // shadowcolor=black@0.0 is an invisible no-op — it exists only to dodge a
  // drawtext parser bug reproduced on two ffmpeg builds (6.0.1-Jellyfin and
  // 6.1.1) with THIS exact filter string: a `text=` value holding our escaped
  // countdown expr (%{eif\:...\:d}, three escaped colons, no comma) mis-parses
  // as "Both text and text file provided" depending on the count of preceding
  // key=value options in the SAME drawtext instance. Empirically, odd counts
  // pass and even counts fail for this specific option list + text expression
  // — that is NOT a general content-independent parity rule, just what was
  // verified for what's built here. If the option list above or the text
  // expression changes, re-verify against tests/slatecompose.test.ts before
  // assuming this still holds.
  const common = `fontfile=${FONT}:fontcolor=white:fontsize=${fontsize}:x=(w-text_w)/2:y=h-text_h-${Math.round(o.height / 14)}:${box}:shadowcolor=black@0.0`;
  const banner =
    `[vc]drawtext=${common}:text=Adding a buffer... %{eif\\:max(0\\,${o.durationSec}-t)\\:d}s:enable='lt(t,${o.durationSec})',` +
    `drawtext=${common}:text=any second now...:enable='gte(t,${o.durationSec})'[vout]`;
  args.push("-filter_complex", `${chains.join(";")};${concat};${banner}`);

  args.push(
    "-map", "[vout]", "-map", `${inputs}:a`,
    "-c:v", enc, ...(enc === "h264_nvenc" ? ["-preset", "p4"] : ["-preset", "veryfast"]),
    "-g", String(o.fps), "-bf", "0", // 1s closed GOP, no B-frames: splice-friendly
    // Pin the video to a fixed rate rather than letting VBR pick per-scene
    // bitrate. Without this, bytes only APPROXIMATE time, so a byte offset
    // computed from a time fraction (see slate/builder.ts's tail-scan) lands
    // at the wrong wall-clock position — sometimes badly wrong on flat
    // (low-motion) source images that VBR would otherwise starve. CBR-ish
    // output makes bytes≈time honest for that computation, and -muxrate
    // below pads the container to a constant rate so PACING (SlateFeeder's
    // own real-time playout) stays correct too — that padding is the point,
    // not a side effect to work around.
    "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "2500k",
    "-c:a", "aac", "-b:a", "96k",
    "-muxrate", "3500k",
    "-t", String(totalSec), "-f", "mpegts", o.out,
  );

  const proc = Bun.spawn(["ffmpeg", ...args], { stderr: "pipe" });
  // SIGTERM first; a wedged ffmpeg that ignores it would otherwise hang
  // `await proc.exited` indefinitely past the 120s budget. Escalate to
  // SIGKILL 5s later if it hasn't exited by then.
  const termTimer = setTimeout(() => proc.kill(), 120_000);
  const killTimer = setTimeout(() => proc.kill("SIGKILL"), 125_000);
  const code = await proc.exited;
  clearTimeout(termTimer);
  clearTimeout(killTimer);
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`);
  }
  return { bytes: statSync(o.out).size, totalSec };
}
