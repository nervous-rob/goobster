# Api service for the compose `full` profile: the web portal backend with
# no Discord gateway connection. Needs ffmpeg (Observatory renders) and a
# Python venv path for the sandbox, but not the music-download toolchain
# or the Opus NEON build flag.

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
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data/sandbox data/images logs

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3100/health || exit 1

EXPOSE 3100

CMD ["node", "apps/api/index.js"]
