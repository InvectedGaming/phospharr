# Phospharr — self-hosted IPTV manager + viewer (Bun + ffmpeg w/ NVENC)
#
# Debian BOOKWORM (glibc) base — NOT Alpine (musl can't load the NVIDIA encode
# libs the container toolkit injects) and NOT trixie (jellyfin only ships the
# driver-535-compatible jellyfin-ffmpeg6 for bookworm). With a GPU grant in
# compose + PHOSPHARR_CAST_ENCODER=h264_nvenc, the compositor/transcoder encode
# on the GPU. Bun is installed directly since we're off the oven/bun image.
FROM debian:bookworm-slim

# Native-VPN helpers (openvpn + iproute2 policy routing; iptables; microsocks
# SOCKS) + tooling (curl/gnupg/unzip for Bun & the jellyfin repo; git/make for
# microsocks). wireproxy (WireGuard, userspace) is fetched at the end.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openvpn iproute2 iptables ca-certificates curl gnupg unzip xz-utils git build-essential \
 && rm -rf /var/lib/apt/lists/*

# Bun runtime (official installer → /usr/local/bin/bun).
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
 && bun --version

# NVENC-capable ffmpeg matched to the host driver (535 → NVENC API 12.x).
# jellyfin-ffmpeg6 (bookworm) is built for broad driver compat; the BtbN "latest"
# build needs driver 610+. It dlopens the toolkit-injected NVIDIA libs; falls back
# to libx264 with no GPU. Symlinked into PATH; FFMPEG_PATH points the app at it.
RUN mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main" > /etc/apt/sources.list.d/jellyfin.list \
 && apt-get update && apt-get install -y --no-install-recommends jellyfin-ffmpeg6 \
 && ln -sf /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
 && ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
 && rm -rf /var/lib/apt/lists/*

# microsocks isn't conveniently packaged — build the tiny single-file proxy.
RUN git clone --depth 1 https://github.com/rofl0r/microsocks /tmp/microsocks \
 && make -C /tmp/microsocks \
 && install -m0755 /tmp/microsocks/microsocks /usr/local/bin/microsocks \
 && rm -rf /tmp/microsocks

WORKDIR /app

# Install deps first so the layer caches across source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App source (drizzle/ migrations included; .dockerignore keeps the dev DB out).
COPY . .

# Fetch the wireproxy helper into ./bin (best-effort — see vpn:helpers).
RUN bun run vpn:helpers || echo "[build] wireproxy not fetched — set PHOSPHARR_WIREPROXY or run 'bun run vpn:helpers'"

# DB + DVR live on a mounted volume so they survive container rebuilds.
ENV DATABASE_URL=/data/phospharr.db \
    PHOSPHARR_DVR_PATH=/data/dvr \
    PORT=7777 \
    NODE_ENV=production \
    FFMPEG_PATH=/usr/local/bin/ffmpeg
VOLUME /data
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7777/robots.txt >/dev/null 2>&1 || exit 1

# Apply any pending migrations on boot, then serve.
CMD ["sh", "-c", "bun run db:migrate && bun run start"]
