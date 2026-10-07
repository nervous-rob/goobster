#!/bin/sh
# Goobster self-extracting installer for Linux (documentation/linux_install.md).
#
# This file is a POSIX shell header followed by a gzip-compressed tar archive
# of the release payload. It does NOT unpack into the installation: it
#   1. checks the machine (CPU, libc, tools),
#   2. verifies the archive against the SHA-256 recorded in this header,
#   3. unpacks it into a private temporary directory,
#   4. starts the bundled Node.js with the manager's bootstrap entry, which
#      installs through the manager's setup engine (stage, verify, activate).
# Nothing is copied into a code root from here, and nothing is left behind in
# the temporary directory when it finishes.
#
#   sh goobster-<version>-linux-<arch>.run [options]
#
#   --headless --answers <file>   install without a browser from an answers file (mode 0600)
#   --base <dir>                  put every root under <dir> (default: /opt + /var/lib/goobster as root, ~/goobster otherwise)
#   --verify                      check the archive and stop
#   --info                        print what this installer carries and stop
#   --keep                        keep the temporary directory
#   --help
#
# The values below are written by scripts/package-bootstrap.js.
GOOBSTER_BOOTSTRAP_VERSION='@VERSION@'
GOOBSTER_BOOTSTRAP_TARGET='@TARGET@'
GOOBSTER_BOOTSTRAP_ARCH='@ARCH@'
GOOBSTER_BOOTSTRAP_PAYLOAD_DIGEST='@PAYLOAD_DIGEST@'
GOOBSTER_BOOTSTRAP_ARCHIVE_SHA256='@ARCHIVE_SHA256@'
GOOBSTER_BOOTSTRAP_ARCHIVE_BYTES='@ARCHIVE_BYTES@'
GOOBSTER_BOOTSTRAP_SIGNED='@SIGNED@'
GOOBSTER_BOOTSTRAP_BUILD='@BUILD@'
GOOBSTER_BOOTSTRAP_PUBLIC_KEY_B64='@PUBLIC_KEY_B64@'
GOOBSTER_ARCHIVE_OFFSET='@ARCHIVE_OFFSET@'

SELF=$0
case $SELF in
    */*) ;;
    *) SELF=$(command -v -- "$SELF" 2>/dev/null || printf '%s' "$SELF") ;;
esac

say() { printf '%s\n' "$*"; }
fail() { printf 'goobster: %s\n' "$*" >&2; exit "${2:-1}"; }

usage() {
    cat <<USAGE
Goobster $GOOBSTER_BOOTSTRAP_VERSION installer for $GOOBSTER_BOOTSTRAP_TARGET ($GOOBSTER_BOOTSTRAP_BUILD build)

Usage: sh $(basename "$SELF") [--headless --answers <file>] [--base <dir>] [--verify] [--info] [--keep] [--help]

  (no option)                  start the setup wizard on http://127.0.0.1:3400/manager/ (loopback only;
                               on a headless machine: ssh -L 3400:127.0.0.1:3400 <host>)
  --headless --answers <file>  install without a browser; the answers file is JSON, mode 0600
  --base <dir>                 place every root under <dir>
  --verify                     verify the embedded archive and stop
  --info                       print the release this installer carries and stop
  --keep                       keep the unpacked temporary directory (debugging)

Supported: Debian 12 / Raspberry Pi OS Bookworm 64-bit, Ubuntu 22.04+, AlmaLinux/Rocky 9;
x64 and arm64 with glibc. Not supported: musl (Alpine), 32-bit ARM, RHEL 8.
Documentation: documentation/linux_install.md
USAGE
}

dev_notice() {
    if [ "$GOOBSTER_BOOTSTRAP_BUILD" != "release" ]; then
        say "NOTICE: this is an UNSIGNED DEVELOPMENT build. Its payload carries no valid release signature;"
        say "        it installs only into a development environment you trust. Do not use it for production."
    fi
}

MODE=run
KEEP=0
for arg in "$@"; do
    case $arg in
        --help|-h) usage; exit 0 ;;
        --verify) MODE=verify ;;
        --info) MODE=info ;;
        --keep) KEEP=1 ;;
    esac
done

if [ "$MODE" = info ]; then
    say "version        $GOOBSTER_BOOTSTRAP_VERSION"
    say "target         $GOOBSTER_BOOTSTRAP_TARGET"
    say "build          $GOOBSTER_BOOTSTRAP_BUILD"
    say "signed         $GOOBSTER_BOOTSTRAP_SIGNED"
    say "payloadDigest  $GOOBSTER_BOOTSTRAP_PAYLOAD_DIGEST"
    say "archiveSha256  $GOOBSTER_BOOTSTRAP_ARCHIVE_SHA256"
    say "archiveBytes   $GOOBSTER_BOOTSTRAP_ARCHIVE_BYTES"
    exit 0
fi

dev_notice

# ---- the machine --------------------------------------------------------
[ "$(uname -s)" = Linux ] || fail "this installer is for Linux; this is $(uname -s)." 3
machine=$(uname -m)
case $GOOBSTER_BOOTSTRAP_ARCH in
    x64) want='x86_64' ;;
    arm64) want='aarch64 arm64' ;;
    *) fail "this installer names an unknown architecture ($GOOBSTER_BOOTSTRAP_ARCH)." 3 ;;
esac
found=0
for candidate in $want; do [ "$machine" = "$candidate" ] && found=1; done
if [ "$found" != 1 ]; then
    case $machine in
        armv6*|armv7*|armhf|i?86) fail "32-bit machines are not supported ($machine). Use a 64-bit operating system." 3 ;;
    esac
    fail "this installer is for $GOOBSTER_BOOTSTRAP_TARGET and this machine is $machine." 3
fi
if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    fail "musl libc (Alpine) is not supported; use a glibc distribution." 3
fi
if command -v getconf >/dev/null 2>&1; then
    glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed 's/^glibc //')
    if [ "$GOOBSTER_BOOTSTRAP_ARCH" = arm64 ] && [ -n "$glibc" ]; then
        major=${glibc%%.*}
        minor=${glibc#*.}
        minor=${minor%%.*}
        if [ "$major" -lt 2 ] 2>/dev/null || { [ "$major" -eq 2 ] && [ "$minor" -lt 33 ]; } 2>/dev/null; then
            fail "arm64 needs glibc 2.33 or newer; this machine has $glibc." 3
        fi
    fi
fi
for tool in tar gzip tail head sed mktemp; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed and was not found." 3
done

# ---- the archive --------------------------------------------------------
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum | sed 's/ .*//'
    elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | sed 's/ .*//'
    elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 | sed 's/^.*= *//'
    else fail "sha256sum, shasum or openssl is needed to verify the archive." 3
    fi
}

