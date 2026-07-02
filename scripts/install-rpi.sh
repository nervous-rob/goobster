#!/usr/bin/env bash
#
# Goobster Raspberry Pi installer
#
# Installs system dependencies, Node.js 22, Python audio tooling, project
# dependencies, and (optionally) the systemd service. Tested on Raspberry Pi
# OS (64-bit, Bookworm) on a Raspberry Pi 4B.
#
# Usage:
#   ./scripts/install-rpi.sh            # install dependencies
#   ./scripts/install-rpi.sh --service  # also install + enable systemd service

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SERVICE=false
[[ "${1:-}" == "--service" ]] && INSTALL_SERVICE=true

echo "==> Goobster Raspberry Pi installer"
echo "    Repo: ${REPO_DIR}"

# --- Architecture check --------------------------------------------------
ARCH="$(uname -m)"
if [[ "${ARCH}" != "aarch64" && "${ARCH}" != "x86_64" ]]; then
    echo "WARNING: ${ARCH} detected. A 64-bit OS is strongly recommended"
    echo "         (Raspberry Pi OS 64-bit). 32-bit armv7l is not supported"
    echo "         by prebuilt binaries for several dependencies."
fi

# --- System packages ------------------------------------------------------
echo "==> Installing system packages (ffmpeg, build tools, python)..."
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
    ffmpeg \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    curl \
    git

# --- Node.js 22 ------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
    echo "==> Installing Node.js 22 (NodeSource)..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "==> Node.js $(node -v) already installed"
fi

# --- Python tooling (spotdl / yt-dlp) --------------------------------------
echo "==> Installing spotdl + yt-dlp into ~/.local/goobster-venv..."
VENV_DIR="${HOME}/.local/goobster-venv"
python3 -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/pip" install --no-cache-dir --upgrade pip yt-dlp spotdl
mkdir -p "${HOME}/.local/bin"
ln -sf "${VENV_DIR}/bin/spotdl" "${HOME}/.local/bin/spotdl"
ln -sf "${VENV_DIR}/bin/yt-dlp" "${HOME}/.local/bin/yt-dlp"
if ! echo "${PATH}" | tr ':' '\n' | grep -qx "${HOME}/.local/bin"; then
    echo "    NOTE: add ~/.local/bin to your PATH (usually automatic on next login)"
fi

# --- Node dependencies ------------------------------------------------------
echo "==> Installing Node dependencies (native modules build on ARM64)..."
cd "${REPO_DIR}"
# @discordjs/opus has no arm64 prebuilt for Node 22 / recent glibc, so it
# compiles from source. Its bundled libopus only declares the NEON intrinsics
# (celt_inner_prod_neon) when OPUS_ARM_MAY_HAVE_NEON_INTR is defined, which
# its gyp config forgets on arm64 - newer GCC then fails the build with an
# implicit-declaration error. Define it ourselves so the source build works.
# See https://github.com/discordjs/opus/issues/175
if [[ "${ARCH}" == "aarch64" || "${ARCH}" == arm* ]]; then
    export CFLAGS="${CFLAGS:-} -DOPUS_ARM_MAY_HAVE_NEON_INTR"
fi
npm ci --omit=dev

# --- Runtime directories ----------------------------------------------------
mkdir -p data/music data/ambience data/images data/playlists cache/music logs

# --- Config ------------------------------------------------------------------
if [[ ! -f config.json ]]; then
    cp config.example.json config.json
    echo "==> Created config.json from template - EDIT IT with your Discord token before starting!"
fi

# --- Database ---------------------------------------------------------------
echo "==> Initializing SQLite database..."
node initDb.js

# --- systemd service (optional) ----------------------------------------------
if [[ "${INSTALL_SERVICE}" == true ]]; then
    echo "==> Installing systemd service..."
    SERVICE_FILE="/etc/systemd/system/goobster.service"
    sed -e "s|/home/pi/goobster|${REPO_DIR}|g" \
        -e "s|User=pi|User=$(whoami)|" \
        -e "s|/usr/bin/node|$(command -v node)|g" \
        deploy/goobster.service | sudo tee "${SERVICE_FILE}" >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable goobster
    echo "==> Service installed. Start it with: sudo systemctl start goobster"
fi

echo ""
echo "==> Done!"
echo "    1. Edit config.json (Discord token, client ID, guild IDs, optional API keys)"
echo "    2. Optional: install Ollama for local AI -> curl -fsSL https://ollama.com/install.sh | sh"
echo "                 then: ollama pull llama3.2:3b"
echo "    3. Start the bot: npm start   (or sudo systemctl start goobster)"
