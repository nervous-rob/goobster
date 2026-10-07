#!/usr/bin/env bash
# Install, run, reconfigure, repair and uninstall Goobster through the Linux
# bootstrapper (documentation/linux_install.md, issue #333) on a machine you
# are willing to change. It needs root and, for the service half of the proof,
# a booted systemd. .github/workflows/linux-bootstrap.yml runs it on GitHub's
# ubuntu-24.04 and ubuntu-24.04-arm runners.
#
#   sudo bash scripts/linux-bootstrap-proof.sh --run <goobster-*.run> --payload <dir> --work <dir> [--reports <dir>] [--no-systemd]
#
# --payload is the directory the .run was built from (repair needs a source).
# --work is where the roots go; the code root and the data root are in
#   different directories and every directory name holds a space.
# --no-systemd runs the same journey without a booted systemd: the install must
#   then finish through the documented manual fallback, and the supervisor is
#   started by hand as the service account. That is the only mode that can run
#   in a container or a VM without systemd; it proves everything except
#   `systemctl enable --now`.
#
# Creates the `goobster` account (and leaves it) and, with systemd, the
# unit /etc/systemd/system/goobster.service (removed again by the uninstall).

set -euo pipefail

RUN_FILE=""
PAYLOAD=""
WORK=""
REPORTS=""
SYSTEMD=1
while [ $# -gt 0 ]; do
    case "$1" in
        --run) RUN_FILE="$2"; shift 2 ;;
        --payload) PAYLOAD="$2"; shift 2 ;;
        --work) WORK="$2"; shift 2 ;;
        --reports) REPORTS="$2"; shift 2 ;;
        --no-systemd) SYSTEMD=0; shift ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
[ -n "$RUN_FILE" ] && [ -n "$PAYLOAD" ] && [ -n "$WORK" ] || { echo "usage: --run <file> --payload <dir> --work <dir> [--reports <dir>] [--no-systemd]" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 2; }
RUN_FILE=$(readlink -f "$RUN_FILE")
PAYLOAD=$(readlink -f "$PAYLOAD")
mkdir -p "$WORK"
WORK=$(readlink -f "$WORK")
REPORTS=${REPORTS:-$WORK/reports}
mkdir -p "$REPORTS"

CODE="$WORK/opt goobster/code root"
BASE="$WORK/state dir"
DATA="$BASE/data"
CONFIG="$BASE/config/config.json"
CACHE="$BASE/cache"
LOGS="$BASE/logs"
STORE="$DATA/manager"
SERVICE=goobster
UNIT="/etc/systemd/system/$SERVICE.service"
API_PORT=3100
MANAGER_PORT=3400
ANSWERS="$WORK/answers.json"
SUPERVISOR_PID=""

PASSED=0
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { PASSED=$((PASSED + 1)); echo "PASS: $*"; }
check() { local what=$1; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }
group() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; else echo "== $*"; fi; }
endgroup() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi; }

wait_for() { # <seconds> <description> <command...>
    local limit=$1 what=$2
    shift 2
    local waited=0
    until "$@" >/dev/null 2>&1; do
        waited=$((waited + 1))
        [ "$waited" -le "$limit" ] || fail "timed out after ${limit}s waiting for $what"
        sleep 1
    done
}

