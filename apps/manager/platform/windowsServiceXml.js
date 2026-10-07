/**
 * The Windows service definition the installer registers
 * (documentation/windows_install.md, "The service").
 *
 * The service host is WinSW (a service wrapper that runs one program and
 * restarts it); this module renders the `goobster-service.xml` that sits next
 * to the host executable, and parses it back. Pure text in, text out: no file
 * is read or written here, nothing touches the manager's own modules, because
 * the privileged helper (../privileged/win32.js) runs this code elevated and
 * must not load anything the unprivileged manager tree could have changed
 * beyond its own few files. Node built-ins only.
 *
 * The definition is the installation's service, not a copy of the operator's
 * unrelated services: it carries an `X-Goobster-Installation:` marker comment
 * as its first line that the helper checks before it overwrites or removes
 * anything. It holds paths and the installation's own roots; never a secret,
 * a token, a URL or a password (the service account is a virtual account and
 * has none).
 */

const path = require('node:path');

const SERVICE_ID = 'goobster';
const DISPLAY_NAME = 'Goobster';
const MARKER_KEY = 'X-Goobster-Installation';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST_FILE_NAME = 'goobster-service.exe';
const XML_FILE_NAME = 'goobster-service.xml';
const SERVICE_DIR_NAME = 'service';
const ACCOUNT_DOMAIN = 'NT SERVICE';
const ACCOUNT_NAME = 'goobster';
const ACCOUNT = `${ACCOUNT_DOMAIN}\\${ACCOUNT_NAME}`;
const STOP_TIMEOUT = '120 sec';
const RESTART_DELAY = '10 sec';

/**
 * The service host: WinSW v2.12.0, the .NET Framework 4.x build (it runs on a
 * stock Windows 10/11 and Server 2016+ without installing a runtime).
 * `scripts/bootstrap-pins.json` (`winsw`) holds the same pin; a test keeps
 * the two equal. The helper compares the host executable against this hash
 * before it registers anything, so a replaced file is never made a service.
 */
const WINSW = Object.freeze({
    version: '2.12.0',
    file: 'WinSW.NET4.exe',
    url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET4.exe',
    sha256: '923111c7142b3dc783a3c722b19b8a21bcb78222d7a136ac33f0ca8a29f4cb66'
});

const MAX_PATH_LENGTH = 200;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f<>"|?*%]/;

/** A path the service definition can carry: absolute drive path, normalised, no expansion (WinSW expands `%VAR%`), no UNC. */
function assertSafePath(value, what) {
    if (typeof value !== 'string' || value.length > MAX_PATH_LENGTH || !/^[A-Za-z]:\\/.test(value) || UNSAFE.test(value) || value.includes(':', 2)) {
        throw new Error(`${what} is not a path a service definition can carry`);
    }
    if (path.win32.normalize(value) !== value || value.endsWith('\\')) throw new Error(`${what} is not normalised`);
    return value;
}

function isInsideOrSame(parent, child) {
    const a = parent.toLowerCase();
    const b = child.toLowerCase();
    return b === a || b.startsWith(a.endsWith('\\') ? a : `${a}\\`);
}

/** Where the host, its definition and the directory holding them live, inside the manager store. */
function servicePaths(roots) {
    const dir = path.win32.join(roots.managerStore, SERVICE_DIR_NAME);
    return { dir, exe: path.win32.join(dir, HOST_FILE_NAME), xml: path.win32.join(dir, XML_FILE_NAME) };
}

/** `<code>\current\runtime\node.exe`, the bundled Node: a Windows installation always runs an activated payload. */
function nodeExeFor(codeRoot) {
    return path.win32.join(codeRoot, 'current', 'runtime', 'node.exe');
}

function managerScriptFor(codeRoot) {
    return path.win32.join(codeRoot, 'current', 'app', 'apps', 'manager', 'index.js');
}

/**
 * The environment the service carries: the same `GOOBSTER_*` roots as the
 * systemd unit, with Windows paths, and `GOOBSTER_SUPERVISOR=windows-service`.
 * Never a secret.
 */
function serviceEnvironment({ roots, layout }) {
    return [
        ['NODE_ENV', 'production'],
        ['GOOBSTER_SUPERVISOR', 'windows-service'],
        ['GOOBSTER_RUNTIME_MODE', layout],
        ['GOOBSTER_WORKSPACE_ROOT', path.win32.join(roots.code, 'current', 'app')],
        ['GOOBSTER_DATA_DIR', roots.data],
        ['GOOBSTER_CONFIG_PATH', roots.config],
        ['GOOBSTER_CACHE_DIR', roots.cache],
        ['GOOBSTER_LOG_DIR', roots.logs],
        ['GOOBSTER_MANAGER_STATE_DIR', roots.managerStore]
    ];
}

function dedupe(paths) {
    const unique = [...new Set(paths)].sort((a, b) => a.length - b.length);
    const kept = [];
    for (const candidate of unique) {
        if (!kept.some(parent => isInsideOrSame(parent, candidate))) kept.push(candidate);
    }
    return kept;
}

/**
 * The directories the service writes, to which the virtual account gets
 * modify rights: the data, config, cache, logs, uploads and manager-store
 * roots. A root inside another listed one is not repeated. The config file is
 * replaced on save, so its directory is the path - unless that directory is
 * (or holds) the code root, in which case the file itself is the path and the
 * code root stays read-only.
 */
