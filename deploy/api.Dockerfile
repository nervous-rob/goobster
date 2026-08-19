# Api service for the compose `full` profile: the web portal backend with
# no Discord gateway connection. Needs ffmpeg (Observatory renders) and a
# Python venv path for the sandbox, but not the music-download toolchain
# or the Opus NEON build flag.
#
# Phase 4: a Vite build stage produces apps/web/dist so webapp.nextClient
# can serve /app/next. The legacy ES-module client stays at /app.

FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY apps/bot/package.json apps/bot/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/web apps/web
RUN npm run build -w @goobster/web

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-venv \
    build-essential \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY apps/bot/package.json apps/bot/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev

COPY . .
COPY --from=web /app/apps/web/dist /app/apps/web/dist

RUN mkdir -p data/sandbox data/images logs

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3100/health || exit 1

EXPOSE 3100

CMD ["node", "apps/api/index.js"]
