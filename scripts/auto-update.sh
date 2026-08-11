#!/usr/bin/env bash
#
# Goobster continuous deployment updater.
#
# Watches the git remote for new commits on the deploy branch (main by
# default). When the branch has moved it redeploys in place: stop the service,
# fast-forward the working copy, re-run the installer, reload systemd, start
# the service again, and verify /health. A deploy that does not come back
# healthy is rolled back to the previous commit automatically.
#
# Designed to be triggered by deploy/goobster-update.timer as root, because
# systemctl stop/start/daemon-reload need root. The git and npm steps are
# re-executed as the repo owner so file ownership and the npm cache stay with
# the bot user.
#
# Usage:
#   sudo ./scripts/auto-update.sh            # deploy if the branch moved
#   sudo ./scripts/auto-update.sh --check    # report only (exit 10 = pending)
#   sudo ./scripts/auto-update.sh --force    # redeploy the current commit
#
# Options:
#   --check          only report whether a deploy is pending
#   --force          deploy even when the branch has not moved
#   --no-rollback    leave a failed deploy in place instead of reverting
#   --repo-dir DIR   working copy to deploy (default: the parent of this script)
#   --branch NAME    branch to track (default: main)
#   --service NAME   systemd unit to restart (default: goobster)
#   --user NAME      user that owns the working copy (default: its owner)
#
# Settings can also come from /etc/goobster-update.conf or the environment;
# see deploy/goobster-update.conf.example for the full list.
#
# Exit codes:
#   0   nothing to do, or deploy succeeded
#   1   deploy failed and was rolled back (bot is running the old commit)
#   2   deploy failed and rollback failed (bot is NOT running - needs a human)
#   10  --check only: an update is available

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Settings, lowest to highest precedence: defaults, config file, environment,
# command line flags.
SETTINGS=(
    GOOBSTER_REPO_DIR GOOBSTER_BRANCH GOOBSTER_REMOTE GOOBSTER_SERVICE
    GOOBSTER_RUN_USER GOOBSTER_HEALTH_URL GOOBSTER_HEALTH_TIMEOUT
    GOOBSTER_HEALTH_INTERVAL GOOBSTER_INSTALL_CMD GOOBSTER_ROLLBACK
    GOOBSTER_REQUIRE_CI GOOBSTER_GITHUB_TOKEN GOOBSTER_SYNC_UNIT
    GOOBSTER_GIT_CLEAN GOOBSTER_DISCORD_WEBHOOK GOOBSTER_LOCK_FILE
    GOOBSTER_SYSTEMCTL
)

CONF_FILE="${GOOBSTER_UPDATE_CONF:-/etc/goobster-update.conf}"
if [[ -r "${CONF_FILE}" ]]; then
    declare -A _preset=()
    for _name in "${SETTINGS[@]}"; do
        if [[ -n "${!_name+x}" ]]; then _preset["${_name}"]="${!_name}"; fi
    done
    # shellcheck disable=SC1090
    source "${CONF_FILE}"
    for _name in "${!_preset[@]}"; do
        printf -v "${_name}" '%s' "${_preset[${_name}]}"
    done
fi

REPO_DIR="${GOOBSTER_REPO_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
BRANCH="${GOOBSTER_BRANCH:-main}"
REMOTE="${GOOBSTER_REMOTE:-origin}"
SERVICE="${GOOBSTER_SERVICE:-goobster}"
RUN_USER="${GOOBSTER_RUN_USER:-}"
HEALTH_URL="${GOOBSTER_HEALTH_URL-http://127.0.0.1:3000/health}"
HEALTH_TIMEOUT="${GOOBSTER_HEALTH_TIMEOUT:-180}"
HEALTH_INTERVAL="${GOOBSTER_HEALTH_INTERVAL:-5}"
INSTALL_CMD="${GOOBSTER_INSTALL_CMD:-scripts/install-rpi.sh --update}"
ROLLBACK="${GOOBSTER_ROLLBACK:-true}"
REQUIRE_CI="${GOOBSTER_REQUIRE_CI:-false}"
GITHUB_TOKEN="${GOOBSTER_GITHUB_TOKEN:-}"
SYNC_UNIT="${GOOBSTER_SYNC_UNIT:-false}"
GIT_CLEAN="${GOOBSTER_GIT_CLEAN:-false}"
DISCORD_WEBHOOK="${GOOBSTER_DISCORD_WEBHOOK:-}"
LOCK_FILE="${GOOBSTER_LOCK_FILE:-/var/lock/goobster-update.lock}"