function mutablePaths({ roots }) {
    const configDir = path.win32.dirname(roots.config);
    const configTree = !isInsideOrSame(configDir, roots.code);
    const candidates = [roots.data, roots.cache, roots.logs, roots.uploads, roots.managerStore];
    if (configTree) candidates.push(configDir);
    const kept = dedupe(candidates);
    if (!configTree && !kept.some(parent => isInsideOrSame(parent, roots.config))) kept.push(roots.config);
    return kept;
}

function escapeText(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
    return escapeText(value).replace(/"/g, '&quot;');
}

function unescapeXml(value) {
    return String(value).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * The service definition for one installation.
 * @param {Object} params
 * @param {string} [params.name]              the service id (always `goobster`)
 * @param {string|null} [params.installationId] the marker
 * @param {string} [params.runtimeUser]       always the virtual account `goobster`
 * @param {string} params.codeRoot
 * @param {Object} params.roots               the seven installation roots
 * @param {string} params.layout
 * @returns {string}
 */
function renderXml({ name = SERVICE_ID, installationId = null, runtimeUser = ACCOUNT_NAME, codeRoot, roots, layout }) {
    if (name !== SERVICE_ID) throw new Error('the service id is not goobster');
    if (runtimeUser !== ACCOUNT_NAME) throw new Error('the service account is not the virtual account goobster');
    if (installationId !== null && !UUID.test(installationId)) throw new Error('the installation id is not a UUID');
    assertSafePath(codeRoot, 'the code root');
    for (const role of ['code', 'data', 'config', 'cache', 'logs', 'uploads', 'managerStore']) assertSafePath(roots[role], `the ${role} root`);
    if (!/^[a-z]+$/.test(String(layout))) throw new Error('the layout is not a layout name');

    const lines = [];
    if (installationId) lines.push(`<!-- ${MARKER_KEY}: ${installationId} -->`);
    lines.push('<service>');
    lines.push(`    <id>${SERVICE_ID}</id>`);
    lines.push(`    <name>${DISPLAY_NAME}</name>`);
    lines.push(`    <description>${installationId ? `Goobster Discord bot, installation ${installationId}` : 'Goobster Discord bot'}</description>`);
    lines.push(`    <executable>${escapeText(nodeExeFor(codeRoot))}</executable>`);
    lines.push(`    <arguments>"${escapeText(managerScriptFor(codeRoot))}" --supervise</arguments>`);
    lines.push(`    <workingdirectory>${escapeText(codeRoot)}</workingdirectory>`);
    lines.push('    <serviceaccount>');
    lines.push(`        <domain>${ACCOUNT_DOMAIN}</domain>`);
    lines.push(`        <user>${ACCOUNT_NAME}</user>`);
    lines.push('    </serviceaccount>');
    lines.push('    <startmode>Automatic</startmode>');
    lines.push(`    <onfailure action="restart" delay="${RESTART_DELAY}"/>`);
    lines.push('    <resetfailure>1 hour</resetfailure>');
    lines.push(`    <stoptimeout>${STOP_TIMEOUT}</stoptimeout>`);
    lines.push('    <stopparentprocessfirst>true</stopparentprocessfirst>');
    lines.push('    <hidewindow>true</hidewindow>');
    for (const [key, value] of serviceEnvironment({ roots, layout })) {
        lines.push(`    <env name="${key}" value="${escapeAttribute(value)}"/>`);
    }
    lines.push(`    <logpath>${escapeText(roots.logs)}</logpath>`);
    lines.push('    <logname>goobster-service</logname>');
    lines.push('    <log mode="roll"/>');
    lines.push('</service>');
    return `${lines.join('\n')}\n`;
}

/**
 * What a definition says about itself: the marker and the ids, so the helper
 * can tell its own from somebody else's. Tolerates a byte-order mark and
 * either line ending.
 * @returns {{ installationId: string|null, executable: string|null, serviceId: string|null }}
 */
function parseDefinition(text) {
    const body = String(text).replace(/^\uFEFF/, '');
    const marker = new RegExp(`<!--\\s*${MARKER_KEY}:\\s*([0-9a-fA-F-]{36})\\s*-->`).exec(body);
    const tag = (name) => {
        const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body);
        return match ? unescapeXml(match[1]).trim() : null;
    };
    return {
        installationId: marker && UUID.test(marker[1].toLowerCase()) ? marker[1].toLowerCase() : null,
        executable: tag('executable'),
        serviceId: tag('id')
    };
}

module.exports = {
    SERVICE_ID,
    DISPLAY_NAME,
    MARKER_KEY,
    UUID,
    HOST_FILE_NAME,
    XML_FILE_NAME,
    SERVICE_DIR_NAME,
    ACCOUNT_DOMAIN,
    ACCOUNT_NAME,
    ACCOUNT,
    STOP_TIMEOUT,
    RESTART_DELAY,
    WINSW,
    assertSafePath,
    isInsideOrSame,
    servicePaths,
    nodeExeFor,
    managerScriptFor,
    serviceEnvironment,
    mutablePaths,
    renderXml,
    parseDefinition
};
