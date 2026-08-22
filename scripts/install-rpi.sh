#!/usr/bin/env bash
#
# Goobster Raspberry Pi installer
#
# Installs system dependencies, Node.js 22, Python audio tooling, project
# dependencies, and (optionally) the systemd service. Tested on Raspberry Pi
# OS (64-bit, Bookworm) on a Raspberry Pi 4B.
#
# Usage:
#   ./scripts/install-rpi.sh                # install dependencies
#   ./scripts/install-rpi.sh --service      # also install + enable systemd service
#   ./scripts/install-rpi.sh --auto-update  # also install the auto-update timer
#   ./scripts/install-rpi.sh --update       # redeploy an existing install
#
# --update is the mode used by scripts/auto-update.sh after it pulls new
# commits: it refreshes node_modules and the database schema but skips apt
# and the Node.js bootstrap, so it needs no sudo. It still heals the music
# CLI venv (missing, orphaned, or missing yt-dlp/spotdl) via
# scripts/ensure-music-cli.sh.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SERVICE=false
INSTALL_AUTO_UPDATE=false
UPDATE_ONLY=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --service) INSTALL_SERVICE=true ;;
        --auto-update) INSTALL_AUTO_UPDATE=true ;;
        --update) UPDATE_ONLY=true ;;
        -h|--help)
            awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 64
            ;;
    esac
    shift
done

if [[ "${UPDATE_ONLY}" == true ]]; then
    echo "==> Goobster update (dependencies + schema only)"
else
    echo "==> Goobster Raspberry Pi installer"
fi
echo "    Repo: ${REPO_DIR}"

# --- Architecture check --------------------------------------------------
ARCH="$(uname -m)"
if [[ "${ARCH}" != "aarch64" && "${ARCH}" != "x86_64" ]]; then
    echo "WARNING: ${ARCH} detected. A 64-bit OS is strongly recommended"
    echo "         (Raspberry Pi OS 64-bit). 32-bit armv7l is not supported"
    echo "         by prebuilt binaries for several dependencies."
fi

if [[ "${UPDATE_ONLY}" == false ]]; then
    # --- System packages ---------------------------------------------------
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

    # --- Node.js 22 --------------------------------------------------------
    if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
        echo "==> Installing Node.js 22 (NodeSource)..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
    else
        echo "==> Node.js $(node -v) already installed"
    fi

    # --- Python tooling (spotdl / yt-dlp) ----------------------------------
    # Shared helper also used by the Cloud environment install. Rebuilds a
    # venv orphaned by an OS Python upgrade (plain `python3 -m venv` does
    # not repair a dangling interpreter) and creates one that never existed
    # — --update used to skip the "missing" case, so hosts that never ran a
    # full install (or lost ~/.local/goobster-venv) stayed CLI-less forever.
    "${REPO_DIR}/scripts/ensure-music-cli.sh"
else
    # --- Python tooling health check (update mode) --------------------------
    # Heal a missing or broken venv (spotdl *or* yt-dlp). Needs no sudo; a
    # failure here must not block deploying the rest of the update.
    if ! "${REPO_DIR}/scripts/ensure-music-cli.sh"; then
        echo "    WARNING: music CLI venv install failed - downloads stay unavailable" >&2
    fi
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
# Full install, build the React portal (Vite lives in devDependencies), then
# prune dev packages for the runtime bot.
npm ci
echo "==> Building React portal client (apps/web/dist)..."
npm run build:web
npm prune --omit=dev

# --- Runtime directories ----------------------------------------------------
mkdir -p data/music data/ambience data/images data/playlists cache/music logs

# --- Config ------------------------------------------------------------------
if [[ ! -f config.json ]]; then
    cp config.example.json config.json
    echo "==> Created config.json from template - EDIT IT with your Discord token before starting!"
fi

# --- Database ---------------------------------------------------------------
echo "==> Initializing SQLite database..."
node scripts/initDb.js

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

# --- Auto-update timer (optional) ---------------------------------------------
if [[ "${INSTALL_AUTO_UPDATE}" == true ]]; then
    echo "==> Installing auto-update timer (polls the deploy branch every 5 min)..."
    for unit in goobster-update.service goobster-update.timer; do
        sed -e "s|/home/pi/goobster|${REPO_DIR}|g" \
            "deploy/${unit}" | sudo tee "/etc/systemd/system/${unit}" >/dev/null
    done
    if [[ ! -f /etc/goobster-update.conf ]]; then
        sed -e "s|^GOOBSTER_REPO_DIR=.*|GOOBSTER_REPO_DIR=${REPO_DIR}|" \
            -e "s|^GOOBSTER_RUN_USER=.*|GOOBSTER_RUN_USER=$(whoami)|" \
            deploy/goobster-update.conf.example | sudo tee /etc/goobster-update.conf >/dev/null
        echo "    Wrote /etc/goobster-update.conf - review it (branch, health URL, CI gate)"
    fi
    chmod +x scripts/auto-update.sh
    sudo systemctl daemon-reload
    sudo systemctl enable --now goobster-update.timer
    echo "==> Auto-update enabled. Next run: systemctl list-timers goobster-update.timer"
fi

if [[ "${UPDATE_ONLY}" == true ]]; then
    echo "==> Update complete"
    exit 0
fi

echo ""
echo "==> Done!"
echo "    1. Edit config.json (Discord token, client ID, guild IDs, optional API keys)"
echo "    2. Optional: install Ollama for local AI -> curl -fsSL https://ollama.com/install.sh | sh"
echo "                 then: ollama pull llama3.2:3b"
echo "    3. Start the bot: npm start   (or sudo systemctl start goobster)"
