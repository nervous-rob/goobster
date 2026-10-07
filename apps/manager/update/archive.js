/**
 * Unpacking a payload archive (`goobster-payload-<core>-<target>.tar.gz`, scripts/release-index.js
 * `pack-payload`) with the system `tar`: no new dependency. The archive's digest was checked
 * against the signed index before this runs, and the unpacked tree is verified again by
 * `verifyPayload` (manifest, signature, every file's SHA-256, no extra file, no link out of the
 * root). What is checked here is only what `tar` must not be asked to do: write outside the
 * destination.
 */

const path = require('node:path');
const childProcess = require('node:child_process');
const { ManagerError } = require('../errors');

const MAX_LIST_BYTES = 256 * 1024 * 1024;
const MANIFEST = 'payload-manifest.json';

function unsafe() {
    return new ManagerError(409, 'ARCHIVE_UNSAFE', 'The payload archive holds a path that would leave its folder; nothing was unpacked.');
}

function broken() {
    return new ManagerError(409, 'ARCHIVE_UNREADABLE', 'The payload archive cannot be read with the system tar.');
}

function tar(args, { input = null, maxBuffer = MAX_LIST_BYTES } = {}) {
    const result = childProcess.spawnSync('tar', args, { encoding: 'buffer', maxBuffer, input: input || undefined, timeout: 30 * 60_000 });
    if (result.error || result.status !== 0) throw broken();
    return result.stdout;
}

/** Every member name; refuse an absolute path, a `..` part, a drive letter or a backslash. */
function listMembers(file) {
    const names = tar(['-tzf', file]).toString('utf8').split('\n').filter(Boolean);
    for (const name of names) {
        const parts = name.split('/');
        if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name) || parts.includes('..')) throw unsafe();
    }
    return names;
}

/** Link members must stay inside too: list them verbosely and refuse an absolute or escaping target. */
function checkLinks(file) {
    const lines = tar(['-tzvf', file]).toString('utf8').split('\n').filter(Boolean);
    for (const line of lines) {
        const flag = line[0];
        if (flag !== 'l' && flag !== 'h') continue;
        const match = / -> (.+)$/.exec(line) || / link to (.+)$/.exec(line);
        if (!match) throw unsafe();
        const target = match[1];
        if (target.startsWith('/') || /^[A-Za-z]:/.test(target) || target.split('/').includes('..')) throw unsafe();
    }
}

/** The manifest's text, read out of the archive without unpacking it. */
function readManifestText(file) {
    const members = listMembers(file);
    const name = members.find(member => member === MANIFEST || member === `./${MANIFEST}`);
    if (!name) throw new ManagerError(409, 'MANIFEST_MISSING', 'The payload archive holds no payload-manifest.json.');
    return tar(['-xzOf', file, name], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}

/** Unpack into `destination` (created, owner-only until the caller moves it). */
function extract(file, destination, { fs }) {
    listMembers(file);
    checkLinks(file);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    tar(['-xzf', file, '-C', path.resolve(destination), '--no-same-owner'], { maxBuffer: 1024 * 1024 });
    try { fs.chmodSync(destination, 0o755); } catch { }
}

module.exports = { listMembers, readManifestText, extract, MANIFEST };
