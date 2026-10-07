/**
 * Where the portal finds the installation manager (installer P2.4, #326).
 *
 * The browser never talks to the manager: the portal's Host routes call it
 * server-side with a bridge assertion (documentation/manager.md, "The portal
 * bridge"). The address is the manager's loopback listener unless the host
 * says otherwise; a non-loopback address must be https (the manager only
 * serves https off loopback anyway).
 */
require('dotenv').config();

let fileConfig = {};
try {
    fileConfig = require('../../../config.json');
} catch {
    // config.json is optional (env-only deployments); never crash at import time.
}

const DEFAULT_URL = 'http://127.0.0.1:3400';

/** The configured address: environment, then config.json `manager.baseUrl`, then the loopback default. */
function resolveUrl({ env = process.env, file = fileConfig } = {}) {
    const fromEnv = env.GOOBSTER_MANAGER_URL;
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
    const fromFile = file && file.manager && file.manager.baseUrl;
    if (typeof fromFile === 'string' && fromFile.trim() !== '') return fromFile.trim();
    return DEFAULT_URL;
}

module.exports = {
    DEFAULT_URL,
    resolveUrl,
    url: resolveUrl()
};
