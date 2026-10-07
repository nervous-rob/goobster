/**
 * The privileged helper protocol (documentation/linux_install.md, "Elevation").
 *
 * The manager never runs elevated. When an installation step needs the
 * operating system's privilege it starts `apps/manager/privileged/helper.js`
 * as a separate process, through `sudo -n` (or `pkexec` when a display is
 * present), and gives it exactly one JSON document on stdin:
 *
 *   { "v": 1, "operation": "service.register", "input": { ... } }
 *
 * The helper answers with exactly one JSON document on stdout:
 *
 *   { "v": 1, "ok": true,  "operation": "...", "outcome": "done"|"noop", "detail": { ... }, "log": [ ... ] }
 *   { "v": 1, "ok": false, "operation": "...", "code": "SERVICE_FOREIGN", "message": "...", "log": [ ... ] }
 *
 * Values never travel in argv or the environment; a secret never travels at
 * all (no operation takes one). Validation here is strict and closed: an
 * unknown field, a path outside the shape rules, an identifier that is not
 * `^[a-z][a-z0-9-]{0,31}$` is a refusal before anything runs. This module and
 * the files beside it are the helper's whole code: Node built-ins only.
 */

const { UUID, RUNTIME_USER, assertSafePath } = require('../platform/systemdUnit');

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 64 * 1024;

const PRIVILEGED_OPERATIONS = Object.freeze([
    'service.register',
    'service.unregister',
    'package.install',
    'updater.disable',
    'user.create'
]);

const IDENTIFIER = /^[a-z][a-z0-9-]{0,31}$/;
const TIMER_UNIT = /^[a-z][a-z0-9-]{0,31}\.timer$/;
const CRON_FILE = /^[a-z][a-z0-9._-]{0,63}$/;
const SERVICE_KINDS = Object.freeze(['systemd', 'windows-service', 'launchd']);
const SERVICE_SCOPES = Object.freeze(['machine', 'user']);
const LAYOUTS = Object.freeze(['lite', 'standalone', 'paired']);
const MODES = Object.freeze(['payload', 'checkout']);
const ROOT_ROLES = Object.freeze(['code', 'data', 'config', 'cache', 'logs', 'uploads', 'managerStore']);
const UPDATER_MECHANISMS = Object.freeze(['systemd-timer', 'cron-system']);

/** Locations a privileged operation may never be pointed at, whatever the request says. */
const SYSTEM_PATHS = Object.freeze(['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/media', '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var']);
const SYSTEM_TREES = Object.freeze(['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var/lib/systemd', '/var/lib/dpkg', '/var/lib/rpm']);
const RESERVED_ACCOUNTS = Object.freeze(['root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'nobody', 'systemd-network', 'systemd-resolve', 'sshd', 'messagebus', 'polkitd']);

class HelperError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'HelperError';
        this.code = code;
    }
}

const refuse = (code, message) => new HelperError(code, message);

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, allowed, what) {
    if (!isPlainObject(value)) throw refuse('INVALID_INPUT', `${what} must be an object.`);
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw refuse('INVALID_INPUT', `${what} has a field this operation does not accept.`);
    }
}

function identifier(value, what) {
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw refuse('INVALID_INPUT', `${what} must match ^[a-z][a-z0-9-]{0,31}$.`);
    return value;
}

function oneOf(value, list, what) {
    if (!list.includes(value)) throw refuse('INVALID_INPUT', `${what} is not one of: ${list.join(', ')}.`);
    return value;
}

/** An absolute, normalised path of safe characters that is not a system location. */
function safeRoot(value, what) {
    try {
        assertSafePath(value, what);
    } catch {
        throw refuse('INVALID_PATH', `${what} must be an absolute, normalised path without quotes, backslashes, $, % or control characters.`);
    }
    if (SYSTEM_PATHS.includes(value)) throw refuse('PATH_NOT_ALLOWED', `${what} is a system location.`);
    if (SYSTEM_TREES.some(tree => value === tree || value.startsWith(`${tree}/`))) throw refuse('PATH_NOT_ALLOWED', `${what} is inside a system location.`);
    if (value.split('/').filter(Boolean).length < 2) throw refuse('PATH_NOT_ALLOWED', `${what} is too close to the file system root.`);
    return value;
}

