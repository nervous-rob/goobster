# Dedicated sandbox-runner (Phase 5d). Owns bubblewrap / seccomp:unconfined
# so bot and api do not. Shares goobster-data for Observatory project dirs
# and the managed Python venv.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    bubblewrap \
    coreutils \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY apps/bot/package.json apps/bot/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/sandbox/package.json apps/sandbox/
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data/sandbox

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:3200/health || exit 1

EXPOSE 3200

CMD ["node", "apps/sandbox/index.js"]
