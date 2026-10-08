/**
 * Unpacking a payload archive (`goobster-payload-<core>-<target>.tar.gz`, scripts/release-index.js
 * `pack-payload`) with the system `tar`: no new dependency. The archive's digest was checked
 * against the signed index before this runs, and the unpacked tree is verified again by
 * `verifyPayload` (manifest, signature, every file's SHA-256, no extra file, no link out of the
 * root). What is checked here is only what `tar` must not be asked to do: write outside the
 * destination.
 */

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { ManagerError } = require('../errors');

const MAX_LIST_BYTES = 256 * 1024 * 1024;
const MANIFEST = 'payload-manifest.json';

function unsafe() {
    return new ManagerError(409, 'ARCHIVE_UNSAFE', 'The payload archive holds a path that would leave its folder; nothing was unpacked.');
}

/** `reason` names the call and its cause (`LIST_EXIT_1`, `EXTRACT_ENOENT`): a code, never tar's output. */
function broken(reason) {
    return new ManagerError(409, 'ARCHIVE_UNREADABLE', 'The payload archive cannot be read with the system tar.', { reason });
}

/**
 * Which `tar` to run. On Windows the system one is bsdtar (`%SystemRoot%\System32\tar.exe`), which
 * takes `D:\...` paths; the GNU tar that Git for Windows puts first on PATH under Git Bash reads the
 * drive letter as a remote host (`Cannot connect to D`) and fails on every archive. So on Windows the
 * System32 copy is used when it is there, and PATH decides only where it is not.
 */
function tarCommand({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
    if (platform !== 'win32') return 'tar';
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    const system = path.win32.join(root, 'System32', 'tar.exe');
    return exists(system) ? system : 'tar';
}

function tar(call, args, { input = null, maxBuffer = MAX_LIST_BYTES } = {}) {
    const result = childProcess.spawnSync(tarCommand(), args, { encoding: 'buffer', maxBuffer, input: input || undefined, timeout: 30 * 60_000, windowsHide: true });
    if (result.error) throw broken(`${call}_${String(result.error.code || 'SPAWN').toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`);
    if (result.status !== 0) throw broken(`${call}_${result.status === null ? `SIGNAL_${result.signal || 'UNKNOWN'}` : `EXIT_${result.status}`}`);
    return result.stdout;
}

/** tar's listing, one member a line; Windows' bsdtar ends its lines with CR LF, so both line ends are taken. */
function lines(output) {
    return output.toString('utf8').split(/\r?\n/).filter(Boolean);
}

/** Every member name; refuse an absolute path, a `..` part, a drive letter or a backslash. */
function listMembers(file) {
    const names = lines(tar('LIST', ['-tzf', file]));
    for (const name of names) {
        const parts = name.split('/');
        if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name) || parts.includes('..')) throw unsafe();
    }
    return names;
}

/** Link members must stay inside too: list them verbosely and refuse an absolute or escaping target. */
function checkLinks(file) {
    for (const line of lines(tar('LIST_LINKS', ['-tzvf', file]))) {
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
    return tar('READ_MEMBER', ['-xzOf', file, name], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}

/** Unpack into `destination` (created, owner-only until the caller moves it). */
function extract(file, destination, { fs }) {
    listMembers(file);
    checkLinks(file);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    tar('EXTRACT', ['-xzf', file, '-C', path.resolve(destination), '--no-same-owner'], { maxBuffer: 16 * 1024 * 1024 });
    try { fs.chmodSync(destination, 0o755); } catch { }
}

module.exports = { listMembers, readManifestText, extract, tarCommand, MANIFEST };
