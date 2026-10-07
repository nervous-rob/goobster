#!/usr/bin/env bash
# Install, run, reconfigure, repair and uninstall Goobster through the macOS
# bootstrapper (documentation/macos_install.md, issue #332) on a Mac you are
# willing to change. It needs administrator rights (sudo) and a logged-in
# graphical session for the per-user half. .github/workflows/macos-bootstrap.yml
# runs it on GitHub's macos-15 (Apple silicon) and macos-15-intel runners.
#
#   sudo bash scripts/macos-bootstrap-proof.sh --pkg <goobster-*.pkg> --tarball <goobster-*.tar.gz> \
#        --payload <dir> --work <dir> [--reports <dir>] [--person <login>]
#
# --pkg        the installer package (the machine-wide, headless journey).
# --tarball    the per-user archive (install.command, a LaunchAgent).
# --payload    the directory the artifacts were built from (repair needs a source).
# --work       where the roots go. It must be readable by every account (use a
#              folder under /Users/Shared); every directory name holds a space
#              and a non-ASCII letter.
# --person     the account the per-user journey runs as (default: $SUDO_USER).
#
# Changes the machine: creates the hidden `_goobster` account and the daemon
# /Library/LaunchDaemons/io.goobster.goobster.plist, and writes
# /etc/goobster-answers.json and /var/log/goobster-*.log. The journey removes
# the daemon and the files again; it removes the account last, with the same
# two dscl commands documentation/macos_install.md gives (the uninstall itself
# never deletes an account).
#
# Written for the bash 3.2 that macOS ships.

set -euo pipefail

PKG=""
TARBALL=""
PAYLOAD=""
WORK=""
REPORTS=""
PERSON="${SUDO_USER:-}"
while [ $# -gt 0 ]; do
    case "$1" in
        --pkg) PKG="$2"; shift 2 ;;
        --tarball) TARBALL="$2"; shift 2 ;;
        --payload) PAYLOAD="$2"; shift 2 ;;
        --work) WORK="$2"; shift 2 ;;
        --reports) REPORTS="$2"; shift 2 ;;
        --person) PERSON="$2"; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
[ -n "$PKG" ] && [ -n "$TARBALL" ] && [ -n "$PAYLOAD" ] && [ -n "$WORK" ] || { echo "usage: --pkg <file> --tarball <file> --payload <dir> --work <dir> [--reports <dir>] [--person <login>]" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo "this journey runs on macOS" >&2; exit 2; }
[ -n "$PERSON" ] && [ "$PERSON" != root ] || { echo "name the person account with --person (a non-root login)" >&2; exit 2; }

absolute() { (cd "$1" && pwd -P); }
absolute_file() { printf '%s/%s' "$(absolute "$(dirname "$1")")" "$(basename "$1")"; }
PKG=$(absolute_file "$PKG")
TARBALL=$(absolute_file "$TARBALL")
PAYLOAD=$(absolute "$PAYLOAD")
mkdir -p "$WORK"
WORK=$(absolute "$WORK")
REPORTS=${REPORTS:-$WORK/reports}
mkdir -p "$REPORTS"

PERSON_UID=$(id -u "$PERSON")
PERSON_HOME=$(dscl . -read "/Users/$PERSON" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')

ACCOUNT=_goobster
LABEL=io.goobster.goobster
PLIST="/Library/LaunchDaemons/$LABEL.plist"
CODE="$WORK/opt göobster/code root"
BASE="$WORK/state dir"
DATA="$BASE/data"
CONFIG="$BASE/config/config.json"
CACHE="$BASE/cache"
LOGS="$BASE/logs"
STORE="$DATA/manager"
ANSWERS_FILE=/etc/goobster-answers.json
API_PORT=3100
MANAGER_PORT=3400
USER_BASE="$PERSON_HOME/Library/Application Support/Goobster ünï proof"
USER_PLIST="$PERSON_HOME/Library/LaunchAgents/$LABEL.plist"
TARGET_DIR="$WORK/tarball ünpacked"
LISTENER_PID=""
OLD_PID=""

PASSED=0
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { PASSED=$((PASSED + 1)); echo "PASS: $*"; }
check() { local what=$1; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }
group() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; else echo "== $*"; fi; }
endgroup() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi; }

