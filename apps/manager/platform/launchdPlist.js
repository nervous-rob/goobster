/**
 * The launchd job the installer registers (documentation/macos_install.md).
 *
 * Pure text in, text out, like `systemdUnit.js`: no file is read or written
 * here, and nothing but Node built-ins and `systemdUnit.js` (path rules, the
 * environment a service carries) is loaded, because the privileged helper
 * (../privileged/darwin.js) runs this code as root.
 *
 * Two shapes of job share one renderer:
 *
 *   machine   a LaunchDaemon in /Library/LaunchDaemons, run as a dedicated
 *             account (`_goobster`), started at boot with no one logged in:
 *             the always-on server mode.
 *   user      a LaunchAgent in ~/Library/LaunchAgents, run as the person who
 *             installed it, only while that person is logged in.
 *
 * The plist is the installation's service, not a copy of the operator's other
 * jobs: it carries a top-level `X-Goobster-Installation` string the helper
 * checks before it overwrites or removes anything. launchd ignores keys it
 * does not know. The XML is written by hand (no DOCTYPE, so nothing in the
 * file names a URL); every value is escaped and the path rules of the Linux
 * unit apply, so a root with spaces or non-ASCII letters is carried verbatim.
 */

const path = require('node:path');
const systemd = require('./systemdUnit');

const LABEL_PREFIX = 'io.goobster.';
const MARKER_KEY = 'X-Goobster-Installation';
const DAEMON_DIR = '/Library/LaunchDaemons';
const AGENT_RELATIVE_DIR = path.posix.join('Library', 'LaunchAgents');
const SCOPES = Object.freeze(['machine', 'user']);
const THROTTLE_INTERVAL_SECONDS = 10;
/** Time launchd gives the manager to drain its workers after SIGTERM before it sends SIGKILL. */
const EXIT_TIMEOUT_SECONDS = 120;
const LOG_FILE_STEM = 'goobster-launchd';
const MAX_PARSE_DEPTH = 24;

function labelFor(name) {
    if (!systemd.SERVICE_NAME.test(name)) throw new Error('the service name is not an identifier');
    return `${LABEL_PREFIX}${name}`;
}

function plistFileName(name) {
    return `${labelFor(name)}.plist`;
}

function daemonPath(name) {
    return path.posix.join(DAEMON_DIR, plistFileName(name));
}

function agentDirOf(home) {
    return path.posix.join(home, AGENT_RELATIVE_DIR);
}

function agentPath(name, home) {
    if (typeof home !== 'string' || !path.posix.isAbsolute(home)) throw new Error('the home directory is not an absolute path');
    return path.posix.join(agentDirOf(home), plistFileName(name));
}

/** What a text node or an attribute-free element body may not carry literally. */
function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function unescapeXml(value) {
    return String(value).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (match, entity) => {
        switch (entity) {
            case 'amp': return '&';
            case 'lt': return '<';
            case 'gt': return '>';
            case 'quot': return '"';
            case 'apos': return '\'';
            default: {
                const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
                return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
            }
        }
    });
}

const string = (value) => `<string>${escapeXml(value)}</string>`;

/** The environment this job carries: the roots (never a secret), with the supervisor named for launchd. */
function jobEnvironment({ roots, layout, mode = 'payload' }) {
    return systemd.serviceEnvironment({ roots, layout, mode }).map(([key, value]) => [key, key === 'GOOBSTER_SUPERVISOR' ? 'launchd' : value]);
}

function programArguments({ codeRoot, mode, nodePath }) {
    return mode === 'payload'
        ? [`${codeRoot}/current/runtime/bin/node`, `${codeRoot}/current/app/apps/manager/index.js`, '--supervise']
        : [nodePath, `${codeRoot}/apps/manager/index.js`, '--supervise'];
}

/** Where the job's standard output and error go: the logs root, which the service account owns. */
function logPaths(roots) {
    return { out: `${roots.logs}/${LOG_FILE_STEM}.out.log`, err: `${roots.logs}/${LOG_FILE_STEM}.err.log` };
}

