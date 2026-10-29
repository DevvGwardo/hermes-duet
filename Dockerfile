# Hermes Duet in a container.
#
# Three stages so the image carries the built PWA and production dependencies only: the Bun server, a Chromium for
# the live browser pane, and SQLite (compiled into Bun, nothing to install). Data lives on a volume at /data, which
# includes the database, uploads, delivered files and the VAPID keys — back that up and nothing else.
#
#   docker build -t hermes-duet .
#   docker run -d --name hermes-duet \
#     -p 7456:7456 -v hermes-duet-data:/data \
#     --env-file .env hermes-duet
#
# Then pair a device with: docker exec hermes-duet bun bin/hermes-duet pair

# syntax=docker/dockerfile:1
FROM oven/bun:1.2-debian AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.2-debian AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build
# Prune the dev dependencies (vite, typescript, playwright-core) from what the runtime image copies.
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.2-debian AS runtime
# Chromium is what the interactive browser pane drives over CDP; ca-certificates for outbound HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 duet

WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown -R duet:duet /data /app

ENV NODE_ENV=production \
    DUET_HOST=0.0.0.0 \
    DUET_PORT=7456 \
    DUET_INTERNAL_PORT=7457 \
    DUET_DATA_DIR=/data \
    DUET_CHROME_BIN=/usr/bin/chromium \
    DUET_CHROME_PROFILE=/data/chrome

USER duet
VOLUME ["/data"]
EXPOSE 7456

HEALTHCHECK --interval=30s --timeout=4s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:7456/api/health || exit 1

# tini reaps the Chromium child the browser pane spawns, so the container stops cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "server/index.ts"]
