/** Fresh-install defaults. Host overrides are stored in instance_state.limits. */
let file = {};
try { file = require('../../../config.json').limits || {}; } catch { /* optional */ }
const value = (env, key, fallback) => process.env[env] ?? file[key] ?? fallback;
const integer = (raw, fallback, min, max) => Number.isSafeInteger(Number(raw)) && Number(raw) >= min && Number(raw) <= max
    ? Number(raw) : fallback;
const cap = value('GOOBSTER_LIMITS_DAILY_TOKENS', 'dailyTokens', null);
module.exports = {
    dailyTokens: cap == null || cap === '' ? null : integer(cap, null, 1, Number.MAX_SAFE_INTEGER),
    windowHours: integer(value('GOOBSTER_LIMITS_WINDOW_HOURS', 'windowHours', 24), 24, 1, 24),
    retentionDays: integer(value('GOOBSTER_LIMITS_RETENTION_DAYS', 'retentionDays', 90), 90, 1, 3650)
};
