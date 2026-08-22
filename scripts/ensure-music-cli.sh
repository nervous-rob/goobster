#!/usr/bin/env bash
#
# Idempotent install of the music-download CLIs (spotdl + yt-dlp).
#
# Creates ~/.local/goobster-venv when it is missing or broken (orphaned by an
# OS Python upgrade, missing one of the two CLIs, or a dangling pip) and
# symlinks the binaries into ~/.local/bin so the bot can find them even when
# that directory is not on PATH (systemd, Cloud Agent snapshots).
#
# Used by scripts/install-rpi.sh (full install and --update) and by the
# Cursor Cloud environment install. Needs python3 + the venv module
# (python3-venv / python3.12-venv). Does not run apt itself.
#
# Usage:
#   ./scripts/ensure-music-cli.sh

set -euo pipefail

VENV_DIR="${GOOBSTER_VENV_DIR:-${HOME}/.local/goobster-venv}"

venv_healthy() {
    [[ -x "${VENV_DIR}/bin/pip" ]] \
        && [[ -x "${VENV_DIR}/bin/spotdl" ]] \
        && [[ -x "${VENV_DIR}/bin/yt-dlp" ]] \
        && "${VENV_DIR}/bin/pip" --version >/dev/null 2>&1 \
        && "${VENV_DIR}/bin/spotdl" --version >/dev/null 2>&1 \
        && "${VENV_DIR}/bin/yt-dlp" --version >/dev/null 2>&1
}

if venv_healthy; then
    echo "==> Music CLI venv already healthy at ${VENV_DIR}"
else
    if [[ -d "${VENV_DIR}" ]]; then
        echo "==> Music CLI venv is missing or broken - rebuilding ${VENV_DIR}..."
    else
        echo "==> Installing spotdl + yt-dlp into ${VENV_DIR}..."
    fi
    if ! python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then
        echo "ERROR: python3 venv/ensurepip is not available." >&2
        echo "       Install it with: sudo apt-get install -y python3-venv" >&2
        echo "       (on Ubuntu 24.04 / this Cloud VM: python3.12-venv)" >&2
        exit 1
    fi
    python3 -m venv --clear "${VENV_DIR}"
    "${VENV_DIR}/bin/pip" install --no-cache-dir --upgrade pip yt-dlp spotdl
fi

mkdir -p "${HOME}/.local/bin"
ln -sf "${VENV_DIR}/bin/spotdl" "${HOME}/.local/bin/spotdl"
ln -sf "${VENV_DIR}/bin/yt-dlp" "${HOME}/.local/bin/yt-dlp"

if ! echo "${PATH}" | tr ':' '\n' | grep -qx "${HOME}/.local/bin"; then
    echo "    NOTE: add ~/.local/bin to your PATH (usually automatic on next login)"
fi
