/**
 * Manager settings, resolved from the environment at call time (never
 * cached at require time, so a test or a CLI run can point the manager at
 * its own roots). Nothing here reads config.json or opens a database.
 *
 *   GOOBSTER_MANAGER_PORT        listen port (default 3400)
 *   GOOBSTER_MANAGER_HOST        bind address (default 127.0.0.1; non-loopback needs LAN mode)
 *   GOOBSTER_MANAGER_LAN=1       explicit LAN access: requires TLS and a LAN host name
 *   GOOBSTER_MANAGER_LAN_HOST    the host[:port] browsers use on the LAN (Host/Origin allow-list)
 *   GOOBSTER_MANAGER_TLS_CERT    PEM certificate file (LAN mode)
 *   GOOBSTER_MANAGER_TLS_KEY     PEM private key file (LAN mode)
 *   GOOBSTER_MANAGER_STATE_DIR   the manager store (default <dataDir>/manager)
 *   GOOBSTER_MANAGER_RECONCILE=0 never open the application database to reconcile audit records
 *   GOOBSTER_MANAGER_SUPERVISE=1 run the workers of the layout (same as --supervise; documentation/manager_lifecycle.md)
 *   GOOBSTER_MANAGER_WORKERS     child (spawn them, default) | external (an OS unit runs each worker)
 *   GOOBSTER_DATA_DIR, GOOBSTER_DB_PATH, GOOBSTER_DB_URL, GOOBSTER_CONFIG_PATH as for the app
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { workspaceRoot } = require('@goobster/core/runtimePaths');

const DEFAULT_PORT = 3400;
const ON_WORDS = new Set(['1', 'true', 'yes', 'on']);
const OFF_WORDS = new Set(['0', 'false', 'no', 'off']);

class StartupError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'StartupError';
        this.code = code;
    }
}

function isLoopbackAddress(host) {
    const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (value === 'localhost' || value === '::1' || value === '::ffff:127.0.0.1') return true;
    return net.isIPv4(value) && value.startsWith('127.');
}

function flag(raw, fallback = false) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const value = String(raw).trim().toLowerCase();
    if (ON_WORDS.has(value)) return true;
    if (OFF_WORDS.has(value)) return false;
    return fallback;
}

/**
 * @param {Object} [env]
 * @returns {Object} settings
 */
function resolveSettings(env = process.env) {
    const root = env.GOOBSTER_WORKSPACE_ROOT || workspaceRoot;
    const dataDir = env.GOOBSTER_DATA_DIR || path.join(root, 'data');
    const lan = flag(env.GOOBSTER_MANAGER_LAN);
    const rawPort = env.GOOBSTER_MANAGER_PORT;
    const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
    return {
        env,
        root,
        supervise: flag(env.GOOBSTER_MANAGER_SUPERVISE),
        workersMode: String(env.GOOBSTER_MANAGER_WORKERS || '').trim().toLowerCase() === 'external' ? 'external' : 'child',
        port,
        host: env.GOOBSTER_MANAGER_HOST || (lan ? '0.0.0.0' : '127.0.0.1'),
        lan,
        lanHost: env.GOOBSTER_MANAGER_LAN_HOST ? String(env.GOOBSTER_MANAGER_LAN_HOST).trim().toLowerCase() : null,
        tlsCertFile: env.GOOBSTER_MANAGER_TLS_CERT || null,
        tlsKeyFile: env.GOOBSTER_MANAGER_TLS_KEY || null,
        reconcile: flag(env.GOOBSTER_MANAGER_RECONCILE, true),
        dataDir,
        storeDir: env.GOOBSTER_MANAGER_STATE_DIR || path.join(dataDir, 'manager'),
        sqlitePath: env.GOOBSTER_DB_PATH || path.join(dataDir, 'goobster.sqlite'),
        dbUrl: env.GOOBSTER_DB_URL || null,
        configPath: env.GOOBSTER_CONFIG_PATH || path.join(root, 'config.json'),
        featuresPath: path.join(dataDir, 'features.json')
    };
}

/**
 * Refuse a transport the manager must not serve: a non-loopback bind
 * without LAN mode, or LAN mode without TLS and a LAN host name.
 * @returns {{ tls: { cert: Buffer, key: Buffer } | null }}
 * @throws {StartupError}
 */
function validateTransport(settings, fs = nodeFs) {
    if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) {
        throw new StartupError('BAD_PORT', 'GOOBSTER_MANAGER_PORT must be an integer between 0 and 65535.');
    }
    const loopback = isLoopbackAddress(settings.host);
    if (!settings.lan) {
        if (!loopback) {
            throw new StartupError('NON_LOOPBACK_REFUSED',
                `Refusing to bind the manager to ${settings.host}: only loopback is allowed without GOOBSTER_MANAGER_LAN=1. `
                + 'For a headless host, keep the loopback bind and use an SSH tunnel (ssh -L 3400:127.0.0.1:3400 <host>).');
        }
        return { tls: null };
    }
    if (!settings.tlsCertFile || !settings.tlsKeyFile) {
        throw new StartupError('LAN_REQUIRES_TLS',
            'GOOBSTER_MANAGER_LAN=1 requires GOOBSTER_MANAGER_TLS_CERT and GOOBSTER_MANAGER_TLS_KEY: '
            + 'the manager never serves a non-loopback address over plain HTTP.');
    }
    if (!settings.lanHost) {
        throw new StartupError('LAN_REQUIRES_HOST',
            'GOOBSTER_MANAGER_LAN=1 requires GOOBSTER_MANAGER_LAN_HOST (the host name browsers use), for the Host and Origin checks.');
    }
    let cert;
    let key;
    try {
        cert = fs.readFileSync(settings.tlsCertFile);
        key = fs.readFileSync(settings.tlsKeyFile);
    } catch {
        throw new StartupError('TLS_UNREADABLE', 'The manager TLS certificate or key file cannot be read.');
    }
    return { tls: { cert, key } };
}

module.exports = { DEFAULT_PORT, StartupError, resolveSettings, validateTransport, isLoopbackAddress, flag };
