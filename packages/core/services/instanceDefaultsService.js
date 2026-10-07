/**
 * Instance defaults: what a person inherits until they choose for themselves.
 *
 * Stored as one JSON document in `instance_state` under the key `defaults`:
 *
 *   { chat: { provider, model }, appearance: { theme, startPage },
 *     memory: { chatHistoryRetentionDays }, budget: { usageAlertTokens } }
 *
 * A default is a fallback, never a policy. It applies to a preference only
 * where the person has no explicit value, it never overwrites one, and it
 * never caps or blocks anything: the enforced limits (`limits.*`, the usage
 * budgets) keep their own store and their own precedence, and a default
 * cannot raise or lower them. See
 * documentation/manager_configuration.md#instance-defaults-versus-enforced-policy.
 *
 * "Explicit" means the key is present in the person's stored preferences.
 * Rows written before this existed hold every key (the old writer persisted
 * the full defaulted object), so those keys count as explicit; people who
 * never saved a setting, and new accounts, inherit.
 */

const db = require('../db');
const instanceState = require('./instanceStateService');
const catalog = require('../config/fieldCatalog');
const { coercePreference } = require('../config/userSettingsSchema');

const KEY = 'defaults';

/** preference key -> dotted position in the defaults document */
const PREFERENCE_DEFAULT_PATHS = Object.freeze({
    theme: 'appearance.theme',
    startPage: 'appearance.startPage',
    chatHistoryRetentionDays: 'memory.chatHistoryRetentionDays',
    usageAlertTokens: 'budget.usageAlertTokens'
});

const FIELD_IDS = Object.freeze(catalog.inSection('defaults').map(field => field.id));

class InstanceDefaultsError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = 'InstanceDefaultsError';
        this.code = code;
        this.details = details;
    }
}

const fieldPath = (id) => id.slice('defaults.'.length);

/** Only catalogued, valid values survive: a hand-edited row cannot inject anything. */
function sanitize(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const id of FIELD_IDS) {
        const dotted = fieldPath(id);
        const value = catalog.getPath(raw, dotted);
        if (value === undefined || value === null) continue;
        const checked = catalog.validateValue(catalog.get(id), value);
        if (checked.ok && checked.value !== null && checked.value !== undefined) catalog.setPath(out, dotted, checked.value);
    }
    return out;
}

/** @returns {Promise<Object>} the stored defaults document (empty when none are set) */
async function get() {
    return sanitize(await instanceState.get(KEY));
}

/** @returns {Promise<Object>} { id: value } for every set default, keyed by catalog id */
async function getFlat() {
    const doc = await get();
    const flat = {};
    for (const id of FIELD_IDS) {
        const value = catalog.getPath(doc, fieldPath(id));
        if (value !== undefined) flat[id] = value;
    }
    return flat;
}

/**
 * Validate a batch against the catalog without writing.
 * @param {Array<{id: string, action: 'set'|'remove', value?: *}>} changes
 * @returns {{ ok: true, normalized: Array } | { ok: false, errors: Array<{id, code, message}> }}
 */
function validateChanges(changes) {
    const errors = [];
    const normalized = [];
    if (!Array.isArray(changes) || changes.length === 0) {
        return { ok: false, errors: [{ id: null, code: 'NO_CHANGES', message: 'At least one change is required.' }] };
    }
    const seen = new Set();
    for (const change of changes) {
        const id = change && typeof change.id === 'string' ? change.id : null;
        if (!id || !FIELD_IDS.includes(id)) {
            errors.push({ id, code: 'UNKNOWN_FIELD', message: 'That is not an instance default.' });
            continue;
        }
        if (seen.has(id)) {
            errors.push({ id, code: 'DUPLICATE_CHANGE', message: 'Each default may change once per request.' });
            continue;
        }
        seen.add(id);
        if (change.action === 'remove') {
            normalized.push({ id, action: 'remove' });
            continue;
        }
        if (change.action !== 'set') {
            errors.push({ id, code: 'BAD_ACTION', message: 'action must be "set" or "remove".' });
            continue;
        }
        const checked = catalog.validateValue(catalog.get(id), change.value);
        if (!checked.ok || checked.value === null || checked.value === undefined || checked.value === '') {
            errors.push({ id, code: checked.code || 'BAD_VALUE', message: checked.message || 'A value is required; use remove to clear a default.' });
            continue;
        }
        normalized.push({ id, action: 'set', value: checked.value });
    }
    return errors.length ? { ok: false, errors } : { ok: true, normalized };
}

