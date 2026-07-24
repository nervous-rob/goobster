require('dotenv').config();

// config.json is optional (e.g. env-only deployments); never crash at import time.
let fileConfig = {};
try {
    fileConfig = require('../config.json');
} catch {
    // config.json optional at load time
}

/**
 * Centralized configuration for the developer integrations (GitHub +
 * Cursor Cloud Agents). Resolution order matches config/aiConfig.js:
 * environment variable first, then config.json, then a default.
 *
 * Everything here is optional — missing credentials disable the related
 * feature with a warning, never a startup crash.
 */
module.exports = {
    github: {
        /**
         * Fine-grained personal access token. Optional: public-repo reads
         * work keyless (60 req/h); a token raises the limit to 5000 req/h,
         * unlocks code search, and grants private-repo access.
         */
        token: process.env.GITHUB_TOKEN || fileConfig.github?.token || null,
        /** HMAC secret shared with the repo's webhook settings. Set = receiver enabled. */
        webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || fileConfig.github?.webhookSecret || null,
        /** Issue label that proposes a Cursor agent launch for that issue. */
        agentLabel: process.env.GITHUB_AGENT_LABEL || fileConfig.github?.agentLabel || 'goobster-fix'
    },

    cursor: {
        /** Cursor API key (Dashboard → API Keys, or a team service-account key). */
        apiKey: process.env.CURSOR_API_KEY || fileConfig.cursor?.apiKey || null,
        /** Optional model ID for launched agents (GET /v1/models); omit for the account default. */
        defaultModel: process.env.CURSOR_AGENT_MODEL || fileConfig.cursor?.model || null,
        /** HMAC secret for the Cursor status webhook receiver. Set = receiver enabled. */
        webhookSecret: process.env.CURSOR_WEBHOOK_SECRET || fileConfig.cursor?.webhookSecret || null,
        /** How often the run tracker polls active runs (webhookless fallback). */
        pollIntervalMs: Number(process.env.CURSOR_POLL_INTERVAL_MS || fileConfig.cursor?.pollIntervalMs || 60_000)
    }
};