CHECK_ONLY=false
FORCE=false

usage() {
    awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check) CHECK_ONLY=true ;;
        --force) FORCE=true ;;
        --no-rollback) ROLLBACK=false ;;
        --repo-dir) REPO_DIR="$2"; shift ;;
        --branch) BRANCH="$2"; shift ;;
        --service) SERVICE="$2"; shift ;;
        --user) RUN_USER="$2"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 64 ;;
    esac
    shift
done

if [[ ! -d "${REPO_DIR}/.git" ]]; then
    echo "ERROR: ${REPO_DIR} is not a git working copy" >&2
    exit 64
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
[[ -n "${RUN_USER}" ]] || RUN_USER="$(stat -c '%U' "${REPO_DIR}")"
RUN_HOME="$(getent passwd "${RUN_USER}" | cut -d: -f6)"
[[ -n "${RUN_HOME}" ]] || RUN_HOME="${HOME:-/tmp}"
LOG_FILE="${GOOBSTER_LOG_FILE:-${REPO_DIR}/logs/auto-update.log}"

if [[ -n "${GOOBSTER_SYSTEMCTL:-}" ]]; then
    read -r -a SYSTEMCTL <<<"${GOOBSTER_SYSTEMCTL}"
elif [[ ${EUID} -eq 0 ]] || ! command -v sudo >/dev/null 2>&1; then
    SYSTEMCTL=(systemctl)
else
    SYSTEMCTL=(sudo systemctl)
fi

# --- Helpers ---------------------------------------------------------------

log() {
    local line
    line="[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"
    echo "${line}"
    if [[ -w "$(dirname "${LOG_FILE}")" || -w "${LOG_FILE}" ]]; then
        echo "${line}" >>"${LOG_FILE}" 2>/dev/null || true
    fi
}

die() {
    log "ERROR: $*"
    exit "${2:-1}"
}

# Run a command as the repo owner when this script runs as root, so git
# metadata, node_modules, and the npm cache never end up root-owned.
as_user() {
    if [[ ${EUID} -eq 0 && "${RUN_USER}" != "root" ]]; then
        runuser -u "${RUN_USER}" -- env HOME="${RUN_HOME}" PATH="${PATH}" "$@"
    else
        "$@"
    fi
}

run_git() {
    as_user git -C "${REPO_DIR}" "$@"
}

service_state() {
    "${SYSTEMCTL[@]}" is-active "${SERVICE}" 2>/dev/null || true
}

short() {
    printf '%s' "${1:0:8}"
}

notify() {
    local text="$1"
    if [[ -z "${DISCORD_WEBHOOK}" ]]; then return 0; fi
    local payload
    if ! payload="$(GOOBSTER_NOTIFY_TEXT="${text}" node -e \
        'process.stdout.write(JSON.stringify({ content: process.env.GOOBSTER_NOTIFY_TEXT }))')"; then
        log "WARN: could not build the Discord notification payload"
        return 0
    fi
    if ! curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
        -d "${payload}" "${DISCORD_WEBHOOK}" >/dev/null; then
        log "WARN: Discord notification failed"
    fi
}

