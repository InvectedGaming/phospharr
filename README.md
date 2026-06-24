# Phospharr

**Free, open-source, self-hosted IPTV manager + viewer that feels like a real TV — not an admin panel.**

Phospharr is **software only** — it ships with **no channels, no streams, and no
providers**. You bring your own legally-obtained IPTV subscription or sources, and
Phospharr organizes and plays them. See [Legal & responsible use](#legal--responsible-use).

Phospharr collapses messy provider channels into a **canonical channel layer**, pools
provider connection slots so two 4-stream providers genuinely give you **8 concurrent
streams**, multiplexes one upstream connection out to many viewers, merges EPG from
multiple sources, and emulates an HDHomeRun tuner so Plex/Jellyfin/Emby and TVs can
consume it natively.

> Status: **0.1 — runnable backend + Phospharr UI.** The control plane, ingest,
> canonical matching, EPG merge, slot-pool scheduler, multiplexing proxy, and HDHR
> emulator are implemented in TypeScript/Bun. The **Phospharr** Watch + Manage UI
> (guide grid, mosaic, channel manager) is built and wired to the live API. The Go
> data-plane hot path is the next milestone (see Roadmap).

## Why it's different

| Capability | How Phospharr does it |
|---|---|
| **One logical channel, N sources** | Canonical matcher normalizes names (`US\| ESPN HD [1080]` → `ESPN`) and collapses duplicates across providers into one channel with ranked sources. |
| **8 streams from 2×4 providers** | Slot pool tracks live usage per provider; the scheduler routes each tune-in to whichever provider has a free slot. |
| **Failover = capacity** | Same channel on multiple providers → the selector silently picks another source on stall *or* when one provider is full. |
| **More viewers than slots** | The muxer fans one upstream connection out to many viewers — same-channel viewers cost **zero** extra slots. |
| **In-browser live playback** | Click any channel to watch. Passthrough MPEG-TS via mpegts.js (MSE) — **no transcoding** for H.264/AAC. AC-3/HEVC channels fall back to the lightest transcode: copy video, re-encode only audio to AAC (one ffmpeg per channel, fanned out). |
| **Shared streams, instant promote** | Every view of a channel (detail preview, mosaic tile, fullscreen) rides **one** upstream connection (muxer multiplex). Fullscreening a channel already previewing **reuses the warm decoder** — no reconnect, no rebuffer. Recently-closed channels stay warm through the slot grace window for instant re-tune. |
| **Instant channel surf** | Configurable keep-warm: the upstream is held for *N* seconds after the last viewer leaves (Settings → Streaming) so re-tuning is instant. Client disconnects are detected via the request signal, so slots free reliably (no phantom viewers). |
| **Always-fresh guide** | XMLTV merge from multiple feeds, bound by tvg-id (`epgChannelId`) with name-slug fallback. Xtream EPG is auto-derived (`xmltv.php`) — no URL to hand-enter. |
| **EPG at scale** | Streaming SAX ingest (flat memory) + single-transaction prepared-statement upsert: a 22MB / 62k-programme feed lands in ~2s. Served from a precomputed, gzip-compressed in-memory snapshot with ETag/304 — all channels for a 26h window is ~200KB on the wire, ~2ms from cache. |
| **Auto management** | Declarative rules auto-hide/rename/categorize (hidden ≠ deleted, fully reversible). |
| **Runs lean or full** | Feature flags (HDHR, transcode, EPG refresh, health probe, timeshift, DVR) toggle each capability. Precedence: env var → DB (UI Settings) → default. Heavy/disk features off by default, so a fresh install is light. |

## Architecture

```
                control plane (this repo, Bun + TS)
  ┌─────────────────────────────────────────────────────────┐
  │  ingest ─► canonical matcher ─► DB (SQLite/Drizzle)      │
  │     M3U / Xtream                 channels · streams      │
  │                                  programs · rules        │
  │  epg merge (XMLTV) ──────────────► programs              │
  │                                                          │
  │  scheduler (slot pool + selector) ──► muxer ──► viewers  │
  │                                         │                │
  │  HDHR emulator ◄────────────────────────┘                │
  └─────────────────────────────────────────────────────────┘
            data plane hot path → Go service (roadmap)
```

The **canonical channel layer is the spine.** Logos, EPG, categories, dedup,
failover, capacity routing, and auto-multiview all key off `channels.canonicalId`.

## Quick start

Requires [Bun](https://bun.sh). For in-browser playback of AC-3/HEVC channels you
also need [ffmpeg](https://ffmpeg.org) on `PATH` (or set `FFMPEG_PATH`); H.264/AAC
channels play with no ffmpeg via passthrough.

```bash
bun install
cp .env.example .env
bun run db:migrate   # create the SQLite schema
bun run seed         # optional: offline demo data (2 providers, deduped channels)
bun run dev          # http://localhost:7777
```

Try it:

```bash
curl localhost:7777/discover.json          # HDHR identity (point Plex/Jellyfin here)
curl localhost:7777/lineup.json            # the channel lineup
curl localhost:7777/api/channels           # managed channels
curl localhost:7777/api/status             # live slot-pool usage + active muxes
```

Add a real provider:

```bash
curl -X POST localhost:7777/api/providers -H 'content-type: application/json' -d '{
  "name": "My Provider", "type": "xtream",
  "url": "http://panel.example.com", "username": "u", "password": "p",
  "maxConnections": 4, "epgUrl": "http://panel.example.com/xmltv.php?username=u&password=p"
}'
curl -X POST localhost:7777/api/providers/1/sync     # ingest + canonical match
curl -X POST localhost:7777/api/epg/sync             # pull + merge EPG (Xtream xmltv.php auto-derived)
```

Point Plex/Jellyfin Live TV at `http://<host>:7777` as an HDHomeRun device.

## Run with Docker

The image bundles Bun + ffmpeg; the DB and DVR recordings persist in a `phospharr-data`
volume. First run creates the schema automatically.

```bash
cp .env.example .env          # optional — sensible defaults work as-is
docker compose up -d          # → http://localhost:7777
```

Open the UI and create your **admin account** (the first account is the admin).
Everything else — providers, EPG, rules, users, share links — is in the UI.

**Streaming is locked down by default.** Exports — the **HDHomeRun** tuner, an
**M3U** playlist, an **XMLTV** guide, and `/stream` — require a session (the web
player) or an auto-generated key, **and** are **LAN-only** unless you opt in. Grab
the URLs from **Settings → Access & Tuner** (e.g. tuner `http://<host>:7777/t/<key>`,
plus `…/playlist.m3u` and `…/epg.xml`) and add them to Plex / Jellyfin / Emby /
TiviMate.

To use them off your network, enable **Settings → Network Access → Allow external**
(you'll get a warning). Running behind nginx/Traefik/Caddy? Turn on **trust proxy**
so the LAN check sees the real client IP — with plain Docker port-publishing every
client looks local, so the key stays your real lock.

### VPN passthrough (Gluetun) — one VPN per source

Run **one Gluetun per region**; each Source picks which VPN it uses — Source A →
Japan, Source B → UK, others direct. Phospharr runs *outside* the tunnels, so one
instance mixes VPN and non-VPN providers.

1. Put your region's VPN details in `.env` (the compose ships a `gluetun-jp`
   example — `JP_WIREGUARD_PRIVATE_KEY`, `JP_SERVER_COUNTRIES`, …; or the OpenVPN
   equivalents — see the [Gluetun wiki](https://github.com/qdm12/gluetun-wiki)).
2. Start with the `vpn` profile:

   ```bash
   docker compose --profile vpn up -d
   ```

3. In the UI: **Settings → VPN** → add an endpoint, e.g. name `Japan`, url
   `http://gluetun-jp:8888`. Add one per region.
4. In **Sources**, set each provider's **VPN** dropdown to Direct or any endpoint.

For more regions, copy the `gluetun-jp` block in `docker-compose.yml` to
`gluetun-uk` (with that region's creds) and add `http://gluetun-uk:8888` as another
endpoint. A source's stream pull, channel-list sync, *and* EPG all egress through
its chosen VPN; everything else stays on your normal connection.

### Adding to an existing stack

Phospharr is a plain container — drop the `phospharr` service into your compose and put
it on whatever network reaches the internet:

```yaml
services:
  phospharr:
    image: ghcr.io/<you>/phospharr:latest   # or  build: ./phospharr
    restart: unless-stopped
    ports: ["7777:7777"]
    volumes: ["phospharr-data:/data"]
volumes: { phospharr-data: }
```

Already run **Gluetun** (or any HTTP/SOCKS proxy)? Don't network Phospharr *through*
it — just share a Docker network and add that proxy as an endpoint in
**Settings → VPN** (e.g. `http://gluetun:8888` or `socks5://gluetun:1080`). The
per-source dropdown does the rest, and you can register several proxies for
several regions.

## The Phospharr UI

Open `http://localhost:7777` for **Phospharr** — the Watch + Manage face, one design
system in two densities (ported from the Claude Design handoff, served static from
the same server, no build step):

- **Watch · Guide** — time-based EPG grid with a pulsing now-line, sticky channel
  column, and a **rich detail pane** that reflects the highlighted program (title,
  time, description, badges) with a **live preview** of that channel. Arrow keys
  navigate the grid remote-style (Enter watches); cells show continuation arrows
  when a program runs past the window. Defaults to **channels with guide data**
  (toggle to All), with a Comfortable/Compact density switch — so a 6,800-channel
  lineup with ~1,100 EPG-carrying channels shows real programming, not empty rows.
- **Watch · Mosaic** — 2×2 / 3×3 live tile grid, per-tile audio toggle, click any
  tile to promote it fullscreen.
- **Manage · Analytics** — viewing dashboard: watch-time KPIs (today / 7-day),
  most-watched **channels** *and* **shows** (the program airing during each session
  is captured from the EPG), a 14-day watch-time chart, what's streaming live now,
  and recent activity (with the exact program watched). A view session is recorded
  on each stream disconnect; tile/mini previews are tagged separately so they don't
  skew real watch time.
- **Manage · Channel Manager** — virtualized dense table (handles 6k+ channels at
  ~6ms/render) with inline-rename (writes through to the API), health badges,
  per-channel source counts, bulk hide, drag-to-reorder.
  **Add source** opens a modal to add an Xtream Codes panel or M3U playlist — it
  POSTs the provider, ingests + canonical-matches the lineup, pulls EPG if given,
  and registers the provider's streams into the slot pool, all live.

The whole UI is driven by one aggregated endpoint, `GET /api/view`.

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/` · `/app.js` | The Phospharr UI (static) |
| GET | `/api/view` | Channels + health + source counts |
| GET | `/api/guide` | Full EPG — precomputed gzip snapshot, ETag/304 |
| GET | `/discover.json`, `/lineup.json`, `/lineup_status.json` | HDHR emulation |
| GET | `/stream/:channelId` | Multiplexed MPEG-TS passthrough (HDHR/Plex) |
| GET | `/watch/:channelId` | Browser-friendly variant (video copy + audio→AAC) |
| GET/POST | `/api/providers` · `/api/providers/:id/sync` | Manage + ingest providers |
| GET/PATCH | `/api/channels` · `/api/channels/:id` | List / edit channels |
| GET | `/api/channels/:id/sources` | The N sources behind a channel |
| GET | `/api/guide/:canonicalId/now` | Now/Next for a channel |
| POST | `/api/epg/sync` | Pull + merge XMLTV |
| GET/POST | `/api/rules` · `/api/rules/apply` | Auto-management rules |
| GET | `/api/analytics` | Watch-time totals, top channels, recent, 14-day chart |
| GET/PATCH | `/api/settings` | Read / change settings + feature flags |
| GET | `/api/capabilities` | Which features are enabled (+ env-locked) |
| GET | `/api/status` | Slot-pool usage + active muxes |

## Accounts, sharing & privacy

- **Multi-user with logins** — the first account is the admin; admins create users
  and **limit what each can see** (by category, network, or specific channels),
  enforced server-side. Non-admins get a watch-only UI.
- **Share links** — generate a login-free, expiring, revocable link to a single
  channel. Concurrent-viewer cap, single-use stream tickets (the media URL can't be
  hotlinked/scraped), `noindex`, and **instant live revoke** (cuts active viewers).
- **Per-source VPN passthrough** — register multiple VPN endpoints (e.g. several
  [Gluetun](https://github.com/qdm12/gluetun) regions) and pick one per source —
  Source A → Japan, Source B → UK, others direct. One instance, mixed VPN / non-VPN.
  See [Run with Docker](#run-with-docker).
- **Locked-down exports** — HDHomeRun, M3U, XMLTV, and `/stream` require a session
  or auto-generated key **and** are LAN-only by default (off-network → `403`), with an
  explicit opt-in + warning to expose them and reverse-proxy IP support. Modeled on
  how [Dispatcharr](https://dispatcharr.github.io/Dispatcharr-Docs/advanced/) gates its outputs.

## Roadmap

- **Phospharr UI polish** — Home / Now-Playing / EPG-Matcher screens (the last stub in
  the rail), real `<video>` playback via HLS, instant-zap surf.
- **Go data plane** — move the byte pump to Go: zero-copy fan-out, MPEG-TS PID
  continuity, ffmpeg pool (passthrough default, transcode on demand), HLS/fMP4 out.
- **Health probes** — ffprobe on ingest + schedule → auto-hide dead/sub-SD sources.
- **Composite multiview** — server-side ffmpeg mosaic as a real tunable channel,
  auto-generated from EPG ("4 NFL games live now").
- **Plugin system** — typed hooks (`onChannelIngest`, `onRename`, `onEpgMatch`,
  `onStreamProbe`, `onFailover`), source providers, output targets — sandboxed via RPC.
- **Postgres option** for larger installs; **Schedules Direct** EPG source.

## Legal & responsible use

Phospharr is a **general-purpose media tool**, like a web browser or a media player.
It is **software only** and is distributed with **no channels, no streams, no
playlists, and no provider accounts**. It does not host, provide, resell, or include
any media content of any kind.

Phospharr is intended **solely** for organizing and viewing content you are **legally
entitled to access** — for example:

- An IPTV subscription you pay for, used within that provider's terms of service.
- Free, over-the-air, or public/free-to-air streams.
- Your own media, M3U playlists, or EPG sources.

**You are solely responsible** for the sources you connect and for ensuring your use
complies with all applicable laws and the terms of service of any provider. You must
have the rights or authorization for any content you stream through it.

This project and its authors **do not support, endorse, encourage, or assist** the
use of pirated, unauthorized, or otherwise illegally-obtained streams, and accept **no
responsibility or liability** for how the software is used. The software is provided
"as is", without warranty of any kind (see [LICENSE](LICENSE)). If you are unsure
whether a source is legal to use, **do not use it**.

## License

[MIT](LICENSE) — free and open-source.