/**
 * @param {Object} params
 * @param {string} params.name                    service name (the label is `io.goobster.<name>`)
 * @param {string|null} [params.installationId]   the marker; null for a hand-copied reference
 * @param {string} params.runtimeUser             the account of a machine job (a user job runs as whoever loads it)
 * @param {string} params.codeRoot
 * @param {Object} params.roots                   the seven installation roots
 * @param {'lite'|'standalone'|'paired'} params.layout
 * @param {'payload'|'checkout'} [params.mode]
 * @param {string} [params.nodePath]              checkout only: the Node that runs the manager
 * @param {'machine'|'user'} [params.scope]
 * @returns {string}
 */
function renderPlist({ name, installationId = null, runtimeUser, codeRoot, roots, layout, mode = 'payload', nodePath = '/usr/local/bin/node', scope = 'machine', environment = null }) {
    const label = labelFor(name);
    if (!SCOPES.includes(scope)) throw new Error('unknown job scope');
    if (!systemd.RUNTIME_USER.test(runtimeUser)) throw new Error('the runtime user is not an account name');
    if (installationId !== null && !systemd.UUID.test(installationId)) throw new Error('the installation id is not a UUID');
    systemd.assertSafePath(codeRoot, 'the code root');
    for (const [role, value] of Object.entries(roots)) systemd.assertSafePath(value, `the ${role} root`);
    if (mode !== 'payload' && mode !== 'checkout') throw new Error('unknown job mode');
    if (mode === 'checkout') systemd.assertSafePath(nodePath, 'the node path');

    const logs = logPaths(roots);
    const out = [];
    const line = (text, depth = 1) => out.push(`${'\t'.repeat(depth)}${text}`);
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<plist version="1.0">');
    out.push('<dict>');
    line('<key>Label</key>');
    line(string(label));
    if (installationId) {
        line(`<key>${MARKER_KEY}</key>`);
        line(string(installationId));
    }
    line('<key>ProgramArguments</key>');
    line('<array>');
    for (const argument of programArguments({ codeRoot, mode, nodePath })) line(string(argument), 2);
    line('</array>');
    line('<key>WorkingDirectory</key>');
    line(string(codeRoot));
    if (scope === 'machine') {
        line('<key>UserName</key>');
        line(string(runtimeUser));
    }
    line('<key>RunAtLoad</key>');
    line('<true/>');
    line('<key>KeepAlive</key>');
    line('<dict>');
    line('<key>SuccessfulExit</key>', 2);
    line('<false/>', 2);
    line('</dict>');
    line('<key>ThrottleInterval</key>');
    line(`<integer>${THROTTLE_INTERVAL_SECONDS}</integer>`);
    line('<key>ExitTimeOut</key>');
    line(`<integer>${EXIT_TIMEOUT_SECONDS}</integer>`);
    line('<key>EnvironmentVariables</key>');
    line('<dict>');
    for (const [key, value] of (environment || jobEnvironment({ roots, layout, mode }))) {
        line(`<key>${escapeXml(key)}</key>`, 2);
        line(string(value), 2);
    }
    line('</dict>');
    line('<key>StandardOutPath</key>');
    line(string(logs.out));
    line('<key>StandardErrorPath</key>');
    line(string(logs.err));
    out.push('</dict>');
    out.push('</plist>');
    out.push('');
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// reading a plist back
// ---------------------------------------------------------------------------

function tokenize(text) {
    const body = String(text || '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\?[\s\S]*?\?>/g, '')
        .replace(/<!DOCTYPE[^>]*>/gi, '');
    const tokens = [];
    const pattern = /<(\/?)([A-Za-z]+)(?:\s[^<>]*?)?(\/?)>|([^<]+)/g;
    for (const match of body.matchAll(pattern)) {
        if (match[4] !== undefined) {
            if (match[4].trim() !== '') tokens.push({ type: 'text', text: unescapeXml(match[4]) });
        } else if (match[3]) {
            tokens.push({ type: 'empty', name: match[2] });
        } else {
            tokens.push({ type: match[1] ? 'close' : 'open', name: match[2] });
        }
    }
    return tokens;
}

/** One value from the token list; a binary plist or anything unexpected throws, and the caller reads that as "not ours". */
function parseValue(tokens, at, depth) {
    if (depth > MAX_PARSE_DEPTH) throw new Error('nested too deeply');
    const token = tokens[at];
    if (!token) throw new Error('truncated');
    if (token.type === 'empty') {
        if (token.name === 'true') return [true, at + 1];
        if (token.name === 'false') return [false, at + 1];
        return [token.name === 'string' ? '' : null, at + 1];
    }
    if (token.type !== 'open') throw new Error('unexpected token');
    if (token.name === 'dict') {
        const value = {};
        let i = at + 1;
        while (tokens[i] && !(tokens[i].type === 'close' && tokens[i].name === 'dict')) {
            if (!(tokens[i].type === 'open' && tokens[i].name === 'key')) throw new Error('expected a key');
            const [key, afterKey] = readText(tokens, i);
            const [item, afterItem] = parseValue(tokens, afterKey, depth + 1);
            value[key] = item;
            i = afterItem;
        }
        if (!tokens[i]) throw new Error('truncated');
        return [value, i + 1];
    }
    if (token.name === 'array') {
        const value = [];
        let i = at + 1;
        while (tokens[i] && !(tokens[i].type === 'close' && tokens[i].name === 'array')) {
            const [item, next] = parseValue(tokens, i, depth + 1);
            value.push(item);
            i = next;
        }
        if (!tokens[i]) throw new Error('truncated');
        return [value, i + 1];
    }
    const [text, next] = readText(tokens, at);
    if (token.name === 'integer') return [Number(text), next];
    return [text, next];
}

/** The text of the element opened at `at`, and the index after its close tag. */
function readText(tokens, at) {
    const open = tokens[at];
    let i = at + 1;
    let text = '';
    if (tokens[i] && tokens[i].type === 'text') {
        text = tokens[i].text;
        i++;
    }
    if (!tokens[i] || tokens[i].type !== 'close' || tokens[i].name !== open.name) throw new Error('unbalanced element');
    return [text, i + 1];
}

/**
 * What an installed plist says about its owner. Anything that is not the
 * XML shape this renderer writes (a binary plist, another tool's layout)
 * reads as carrying no marker, so it is never mistaken for ours.
 */
function parsePlist(text) {
    const out = { label: null, installationId: null, user: null, workingDirectory: null, programArguments: null };
    try {
        const tokens = tokenize(text);
        const start = tokens.findIndex(token => token.type === 'open' && token.name === 'plist');
        if (start < 0) return out;
        const [root] = parseValue(tokens, start + 1, 0);
        if (!root || typeof root !== 'object' || Array.isArray(root)) return out;
        const textOf = (value) => (typeof value === 'string' ? value : null);
        out.label = textOf(root.Label);
        out.installationId = textOf(root[MARKER_KEY]);
        out.user = textOf(root.UserName);
        out.workingDirectory = textOf(root.WorkingDirectory);
        out.programArguments = Array.isArray(root.ProgramArguments) && root.ProgramArguments.every(item => typeof item === 'string') ? root.ProgramArguments : null;
    } catch { }
    return out;
}

module.exports = {
    LABEL_PREFIX,
    MARKER_KEY,
    DAEMON_DIR,
    SCOPES,
    THROTTLE_INTERVAL_SECONDS,
    EXIT_TIMEOUT_SECONDS,
    labelFor,
    plistFileName,
    daemonPath,
    agentDirOf,
    agentPath,
    escapeXml,
    unescapeXml,
    jobEnvironment,
    programArguments,
    logPaths,
    renderPlist,
    parsePlist
};
