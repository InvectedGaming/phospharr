# Meme Slate — instant tune with a buffering reel

**Date:** 2026-09-01
**Status:** approved direction, spec for review
**Branch:** `meme-slate`

## Problem

A cold channel tune takes ~15s: the provider delivers its bursty multi-program TS
slowly enough that Emby's stream analyzer sits on an open socket accumulating data
before the TV shows anything. (Warm channels are already instant via `TsPreroll`.)

Instead of a black screen, the user wants: **instant picture — a ~20s reel of random
memes with a banner counting down ("Adding a buffer… 12s") — spliced into the live
feed the moment it is ready.**

## Measured facts this design rests on

- Cold-attach cost is 5–20s (provider dial + burst accumulation); Emby logged
  `Live stream opened after 16816ms` on a real tune.
- The muxer already splices between different provider sources mid-stream in
  production (failover), using TS primitives in `src/proxy/ts.ts`
  (`findAlignment`, `isKeyframe`, PAT/PMT tracking). A slate→live splice is the
  same class of event.
- `TsPreroll` already replays "PAT+PMT+last GOP" so a new viewer starts on a
  decodable keyframe. The slate serves the same purpose for channels with no
  flowing bytes yet.
- phospharr's ffmpeg has `drawtext` + NVENC; a live countdown renders via
  `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:
  text=Adding a buffer... %{eif\:max(0\,20-t)\:d}s` — **verified working in the
  running container** (fontfile must be explicit; fontconfig alone fails).
- `streams` table already stores probed `resolution`/`fps`/`codec` per stream, so
  slate variants can match the channel's parameter family.

## Meme source: API League Random Meme API

- Endpoint: `https://api.apileague.com/retrieve-random-meme`
- Auth: `?api-key=KEY` query param; free key on signup
  (https://apileague.com/docs/authentication/)
- Response: `{ description, url, type (image/jpeg|png|gif), width, height, ratio }`
- Only filter: `max-age-days`. **There is NO safe-for-work/rating filter.**
- Free tier: daily quota; exhaustion returns HTTP 402.

### Two consequences, decided as follows

1. **Content risk.** Random internet memes on the household TV, unfiltered. The
   reel builder is a `SlateSource` interface with the meme API as its first
   implementation, so a curated source (local image folder, or API League's
   keyword-constrained Search Memes API) can replace it without touching the
   pipeline. Ships with the meme API per the user's explicit choice; the local
   folder fallback doubles as the no-key mode.
2. **Quota discipline.** Reel is built in the BACKGROUND on a cadence, never on
   the tune path. Defaults: 5 memes per reel, refreshed every 6h = 20 API
   calls/day. A 402 or any API failure ⇒ keep serving the previous reel; if no
   reel has ever been built ⇒ plain generated slate (no memes, banner only).
   **The meme API being down must never affect tuning.**

## Architecture

```
                     background (cadence: slate.refreshHours)
  meme API ──▶ fetch N images ──▶ ffmpeg compose ──▶ reel cache (per param family)
                                   (scale/pad, 4s each,          /data/slate/
                                    countdown banner, NVENC,
                                    single-program TS, ~20s)

                     tune path (cold attach only)
  viewer attach ──▶ muxer serves reel bytes instantly ──▶ provider dials in parallel
                         │                                        │
                         └── splice at keyframe boundary ◀── first live keyframe
```

### 1. Reel builder — `src/slate/builder.ts`

Background job (NOT under the big-job mutex — output is ~20s of 1–2 Mbps video,
small). Steps: fetch 5 memes (skip `image/gif` v1 — static images only), download
images (size-capped, content-type checked), compose with ffmpeg:

- each image scaled/padded to the family resolution, 4s per image
- banner: semi-transparent bar + `drawtext` countdown from `slate.durationSec`
- after the countdown floors at 0 the last segment's banner reads
  "any second now…" — the reel LOOPS if live isn't ready, and a restarting
  countdown looks broken, so the loop point is the hold-pattern segment, not
  the countdown (reel = countdown body + loopable tail)
- encode h264_nvenc + AAC silence, single-program TS, closed GOP ≤1s so the
  splice-out point is always near
- one variant per parameter family actually present in the lineup's top streams
  (v1: 1080p25 and 720p30 cover the fleet; family lookup from `streams`)

Cache to `/data/slate/<family>.ts` + a small manifest (built-at, meme
descriptions for the log). Atomic replace (write temp, rename).

### 2. Slate serving + splice — muxer integration (`src/proxy/muxer.ts`)

On viewer attach when the channel has no flowing source yet (the cold case —
today the response stays open with zero bytes):

- stream the cached reel's TS packets, pacing to real time (~1× speed, from the
  reel's own PCR cadence), looping the tail segment
- when the upstream produces its first keyframe (exactly what `TsPreroll`
  detects), STOP the reel at the next slate packet boundary and splice the live
  GOP in — same keyframe-boundary mechanics as failover
- PTS/PCR: slate and live have unrelated timelines; the splice sets the TS
  discontinuity indicator, mirroring whatever the failover path already does
  (implementation must read that path first and reuse its approach — this spec
  deliberately does not invent a second discontinuity strategy)
- viewers attaching to an ALREADY-flowing channel are untouched (TsPreroll path)

### 3. Settings

| key | default | |
| --- | --- | --- |
| `features.slate` | `false` | master switch; ships off |
| `slate.apiKey` | `""` | API League key; empty ⇒ local-folder/plain slate mode |
| `slate.durationSec` | `20` | countdown length |
| `slate.refreshHours` | `6` | reel rebuild cadence |
| `slate.memesPerReel` | `5` | |
| `slate.localDir` | `""` | optional curated image folder; used when set or when API fails |

### 4. What can go wrong, and the design's answer

| risk | answer |
| --- | --- |
| Roku/Emby glitches at splice (codec param change) | closed-GOP slate matched to family params; discontinuity flag; **Milestone 1 measures this on the real TV before anything ships** |
| meme API down / 402 / slow | background-only fetch; stale reel or plain slate; never on tune path |
| NSFW meme on the family TV | acknowledged, user's call; `SlateSource` swap + `slate.localDir` escape hatch |
| countdown lies (live ready at 8s, or not at 20s) | early splice just cuts the reel; late = loopable "any second now…" tail |
| reel encode fails (NVENC busy) | keep previous reel; builder retries next cadence; log once |
| disk | reels are ~5–10MB total, on /data (sda1) |

## Out of scope (v1)

- GIF/video memes (static images only)
- Per-channel or per-genre meme theming
- Slate for VOD or the mosaic
- An accurate progress bar (the countdown is cosmetic by design)

## Milestones

1. **Splice proof on the real TV.** Hand-built 10s slate + hardcoded splice on one
   test channel; tune it on the Roku. Gate: no decoder wedge (one-frame glitch
   acceptable). If the Roku won't survive the splice, stop and rethink (HLS-level
   insertion in Emby is the fallback direction, not more TS surgery).
2. Reel builder with plain (no-meme) slate + countdown; cache + atomic swap.
3. Meme source + fallback chain (API → localDir → plain).
4. Muxer integration behind `features.slate`, cold-attach only.
5. Settings UI section.
