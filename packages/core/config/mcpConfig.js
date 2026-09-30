require('dotenv').config();

// config.json is optional (env-only deployments); never crash at import time.
let fileConfig = {};
try {
    fileConfig = require('../../../config.json');
} catch {
    // config.json optional at load time
}

const mcp = fileConfig.mcp || {};

function flag(envName, fileValue, def) {
    const raw = process.env[envName];
    if (raw !== undefined && raw !== '') {
        return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
    }
    if (fileValue === undefined || fileValue === null) return def;
    return Boolean(fileValue);
}

function bounded(value, def, min, max) {
    if (value === null || value === undefined || value === '') return def;
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Read-only MCP server (documentation/mcp.md).
 *
 * Off by default: the endpoint serves one person's private workspace, so
 * it is an explicit opt-in like the sandbox, never a side effect of
 * turning the portal on.
 */
function defaults() {
    return {
        enabled: flag('GOOBSTER_MCP_ENABLED', mcp.enabled, false),
        /** Mount path on the public HTTP server. */
        path: '/mcp',
        maxTokensPerUser: bounded(
            process.env.GOOBSTER_MCP_MAX_TOKENS ?? mcp.maxTokensPerUser,
            10, 1, 25
        ),
        requestsPerMinute: bounded(
            process.env.GOOBSTER_MCP_REQUESTS_PER_MINUTE ?? mcp.requestsPerMinute,
            120, 10, 600
        ),
        maxResultChars: 16_000
    };
}

let override = null;

function resolve() {
    return override || defaults();
}

/** Tests replace the resolved configuration; `null` clears the override. */
function _setForTests(partial) {
    override = partial == null ? null : { ...defaults(), ...partial };
}

module.exports = {
    resolve,
    _setForTests,
    get enabled() {
        return resolve().enabled;
    },
    get path() {
        return resolve().path;
    },
    get maxTokensPerUser() {
        return resolve().maxTokensPerUser;
    },
    get requestsPerMinute() {
        return resolve().requestsPerMinute;
    },
    get maxResultChars() {
        return resolve().maxResultChars;
    }
};
