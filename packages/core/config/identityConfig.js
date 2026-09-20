require('dotenv').config();

// config.json is optional (e.g. env-only deployments); never crash at import time.
let fileConfig = {};
try {
    fileConfig = require('../../../config.json');
} catch {
    // config.json optional at load time
}

const identity = fileConfig.identity || {};

/** Env switch first, then config.json, then the default. */
function flag(envName, fileValue, def) {
    const raw = process.env[envName];
    if (raw !== undefined && raw !== '') {
        return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
    }
    if (fileValue === undefined || fileValue === null) return def;
    return Boolean(fileValue);
}

/** Comma/space separated string or array -> trimmed non-empty tokens. */
function tokens(value) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,\s]+/);
    return raw.map(v => String(v ?? '').trim()).filter(Boolean);
}

/**
 * Application identity configuration (shared-instance Increment A; spec in
 * documentation/shared_instance_product_spec.md). Resolution order matches
 * the other config modules: environment variable, then config.json, then a
 * default.
 *
 * Everything here is inert by default so a single-user installation keeps
 * behaving exactly as before: Discord users still sign in through OAuth
 * and a session is all the portal requires. `requireAccount` is the
 * release gate that turns installation membership into an explicit
 * entitlement (an app_accounts row).
 */
module.exports = {
    /**
     * Stable label for this installation, carried on every ActorContext so
     * a job or event can be traced to the instance that produced it.
     */
    installationId: process.env.GOOBSTER_INSTALLATION_ID
        || identity.installationId
        || 'local',
    /**
     * Release gate: when true, a web session whose principal has no active
     * app_accounts row is rejected with 403 NO_ACCOUNT. Off by default -
     * existing Discord logins must keep working until the operator has
     * granted accounts (see scripts/identity-report.js).
     */
    requireAccount: flag('GOOBSTER_IDENTITY_REQUIRE_ACCOUNT', identity.requireAccount, false),
    /**
     * Discord user ids that receive the operator role through the explicit
     * bootstrap (`node scripts/identity-report.js --bootstrap-operators`).
     * Never inferred from "first visitor" or from Manage Server.
     */
    operators: tokens(process.env.GOOBSTER_IDENTITY_OPERATORS || identity.operators || [])
};
