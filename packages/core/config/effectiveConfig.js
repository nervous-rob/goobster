/**
 * Effective settings: what every catalogued field resolves to right now and
 * where that value comes from.
 *
 * Pure. The caller hands in the environment, the parsed config.json and
 * (optionally) the database overrides it has already read, so the manager can
 * call this with the application database down: pass `overrides: null` and the
 * database-backed fields report `source: 'unknown-db'` instead of guessing.
 *
 * Precedence follows the runtime modules, not a wish: environment, then
 * config.json, then the default. A field with `dbOverride.wins` (the host
 * `limits.*` policy, the instance defaults) puts the database first, which is
 * what usageBudgetService.policy() does today.
 *
 * A secret's value never leaves `resolveEffective`: it reports presence, the
 * source and, when the secret is at least 12 characters long, its last four
 * characters. `resolveSecretValue` is the one separate function that returns a
 * value, for the provider probes that must authenticate; nothing else calls it.
 */

const catalog = require('./fieldCatalog');

const PLACEHOLDER = 'YOUR_';

function isPlaceholder(value) {
    return typeof value === 'string' && value.includes(PLACEHOLDER);
}

function envEntry(field, env) {
    for (const name of field.env) {
        const raw = env ? env[name] : undefined;
        if (raw !== undefined && raw !== null && String(raw).trim() !== '') return { name, raw: String(raw).trim() };
    }
    return null;
}

function fileEntry(field, fileConfig) {
    const primary = catalog.filePath(field);
    if (!primary || !fileConfig) return null;
    for (const dotted of [primary, ...field.legacyConfigPaths]) {
        const raw = catalog.getPath(fileConfig, dotted);
        if (raw === undefined || raw === null) continue;
        if (typeof raw === 'string' && raw.trim() === '') continue;
        if (Array.isArray(raw) && raw.length === 0) continue;
        return { path: dotted, raw };
    }
    return null;
}

function dbEntry(field, overrides) {
    if (!field.dbOverride || !overrides) return null;
    const store = overrides[field.dbOverride.key];
    if (store === null || typeof store !== 'object') return null;
    const raw = catalog.getPath(store, field.dbOverride.field);
    return raw === undefined ? null : { raw };
}

/** An environment string read the way the runtime modules read it. */
function parseEnvValue(field, raw) {
    if (field.type === 'boolean') {
        const word = raw.toLowerCase();
        return field.boolEnv === 'on-words' ? catalog.ON_WORDS.includes(word) : !catalog.OFF_WORDS.includes(word);
    }
    return raw;
}

function parseValue(field, raw, fromEnv) {
    const candidate = fromEnv ? parseEnvValue(field, String(raw)) : raw;
    if (field.type === 'boolean' && typeof candidate === 'boolean') return { ok: true, value: candidate };
    if (field.type === 'boolean' && !fromEnv) return { ok: true, value: Boolean(candidate) };
    return catalog.validateValue(field, candidate);
}

function describeOne(field, { env, fileConfig, overrides, features }) {
    const envHit = envEntry(field, env);
    const fileHit = fileEntry(field, fileConfig);
    const dbHit = dbEntry(field, overrides);
    const dbUnknown = Boolean(field.dbOverride) && overrides === null;
    const dbWins = Boolean(field.dbOverride && field.dbOverride.wins);

    const candidates = [];
    if (dbWins && dbHit) candidates.push(['db', dbHit]);
    if (envHit && field.sources.includes('env')) candidates.push(['env', envHit]);
    if (fileHit && field.sources.includes('config')) candidates.push(['config', fileHit]);
    if (!dbWins && dbHit) candidates.push(['db', dbHit]);

    let winner = candidates[0] || null;
    if (winner && winner[0] === 'config' && field.secret && isPlaceholder(winner[1].raw)) {
        winner = null;
    }
    const placeholder = Boolean(fileHit && isPlaceholder(fileHit.raw));

    const out = {
        id: field.id,
        section: field.section,
        type: field.type,
        feature: field.feature,
        apply: field.apply,
        help: field.help,
        secret: field.secret,
        present: false,
        source: 'unset',
        envControlled: false,
        controlledBy: null,
        envName: envHit ? envHit.name : null
    };
    if (features && features[field.feature]) out.featureActive = Boolean(features[field.feature].active);
    if (placeholder) out.placeholder = true;

    if (winner) {
        out.present = true;
        out.source = winner[0];
        if (winner[0] === 'env') out.envControlled = true;
        if (winner[0] === 'env' || winner[0] === 'db') out.controlledBy = winner[0];
    } else if (field.default !== null && field.default !== undefined) {
        out.source = 'default';
    }

    if (dbUnknown) {
        out.knownSource = out.source;
        out.source = 'unknown-db';
    }

    if (field.secret) {
        out.masked = true;
        const raw = winner ? winner[1].raw : null;
        out.fingerprint = typeof raw === 'string' ? catalog.fingerprintOf(raw) : null;
        return out;
    }

    if (!winner) {
        out.value = field.default === undefined ? null : field.default;
        return out;
    }
    const parsed = parseValue(field, winner[1].raw, winner[0] === 'env');
    if (!parsed.ok) {
        out.value = field.default === undefined ? null : field.default;
        out.invalid = true;
        out.issue = parsed.code;
        return out;
    }
    out.value = parsed.value;
    return out;
}

/**
 * @param {Object} params
 * @param {Object<string, string>} [params.env]
 * @param {Object} [params.fileConfig] parsed config.json ({} when absent or unreadable)
 * @param {Object<string, Object>|null} [params.overrides] instance_state values keyed by store key
 *   (`{ limits, defaults }`); `null` means the database could not be read
 * @param {Object<string, { active: boolean }>} [params.features] feature id -> state, to flag fields of inactive features
 * @param {Array} [params.fields] defaults to the whole catalog
 * @returns {{ fields: Object[], sections: Array<{ id: string, title: string, fields: Object[] }> }}
 */
function resolveEffective({ env = {}, fileConfig = {}, overrides = {}, features = null, fields = catalog.list() } = {}) {
    const resolved = fields.map(field => describeOne(field, { env, fileConfig, overrides, features }));
    const sections = [];
    for (const section of catalog.SECTIONS) {
        const inSection = resolved.filter(entry => entry.section === section.id);
        if (inSection.length > 0) sections.push({ id: section.id, title: section.title, fields: inSection });
    }
    return { fields: resolved, sections };
}

/**
 * The raw value of one secret for a provider probe or an adapter, or null.
 * Applies the same precedence as `resolveEffective`; placeholders count as unset.
 */
function resolveSecretValue(id, { env = {}, fileConfig = {} } = {}) {
    const field = catalog.get(id);
    if (!field || !field.secret) return null;
    const envHit = envEntry(field, env);
    if (envHit && field.sources.includes('env')) return envHit.raw;
    const fileHit = fileEntry(field, fileConfig);
    if (fileHit && field.sources.includes('config') && typeof fileHit.raw === 'string' && !isPlaceholder(fileHit.raw)) {
        return fileHit.raw.trim();
    }
    return null;
}

/** The non-secret effective value of one field, for probes that need a host or a port. */
function resolveValue(id, { env = {}, fileConfig = {}, overrides = {} } = {}) {
    const field = catalog.get(id);
    if (!field || field.secret) return null;
    const entry = describeOne(field, { env, fileConfig, overrides });
    return entry.value === undefined ? null : entry.value;
}

module.exports = { resolveEffective, resolveSecretValue, resolveValue };