/** The document a batch would produce, without writing it. */
function applyChanges(doc, normalized) {
    const next = sanitize(JSON.parse(JSON.stringify(doc || {})));
    for (const change of normalized) {
        if (change.action === 'remove') catalog.deletePath(next, fieldPath(change.id));
        else catalog.setPath(next, fieldPath(change.id), change.value);
    }
    return next;
}

/**
 * Write a validated batch. Callers that must refuse on a stale view compare
 * `before` themselves; the read-modify-write is one transaction.
 * @returns {Promise<{ before: Object, after: Object, changed: string[] }>}
 */
async function set(changes) {
    const checked = validateChanges(changes);
    if (!checked.ok) throw new InstanceDefaultsError('INVALID_DEFAULTS', 'The defaults change is not valid.', checked.errors);
    return db.transaction(async () => {
        const before = await get();
        const after = applyChanges(before, checked.normalized);
        if (Object.keys(after).length === 0) await instanceState.remove(KEY);
        else await instanceState.set(KEY, after);
        const changed = checked.normalized
            .filter(change => JSON.stringify(catalog.getPath(before, fieldPath(change.id)) ?? null)
                !== JSON.stringify(catalog.getPath(after, fieldPath(change.id)) ?? null))
            .map(change => change.id);
        return { before, after, changed };
    });
}

/** Keys a person has explicitly stored, with their (valid) values. */
function explicitPreferences(json) {
    let raw = {};
    if (typeof json === 'string' && json) {
        try { raw = JSON.parse(json) || {}; } catch { raw = {}; }
    } else if (json && typeof json === 'object' && !Array.isArray(json)) {
        raw = json;
    }
    const out = {};
    if (typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const key of Object.keys(raw)) {
        if (raw[key] === undefined) continue;
        const checked = coercePreference(key, raw[key]);
        if (checked.ok) out[key] = checked.value;
    }
    return out;
}

/**
 * Fill the preferences a person has not set from the instance defaults.
 * Pure: `prefs` is the fully defaulted object, `explicit` the stored keys.
 * @returns {{ prefs: Object, sources: Record<string, 'instance-default'> }}
 */
function overlayPreferences(prefs, explicit, defaults) {
    const out = { ...prefs };
    const sources = {};
    for (const [key, dotted] of Object.entries(PREFERENCE_DEFAULT_PATHS)) {
        if (Object.prototype.hasOwnProperty.call(explicit || {}, key)) continue;
        const value = catalog.getPath(defaults || {}, dotted);
        if (value === undefined) continue;
        out[key] = value;
        sources[key] = 'instance-default';
    }
    return { prefs: out, sources };
}

/**
 * The chat provider/model a person without an explicit choice gets.
 * The default provider applies only if it is configured on this host; the
 * default model applies only when it belongs to the provider that wins.
 * Used by getSettings today; the chat turn path adopts it through this seam.
 *
 * @param {{ provider?: string|null, model?: string|null }} user the person's own stored choice
 * @param {Object} defaults the defaults document
 * @param {{ configuredProviders?: string[], hostProvider?: string }} [host]
 * @returns {{ provider: string|null, model: string|null, providerSource: 'user-override'|'instance-default'|'host-default', modelSource: 'user-override'|'instance-default'|'provider-default' }}
 */
function resolveChat(user, defaults, host = {}) {
    const configured = host.configuredProviders || null;
    const chat = (defaults && defaults.chat) || {};
    const usable = (provider) => provider && (!configured || configured.includes(provider));

    let provider = user && user.provider ? user.provider : null;
    let providerSource = provider ? 'user-override' : 'host-default';
    if (!provider && usable(chat.provider)) {
        provider = chat.provider;
        providerSource = 'instance-default';
    }

    const effectiveProvider = provider || host.hostProvider || null;
    let model = user && user.model ? user.model : null;
    let modelSource = model ? 'user-override' : 'provider-default';
    if (!model && chat.model && !(user && user.provider) && effectiveProvider && (!chat.provider || chat.provider === effectiveProvider)) {
        model = chat.model;
        modelSource = 'instance-default';
    }
    return { provider, model, providerSource, modelSource };
}

/** resolveChat against the live defaults, for callers that only have the person's stored choice. */
async function resolveAI(user, host = {}) {
    return resolveChat(user, await get(), host);
}

module.exports = {
    KEY,
    FIELD_IDS,
    PREFERENCE_DEFAULT_PATHS,
    InstanceDefaultsError,
    get,
    getFlat,
    set,
    validateChanges,
    applyChanges,
    explicitPreferences,
    overlayPreferences,
    resolveChat,
    resolveAI,
    sanitize
};
