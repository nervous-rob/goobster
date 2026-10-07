#!/bin/sh
# Goobster per-user installer for macOS (documentation/macos_install.md).
#
# Double-click this file in Finder, or run it in Terminal, from the folder the
# tar.gz unpacked into. It installs Goobster for YOUR account only: the roots
# live under ~/Library/Application Support/Goobster and the service is a
# LaunchAgent that runs while you are logged in. It needs no administrator
# password and must not be run with sudo.
#
# It does not copy files into the installation itself: it starts the bundled
# Node.js with the manager's bootstrap entry, which installs through the
# setup engine (stage, verify, activate) and opens the wizard in your browser
# on http://127.0.0.1:3400/manager/ (loopback only).
#
#   ./install.command [--headless --answers <file>] [--base <dir>] [--no-open] [--help]
#
# Downloaded with a browser, the folder carries macOS's quarantine mark; a
# development build is unsigned, so Gatekeeper refuses its programs until you
# clear it for this folder: xattr -dr com.apple.quarantine <this folder>
#
# The values below are written by scripts/package-bootstrap-darwin.js.
GOOBSTER_BOOTSTRAP_VERSION='@VERSION@'
GOOBSTER_BOOTSTRAP_TARGET='@TARGET@'
GOOBSTER_BOOTSTRAP_ARCH='@ARCH@'
GOOBSTER_BOOTSTRAP_PAYLOAD_DIGEST='@PAYLOAD_DIGEST@'
GOOBSTER_BOOTSTRAP_SIGNED='@SIGNED@'
GOOBSTER_BOOTSTRAP_BUILD='@BUILD@'

say() { printf '%s\n' "$*"; }
fail() { printf 'goobster: %s\n' "$1" >&2; exit "${2:-1}"; }

HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || fail "this folder could not be entered." 1

open=--open-browser
for arg in "$@"; do
    case $arg in
        --help|-h)
            cat <<USAGE
Goobster $GOOBSTER_BOOTSTRAP_VERSION installer for $GOOBSTER_BOOTSTRAP_TARGET ($GOOBSTER_BOOTSTRAP_BUILD build), for your own account

Usage: ./install.command [--headless --answers <file>] [--base <dir>] [--no-open] [--help]

  (no option)                  start the setup wizard on http://127.0.0.1:3400/manager/ and open it
  --headless --answers <file>  install without a browser; the answers file is JSON, mode 0600
  --base <dir>                 place every root under <dir> (default: ~/Library/Application Support/Goobster)
  --no-open                    print the wizard address, do not open a browser

Requires macOS 13 or newer. Do not run it with sudo. Documentation: documentation/macos_install.md
USAGE
            exit 0
            ;;
        --no-open) open= ;;
    esac
done

if [ "$GOOBSTER_BOOTSTRAP_BUILD" != "release" ]; then
    say "NOTICE: this is an UNSIGNED DEVELOPMENT build. Its payload carries no valid release signature;"
    say "        it installs only into a development environment you trust. Do not use it for production."
fi

[ "$(uname -s)" = Darwin ] || fail "this installer is for macOS; this is $(uname -s)." 3
[ "$(id -u)" != 0 ] || fail "run this as yourself, not with sudo: the wizard and the manager never run as root." 3
machine=$(uname -m)
case $GOOBSTER_BOOTSTRAP_ARCH in
    x64) want=x86_64 ;;
    arm64) want=arm64 ;;
    *) fail "this installer names an unknown architecture ($GOOBSTER_BOOTSTRAP_ARCH)." 3 ;;
esac
if [ "$machine" != "$want" ]; then
    translated=$(sysctl -in sysctl.proc_translated 2>/dev/null)
    if [ "$want" = x86_64 ] && [ "$machine" = arm64 ]; then
        say "NOTE: this is an Apple silicon Mac running the Intel build (through Rosetta, if it is installed)."
    elif [ "$translated" = 1 ]; then
        :
    else
        fail "this installer is for $GOOBSTER_BOOTSTRAP_TARGET and this machine is $machine." 3
    fi
fi
version=$(sw_vers -productVersion 2>/dev/null)
major=${version%%.*}
if [ -n "$major" ] && [ "$major" -lt 13 ] 2>/dev/null; then
    fail "macOS 13 (Ventura) or newer is required; this is $version." 3
fi

NODE="$HERE/payload/runtime/bin/node"
ENTRY="$HERE/payload/app/apps/manager/bootstrap/darwin.js"
[ -x "$NODE" ] || fail "the folder holds no runtime ($NODE); unpack the whole archive." 4
[ -f "$ENTRY" ] || fail "the folder holds no bootstrap entry." 4

n=$#
i=0
while [ "$i" -lt "$n" ]; do
    arg=$1
    shift
    [ "$arg" = --no-open ] || set -- "$@" "$arg"
    i=$((i + 1))
done

if [ -f "$HERE/release-key.pem" ]; then
    exec "$NODE" "$ENTRY" --payload "$HERE/payload" --payload-digest "$GOOBSTER_BOOTSTRAP_PAYLOAD_DIGEST" --build "$GOOBSTER_BOOTSTRAP_BUILD" --signed "$GOOBSTER_BOOTSTRAP_SIGNED" --public-key "$HERE/release-key.pem" --installer "$0" --per-user $open "$@"
fi
exec "$NODE" "$ENTRY" --payload "$HERE/payload" --payload-digest "$GOOBSTER_BOOTSTRAP_PAYLOAD_DIGEST" --build "$GOOBSTER_BOOTSTRAP_BUILD" --signed "$GOOBSTER_BOOTSTRAP_SIGNED" --installer "$0" --per-user $open "$@"
