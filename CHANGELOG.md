# Changelog

## Unreleased

### Lineup: America first, dial starts at the top
- The guide no longer opens on an alphabetical accident: **foreign broadcast
  brands on US feeds** (Al Jazeera, BBC World News, CGTN, France 24, Sky News,
  …) are classified International (8100s) instead of leading the news block.
  BBC America stays a US network.
- The **News block orders American networks first** — CNN, Fox News,
  MSNBC/MS NOW, ABC/CBS/NBC News, CNBC, Bloomberg, … — then the rest
  alphabetically.
- **Numbering starts at the top of the dial**: live streams (your own added
  channels) now sit at 2–19 right after the Mosaic on 1, News starts at 20
  (was 100), Sports at 300. Run **reflow** (or it's applied on deploy) to
  renumber an existing lineup.

### Fixed
- **Playback broken after deploy ("play button with a line through it")**:
  stream teardown called `body.cancel()` on a reader-locked stream, whose
  rejected promise escaped the bare try/catch — every muxer teardown produced
  an unhandled `ERR_INVALID_STATE`. Latent for months; a newer Bun's stricter
  stream-state checks made it fatal. Fixed at the source (cancel via the
  reader) plus the same pattern in the transcode teardown and tile feeds.
- **Reproducible images**: the Docker image and CI now PIN the Bun version
  (`BUN_VERSION` build arg) instead of installing latest-at-build — an
  unpinned rebuild is what exposed the bug above.

### Mosaic architecture redo: slate-backed tile feeds
- **Per-tile normalizer feeds**: each composed channel gets its own supervised
  ffmpeg that normalizes it to a uniform intermediate; the grid encode reads
  tiles from `/tile/<slot>`, which splices in a pre-rendered **labelled slate**
  (channel name on a dark card) whenever the tile isn't producing — cold dial,
  provider drop, crash backoff. The compositor's inputs always flow from byte
  one: the mosaic **starts instantly** even when every channel is dead, and a
  dead tile is a visible card that **heals in place**.
- **Layout/focus changes no longer re-dial**: only the grid encode restarts
  (~1-2s); tile normalizers keep running (and linger 20s after leaving the
  layout), so flipping focus back and forth is instant.
- **Shared process supervisor** (`supervisor.ts`): serialized restarts,
  crash backoff, output watchdog, stderr ring — one primitive instead of a
  bespoke lifecycle per ffmpeg call-site.
- **Per-tile health** surfaced in `/api/mosaic/status` and as green/amber dots
  in the cast bar (green = live on the cast, amber = slate).
- **Removed the legacy headless-Chrome cast path** (castbrowser, castrender,
  castingest WebSocket, `/mosaic/*.m3u8` HLS, `PHOSPHARR_SERVER_CAST`) and the
  dead in-tab canvas-capture code — the server compositor is the one path.
- New env knobs: `PHOSPHARR_MOSAIC_RES` / `PHOSPHARR_MOSAIC_FPS` (grid output),
  `PHOSPHARR_TILE_RES` / `PHOSPHARR_TILE_ENCODER` (tile intermediates; default
  960x540 libx264-ultrafast, `h264_nvenc` opt-in).

### Mosaic reliability overhaul
- The compositor encode is now **supervised**: an unexpected ffmpeg death closes
  viewer streams (players reconnect instead of hanging on a frozen picture) and
  restarts the encode with crash-loop backoff. A wedged encode (alive, zero
  output for 25s) is watchdog-restarted the same way.
- **Audio-tile switching no longer dies after layout changes**: restarts are
  serialized (the old encode fully exits before the new one spawns) and the azmq
  broker binds a dedicated port, so the volume-flip commands always reach the
  running encode.
- **Dead tiles heal**: `/mosaicfeed` re-dials the channel when an upstream ends
  cleanly (provider drop, mux failover) instead of letting that ffmpeg input EOF
  — each splice restarts at PAT+PMT+keyframe so the decoder resyncs in a GOP.
- A viewer that falls seconds behind live is disconnected (and reconnects at the
  edge) instead of being fed a corrupted stream — the old chunk-dropping
  guaranteed decoder errors and reload spirals.
- The TV page (`/mosaic/tv`) now recovers from *everything*: reloads on stream
  end (server-side restart), and a stall watchdog reloads when the picture
  freezes without an error event.

### Live streams (custom channels)
- Add any live stream as a guide channel: **Manage → Live streams**. Paste a
  Twitch/Kick link, a YouTube live, or a direct `.m3u8`/`.ts`. Each becomes a
  numbered channel (block 2–19, right at the top of the dial) with an editable "what's on now" that shows as a
  red LIVE block in the guide and a LIVE programme in the Emby/XMLTV export.
- Resolved server-side and fed through the same muxer as everything else, so they
  get multiplexing, keep-warm, failover, and the stall watchdog. Twitch/Kick via
  streamlink (H.264 copy); YouTube via yt-dlp + a deno JS runtime with a video
  transcode (YouTube live is VP9); direct HLS via ffmpeg.
- **Reliability note:** Twitch, Kick, and direct URLs are solid. YouTube works
  best-effort — Google actively blocks datacenter IPs, so a self-hosted box on a
  VPS may get "not available"; a home/residential connection fares better.
- Player polish this cycle: fixed first-launch APK crash, mobile rotation zoom,
  fullscreen fit; added Fit/Fill + pinch-zoom; long-session A/V drift fix.

## 1.0.0-rc.3 — 2026-07-04

Everything-app release: on-demand library, more devices, watch parties, and a
security pass.

### Video on demand
- Full movie + series catalogs from Xtream providers (browse, search, category
  filter, paginated); movie/series detail with lazily-fetched plots + episodes;
  in-browser playback via server-side remux (MKV/AVI → MPEG-TS), HEVC auto-falls
  back to a GPU transcode; ±30s/±5m seeking.
- **Resume + Continue Watching**: per-user positions saved during playback,
  auto-resume, a poster row on Home; near-finished items clear themselves.

### More devices (standalone — no media server required)
- **HLS output layer**: iOS/iPadOS Safari now plays live TV natively in the PWA
  (no MSE needed); AirPlay works; Chromecast-ready URLs. One ffmpeg segmenter per
  watched channel, sharing the provider slot.
- **Android app**: sideloadable WebView APK (phone, tablet, Android TV, Fire TV),
  built in CI; server-address setup, fullscreen video, leanback launcher entry.

### Watch-party chat
- Per-channel WebSocket rooms — everyone watching the same channel can talk;
  presence blends chatters with the true muxer watcher count (Emby/TV included);
  history replay for late joiners, per-client rate limiting, colored names.

### Security (pre-1.0 audit)
- **Fixed (critical):** `/api/channels/:id/sources` was missing its admin gate,
  exposing provider account credentials (embedded in stream URLs) to any
  logged-in user. Now admin-only.
- Added login brute-force protection (per-IP sliding window → 429).
- Documented internet-exposure guidance (bind scope, reverse-proxy XFF).

## 1.0.0-rc.2 — 2026-07-03

The "feels like real TV" release.

### DVR (new)
- One-tap record from the guide; series rules ("record every airing matching…");
  recordings pull through the muxer (share a provider slot with live viewers and
  inherit source failover); storage cap with oldest-first pruning; crash-resume.
- Recordings screen: status badges, live sizes, in-app playback with seeking.

### Live TV feel
- **TV mode** — launch straight into your last channel, fullscreen.
- **Start over** — restart the current program from its beginning when the
  timeshift buffer reaches back that far (timeshift now defaults ON).
- **Prewarm ring** — number-adjacent + most-watched-this-hour channels stay warm;
  surf lands in ~1s instead of a cold provider dial.
- **Mid-watch failover** — a dying or silently-stalling source (12s watchdog)
  swaps to the channel's next-ranked source in place; viewers see a blip.
- Player stats readout (bitrate / dropped frames); reminders with one-tap Tune;
  per-user favorites.

### Lineup intelligence
- Structured taxonomy (kind + genre) classified from provider groups/names;
  cable-style block numbering (news 100s, sports 250s, locals 1500s, 24/7 loops
  3000s); sticky numbers; one-call reflow; working genre filter in the guide.
- Mosaic is the permanent channel 1.

### Tuner consumers (Emby / Plex / Jellyfin / TiviMate)
- Honest tuner count from real provider capacity; color-coded XMLTV categories;
  synthetic 24/7 guide filler (no more blank rows); channel-logo proxy + cache;
  clean taxonomy group-titles; EPG + ingest fixed to route through VPN pins.

## 1.0.0-rc.1 — 2026-07-02

First release candidate. Everything below is live and verified on a production
install (6k+ channels, Emby tuner consumer, VPN-pinned provider).

### Core
- **Canonical channel layer** — N messy provider entries collapse into logical
  channels (tvg-id → slug → fuzzy matching), each with ranked failover sources.
- **Multiplexing stream proxy** — one upstream per channel fans out to any number
  of viewers; rolling keyframe preroll makes channel-surf/attach start instantly
  (~3ms warm); keep-warm grace beats provider connection caps.
- **Slot-pool scheduling** — per-provider connection budgets enforced across
  viewing, recording, casting, and probing.
- **Tuner outputs** — HDHomeRun emulation, M3U playlist, XMLTV guide export for
  Plex / Jellyfin / Emby / TiviMate; key-gated and LAN-only by default.
- **Merged EPG** — streaming XMLTV ingest (flat memory on 100MB+ feeds), multi-feed
  merge by canonical id, gzip'd guide snapshot with ETag.

### Health probes (new)
- Background loop ffprobes every source through its provider's proper egress,
  writing health / resolution / codec / fps back to the DB (UI badges are now
  measurements, not guesses).
- Polite by design: probes only run when the provider pool has slot headroom, so
  viewers always win.
- Tuner outputs (HDHR lineup + M3U) automatically drop channels once every source
  is provably dead — Emby never lists a channel that can only spin.

### Mosaic / multiview
- Server-side GPU-composited mosaic (NVENC): a real tunable channel (#8000) and a
  fullscreen TV display page (`/mosaic/tv`) that mirrors the app's mosaic tab.
- Instant audio-tile switching over zmq on the running encode — no restart, no
  re-buffer; layout/focus changes re-encode in ~1–2s.

### VPN per source
- Native OpenVPN/WireGuard tunnels (no Gluetun), fail-closed policy routing, and
  an HTTP→SOCKS bridge so Bun's fetch can use them; per-source egress pinning with
  a NordVPN location picker and per-source "Check IP".

### Fixed in this cycle
- EPG refresh no longer starves the event loop (was a ~64s app-wide stall / 504s):
  chunked event-loop yields + short batched write transactions.
- VPN-pinned providers' EPG refresh and channel ingest actually route through the
  tunnel (the raw `vpn:<id>` pin used to be handed to fetch verbatim and died).
- Mosaic cast survives viewer reconnects (keep-warm grace) and transiently
  unavailable tiles (per-input reconnect) instead of dying.
- Adult-category channels are excluded from the guide, lineup, and playback — not
  merely hidden in the UI.
- Assorted robustness: VPN health-monitor can no longer die silently, transcoder
  cleanup on muxer failure, share revoke clears live-viewer state.

### Tooling
- `bun test` smoke suite (parsers, matcher, slot pool, TS preroll) + GitHub Actions
  CI on every push.
- Tagged releases publish `ghcr.io/invectedgaming/phospharr`.
