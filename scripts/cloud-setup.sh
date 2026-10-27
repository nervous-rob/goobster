#!/usr/bin/env bash
#
# Setup script for Claude Code cloud sessions (claude.ai/code).
#
# Paste this into the cloud environment's "Setup script" field (or have the
# field run `bash scripts/cloud-setup.sh`). The environment caches the
# container after the script runs, so later sessions start with system
# packages, the npm cache, node_modules, the built portal and a local
# Postgres already in place. It does not write config.json (tests and smoke
# make their own placeholder; see AGENTS.md to build a real one from secrets).
#
# Idempotent and best-effort: a failed optional step logs a warning and the
# script still exits 0, so a flaky mirror never blocks a session from
# starting. Set GOOBSTER_SETUP_STRICT=1 to fail on the first error instead.
#
# Skips (env):
#   GOOBSTER_SETUP_SKIP_PG=1      no local Postgres + pgvector
#   GOOBSTER_SETUP_SKIP_WEB=1     no `npm run build:web`
#   GOOBSTER_SETUP_SKIP_MUSIC=1   no spotdl / yt-dlp venv
#   GOOBSTER_SETUP_SKIP_SANDBOX=1 no sandbox Python toolkit (skipped by default
#                                 unless GOOBSTER_SETUP_SANDBOX=1; ~700 MB)

set -uo pipefail

log()  { printf '\n[cloud-setup] %s\n' "$*"; }
warn() { printf '[cloud-setup] WARN: %s\n' "$*" >&2; }

step() {
    local name="$1"; shift
    log "$name"
    "$@"
    local rc=$?
    if [[ $rc -ne 0 ]]; then
        warn "$name failed (exit $rc)"
        [[ "${GOOBSTER_SETUP_STRICT:-0}" == "1" ]] && exit "$rc"
    fi
    return 0
}

as_root() {
    if [[ "$(id -u)" -eq 0 ]]; then "$@"; else sudo -n "$@"; fi
}

# Locate the repo: the script's own checkout, else the usual clone path.
REPO_DIR="${GOOBSTER_REPO_DIR:-}"
if [[ -z "$REPO_DIR" ]]; then
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)"
    if [[ -n "$here" && -f "$here/package.json" ]] && grep -q '"name": "goobster"' "$here/package.json"; then
        REPO_DIR="$here"
    elif [[ -f "$PWD/package.json" ]] && grep -q '"name": "goobster"' "$PWD/package.json"; then
        REPO_DIR="$PWD"
    elif [[ -d /home/user/goobster ]]; then
        REPO_DIR=/home/user/goobster
    fi
fi

apt_packages() {
    local py_minor pkgs=(ffmpeg bubblewrap python3-venv)
    py_minor="$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null || true)"
    [[ -n "$py_minor" ]] && pkgs+=("python${py_minor}-venv")
    local missing=()
    for p in "${pkgs[@]}"; do
        dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
    done
    [[ ${#missing[@]} -eq 0 ]] && { echo "already installed: ${pkgs[*]}"; return 0; }
    as_root apt-get update -qq || return 1
    # Install one at a time so a package missing from this distro does not block the rest.
    local rc=0
    for p in "${missing[@]}"; do
        DEBIAN_FRONTEND=noninteractive as_root apt-get install -y -qq "$p" || { warn "apt: $p unavailable"; rc=1; }
    done
    return $rc
}

npm_install() {
    cd "$REPO_DIR" || return 1
    # Chromium is pre-installed in the cloud image (/opt/pw-browsers); don't download another.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefer-offline --no-audit --no-fund
}

build_web() {
    cd "$REPO_DIR" || return 1
    npm run build:web
}

local_postgres() {
    cd "$REPO_DIR" || return 1
    bash scripts/ensure-local-postgres.sh
}

music_cli() {
    cd "$REPO_DIR" || return 1
    bash scripts/ensure-music-cli.sh
}

sandbox_python() {
    cd "$REPO_DIR" || return 1
    npm run sandbox-python
}

log "Goobster cloud setup (node $(node -v 2>/dev/null || echo missing), repo: ${REPO_DIR:-not found})"

step "System packages (ffmpeg, bubblewrap, python venv)" apt_packages

if [[ -z "$REPO_DIR" ]]; then
    warn "repo not found; skipping npm/build steps (set GOOBSTER_REPO_DIR)"
    exit 0
fi

step "npm ci (all workspaces)" npm_install
[[ "${GOOBSTER_SETUP_SKIP_WEB:-0}" == "1" ]]   || step "Build React portal (apps/web/dist)" build_web
[[ "${GOOBSTER_SETUP_SKIP_PG:-0}" == "1" ]]    || step "Local Postgres + pgvector" local_postgres
[[ "${GOOBSTER_SETUP_SKIP_MUSIC:-0}" == "1" ]] || step "Music CLIs (spotdl, yt-dlp)" music_cli
if [[ "${GOOBSTER_SETUP_SANDBOX:-0}" == "1" && "${GOOBSTER_SETUP_SKIP_SANDBOX:-0}" != "1" ]]; then
    step "Sandbox Python toolkit" sandbox_python
fi

log "done"
exit 0