function runtimeUser(value, what = 'The runtime user') {
    if (typeof value !== 'string' || !RUNTIME_USER.test(value)) throw refuse('INVALID_INPUT', `${what} must be a lowercase account name.`);
    if (RESERVED_ACCOUNTS.includes(value)) throw refuse('USER_REFUSED', `${what} names a system account.`);
    return value;
}

function installationId(value) {
    if (typeof value !== 'string' || !UUID.test(value)) throw refuse('INVALID_INPUT', 'The installation id must be a UUID.');
    return value;
}

function roots(value) {
    exactKeys(value, ROOT_ROLES, 'The roots');
    const out = {};
    for (const role of ROOT_ROLES) {
        if (value[role] === undefined) throw refuse('INVALID_INPUT', `The roots must name ${role}.`);
        out[role] = safeRoot(value[role], `The ${role} root`);
    }
    return out;
}

const VALIDATORS = {
    'service.register'(input) {
        exactKeys(input, ['kind', 'name', 'layout', 'codeRoot', 'runtimeUser', 'installationId', 'roots', 'mode', 'nodePath', 'scope'], 'The input');
        const out = {
            kind: oneOf(input.kind, SERVICE_KINDS, 'The service kind'),
            // Whether the service belongs to the machine (a system unit, a LaunchDaemon, a Windows service) or to the
            // invoking account's sessions (a LaunchAgent). systemd registers machine services only.
            scope: input.scope === undefined ? 'machine' : oneOf(input.scope, SERVICE_SCOPES, 'The service scope'),
            name: identifier(input.name, 'The service name'),
            layout: oneOf(input.layout, LAYOUTS, 'The layout'),
            codeRoot: safeRoot(input.codeRoot, 'The code root'),
            runtimeUser: runtimeUser(input.runtimeUser),
            installationId: installationId(input.installationId),
            roots: roots(input.roots),
            mode: input.mode === undefined ? 'payload' : oneOf(input.mode, MODES, 'The mode')
        };
        if (input.nodePath !== undefined) out.nodePath = safeRoot(input.nodePath, 'The node path');
        if (out.codeRoot !== out.roots.code) throw refuse('INVALID_INPUT', 'The code root is not the roots\' code root.');
        return out;
    },
    'service.unregister'(input) {
        exactKeys(input, ['kind', 'name', 'registeredBy', 'installationId'], 'The input');
        if (input.registeredBy !== 'installer') throw refuse('INVALID_INPUT', 'Only a service the installer registered can be unregistered.');
        return {
            kind: oneOf(input.kind, SERVICE_KINDS, 'The service kind'),
            name: identifier(input.name, 'The service name'),
            registeredBy: 'installer',
            installationId: installationId(input.installationId)
        };
    },
    'user.create'(input) {
        exactKeys(input, ['name', 'home', 'system', 'installationId', 'roots', 'mode'], 'The input');
        if (input.system !== true) throw refuse('INVALID_INPUT', 'Only a system account can be created.');
        const out = {
            name: runtimeUser(input.name, 'The account name'),
            home: safeRoot(input.home, 'The home directory'),
            system: true,
            installationId: installationId(input.installationId),
            roots: roots(input.roots),
            mode: input.mode === undefined ? 'payload' : oneOf(input.mode, MODES, 'The mode')
        };
        return out;
    },
    'updater.disable'(input) {
        exactKeys(input, ['mechanism', 'unit', 'codeRoot'], 'The input');
        const mechanism = oneOf(input.mechanism, UPDATER_MECHANISMS, 'The updater mechanism');
        if (mechanism === 'systemd-timer' && !TIMER_UNIT.test(input.unit || '')) throw refuse('INVALID_INPUT', 'The unit must be a .timer unit name.');
        if (mechanism === 'cron-system' && !CRON_FILE.test(input.unit || '')) throw refuse('INVALID_INPUT', 'The unit must be a file name under /etc/cron.d.');
        return { mechanism, unit: input.unit, codeRoot: safeRoot(input.codeRoot, 'The code root') };
    },
    'package.install'(input) {
        exactKeys(input, ['names'], 'The input');
        if (!Array.isArray(input.names) || input.names.length > 32 || input.names.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9+._-]{0,63}$/.test(name))) {
            throw refuse('INVALID_INPUT', 'The names must be a list of package names.');
        }
        return { names: [...input.names] };
    }
};

