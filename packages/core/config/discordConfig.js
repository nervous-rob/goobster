require('dotenv').config();

// config.json is optional (env-only deployments); never crash at import time.
let fileConfig = {};
try {
    fileConfig = require('../../../config.json');
} catch {
    // config.json optional at load time
}

const discord = fileConfig.discord || {};

/** Env switch first, then config.json; null when neither says anything. */
function tri(envName, fileValue) {
    const raw = process.env[envName];
    if (raw !== undefined && raw !== '') {
        return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
    }
    if (fileValue === undefined || fileValue === null) return null;
    return Boolean(fileValue);
}

let override;

/**
 * Whether this installation has a Discord adapter at all (shared-instance
 * Increment C, spec §6). Discord is one transport among others: the web
 * portal, the schedulers, and result delivery all work with it switched
 * off, and only Discord-specific actions report the integration as
 * unavailable.
 *
 * Resolution: `GOOBSTER_DISCORD_ENABLED` / `discord.enabled` when set;
 * otherwise inferred from whether a bot token is configured.
 */
module.exports = {
    /** Explicit switch, or null to infer from the token. */
    get explicit() {
        return tri('GOOBSTER_DISCORD_ENABLED', discord.enabled);
    },

    /** Whether a bot token is configured (config.json `token`). */
    get tokenConfigured() {
        return typeof fileConfig.token === 'string' && fileConfig.token.trim().length > 0;
    },

    /** The Discord adapter is part of this installation. */
    get enabled() {
        if (override !== undefined) return override;
        const explicit = this.explicit;
        if (explicit !== null) return explicit;
        return this.tokenConfigured;
    },

    /** Why the adapter is off, or null when it is on (shown to the host). */
    get disabledReason() {
        if (this.enabled) return null;
        if (this.explicit === false) {
            return 'Discord is switched off for this installation (discord.enabled = false).';
        }
        return 'No Discord bot token is configured.';
    },

    /** Test seam: force the resolved state for this process (undefined clears). */
    setEnabledForTests(value) {
        override = value === undefined ? undefined : Boolean(value);
    }
};
