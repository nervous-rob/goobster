const db = require('../../db');
const { ExchangeError } = require('./errors');

/**
 * Per-guild exchange rules. Everything risky is OFF until an admin turns it
 * on, so adding this subsystem changes nothing for a server that never opts
 * in - the plain cash stock game keeps working exactly as before.
 */
const DEFAULTS = Object.freeze({
    marginEnabled: false,
    optionsEnabled: false,
    zeroDteEnabled: false,
    predictionsEnabled: false,
    maxLeverage: 2,
    interestRate: 0.08,
    borrowFeeRate: 0.05,
    maintenanceMargin: 0.25,
    shortMaintenanceMargin: 0.35,
    marginCallGraceMinutes: 60
});

// Guardrails on what an admin may configure. Leverage above 10x turns a
// margin call into a coin flip on the next tick, which is chaos without fun.
const LIMITS = Object.freeze({
    maxLeverage: { min: 1, max: 10 },
    interestRate: { min: 0, max: 2 },
    borrowFeeRate: { min: 0, max: 2 },
    maintenanceMargin: { min: 0.05, max: 1 },
    shortMaintenanceMargin: { min: 0.05, max: 2 },
    marginCallGraceMinutes: { min: 0, max: 1440 }
});

const BOOLEAN_KEYS = ['marginEnabled', 'optionsEnabled', 'zeroDteEnabled', 'predictionsEnabled'];
const NUMERIC_KEYS = Object.keys(LIMITS);

/** The risk-free rate used to price contracts (matches the loan rate). */
function riskFreeRate(settings) {
    return Math.min(0.25, settings.interestRate);
}

class ExchangeConfig {
    /** Effective settings for a guild (defaults when the guild never configured). */
    get(guildId) {
        const row = db.get('SELECT * FROM exchange_settings WHERE guildId = @guildId', { guildId });
        if (!row) return { ...DEFAULTS };
        return {
            marginEnabled: !!row.marginEnabled,
            optionsEnabled: !!row.optionsEnabled,
            zeroDteEnabled: !!row.zeroDteEnabled,
            predictionsEnabled: !!row.predictionsEnabled,
            maxLeverage: row.maxLeverage,
            interestRate: row.interestRate,
            borrowFeeRate: row.borrowFeeRate,
            maintenanceMargin: row.maintenanceMargin,
            shortMaintenanceMargin: row.shortMaintenanceMargin,
            marginCallGraceMinutes: row.marginCallGraceMinutes
        };
    }

    /**
     * Partially update a guild's rules. Unknown keys are rejected rather than
     * silently ignored so a typo in an admin command is visible.
     * @param {string} guildId
     * @param {Object} updates - any subset of the settings keys
     * @returns {Object} the effective settings after the update
     */
    set(guildId, updates = {}) {
        const current = this.get(guildId);
        const next = { ...current };

        for (const [key, value] of Object.entries(updates)) {
            if (value === undefined || value === null) continue;
            if (BOOLEAN_KEYS.includes(key)) {
                next[key] = !!value;
            } else if (NUMERIC_KEYS.includes(key)) {
                const numeric = Number(value);
                const { min, max } = LIMITS[key];
                if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
                    throw new ExchangeError('BAD_SETTING', `${key} must be a number between ${min} and ${max}.`);
                }
                next[key] = numeric;
            } else {
                throw new ExchangeError('BAD_SETTING', `Unknown exchange setting "${key}".`);
            }
        }

        // 0DTE without options is a switch wired to nothing - say so instead
        // of storing a state the trader can never reach.
        if (next.zeroDteEnabled && !next.optionsEnabled) {
            throw new ExchangeError('BAD_SETTING', 'Enable options before enabling 0DTE contracts.');
        }

        db.run(
            `INSERT INTO exchange_settings (
                 guildId, marginEnabled, optionsEnabled, zeroDteEnabled, predictionsEnabled,
                 maxLeverage, interestRate, borrowFeeRate, maintenanceMargin,
                 shortMaintenanceMargin, marginCallGraceMinutes, updatedAt
             ) VALUES (
                 @guildId, @marginEnabled, @optionsEnabled, @zeroDteEnabled, @predictionsEnabled,
                 @maxLeverage, @interestRate, @borrowFeeRate, @maintenanceMargin,
                 @shortMaintenanceMargin, @marginCallGraceMinutes, CURRENT_TIMESTAMP
             )
             ON CONFLICT(guildId) DO UPDATE SET
                 marginEnabled = excluded.marginEnabled,
                 optionsEnabled = excluded.optionsEnabled,
                 zeroDteEnabled = excluded.zeroDteEnabled,
                 predictionsEnabled = excluded.predictionsEnabled,
                 maxLeverage = excluded.maxLeverage,
                 interestRate = excluded.interestRate,
                 borrowFeeRate = excluded.borrowFeeRate,
                 maintenanceMargin = excluded.maintenanceMargin,
                 shortMaintenanceMargin = excluded.shortMaintenanceMargin,
                 marginCallGraceMinutes = excluded.marginCallGraceMinutes,
                 updatedAt = CURRENT_TIMESTAMP`,
            { guildId, ...next }
        );
        return next;
    }

    /** Guilds that have ever configured the exchange (the risk engine's work list). */
    configuredGuilds() {
        return db.all('SELECT guildId FROM exchange_settings').map(row => row.guildId);
    }

    /** @throws {ExchangeError} FEATURE_OFF when the named feature is disabled. */
    requireFeature(guildId, key, label) {
        const settings = this.get(guildId);
        if (!settings[key]) {
            throw new ExchangeError('FEATURE_OFF', `${label} are switched off in this server. An admin can enable them with \`/exchange settings\`.`);
        }
        return settings;
    }
}

module.exports = new ExchangeConfig();
module.exports.DEFAULTS = DEFAULTS;
module.exports.LIMITS = LIMITS;
module.exports.riskFreeRate = riskFreeRate;
