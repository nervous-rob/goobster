#!/bin/bash
#
# SessionStart hook for Claude Code cloud sessions.
#
# The environment's setup script (scripts/cloud-setup.sh) installs everything
# into the cached container, but running servers don't survive the snapshot,
# and the lockfile may have moved on since the cache was made. So on each
# session start this:
#   1. reinstalls npm dependencies only when a manifest changed since the
#      last successful install (hash kept inside node_modules), and
#   2. starts the local Postgres cluster if it is installed (best-effort; a
#      failure warns and never blocks the session).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

hashes=node_modules/.session-start.sha256
if ! sha256sum --check --status "$hashes" 2>/dev/null; then
    rm -f "$hashes"
    # npm ci, not npm install: it never rewrites package-lock.json.
    # Chromium is pre-installed in the cloud image; skip Playwright's download.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefer-offline --no-audit --no-fund
    sha256sum .claude/hooks/session-start.sh package.json package-lock.json \
        apps/*/package.json packages/*/package.json 2>/dev/null > "$hashes" || rm -f "$hashes"
fi

if command -v pg_isready >/dev/null 2>&1 \
    && ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 \
    && ls /usr/lib/postgresql/*/bin/postgres >/dev/null 2>&1; then
    bash scripts/ensure-local-postgres.sh start >/dev/null 2>&1 \
        || echo "session-start: local Postgres did not start; run scripts/ensure-local-postgres.sh start" >&2
fi
