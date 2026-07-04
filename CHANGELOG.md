# Changelog

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