# What still runs or listens, for the log when a step finds something in the way.
leftovers() {
    echo "-- listeners on $API_PORT and $MANAGER_PORT:"; lsof -nP -iTCP:"$API_PORT" -iTCP:"$MANAGER_PORT" 2>/dev/null || true
    echo "-- processes of $ACCOUNT:"; ps -axo pid,ppid,pgid,user,lstart,command 2>/dev/null | grep -E "^\s*PID|$ACCOUNT" | grep -v grep || true
}
no_account_process() { ! pgrep -u "$ACCOUNT" >/dev/null 2>&1; }
# An uninstall ends with nothing of the service account running; the stop bound is 120 s.
account_processes_gone() {
    local waited=0
    until no_account_process; do
        waited=$((waited + 1))
        if [ "$waited" -gt 150 ]; then leftovers; fail "a process of $ACCOUNT is still running 150 s after the uninstall"; fi
        sleep 1
    done
    pass "no process of the service account is left"
}

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

stop_listener() {
    if [ -n "$LISTENER_PID" ] && kill -0 "$LISTENER_PID" 2>/dev/null; then kill -TERM "$LISTENER_PID" 2>/dev/null || true; fi
    LISTENER_PID=""
}

cleanup() {
    log show --last 15m --style compact --predicate 'process == "launchd" AND eventMessage CONTAINS "goobster"' > "$REPORTS/launchd-goobster.log" 2>&1 || true
    stop_listener
    rm -f "$ANSWERS_FILE"
}
trap cleanup EXIT

write_private() { # <file> <json> [owner]
    printf '%s\n' "$2" > "$1"
    chown "${3:-root:wheel}" "$1"
    chmod 600 "$1"
}

json_roots() { # <logs root>
    printf '{"code":"%s","data":"%s","config":"%s","cache":"%s","logs":"%s","managerStore":"%s"}' "$CODE" "$DATA" "$CONFIG" "$CACHE" "$1" "$STORE"
}

