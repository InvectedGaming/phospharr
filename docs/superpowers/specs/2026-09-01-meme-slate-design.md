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

## Meme source: Meme_Api (meme-api.com, D3vd/Meme_Api)

Chosen by the user over API League after review — it is better on every axis:

- Endpoint: `https://meme-api.com/gimme/{count}` (count ≤ 50) — **no API key**
- Optional `/gimme/{subreddit}/{count}` — the meme pool is user-curatable by
  subreddit (defaults scrape r/memes, r/dankmemes, r/me_irl)
- Response per meme: `{ postLink, subreddit, title, url, nsfw, spoiler, author,
  ups, preview[] }` — **`nsfw` and `spoiler` booleans exist and are filtered on**
- One request fetches a whole reel (`/gimme/8`, over-fetch then filter)
- **Verified live from the phospharr container 2026-09-01**: `/gimme/3` returned
  3 memes, all `nsfw=false`, direct i.redd.it image URLs.

### Decisions

1. **Content filter.** Drop any meme with `nsfw=true` or `spoiler=true`;
   over-fetch (request 8, keep first 5 clean) so filtering can't starve the reel.
   `slate.subreddits` (default empty = API default pool) lets the user pin the
   pool to e.g. `wholesomememes` for stricter curation. `slate.localDir` remains
   the fully-curated escape hatch. Residual risk: `nsfw` is Reddit's own
   flagging — imperfect, accepted knowingly.
2. **Quota discipline.** No documented rate limit and no key, but the same rules
   stand: reel builds in the BACKGROUND on a cadence (1 request per rebuild,
   4/day at defaults), never on the tune path. Any API failure ⇒ keep the
   previous reel; none ever built ⇒ plain slate. **The meme API being down must
   never affect tuning.** Use the `preview[]` mid-quality URL when present
   (smaller download than full-res `url`); cap image downloads at 5MB each.

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
small). Steps: one `/gimme/8` request, drop `nsfw`/`spoiler`/`.gif` entries, keep
5 (fewer is fine — reel just gets shorter segments), download images (size-capped
at 5MB, content-type checked, i.redd.it/preview hosts only), compose with ffmpeg:

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
| `slate.subreddits` | `[]` | pin the meme pool (e.g. `["wholesomememes"]`); empty = API default |
| `slate.durationSec` | `20` | countdown length |
| `slate.refreshHours` | `6` | reel rebuild cadence |
| `slate.memesPerReel` | `5` | |
| `slate.localDir` | `""` | optional curated image folder; used when set or when API fails |

### 4. What can go wrong, and the design's answer

| risk | answer |
| --- | --- |
| Roku/Emby glitches at splice (codec param change) | closed-GOP slate matched to family params; discontinuity flag; **Milestone 1 measures this on the real TV before anything ships** |
| meme API down / slow | background-only fetch; stale reel or plain slate; never on tune path |
| NSFW meme on the family TV | `nsfw`/`spoiler` flags filtered; `slate.subreddits` pinning; `slate.localDir` escape hatch; residual risk = Reddit's own flagging accuracy |
| countdown lies (live ready at 8s, or not at 20s) | early splice just cuts the reel; late = loopable "any second now…" tail |
| reel encode fails (NVENC busy) | keep previous reel; builder retries next cadence; log once |
| disk | reels are ~5–10MB total, on /data (sda1) |

## Out of scope (v1)

- GIF/video memes (static images only; `.gif` URLs are dropped at fetch)
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
