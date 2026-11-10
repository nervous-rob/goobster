#!/usr/bin/env bash
# Install Playwright's Chromium and its system packages in a CI job, without
# depending on the Ubuntu mirror when the packages are already in a cache.
#
#   scripts/ci-playwright-chromium.sh <cache-dir>
#
# `npx playwright install --with-deps chromium` does three things: `apt-get
# update`, `apt-get install` of Chromium's libraries and fonts, and the
# browser download. On a GitHub runner the libraries are already there and
# the install is nine font packages (21 MB). The step takes about 22 seconds,
# but on 2026-11-10 the runner's mirror served those packages at about
# 100 kB/s to four jobs and it took between 1.5 and 4 minutes.
#
# With .deb files in <cache-dir> (saved by an earlier run on the same runner
# image and Playwright version):
#   1. `apt-get update`, given a time limit. If the mirror stalls, the package
#      lists already on the runner are used.
#   2. Each cached file must have the SHA-256 the signed package index gives
#      for that package and version, so it is byte for byte the file apt
#      would download.
#   3. `apt-get install --no-download` of those packages. apt still picks the
#      version; if that is not the cached one, it fails here.
#   4. Playwright's own check, `install --with-deps --dry-run`: it exits 0
#      only when the command this step used to run would install or upgrade
#      nothing.
#   5. `npx playwright install chromium`: the same browser download as before.
#
# With no cache, or if any of 1 to 5 fails, the step runs the command it has
# always run, `npx playwright install --with-deps chromium`, with no time
# limit (and once more if it fails), and then saves the packages that command
# installed for the next run. Nothing here can make the job fail that the old
# command would not.
set -uo pipefail

CACHE_DIR="${1:?usage: ci-playwright-chromium.sh <cache-dir>}"
ARCHIVES="${PW_APT_ARCHIVES:-/var/cache/apt/archives}"
UPDATE_TIMEOUT="${PW_APT_UPDATE_TIMEOUT:-45}"
DOWNLOAD_TIMEOUT="${PW_APT_DOWNLOAD_TIMEOUT:-60}"
RETRY_WAIT="${PW_INSTALL_RETRY_WAIT:-15}"
STARTED=$SECONDS

log() { echo "[chromium-install] $*"; }
output() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi; }
summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$*" >> "$GITHUB_STEP_SUMMARY"; fi; }

# What the journeys render with: every font file on the machine, by content.
# The cached path and the old command must print the same line on one image.
fingerprint() {
    command -v fc-list > /dev/null 2>&1 || return 0
    local files count digest
    files="$(fc-list --format '%{file}\n' 2> /dev/null | sort -u)"
    count="$(grep -c . <<< "$files" || true)"
    digest="$(xargs -r -d '\n' sha256sum <<< "$files" 2> /dev/null | sha256sum | cut -c1-16)"
    log "fonts: ${count} files, sha256 ${digest}"
}

finish() {
    local how="$1"
    fingerprint
    log "done in $((SECONDS - STARTED))s (${how})"
    summary "Chromium install: $((SECONDS - STARTED))s, ${how}"
    output path "$how"
}

# Installed packages only; dpkg-query also lists removed ones that left
# configuration files behind.
installed_packages() {
    dpkg-query -W -f='${db:Status-Abbrev}${binary:Package}=${Version}\n' | sed -n 's/^ii *//p' | sort
}

full_install() {
    npx playwright install --with-deps chromium && return 0
    log "the full install failed; trying once more in ${RETRY_WAIT}s"
    sleep "$RETRY_WAIT"
    npx playwright install --with-deps chromium
}

# Exit 0 only when `install --with-deps` would install or upgrade no system
# package. The sentence is checked as well as the exit code: a Playwright
# that reports this some other way must not pass as "nothing missing".
system_packages_complete() {
    local report
    report="$(npx playwright install --with-deps --dry-run chromium 2>&1)" || return 1
    grep -q 'All system dependencies are installed' <<< "$report"
}

install_from_cache() {
    local debs=("$CACHE_DIR"/*.deb)
    [ -e "${debs[0]}" ] || return 1

    local began=$SECONDS
    if sudo timeout --kill-after=10 "$UPDATE_TIMEOUT" apt-get update -qq; then
        log "apt-get update: $((SECONDS - began))s"
    else
        log "apt-get update did not finish within ${UPDATE_TIMEOUT}s; using the package lists already on the runner"
    fi

    local names=() deb name version expected actual
    for deb in "${debs[@]}"; do
        name="$(dpkg-deb -f "$deb" Package)" && version="$(dpkg-deb -f "$deb" Version)" || return 1
        expected="$(apt-cache show "${name}=${version}" 2> /dev/null | sed -n 's/^SHA256: //p' | head -n 1)"
        actual="$(sha256sum "$deb" | cut -d' ' -f1)"
        if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
            log "$(basename "$deb") is not the file the package index lists for ${name} ${version}"
            return 1
        fi
        names+=("$name")
    done

    # apt writes a lock and a partial/ folder as root next to the files it
    # reads; keep those out of the folder the cache action saves.
    local work
    work="$(mktemp -d)" || return 1
    mkdir -p "$work/partial" && cp "${debs[@]}" "$work/" || return 1

    began=$SECONDS
    sudo apt-get install -y --no-install-recommends --no-download \
        -o "Dir::Cache::archives=$work/" "${names[@]}" || return 1
    log "${#names[@]} packages installed from the cache: $((SECONDS - began))s"

    system_packages_complete
}

# After the full install: copy into the cache folder exactly the packages and
# versions it added. apt-get leaves the files it downloaded in its archive
# folder; one that is not there is downloaded again, with a time limit. Best
# effort: without it the next run simply does the full install again.
save_for_next_run() {
    local before="$1" changed staging entry name version missing=()
    changed="$(comm -13 <(echo "$before") <(installed_packages))"
    if [ -z "$changed" ]; then
        log "the full install added no system package; nothing to cache"
        return 0
    fi
    staging="$(mktemp -d)" || return 0
    for entry in $changed; do
        name="${entry%%=*}"
        name="${name%%:*}"
        version="${entry#*=}"
        cp "$ARCHIVES/${name}_${version//:/%3a}_"*.deb "$staging/" 2> /dev/null || missing+=("$entry")
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        if ! (cd "$staging" && timeout --kill-after=10 "$DOWNLOAD_TIMEOUT" apt-get download "${missing[@]}" > /dev/null); then
            log "could not collect the packages for the cache; the next run does the full install"
            return 0
        fi
    fi
    mkdir -p "$CACHE_DIR" && rm -f "$CACHE_DIR"/*.deb && mv "$staging"/*.deb "$CACHE_DIR"/ || return 0
    log "saved $(wc -l <<< "$changed") packages for the next run"
    output harvested true
}

had_cache=false
cached=("$CACHE_DIR"/*.deb)
if [ -e "${cached[0]}" ]; then
    had_cache=true
    log "${#cached[@]} cached packages in $CACHE_DIR"
    if install_from_cache && npx playwright install chromium; then
        finish "system packages from the cache"
        exit 0
    fi
    log "the install from the cache did not complete; running the full install"
fi

before="$(installed_packages)"
full_install || exit $?
if [ "$had_cache" = false ]; then
    save_for_next_run "$before"
    finish "full install, no cache"
else
    finish "full install, cache not usable"
fi