# Wait for the unit to be active and (when configured) for /health to answer.
wait_for_health() {
    local deadline=$((SECONDS + HEALTH_TIMEOUT))
    while :; do
        local state
        state="$(service_state)"
        if [[ "${state}" == "failed" ]]; then
            log "Unit ${SERVICE} entered the failed state"
            return 1
        fi
        if [[ "${state}" == "active" ]]; then
            if [[ -z "${HEALTH_URL}" ]]; then
                sleep "${HEALTH_INTERVAL}"
                if [[ "$(service_state)" == "active" ]]; then return 0; fi
            elif curl -fsS -m 5 -o /dev/null "${HEALTH_URL}"; then
                return 0
            fi
        fi
        if (( SECONDS >= deadline )); then
            log "Timed out after ${HEALTH_TIMEOUT}s waiting for ${SERVICE} to become healthy (state=${state})"
            return 1
        fi
        sleep "${HEALTH_INTERVAL}"
    done
}

github_slug() {
    local url
    url="$(run_git remote get-url "${REMOTE}")"
    url="${url%.git}"
    url="${url#git@github.com:}"
    url="${url#ssh://git@github.com/}"
    url="${url#https://github.com/}"
    url="${url#http://github.com/}"
    printf '%s' "${url}"
}

# 0 = checks passed, 1 = checks failed, 2 = still running / unknown.
ci_status() {
    local sha="$1" slug json
    slug="$(github_slug)"
    local args=(-fsS -m 20 -H 'Accept: application/vnd.github+json')
    if [[ -n "${GITHUB_TOKEN}" ]]; then
        args+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
    fi
    if ! json="$(curl "${args[@]}" "https://api.github.com/repos/${slug}/commits/${sha}/check-runs")"; then
        log "WARN: could not reach the GitHub checks API for ${slug}@$(short "${sha}")"
        return 2
    fi
    local rc=0
    printf '%s' "${json}" | node -e '
        let raw = "";
        process.stdin.on("data", (c) => { raw += c; });
        process.stdin.on("end", () => {
            let runs = [];
            try { runs = JSON.parse(raw).check_runs || []; } catch { process.exit(2); }
            if (runs.length === 0) process.exit(2);
            if (runs.some((r) => r.status !== "completed")) process.exit(2);
            const ok = new Set(["success", "skipped", "neutral"]);
            process.exit(runs.every((r) => ok.has(r.conclusion)) ? 0 : 1);
        });
    ' || rc=$?
    return "${rc}"
}

# Re-render the systemd unit from the repo (opt-in): picks up unit file changes
# that ship with a release.
sync_unit_file() {
    local src="${REPO_DIR}/deploy/goobster.service"
    local dest="/etc/systemd/system/${SERVICE}.service"
    if [[ ! -f "${src}" ]]; then return 0; fi
    local node_bin
    node_bin="$(command -v node || echo /usr/bin/node)"
    local rendered
    rendered="$(sed -e "s|/home/pi/goobster|${REPO_DIR}|g" \
        -e "s|User=pi|User=${RUN_USER}|" \
        -e "s|/usr/bin/node|${node_bin}|g" "${src}")"
    if [[ -f "${dest}" ]] && [[ "${rendered}" == "$(cat "${dest}")" ]]; then
        return 0
    fi
    log "Updating ${dest} from ${src}"
    printf '%s\n' "${rendered}" >"${dest}"
}

run_install() {
    log "Running install step: ${INSTALL_CMD}"
    as_user bash -c "cd $(printf '%q' "${REPO_DIR}") && ${INSTALL_CMD}"
}

checkout_and_install() {
    local sha="$1"
    run_git reset --hard "${sha}"
    if [[ "${GIT_CLEAN}" == "true" ]]; then
        # -x is deliberately omitted: config.json, data/, cache/, and logs/ are
        # gitignored and must survive a deploy.
        run_git clean -fd
    fi
    run_install
}

start_service() {
    if [[ "${SYNC_UNIT}" == "true" ]]; then sync_unit_file; fi
    log "Reloading systemd and starting ${SERVICE}"
    "${SYSTEMCTL[@]}" daemon-reload
    "${SYSTEMCTL[@]}" start "${SERVICE}"
}

# --- Detect ----------------------------------------------------------------

log "Checking ${REMOTE}/${BRANCH} for updates (repo=${REPO_DIR}, user=${RUN_USER})"
run_git fetch --prune --quiet "${REMOTE}" "${BRANCH}" \
    || die "git fetch from ${REMOTE} failed"

