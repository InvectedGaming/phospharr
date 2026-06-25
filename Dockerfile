# Phospharr — self-hosted IPTV manager + viewer (Bun + ffmpeg)
FROM oven/bun:1-alpine

# ffmpeg powers the browser audio-transcode fallback (AC-3/HEVC channels).
# The rest are the native-VPN helpers (no Gluetun): openvpn + iproute2 run OpenVPN
# tunnels with per-source policy routing; microsocks is the per-tunnel SOCKS proxy;
# wireproxy (fetched below) runs WireGuard tunnels in userspace.
#
# microsocks isn't in Alpine's stable repos (only edge/testing), so build the tiny
# single-file proxy from source — reliable and avoids pulling edge into a stable base.
RUN apk add --no-cache ffmpeg openvpn iproute2 iptables ca-certificates \
 && apk add --no-cache --virtual .ms-build git make gcc musl-dev \
 && git clone --depth 1 https://github.com/rofl0r/microsocks /tmp/microsocks \
 && make -C /tmp/microsocks \
 && install -m 0755 /tmp/microsocks/microsocks /usr/local/bin/microsocks \
 && rm -rf /tmp/microsocks \
 && apk del .ms-build

WORKDIR /app

# Install deps first so the layer caches across source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App source (drizzle/ migrations included; .dockerignore keeps the dev DB out).
COPY . .

# Fetch the wireproxy helper into ./bin for the build platform (best-effort — if
# GitHub is unreachable at build time, set PHOSPHARR_WIREPROXY or run the script
# at runtime; WireGuard simply won't start until it's present).
RUN bun run vpn:helpers || echo "[build] wireproxy not fetched — set PHOSPHARR_WIREPROXY or run 'bun run vpn:helpers'"

# DB + DVR live on a mounted volume so they survive container rebuilds.
ENV DATABASE_URL=/data/phospharr.db \
    PHOSPHARR_DVR_PATH=/data/dvr \
    PORT=7777 \
    NODE_ENV=production
VOLUME /data
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7777/robots.txt >/dev/null 2>&1 || exit 1

# Apply any pending migrations on boot, then serve.
CMD ["sh", "-c", "bun run db:migrate && bun run start"]
