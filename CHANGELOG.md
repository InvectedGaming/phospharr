# Changelog

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