CURRENT_SHA="$(run_git rev-parse HEAD)"
TARGET_SHA="$(run_git rev-parse "${REMOTE}/${BRANCH}")"

if [[ "${CURRENT_SHA}" == "${TARGET_SHA}" && "${FORCE}" != "true" ]]; then
    log "Already up to date at $(short "${CURRENT_SHA}")"
    exit 0
fi

if [[ "${CHECK_ONLY}" == "true" ]]; then
    log "Update available: $(short "${CURRENT_SHA}") -> $(short "${TARGET_SHA}")"
    run_git log --oneline "${CURRENT_SHA}..${TARGET_SHA}" || true
    exit 10
fi

if [[ "${REQUIRE_CI}" == "true" ]]; then
    set +e
    ci_status "${TARGET_SHA}"
    ci_result=$?
    set -e
    case "${ci_result}" in
        0) log "CI checks passed for $(short "${TARGET_SHA}")" ;;
        1) log "Skipping $(short "${TARGET_SHA}"): CI checks failed"; exit 0 ;;
        *) log "Skipping $(short "${TARGET_SHA}") for now: CI checks are not complete"; exit 0 ;;
    esac
fi

# --- Deploy ----------------------------------------------------------------

if ! touch "${LOCK_FILE}" 2>/dev/null; then
    LOCK_FILE="${TMPDIR:-/tmp}/goobster-update.lock"
fi
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
    log "Another update is already running (${LOCK_FILE}); nothing to do"
    exit 0
fi

SUBJECT="$(run_git log -1 --pretty=%s "${TARGET_SHA}" 2>/dev/null || echo '')"
log "Deploying $(short "${CURRENT_SHA}") -> $(short "${TARGET_SHA}") (${SUBJECT})"

log "Stopping ${SERVICE}"
"${SYSTEMCTL[@]}" stop "${SERVICE}" || die "could not stop ${SERVICE}"

DEPLOY_OK=true
if ! checkout_and_install "${TARGET_SHA}"; then
    log "Install step failed for $(short "${TARGET_SHA}")"
    DEPLOY_OK=false
fi

if [[ "${DEPLOY_OK}" == "true" ]]; then
    if ! start_service; then
        log "Could not start ${SERVICE} on $(short "${TARGET_SHA}")"
        DEPLOY_OK=false
    elif ! wait_for_health; then
        DEPLOY_OK=false
    fi
fi

if [[ "${DEPLOY_OK}" == "true" ]]; then
    log "Deployed $(short "${TARGET_SHA}") successfully"
    notify ":white_check_mark: Goobster deployed \`$(short "${TARGET_SHA}")\` on $(hostname): ${SUBJECT}"
    exit 0
fi

if [[ "${ROLLBACK}" != "true" ]]; then
    notify ":x: Goobster deploy of \`$(short "${TARGET_SHA}")\` failed on $(hostname) and rollback is disabled."
    die "deploy failed and rollback is disabled" 2
fi

# --- Rollback --------------------------------------------------------------

log "Rolling back to $(short "${CURRENT_SHA}")"
"${SYSTEMCTL[@]}" stop "${SERVICE}" || true

if ! checkout_and_install "${CURRENT_SHA}"; then
    notify ":rotating_light: Goobster rollback to \`$(short "${CURRENT_SHA}")\` FAILED on $(hostname). The bot is down."
    die "rollback install failed - ${SERVICE} is down" 2
fi
if ! start_service || ! wait_for_health; then
    notify ":rotating_light: Goobster rollback to \`$(short "${CURRENT_SHA}")\` FAILED on $(hostname). The bot is down."
    die "rollback failed - ${SERVICE} is down" 2
fi

log "Rolled back to $(short "${CURRENT_SHA}")"
notify ":warning: Goobster deploy of \`$(short "${TARGET_SHA}")\` failed on $(hostname); rolled back to \`$(short "${CURRENT_SHA}")\`."
exit 1
