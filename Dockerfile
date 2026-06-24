# Phospharr — self-hosted IPTV manager + viewer (Bun + ffmpeg)
FROM oven/bun:1-alpine

# ffmpeg powers the browser audio-transcode fallback (AC-3/HEVC channels).
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install deps first so the layer caches across source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App source (drizzle/ migrations included; .dockerignore keeps the dev DB out).
COPY . .

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
