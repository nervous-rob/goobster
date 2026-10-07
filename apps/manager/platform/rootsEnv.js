/**
 * `<code root>/goobster.env`: the installation's roots as plain
 * `GOOBSTER_*=value` lines, so `<code>/current/bin/goobster-manager` (the
 * launcher, scripts/package-runtime.js) finds the right data, config, cache,
 * log and manager-store roots when an operator runs it by hand - the manual
 * fallback, the CLI after install - without an environment of its own. The
 * launcher reads the file as text, one `GOOBSTER_` line at a time, and never
 * runs it. Paths only: no secret, no token, no connection string.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const files = require('../store/files');
const { serviceEnvironment } = require('./systemdUnit');

const FILE_NAME = 'goobster.env';

function envFilePath(codeRoot) {
    return path.join(codeRoot, FILE_NAME);
}

function renderRootsEnv({ roots, layout, mode = 'payload' }) {
    const lines = serviceEnvironment({ roots, layout, mode })
        .filter(([key]) => key.startsWith('GOOBSTER_') && key !== 'GOOBSTER_SUPERVISOR')
        .map(([key, value]) => `${key}=${value}`);
    return `# Written by the Goobster installer: the roots of this installation. Paths only.\n${lines.join('\n')}\n`;
}

function writeRootsEnv({ roots, layout, mode }, fs = nodeFs) {
    const file = envFilePath(roots.code);
    const text = renderRootsEnv({ roots, layout, mode });
    try {
        if (fs.readFileSync(file, 'utf8') === text) return { file, written: false };
    } catch { }
    fs.mkdirSync(roots.code, { recursive: true });
    files.writeAtomic(file, text, fs);
    fs.chmodSync(file, 0o644);
    return { file, written: true };
}

/** The `GOOBSTER_*` lines of the file as an object (empty when it is absent). Parsed as text, never run. */
function readRootsEnv(codeRoot, fs = nodeFs) {
    const out = {};
    let text;
    try {
        text = fs.readFileSync(envFilePath(codeRoot), 'utf8');
    } catch {
        return out;
    }
    for (const line of text.split('\n')) {
        const match = /^(GOOBSTER_[A-Z0-9_]*)=(.*)$/.exec(line);
        if (match) out[match[1]] = match[2];
    }
    return out;
}

function removeRootsEnv(codeRoot, fs = nodeFs) {
    return files.removeIfPresent(envFilePath(codeRoot), fs);
}

module.exports = { FILE_NAME, envFilePath, renderRootsEnv, writeRootsEnv, readRootsEnv, removeRootsEnv };