/** @throws {HelperError} */
function validateInput(operation, input) {
    if (!PRIVILEGED_OPERATIONS.includes(operation)) throw refuse('UNKNOWN_OPERATION', 'There is no such privileged operation.');
    return VALIDATORS[operation](input);
}

/** Parse the one document on stdin into `{ operation, input }`. @throws {HelperError} */
function parseRequest(text) {
    if (typeof text !== 'string' || text.length === 0) throw refuse('INVALID_REQUEST', 'The request is empty.');
    if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw refuse('INVALID_REQUEST', 'The request is too large.');
    let doc;
    try {
        doc = JSON.parse(text);
    } catch {
        throw refuse('INVALID_REQUEST', 'The request is not one JSON document.');
    }
    exactKeys(doc, ['v', 'operation', 'input'], 'The request');
    if (doc.v !== PROTOCOL_VERSION) throw refuse('INVALID_REQUEST', 'The protocol version is not supported.');
    if (typeof doc.operation !== 'string') throw refuse('INVALID_REQUEST', 'The request names no operation.');
    return { operation: doc.operation, input: validateInput(doc.operation, doc.input) };
}

function buildRequest(operation, input) {
    return JSON.stringify({ v: PROTOCOL_VERSION, operation, input });
}

function okReply(operation, outcome, detail = {}, log = []) {
    return { v: PROTOCOL_VERSION, ok: true, operation, outcome, detail, log };
}

function errorReply(operation, code, message, log = []) {
    return { v: PROTOCOL_VERSION, ok: false, operation, code, message, log };
}

/** Parse the helper's one document. A reply the shape rules reject is a failure, not data. */
function parseReply(text, operation) {
    let doc;
    try {
        doc = JSON.parse(String(text).trim());
    } catch {
        return null;
    }
    if (!isPlainObject(doc) || doc.v !== PROTOCOL_VERSION || doc.operation !== operation || typeof doc.ok !== 'boolean') return null;
    const log = Array.isArray(doc.log) ? doc.log.filter(line => typeof line === 'string').slice(0, 40).map(line => line.slice(0, 240)) : [];
    if (doc.ok) {
        return { ok: true, outcome: doc.outcome === 'noop' ? 'noop' : 'done', detail: isPlainObject(doc.detail) ? doc.detail : {}, log };
    }
    return { ok: false, code: typeof doc.code === 'string' && /^[A-Z][A-Z0-9_]{1,47}$/.test(doc.code) ? doc.code : 'HELPER_FAILED', message: typeof doc.message === 'string' ? doc.message.slice(0, 300) : 'The helper failed.', log };
}

module.exports = {
    PROTOCOL_VERSION,
    MAX_REQUEST_BYTES,
    PRIVILEGED_OPERATIONS,
    IDENTIFIER,
    ROOT_ROLES,
    SYSTEM_PATHS,
    SYSTEM_TREES,
    RESERVED_ACCOUNTS,
    HelperError,
    refuse,
    isPlainObject,
    validateInput,
    parseRequest,
    buildRequest,
    okReply,
    errorReply,
    parseReply
};