cleanup() {
    if [ "$SYSTEMD" -eq 1 ] && command -v journalctl >/dev/null; then
        journalctl -u "$SERVICE" --no-pager -n 300 > "$REPORTS/journal-$SERVICE.log" 2>&1 || true
    fi
    if [ -n "$SUPERVISOR_PID" ] && kill -0 "$SUPERVISOR_PID" 2>/dev/null; then kill -TERM "$SUPERVISOR_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

write_private() { # <file> <json>
    printf '%s\n' "$2" > "$1"
    chown root:root "$1"
    chmod 600 "$1"
}

json_roots() { # <logs root>
    printf '{"code":"%s","data":"%s","config":"%s","cache":"%s","logs":"%s","managerStore":"%s"}' "$CODE" "$DATA" "$CONFIG" "$CACHE" "$1" "$STORE"
}

manager() { env GOOBSTER_PAYLOAD_DEV_UNSIGNED=1 "$CODE/current/bin/goobster-manager" "$@"; }
install_run() { sh "$RUN_FILE" --headless --answers "$ANSWERS" --yes; }
service_active() { [ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" = active ]; }
health_ok() { curl -fsS -m 5 "http://127.0.0.1:$API_PORT/health" | grep -q '"status":"healthy"'; }
manager_up() { [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$MANAGER_PORT/manager/")" = 200 ]; }
unit_count() { { grep -l 'X-Goobster-Installation=' /etc/systemd/system/*.service 2>/dev/null || true; } | wc -l | tr -d ' '; }
installation_id() { jq -r .installationId "$STORE/installation.json"; }

start_supervisor_by_hand() { # the manual-fallback path: what an operator does after the notice
    (cd / && exec setpriv --reuid=goobster --regid=goobster --init-groups "$CODE/current/bin/goobster-manager" --supervise) > "$REPORTS/manual-supervisor.log" 2>&1 &
    SUPERVISOR_PID=$!
}
stop_supervisor_by_hand() {
    [ -n "$SUPERVISOR_PID" ] || return 0
    kill -TERM "$SUPERVISOR_PID" 2>/dev/null || true
    wait_for 60 "the supervisor to stop" bash -c "! kill -0 $SUPERVISOR_PID 2>/dev/null"
    SUPERVISOR_PID=""
}

group "environment"
uname -a
echo "systemd mode: $SYSTEMD"
[ "$SYSTEMD" -eq 0 ] || [ -d /run/systemd/system ] || fail "systemd is not running here; pass --no-systemd for the fallback journey"
if [ "$SYSTEMD" -eq 1 ]; then systemctl --version | head -1; fi
for tool in curl jq setpriv useradd; do command -v "$tool" >/dev/null || fail "$tool is needed by this script"; done
if getent passwd goobster >/dev/null; then echo "the goobster account already exists"; fi
endgroup

write_private "$ANSWERS" "{\"ownerLabel\":\"linux bootstrap proof\",\"roots\":$(json_roots "$LOGS")}"

group "1. interrupted install, then the same command again"
setsid sh "$RUN_FILE" --headless --answers "$ANSWERS" --yes > "$REPORTS/install-interrupted.log" 2>&1 &
INTERRUPTED=$!
wait_for 120 "the install to reach the stage step" grep -q '^\[install.new\] stage' "$REPORTS/install-interrupted.log"
sleep 1
kill -KILL -- "-$INTERRUPTED" 2>/dev/null || true
wait "$INTERRUPTED" 2>/dev/null || true
check "the install was killed before the payload was activated" test ! -e "$CODE/current"
check "no unit exists after the interruption" test "$(unit_count)" = 0
install_run > "$REPORTS/install-resumed.log" 2>&1 || { tail -30 "$REPORTS/install-resumed.log"; fail "the install did not finish when run again"; }
pass "the same command finished the install"
check "the payload is activated" test -x "$CODE/current/bin/goobster-manager"
endgroup

group "2. what the install left behind"
check "the code root and the data root are different trees" bash -c '[ "$1" != "$2" ] && [ "${2#"$1"/}" = "$2" ]' _ "$CODE" "$DATA"
check "the database is in the data root" test -f "$DATA/goobster.sqlite"
check "no database is in the code root" test -z "$(find "$CODE" -name '*.sqlite' | head -1)"
check "the service account owns the data root" test "$(stat -c %U "$DATA")" = goobster
check "the code root is not writable by the service account" bash -c '! setpriv --reuid=goobster --regid=goobster --init-groups test -w "$1/current"' _ "$CODE"
check "the installation record exists" test -f "$STORE/installation.json"
if [ "$SYSTEMD" -eq 1 ]; then
    check "the unit file exists" test -f "$UNIT"
    check "the unit names its installation" grep -q '^X-Goobster-Installation=' "$UNIT"
    check "one unit of this installation" test "$(unit_count)" = 1
    check "the unit carries every mutable root" bash -c 'for p in "$@"; do grep -qF "ReadWritePaths=\"$p\"" "'"$UNIT"'" || exit 1; done' _ "$DATA" "$CACHE" "$LOGS"
    systemd-analyze verify "$UNIT" || fail "systemd-analyze verify rejected the unit"
    pass "systemd-analyze verify accepts the unit"
    wait_for 90 "the service to become active" systemctl is-active --quiet "$SERVICE"
    pass "systemctl enable --now left the service active"
    check "the service is enabled for boot" test "$(systemctl is-enabled "$SERVICE")" = enabled
    PID=$(systemctl show -p MainPID --value "$SERVICE")
    check "the manager runs as the service account" test "$(ps -o user= -p "$PID" | tr -d ' ')" = goobster
else
    check "the install finished through the documented manual fallback" grep -q 'was not registered with the operating system' "$REPORTS/install-resumed.log"
    check "the fallback unit text was written to the store" test -f "$STORE/goobster.service"
    systemd-analyze verify "$STORE/goobster.service" 2>&1 | grep -v '^$' || true
    start_supervisor_by_hand
fi
wait_for 120 "the api to answer /health" health_ok
pass "/health answers from the installed api"
wait_for 60 "the manager to serve /manager/" manager_up
pass "the manager answers on 127.0.0.1:$MANAGER_PORT"
if command -v ss >/dev/null; then
    ss -ltnp > "$REPORTS/listeners.txt" || true
    LISTENING=$(ss -H -ltn "sport = :$MANAGER_PORT" | awk '{print $4}' | sort -u)
    check "the manager listens on the loopback address only" test "$LISTENING" = "127.0.0.1:$MANAGER_PORT"
else
    echo "NOTE: ss is not installed; the loopback bind of the manager was not checked"
fi
endgroup

group "3. the same install command again changes nothing"
install_run > "$REPORTS/install-again.log" 2>&1 || { tail -30 "$REPORTS/install-again.log"; fail "running the install again failed"; }
pass "running the install again exits 0"
if [ "$SYSTEMD" -eq 1 ]; then
    check "still exactly one unit" test "$(unit_count)" = 1
    check "the service is still active" service_active
fi
check "/health still answers" health_ok
endgroup

group "4. repair"
write_private "$WORK/repair.json" "{\"source\":\"$PAYLOAD\",\"release\":{\"allowUnsigned\":true}}"
manager repair --answers "$WORK/repair.json" --yes > "$REPORTS/repair.log" 2>&1 || { tail -30 "$REPORTS/repair.log"; fail "repair failed"; }
pass "repair finished"
check "/health answers after the repair" health_ok
endgroup

group "5. reconfigure (the logs root moves, the unit is rewritten)"
MOVED_LOGS="$BASE/logs moved"
if [ "$SYSTEMD" -eq 0 ]; then
    stop_supervisor_by_hand
    # With a registered service the helper creates and hands over a new root; by hand that is the operator's step.
    install -d -o goobster -g goobster -m 0750 "$MOVED_LOGS"
fi
write_private "$WORK/reconfigure.json" "{\"roots\":{\"logs\":\"$MOVED_LOGS\"}}"
manager reconfigure --answers "$WORK/reconfigure.json" --yes > "$REPORTS/reconfigure.log" 2>&1 || { tail -30 "$REPORTS/reconfigure.log"; fail "reconfigure failed"; }
pass "reconfigure finished"
if [ "$SYSTEMD" -eq 1 ]; then
    check "the unit names the new logs root" grep -qF "ReadWritePaths=\"$MOVED_LOGS\"" "$UNIT"
    check "the new logs root exists and belongs to the service account" test "$(stat -c %U "$MOVED_LOGS")" = goobster
    check "still exactly one unit" test "$(unit_count)" = 1
    systemctl restart "$SERVICE"
    wait_for 90 "the service to be active after the restart" systemctl is-active --quiet "$SERVICE"
    pass "the service restarted on the rewritten unit"
else
    start_supervisor_by_hand
fi
wait_for 120 "the api to answer /health" health_ok
pass "/health answers after the reconfigure"
endgroup

group "6. uninstall, keeping the data"
ID=$(installation_id)
write_private "$WORK/uninstall-keep.json" '{"keepData":true}'
if [ "$SYSTEMD" -eq 0 ]; then stop_supervisor_by_hand; fi
manager uninstall --answers "$WORK/uninstall-keep.json" --yes > "$REPORTS/uninstall-keep.log" 2>&1 || { tail -30 "$REPORTS/uninstall-keep.log"; fail "the keep-data uninstall failed"; }
pass "the keep-data uninstall finished"
check "the payload is gone" test ! -e "$CODE/current"
check "the data is kept" test -f "$DATA/goobster.sqlite"
if [ "$SYSTEMD" -eq 1 ]; then
    check "the unit file is gone" test ! -e "$UNIT"
    check "the service is not running" bash -c '! systemctl is-active --quiet '"$SERVICE"
    check "no unit of this installation is left" test "$(unit_count)" = 0
fi
if [ "$SYSTEMD" -eq 1 ]; then
    check "nothing answers on the api port" bash -c '! curl -fsS -m 3 http://127.0.0.1:'"$API_PORT"'/health'
fi
endgroup

group "7. install again over the kept data, then uninstall and delete the data"
write_private "$ANSWERS" "{\"ownerLabel\":\"linux bootstrap proof\",\"roots\":$(json_roots "$MOVED_LOGS")}"
install_run > "$REPORTS/install-after-keep.log" 2>&1 || { tail -30 "$REPORTS/install-after-keep.log"; fail "installing over kept data failed"; }
pass "the install over the kept data finished"
if [ "$SYSTEMD" -eq 1 ]; then
    wait_for 90 "the service to be active" systemctl is-active --quiet "$SERVICE"
else
    start_supervisor_by_hand
fi
wait_for 120 "the api to answer /health" health_ok
pass "/health answers again"
ID=$(installation_id)
write_private "$WORK/uninstall-all.json" '{"keepData":false}'
if [ "$SYSTEMD" -eq 0 ]; then stop_supervisor_by_hand; fi
manager uninstall --answers "$WORK/uninstall-all.json" --delete-data --confirm "$ID" --yes > "$REPORTS/uninstall-all.log" 2>&1 || { tail -30 "$REPORTS/uninstall-all.log"; fail "the delete-data uninstall failed"; }
pass "the delete-data uninstall finished"
check "the database is gone" test ! -e "$DATA/goobster.sqlite"
check "the payload is gone" test ! -e "$CODE/current"
if [ "$SYSTEMD" -eq 1 ]; then
    check "the unit file is gone" test ! -e "$UNIT"
    check "no unit of this installation is left" test "$(unit_count)" = 0
fi
endgroup

echo "linux bootstrap proof: $PASSED checks passed (systemd=$SYSTEMD)"
