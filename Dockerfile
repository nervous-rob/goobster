# Goobster - multi-arch Dockerfile (works on amd64 and arm64, incl. Raspberry Pi 4B)
#
# Build:  docker build -t goobster .
# Run:    docker run -d --name goobster \
#             -v ./config.json:/app/config.json:ro \
#             -v goobster-data:/app/data \
#             -v goobster-logs:/app/logs \
#             goobster

FROM node:22-bookworm-slim

# System dependencies:
#  - ffmpeg: audio playback/transcoding (native multi-arch, replaces ffmpeg-static)
#  - python3 + pip: spotdl / yt-dlp for music downloads
#  - build-essential + python-is-python3: native module builds (@discordjs/opus, better-sqlite3, sodium-native)
#  - curl: container health check
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Python tools in an isolated venv
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip yt-dlp spotdl
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Install Node dependencies first for better layer caching
# On arm64, @discordjs/opus may fall back to a source build; its gyp config
# omits OPUS_ARM_MAY_HAVE_NEON_INTR, breaking the NEON code under newer GCC
# (see https://github.com/discordjs/opus/issues/175), so define it here.
COPY package*.json ./
RUN if [ "$(uname -m)" = "aarch64" ]; then export CFLAGS="-DOPUS_ARM_MAY_HAVE_NEON_INTR"; fi && \
    npm ci --omit=dev

# Copy application source
COPY . .

# Runtime directories
RUN mkdir -p data/music data/ambience data/images data/playlists cache/music logs

# Health check against the built-in Express endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

EXPOSE 3000

CMD ["sh", "-c", "node deploy-commands.js && node index.js"]
