const aiConfig = require('../config/aiConfig');
const registry = require('./registry');

const TTL_MS = 10 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const TIMEOUT_MS = 8000;
const cache = new Map();
const inFlight = new Map();
const PROVIDERS = ['openai', 'anthropic', 'gemini', 'ollama'];

function configured(provider) {
    return provider === 'ollama' || Boolean(aiConfig[provider]?.apiKey);
}

async function fetchIds(provider) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const ids = [];
    const cursors = new Set();
    let cursor = '';
    try {
        // One deadline covers the whole listing. A partial result must never
        // mark models on a later page as unavailable.
        for (let page = 0; page < 20; page++) {
            let url;
            let headers = {};
            if (provider === 'openai') {
                url = 'https://api.openai.com/v1/models';
                headers = { Authorization: `Bearer ${aiConfig.openai.apiKey}` };
            } else if (provider === 'anthropic') {
                url = `https://api.anthropic.com/v1/models?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ''}`;
                headers = { 'x-api-key': aiConfig.anthropic.apiKey, 'anthropic-version': '2023-06-01' };
            } else if (provider === 'gemini') {
                url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`;
                headers = { 'x-goog-api-key': aiConfig.gemini.apiKey };
            } else {
                url = `${aiConfig.ollama.host}/api/tags`;
            }
            const res = await fetch(url, { headers, signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const rows = provider === 'openai' || provider === 'anthropic' ? json.data : json.models;
            if (!Array.isArray(rows)) throw new Error('Invalid model list');
            for (const row of rows) {
                if (provider === 'gemini' && !(row.supportedGenerationMethods || []).includes('generateContent')) continue;
                const id = provider === 'gemini' ? String(row.name || '').replace(/^models\//, '')
                    : provider === 'ollama' ? row.name : row.id;
                if (typeof id === 'string' && id) ids.push(id);
            }
            const next = provider === 'anthropic' && json.has_more ? json.last_id
                : provider === 'gemini' ? json.nextPageToken : null;
            if (provider === 'anthropic' && json.has_more && !next) throw new Error('Incomplete model list');
            if (!next) return [...new Set(ids)];
            if (cursors.has(next)) throw new Error('Repeated model-list cursor');
            cursors.add(next);
            cursor = next;
        }
        throw new Error('Model list exceeded page limit');
    } finally {
        clearTimeout(timer);
    }
}

async function discover(provider) {
    if (!PROVIDERS.includes(provider)) throw new registry.ModelPolicyError('BAD_PROVIDER', 'Unknown AI provider.');
    if (!configured(provider)) return { ids: [], status: 'not-configured', checkedAt: null };
    const prior = cache.get(provider);
    if (prior && Date.now() < prior.expiresAt) return { ...prior, status: prior.status === 'live' ? 'cached' : prior.status };
    if (inFlight.has(provider)) return inFlight.get(provider);
    const task = (async () => {
        let result;
        try {
            result = { ids: await fetchIds(provider), status: 'live', checkedAt: new Date().toISOString(), expiresAt: Date.now() + TTL_MS };
        } catch {
            // Do not leak upstream URLs, credentials, or raw provider errors.
            result = { ids: prior?.ids || [], status: prior?.checkedAt ? 'stale' : 'unavailable', checkedAt: prior?.checkedAt || null, expiresAt: Date.now() + RETRY_MS };
        }
        cache.set(provider, result);
        return result;
    })();
    inFlight.set(provider, task);
    try { return await task; } finally { inFlight.delete(provider); }
}

async function listCatalog(provider, workflow = 'chat') {
    if (!['chat', 'parlor', 'research'].includes(workflow)) throw new registry.ModelPolicyError('BAD_WORKFLOW', 'Unknown model workflow.');
    const result = await discover(provider);
    const fresh = result.status === 'live' || result.status === 'cached';
    const discovered = new Set(result.ids.map(id => registry.get(provider, id)?.canonicalId || id));
    const models = registry.list(provider).filter(m => m.id === m.canonicalId && m.workflows.includes(workflow)).map(model => {
        const availability = fresh ? (discovered.has(model.id) ? 'listed' : 'not-listed') : 'unknown';
        return { ...model, availability, selectable: configured(provider) && availability !== 'not-listed' && model.status !== 'disabled' };
    });
    return {
        version: registry.version, provider, workflow, models,
        discovery: { status: result.status, checkedAt: result.checkedAt },
        unregisteredCount: result.ids.filter(id => !registry.get(provider, id)).length
    };
}

module.exports = { listCatalog };
