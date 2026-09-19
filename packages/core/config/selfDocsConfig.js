require('dotenv').config();

const path = require('node:path');
const runtimePaths = require('../runtimePaths');

// config.json is optional (e.g. env-only deployments); never crash at import time.
let fileConfig = {};
try {
    fileConfig = require('../../../config.json');
} catch {
    // config.json optional at load time
}

const selfDocs = fileConfig.selfDocs || {};

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
 * Self-knowledge configuration: how Goobster's own documentation is seeded
 * into the `self_docs` table and exposed through the `consultDocs` tool.
 * Resolution order matches config/sandboxConfig.js: environment variable
 * first, then config.json, then a default.
 *
 * The whole feature is ON by default - it needs no credentials and no
 * network. Semantic ranking (`embeddings`) is layered on top only when an
 * embedding backend is configured and degrades to keyword ranking
 * otherwise, so turning it off never removes the tool.
 *
 * `sourceDirs` are repo-relative or absolute directories walked for
 * `*.md` files. `operatorDir` (default `data/self-docs/`) is where a
 * server operator drops deployment-specific notes; it is walked last so
 * an operator doc with the same relative name never collides with a
 * shipped one (slugs carry the directory).
 */
module.exports = {
    /** Master switch: when false the tool is not registered and nothing is seeded. */
    enabled: flag('GOOBSTER_SELF_DOCS_ENABLED', selfDocs.enabled, true),
    /** Re-seed (idempotent, hash-compared) every time the bot starts. */
    seedOnStartup: flag('GOOBSTER_SELF_DOCS_SEED_ON_STARTUP', selfDocs.seedOnStartup, true),
    /** Compute chunk embeddings in the background when a backend exists. */
    embeddings: flag('GOOBSTER_SELF_DOCS_EMBEDDINGS', selfDocs.embeddings, true),
    /** Repo-relative (or absolute) files and directories that make up the corpus. */
    sources: tokens(process.env.GOOBSTER_SELF_DOCS_SOURCES || selfDocs.sources || ['README.md', 'documentation']),
    /** Operator-authored docs; walked in addition to `sources`. */
    operatorDir: process.env.GOOBSTER_SELF_DOCS_OPERATOR_DIR
        || selfDocs.operatorDir
        || path.join(runtimePaths.dataDir, 'self-docs'),
    /** Where repo-relative sources resolve from. */
    workspaceRoot: runtimePaths.workspaceRoot,
    /** Target chunk size in characters (sections are merged/split toward this). */
    chunkChars: 1800,
    /** Hard cap on one search result set. */
    maxSearchResults: 8
};
