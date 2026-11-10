/**
 * Fresh-install caps for delegated work (documentation/delegated_operations.md).
 * Host overrides are stored in instance_state.assistantCaps and win over
 * these; services/assistantControlService.js is the reader.
 *
 * Until the owner records the pilot's numbers these are the conservative
 * defaults DA-3 shipped with: two runs across the installation, one per
 * account, and per responsibility per UTC day 200,000 model tokens, 20 web
 * searches and 120 sandbox seconds.
 */
let file = {};
try { file = require('./configJson').load().assistant || {}; } catch { /* optional */ }

/** Inclusive bounds for each cap; the field catalog repeats them for the manager. */
const BOUNDS = Object.freeze({
    installationRuns: { min: 1, max: 20 },
    runsPerAccount: { min: 1, max: 10 },
    defaultModelTokens: { min: 1000, max: 100_000_000 },
    defaultSearches: { min: 0, max: 1000 },
    defaultComputeSeconds: { min: 0, max: 86_400 }
});

const integer = (env, key, fallback) => {
    const raw = process.env[env] ?? file[key];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= BOUNDS[key].min && n <= BOUNDS[key].max ? n : fallback;
};

module.exports = {
    installationRuns: integer('GOOBSTER_ASSISTANT_INSTALLATION_RUNS', 'installationRuns', 2),
    runsPerAccount: integer('GOOBSTER_ASSISTANT_RUNS_PER_ACCOUNT', 'runsPerAccount', 1),
    defaultModelTokens: integer('GOOBSTER_ASSISTANT_DEFAULT_MODEL_TOKENS', 'defaultModelTokens', 200_000),
    defaultSearches: integer('GOOBSTER_ASSISTANT_DEFAULT_SEARCHES', 'defaultSearches', 20),
    defaultComputeSeconds: integer('GOOBSTER_ASSISTANT_DEFAULT_COMPUTE_SECONDS', 'defaultComputeSeconds', 120),
    BOUNDS
};
