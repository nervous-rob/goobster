#!/usr/bin/env bash
#
# Idempotent local Postgres + pgvector for the CI postgres matrix.
#
# Installs PostgreSQL 17 (PGDG) when possible, otherwise Ubuntu's 16, creates
# the goobster role/database/extensions, and starts the cluster. Safe to rerun.
# Does not export GOOBSTER_DB_URL — `npm test` stays on throwaway SQLite;
# use `npm run test:postgres` (or the env vars below) for the engine-parity
# suite.
#
# Usage:
#   ./scripts/ensure-local-postgres.sh           # install + start
#   ./scripts/ensure-local-postgres.sh install   # packages only
#   ./scripts/ensure-local-postgres.sh start     # start cluster, role, db, wait
#
# Connection (matches .github/workflows/ci.yml):
#   postgres://goobster:goobster@127.0.0.1:5432/goobster

set -euo pipefail

ROLE="${GOOBSTER_PG_USER:-goobster}"
PASSWORD="${GOOBSTER_PG_PASSWORD:-goobster}"
DATABASE="${GOOBSTER_PG_DATABASE:-goobster}"
HOST="${GOOBSTER_PG_HOST:-127.0.0.1}"
PORT="${GOOBSTER_PG_PORT:-5432}"

need_sudo() {
    if [[ "$(id -u)" -eq 0 ]]; then
        "$@"
    else
        sudo -n "$@"
    fi
}

pg_as_superuser() {
    need_sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"
}

detect_version() {
    if [[ -x /usr/lib/postgresql/17/bin/postgres ]]; then
        echo 17
    elif [[ -x /usr/lib/postgresql/16/bin/postgres ]]; then
        echo 16
    else
        echo ""
    fi
}

install_packages() {
    if [[ -n "$(detect_version)" ]] && command -v pg_isready >/dev/null 2>&1 \
        && dpkg -s "postgresql-$(detect_version)-pgvector" >/dev/null 2>&1; then
        echo "==> Postgres $(detect_version) + pgvector already installed"
        return 0
    fi

    echo "==> Installing Postgres + pgvector"
    need_sudo apt-get update -y
    need_sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        postgresql-common ca-certificates

    if [[ ! -x /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh ]]; then
        echo "ERROR: postgresql-common did not ship the PGDG helper." >&2
        exit 1
    fi
    need_sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y

    if ! need_sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        postgresql-17 postgresql-17-pgvector; then
        echo "==> Postgres 17 unavailable; falling back to Ubuntu postgresql-16-pgvector"
        need_sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
            postgresql-16 postgresql-16-pgvector
    fi

    local version
    version="$(detect_version)"
    if [[ -z "${version}" ]]; then
        echo "ERROR: Postgres install finished but no cluster binary was found." >&2
        exit 1
    fi
    echo "==> Installed Postgres ${version} + pgvector"
}

ensure_cluster() {
    local version="$1"
    if need_sudo pg_lsclusters --no-header | awk -v v="${version}" '$1 == v && $2 == "main" { found=1 } END { exit found ? 0 : 1 }'; then
        return 0
    fi
    echo "==> Creating Postgres ${version} main cluster"
    need_sudo pg_createcluster "${version}" main
}

start_cluster() {
    local version="$1"
    ensure_cluster "${version}"

    local status
    status="$(need_sudo pg_lsclusters --no-header | awk -v v="${version}" '$1 == v && $2 == "main" { print $4; exit }')"
    if [[ "${status}" == "online" ]]; then
        echo "==> Postgres ${version} main is already online"
        return 0
    fi

    echo "==> Starting Postgres ${version} main"
    # Cloud Agent VMs often have systemd "offline"; pg_ctlcluster falls back to pg_ctl.
    if ! need_sudo pg_ctlcluster "${version}" main start; then
        local data_dir
        data_dir="$(need_sudo pg_lsclusters --no-header | awk -v v="${version}" '$1 == v && $2 == "main" { print $6; exit }')"
        if [[ -z "${data_dir}" ]]; then
            echo "ERROR: Could not start Postgres ${version} and no data directory was listed." >&2
            exit 1
        fi
        need_sudo -u postgres /usr/lib/postgresql/"${version}"/bin/pg_ctl \
            -D "${data_dir}" -l /tmp/postgresql-"${version}"-main.log start
    fi
}

wait_ready() {
    local i
    for i in $(seq 1 40); do
        if pg_isready -h "${HOST}" -p "${PORT}" >/dev/null 2>&1; then
            echo "==> Postgres is accepting connections on ${HOST}:${PORT}"
            return 0
        fi
        sleep 0.25
    done
    echo "ERROR: Postgres did not become ready on ${HOST}:${PORT}." >&2
    need_sudo pg_lsclusters || true
    exit 1
}

ensure_role_and_db() {
    if ! pg_as_superuser -tAc "SELECT 1 FROM pg_roles WHERE rolname='${ROLE}'" | grep -q 1; then
        echo "==> Creating role ${ROLE}"
        pg_as_superuser -c "CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'"
    else
        pg_as_superuser -c "ALTER ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'"
    fi

    if ! pg_as_superuser -tAc "SELECT 1 FROM pg_database WHERE datname='${DATABASE}'" | grep -q 1; then
        echo "==> Creating database ${DATABASE}"
        need_sudo -u postgres createdb -O "${ROLE}" "${DATABASE}"
    fi

    pg_as_superuser -d "${DATABASE}" -c "CREATE EXTENSION IF NOT EXISTS vector;"
    pg_as_superuser -d "${DATABASE}" -c "CREATE EXTENSION IF NOT EXISTS citext;"
}

cmd="${1:-all}"
case "${cmd}" in
    install)
        install_packages
        ;;
    start)
        version="$(detect_version)"
        if [[ -z "${version}" ]]; then
            echo "ERROR: Postgres is not installed. Run: $0 install" >&2
            exit 1
        fi
        start_cluster "${version}"
        wait_ready
        ensure_role_and_db
        echo "==> Ready: postgres://${ROLE}@${HOST}:${PORT}/${DATABASE}"
        ;;
    all|"")
        install_packages
        version="$(detect_version)"
        start_cluster "${version}"
        wait_ready
        ensure_role_and_db
        echo "==> Ready: postgres://${ROLE}@${HOST}:${PORT}/${DATABASE}"
        ;;
    *)
        echo "Usage: $0 [install|start|all]" >&2
        exit 2
        ;;
esac
