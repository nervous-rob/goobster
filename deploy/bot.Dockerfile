# Bot service for the compose `full` profile.
# Same image shape as the root lite Dockerfile (ffmpeg, music venv, native
# module build deps, ARM64 NEON flag) — the bot still owns voice, Activity,
# webhooks, screen/GBA, and the internal gateway API.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip yt-dlp spotdl
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Workspace manifests must all be present before npm ci (monorepo).
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY apps/bot/package.json apps/bot/
COPY apps/api/package.json apps/api/
RUN if [ "$(uname -m)" = "aarch64" ]; then export CFLAGS="-DOPUS_ARM_MAY_HAVE_NEON_INTR"; fi && \
    npm ci --omit=dev

COPY . .

RUN mkdir -p data/music data/ambience data/images data/playlists cache/music logs

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

EXPOSE 3000

CMD ["sh", "-c", "node apps/bot/deploy-commands.js && node apps/bot/index.js"]