manager() { env GOOBSTER_PAYLOAD_DEV_UNSIGNED=1 "$CODE/current/bin/goobster-manager" "$@"; }
install_pkg() { installer -pkg "$PKG" -target / -verboseR; }
daemon_loaded() { launchctl print "system/$LABEL" >/dev/null 2>&1; }
daemon_field() { launchctl print "system/$LABEL" 2>/dev/null | sed -n "s/^[[:space:]]*$1 = //p" | head -1; }
daemon_pid() { daemon_field pid; }
restarted() { local now; now=$(daemon_pid); [ -n "$now" ] && [ "$now" != "$OLD_PID" ]; }
daemon_running() { [ "$(daemon_field state)" = running ]; }
agent_loaded() { launchctl print "gui/$PERSON_UID/$LABEL" >/dev/null 2>&1; }
health_ok() { curl -fsS -m 5 "http://127.0.0.1:$API_PORT/health" | grep -q '"status":"healthy"'; }
manager_up() { [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$MANAGER_PORT/manager/")" = 200 ]; }
plist_count() { { grep -l 'X-Goobster-Installation' /Library/LaunchDaemons/*.plist 2>/dev/null || true; } | wc -l | tr -d ' '; }
installation_id() { jq -r .installationId "$STORE/installation.json"; }
account_exists() { dscl . -read "/Users/$ACCOUNT" UniqueID >/dev/null 2>&1; }
as_person() { launchctl asuser "$PERSON_UID" sudo -u "$PERSON" -H "$@"; }

# What other launchd jobs look like: the labels loaded into the system domain that are not Apple's and not ours,
# plus the files of the two machine-wide job folders. The journey must leave both exactly as it found them.
other_jobs() {
    {
        launchctl print system | sed -n 's/^[[:space:]]*[-0-9]*[[:space:]]*[-0-9]*[[:space:]]*\([A-Za-z0-9_.-]*\)$/loaded \1/p' \
            | grep -v -e ' com\.apple\.' -e ' io\.goobster\.' -e ' application\.' -e ' 0x' || true
        ls /Library/LaunchDaemons /Library/LaunchAgents 2>/dev/null | grep -v '^io\.goobster\.' | sed 's/^/file /' || true
    } | sort -u
}

group "environment"
sw_vers
uname -m
echo "person: $PERSON ($PERSON_UID), home $PERSON_HOME"
for tool in curl jq launchctl dscl plutil lsof installer; do command -v "$tool" >/dev/null || fail "$tool is needed by this script"; done
account_exists && echo "NOTE: the $ACCOUNT account already exists; the journey keeps it until the end"
[ ! -e "$PLIST" ] || fail "$PLIST exists: another Goobster installation is on this Mac"
[ ! -e "$ANSWERS_FILE" ] || fail "$ANSWERS_FILE exists; remove it first"
launchctl print "gui/$PERSON_UID" >/dev/null 2>&1 || fail "no graphical session for $PERSON (gui/$PERSON_UID): the per-user LaunchAgent cannot be loaded"
other_jobs > "$REPORTS/jobs-before.txt"
wc -l < "$REPORTS/jobs-before.txt" | sed 's/^ *//; s/$/ other launchd entries recorded/'
endgroup

group "1. a busy wizard port is reported, nothing is installed"
"$PAYLOAD/runtime/bin/node" -e "require('net').createServer().listen($MANAGER_PORT,'127.0.0.1',()=>setInterval(()=>{},1000))" &
LISTENER_PID=$!
wait_for 20 "the stand-in listener" lsof -nP -iTCP:$MANAGER_PORT -sTCP:LISTEN
set +e
as_person env GOOBSTER_PAYLOAD_DEV_UNSIGNED=1 "$PAYLOAD/runtime/bin/node" "$PAYLOAD/app/apps/manager/bootstrap/darwin.js" --payload "$PAYLOAD" --build dev --per-user > "$REPORTS/port-conflict.log" 2>&1
STATUS=$?
set -e
check "the wizard refused with exit 3" test "$STATUS" -eq 3
check "the refusal names PORT_BUSY" grep -q '^PORT_BUSY' "$REPORTS/port-conflict.log"
check "nothing was written for the person" test ! -e "$USER_BASE"
stop_listener
wait_for 20 "the port to be free again" bash -c "! lsof -nP -iTCP:$MANAGER_PORT -sTCP:LISTEN"
endgroup

group "2. the wizard is refused as root"
set +e
env GOOBSTER_PAYLOAD_DEV_UNSIGNED=1 "$PAYLOAD/runtime/bin/node" "$PAYLOAD/app/apps/manager/bootstrap/darwin.js" --payload "$PAYLOAD" --build dev > "$REPORTS/wizard-as-root.log" 2>&1
STATUS=$?
set -e
check "the wizard as root exits 3" test "$STATUS" -eq 3
check "the refusal names WIZARD_AS_ROOT" grep -q '^WIZARD_AS_ROOT' "$REPORTS/wizard-as-root.log"
endgroup

write_private "$ANSWERS_FILE" "{\"ownerLabel\":\"macos bootstrap proof\",\"roots\":$(json_roots "$LOGS")}"

group "3. a loose answers file is refused, nothing is installed"
chmod 644 "$ANSWERS_FILE"
set +e
install_pkg > "$REPORTS/install-loose-answers.log" 2>&1
STATUS=$?
set -e
check "installer failed on the world-readable answers file" test "$STATUS" -ne 0
check "no daemon was registered" test ! -e "$PLIST"
check "no payload was activated" test ! -e "$CODE/current"
chmod 600 "$ANSWERS_FILE"
endgroup

group "4. machine-wide install: installer -pkg, headless"
install_pkg > "$REPORTS/install.log" 2>&1 || { tail -40 "$REPORTS/install.log"; tail -40 /var/log/goobster-install.log || true; fail "installer -pkg failed"; }
pass "installer -pkg finished"
cp /var/log/goobster-install.log "$REPORTS/goobster-install.log" 2>/dev/null || true
check "the payload is activated" test -x "$CODE/current/bin/goobster-manager"
check "the unpacked copy under /opt/goobster/stage is gone" test ! -e /opt/goobster/stage
endgroup

group "5. what the install left behind"
check "the code root and the data root are different trees" bash -c '[ "$1" != "$2" ] && [ "${2#"$1"/}" = "$2" ]' _ "$CODE" "$DATA"
check "the database is in the data root" test -f "$DATA/goobster.sqlite"
check "no database is in the code root" test -z "$(find "$CODE" -name '*.sqlite' | head -1)"
check "the hidden account exists" account_exists
UID_OF_ACCOUNT=$(id -u "$ACCOUNT")
check "its UniqueID is in 200-400" bash -c '[ "$1" -ge 200 ] && [ "$1" -le 400 ]' _ "$UID_OF_ACCOUNT"
check "its shell is /usr/bin/false" bash -c 'dscl . -read /Users/'"$ACCOUNT"' UserShell | grep -q "/usr/bin/false"'
check "it is hidden" bash -c 'dscl . -read /Users/'"$ACCOUNT"' IsHidden | grep -q "1"'
check "the service account owns the data root" test "$(stat -f %Su "$DATA")" = "$ACCOUNT"
check "the code root is not writable by the service account" bash -c '! sudo -u '"$ACCOUNT"' test -w "$1/current"' _ "$CODE"
check "the installation record exists" test -f "$STORE/installation.json"
check "the plist exists" test -f "$PLIST"
check "the plist is owned by root:wheel with mode 644" test "$(stat -f '%Su:%Sg %Lp' "$PLIST")" = "root:wheel 644"
plutil -lint "$PLIST" || fail "plutil -lint rejected the plist"
pass "plutil -lint accepts the plist"
check "the plist carries the label" test "$(plutil -extract Label raw -o - "$PLIST")" = "$LABEL"
check "the plist names the account" test "$(plutil -extract UserName raw -o - "$PLIST")" = "$ACCOUNT"
check "the plist names its installation" bash -c 'plutil -extract X-Goobster-Installation raw -o - "$1" | grep -q .' _ "$PLIST"
check "the plist throttles restarts" test "$(plutil -extract ThrottleInterval raw -o - "$PLIST")" = 10
check "the plist gives the manager 120 s to stop" test "$(plutil -extract ExitTimeOut raw -o - "$PLIST")" = 120
check "one plist of this installation" test "$(plist_count)" = 1
wait_for 120 "launchd to run the daemon" daemon_running
pass "launchctl print shows the daemon running"
PID=$(daemon_pid)
check "the manager runs as the service account" test "$(ps -o uid= -p "$PID" | tr -d ' ')" = "$UID_OF_ACCOUNT"
wait_for 120 "the api to answer /health" health_ok
pass "/health answers from the installed api"
wait_for 60 "the manager to serve /manager/" manager_up
pass "the manager answers on 127.0.0.1:$MANAGER_PORT"
lsof -nP -iTCP -sTCP:LISTEN > "$REPORTS/listeners.txt" || true
LISTENING=$(lsof -nP -iTCP:$MANAGER_PORT -sTCP:LISTEN -Fn | sed -n 's/^n//p' | sort -u)
check "the manager listens on the loopback address only" test "$LISTENING" = "127.0.0.1:$MANAGER_PORT"
check "the install log names no password, token or key" bash -c '! grep -Ei "password|token|BEGIN [A-Z ]*KEY" "$1"' _ "$REPORTS/goobster-install.log"
endgroup

group "6. the same install command again changes nothing"
write_private "$ANSWERS_FILE" "{\"ownerLabel\":\"macos bootstrap proof\",\"roots\":$(json_roots "$LOGS")}"
install_pkg > "$REPORTS/install-again.log" 2>&1 || { tail -40 "$REPORTS/install-again.log"; tail -40 /var/log/goobster-install.log || true; fail "running the install again failed"; }
pass "running the install again exits 0"
check "still exactly one plist" test "$(plist_count)" = 1
check "the daemon is still running" daemon_running
check "/health still answers" health_ok
check "the account was not recreated" test "$(id -u "$ACCOUNT")" = "$UID_OF_ACCOUNT"
endgroup

group "7. SIGKILL of the manager: launchd restarts it"
OLD_PID=$(daemon_pid)
kill -KILL "$OLD_PID"
wait_for 60 "the old manager to be gone" bash -c "! kill -0 $OLD_PID 2>/dev/null"
wait_for 120 "launchd to start a new manager" restarted
NEW_PID=$(daemon_pid)
check "the new manager has another process id" test "$NEW_PID" != "$OLD_PID"
wait_for 120 "the api to answer /health after the restart" health_ok
pass "/health answers after the restart"
wait_for 60 "the manager to answer after the restart" manager_up
endgroup

group "8. repair"
write_private "$WORK/repair.json" "{\"source\":\"$PAYLOAD\",\"release\":{\"allowUnsigned\":true}}"
manager repair --answers "$WORK/repair.json" --yes > "$REPORTS/repair.log" 2>&1 || { tail -30 "$REPORTS/repair.log"; fail "repair failed"; }
pass "repair finished"
wait_for 120 "the api to answer /health" health_ok
pass "/health answers after the repair"
endgroup

group "9. reconfigure (the logs root moves, the plist is rewritten)"
MOVED_LOGS="$BASE/logs moved"
write_private "$WORK/reconfigure.json" "{\"roots\":{\"logs\":\"$MOVED_LOGS\"}}"
manager reconfigure --answers "$WORK/reconfigure.json" --yes > "$REPORTS/reconfigure.log" 2>&1 || { tail -30 "$REPORTS/reconfigure.log"; fail "reconfigure failed"; }
pass "reconfigure finished"
check "the plist names the new logs root" grep -qF "$MOVED_LOGS" "$PLIST"
check "the new logs root exists and belongs to the service account" test "$(stat -f %Su "$MOVED_LOGS")" = "$ACCOUNT"
check "still exactly one plist" test "$(plist_count)" = 1
check "the rewritten plist is still root:wheel 644" test "$(stat -f '%Su:%Sg %Lp' "$PLIST")" = "root:wheel 644"
plutil -lint "$PLIST" || fail "plutil -lint rejected the rewritten plist"
pass "plutil -lint accepts the rewritten plist"
wait_for 120 "the daemon to be running" daemon_running
wait_for 120 "the api to answer /health" health_ok
pass "/health answers after the reconfigure"
endgroup

group "10. uninstall, keeping the data (the account stays)"
write_private "$WORK/uninstall-keep.json" '{"keepData":true}'
manager uninstall --answers "$WORK/uninstall-keep.json" --yes > "$REPORTS/uninstall-keep.log" 2>&1 || { tail -30 "$REPORTS/uninstall-keep.log"; fail "the keep-data uninstall failed"; }
pass "the keep-data uninstall finished"
check "the payload is gone" test ! -e "$CODE/current"
check "the data is kept" test -f "$DATA/goobster.sqlite"
check "the plist is gone" test ! -e "$PLIST"
check "the daemon is not loaded" bash -c '! launchctl print system/'"$LABEL"' >/dev/null 2>&1'
check "no plist of this installation is left" test "$(plist_count)" = 0
check "nothing answers on the api port" bash -c '! curl -fsS -m 3 http://127.0.0.1:'"$API_PORT"'/health'
account_processes_gone
check "the _goobster account stays by default" account_exists
endgroup

group "11. install again over the kept data, then uninstall and delete the data"
write_private "$ANSWERS_FILE" "{\"ownerLabel\":\"macos bootstrap proof\",\"roots\":$(json_roots "$MOVED_LOGS")}"
install_pkg > "$REPORTS/install-after-keep.log" 2>&1 || { tail -40 "$REPORTS/install-after-keep.log"; tail -40 /var/log/goobster-install.log || true; fail "installing over kept data failed"; }
pass "the install over the kept data finished"
check "the account is the same one" test "$(id -u "$ACCOUNT")" = "$UID_OF_ACCOUNT"
wait_for 120 "the daemon to be running" daemon_running
wait_for 120 "the api to answer /health" health_ok
pass "/health answers again"
ID=$(installation_id)
write_private "$WORK/uninstall-all.json" '{"keepData":false}'
manager uninstall --answers "$WORK/uninstall-all.json" --delete-data --confirm "$ID" --yes > "$REPORTS/uninstall-all.log" 2>&1 || { tail -30 "$REPORTS/uninstall-all.log"; fail "the delete-data uninstall failed"; }
pass "the delete-data uninstall finished"
check "the database is gone" test ! -e "$DATA/goobster.sqlite"
check "the payload is gone" test ! -e "$CODE/current"
check "the plist is gone" test ! -e "$PLIST"
check "no plist of this installation is left" test "$(plist_count)" = 0
account_processes_gone
check "the _goobster account still stays (the uninstall never deletes an account)" account_exists
endgroup

group "12. removing the account by hand, with the documented commands"
dscl . -delete "/Users/$ACCOUNT"
dscl . -delete "/Groups/$ACCOUNT"
check "the account is gone" bash -c '! dscl . -read /Users/'"$ACCOUNT"' >/dev/null 2>&1'
check "its group is gone" bash -c '! dscl . -read /Groups/'"$ACCOUNT"' >/dev/null 2>&1'
rm -f "$ANSWERS_FILE"
endgroup

group "13. the other launchd jobs of this Mac are untouched by the machine journey"
other_jobs > "$REPORTS/jobs-after-machine.txt"
diff "$REPORTS/jobs-before.txt" "$REPORTS/jobs-after-machine.txt" > "$REPORTS/jobs-diff-machine.txt" || { cat "$REPORTS/jobs-diff-machine.txt"; fail "the set of other launchd jobs changed"; }
pass "the loaded jobs and the job folders are unchanged"
endgroup

group "14. per-user install from the tar.gz (a LaunchAgent for $PERSON)"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
tar -xzf "$TARBALL" -C "$TARGET_DIR"
chown -R "$PERSON" "$TARGET_DIR"
INSTALLER="$(find "$TARGET_DIR" -name install.command -type f | head -1)"
[ -n "$INSTALLER" ] || fail "the archive holds no install.command"
chmod +x "$INSTALLER"
FOLDER=$(dirname "$INSTALLER")
check "install.command refuses root" bash -c '! "$1" --no-open >/dev/null 2>&1' _ "$INSTALLER"
USER_ANSWERS="$WORK/user-answers.json"
USER_CODE="$USER_BASE/code"
USER_DATA="$USER_BASE/data"
write_private "$USER_ANSWERS" "{\"ownerLabel\":\"macos per-user proof\"}" "$PERSON:staff"
as_person env GOOBSTER_PAYLOAD_DEV_UNSIGNED=1 "$INSTALLER" --headless --answers "$USER_ANSWERS" --base "$USER_BASE" --yes > "$REPORTS/user-install.log" 2>&1 || { tail -40 "$REPORTS/user-install.log"; leftovers; fail "install.command failed"; }
pass "install.command finished for $PERSON"
check "the payload is activated under the person's Library" test -x "$USER_CODE/current/bin/goobster-manager"
check "the roots belong to the person" test "$(stat -f %Su "$USER_DATA")" = "$PERSON"
check "the LaunchAgent plist exists" test -f "$USER_PLIST"
plutil -lint "$USER_PLIST" || fail "plutil -lint rejected the agent plist"
pass "plutil -lint accepts the agent plist"
check "the agent plist has no UserName (it runs as the person)" bash -c '! plutil -extract UserName raw -o - "$1" >/dev/null 2>&1' _ "$USER_PLIST"
check "the agent is loaded in the person's domain" agent_loaded
check "no machine daemon was created" test ! -e "$PLIST"
check "no _goobster account was created" bash -c '! dscl . -read /Users/'"$ACCOUNT"' >/dev/null 2>&1'
wait_for 120 "the api to answer /health" health_ok
pass "/health answers from the per-user install"
set +e
as_person env GOOBSTER_MANAGER_PORT=0 GOOBSTER_PAYLOAD_DEV_UNSIGNED=1 "$FOLDER/payload/runtime/bin/node" "$FOLDER/payload/app/apps/manager/bootstrap/darwin.js" --payload "$FOLDER/payload" --build dev --per-user --base "$USER_BASE" > "$REPORTS/user-again.log" 2>&1
STATUS=$?
set -e
check "starting the wizard again is refused with exit 3" test "$STATUS" -eq 3
check "the refusal names ALREADY_INSTALLED" grep -q '^ALREADY_INSTALLED' "$REPORTS/user-again.log"
USER_ID=$(jq -r .installationId "$USER_DATA/manager/installation.json")
write_private "$WORK/user-uninstall.json" '{"keepData":false}' "$PERSON:staff"
as_person env GOOBSTER_PAYLOAD_DEV_UNSIGNED=1 "$USER_CODE/current/bin/goobster-manager" uninstall --answers "$WORK/user-uninstall.json" --delete-data --confirm "$USER_ID" --yes > "$REPORTS/user-uninstall.log" 2>&1 || { tail -30 "$REPORTS/user-uninstall.log"; fail "the per-user uninstall failed"; }
pass "the per-user uninstall finished"
check "the agent plist is gone" test ! -e "$USER_PLIST"
check "the agent is not loaded" bash -c '! launchctl print gui/'"$PERSON_UID/$LABEL"' >/dev/null 2>&1'
check "the per-user data is gone" test ! -e "$USER_DATA/goobster.sqlite"
endgroup

group "15. nothing else changed"
other_jobs > "$REPORTS/jobs-after.txt"
diff "$REPORTS/jobs-before.txt" "$REPORTS/jobs-after.txt" > "$REPORTS/jobs-diff.txt" || { cat "$REPORTS/jobs-diff.txt"; fail "the set of other launchd jobs changed"; }
pass "the set of other launchd jobs is exactly what it was before the journey"
endgroup

echo "macos bootstrap proof: $PASSED checks passed ($(uname -m))"