offset=$(printf '%s' "$GOOBSTER_ARCHIVE_OFFSET" | sed 's/^0*//')
[ -n "$offset" ] || fail "this file is damaged (no archive offset)." 4
archive() { tail -c +"$((offset + 1))" "$SELF"; }

actual=$(archive | sha256_of)
if [ "$actual" != "$GOOBSTER_BOOTSTRAP_ARCHIVE_SHA256" ]; then
    fail "the embedded archive does not match its recorded SHA-256; the download is damaged or was modified. Nothing was unpacked." 4
fi
say "Archive verified (SHA-256 $GOOBSTER_BOOTSTRAP_ARCHIVE_SHA256)."
if [ "$MODE" = verify ]; then
    say "Payload digest recorded in this installer: $GOOBSTER_BOOTSTRAP_PAYLOAD_DIGEST"
    exit 0
fi

# ---- unpack, then hand over to the manager ------------------------------
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/goobster-bootstrap.XXXXXXXX") || fail "a temporary directory could not be created (set TMPDIR to a folder with about 1 GB free)." 5
chmod 700 "$STAGE"
KEYDIR=
cleanup() {
    if [ -n "$KEYDIR" ]; then rm -rf "$KEYDIR"; fi
    if [ "$KEEP" = 1 ]; then say "Kept $STAGE"; else rm -rf "$STAGE"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "Unpacking to $STAGE ..."
if ! archive | tar -xzf - -C "$STAGE"; then
    fail "the archive could not be unpacked (is there enough free space in ${TMPDIR:-/tmp}?)." 5
fi
NODE="$STAGE/runtime/bin/node"
ENTRY="$STAGE/app/apps/manager/bootstrap/index.js"
[ -x "$NODE" ] || fail "the archive holds no runtime ($NODE)." 4
[ -f "$ENTRY" ] || fail "the archive holds no bootstrap entry." 4

KEYARG=
if [ -n "$GOOBSTER_BOOTSTRAP_PUBLIC_KEY_B64" ]; then
    KEYDIR=$(mktemp -d "${TMPDIR:-/tmp}/goobster-key.XXXXXXXX") || fail "a temporary directory could not be created." 5
    printf '%s' "$GOOBSTER_BOOTSTRAP_PUBLIC_KEY_B64" | base64 -d > "$KEYDIR/release-key.pem" || fail "the embedded release key could not be decoded." 4
    KEYARG="$KEYDIR/release-key.pem"
fi

if [ -n "$KEYARG" ]; then
    "$NODE" "$ENTRY" --payload "$STAGE" --payload-digest "$GOOBSTER_BOOTSTRAP_PAYLOAD_DIGEST" --build "$GOOBSTER_BOOTSTRAP_BUILD" --signed "$GOOBSTER_BOOTSTRAP_SIGNED" --public-key "$KEYARG" --installer "$SELF" "$@"
else
    "$NODE" "$ENTRY" --payload "$STAGE" --payload-digest "$GOOBSTER_BOOTSTRAP_PAYLOAD_DIGEST" --build "$GOOBSTER_BOOTSTRAP_BUILD" --signed "$GOOBSTER_BOOTSTRAP_SIGNED" --installer "$SELF" "$@"
fi
status=$?
exit "$status"
# ---- end of header: the archive follows -------------------------------
