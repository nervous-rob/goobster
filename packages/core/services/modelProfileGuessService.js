/**
 * Goobster's best guess about an unreviewed chat model.
 *
 * The registry gives a newly listed id a deterministic profile from its
 * name (models/inference.js). This service does the reading a reviewer
 * would do: it fetches the provider's own documentation page for the model
 * (safeFetch stages: https, public address, pinned DNS, byte cap), hands
 * the passages that mention the model to the host's default provider, and
 * asks for a one-sentence description, what the model is probably good
 * for, what is uncertain, and - only when a page was read - the controls the
 * page states: context window, output limit, image input, web search,
 * effort support and levels, and whether sampling applies.
 *
 * The result is stored once per provider/model in `model_profile_guesses`:
 * the text decorates every later listing; the controls become a stored
 * overlay that `providerDefaults.describe` applies under the live listing's
 * evidence (`setStoredControls`), so the picker and request validation agree
 * in this process, and other processes pick the rows up through
 * `ensureLoaded()` on their next listing or model call. Effort levels are
 * clamped to what Goobster's adapter implements for that provider; nothing
 * read from a page can widen the adapter contract. Reviewed and custom
 * entries are never touched.
 *
 * Degrades gracefully: with no configured provider, with `ai.modelGuesses`
 * off, or when the page or the model call fails, the heuristic description
 * stands and no control changes. A page that cannot be read means no
 * control claims at all: the model's own words about controls are trusted
 * only with the documentation in front of it. No prompt, page or reply is
 * persisted beyond the validated fields.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../db');
const logger = require('../utils/logger');
const aiConfig = require('../config/aiConfig');
const safeFetch = require('../utils/safeFetch');
const { MODELS } = require('../models/catalog');
const { PHRASES } = require('../models/inference');
const providerDefaults = require('../models/providerDefaults');

const PROVIDER_LABELS = { openai: 'OpenAI', anthropic: 'Anthropic Claude', gemini: 'Google Gemini', ollama: 'Ollama (local)' };
const LIMITS = { description: 200, bestFor: 120, caveat: 160 };
const BATCH = 6;
const RETRY_MS = 60 * 60 * 1000;
const DOC_BYTES = 1_000_000;
const DOC_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const EXCERPT_CHARS = 9000;
const WINDOW_CHARS = 700;
const OPENAI = 'https://developers.openai.com/api/docs/';
const CLAUDE = 'https://platform.claude.com/docs/en/';
const GEMINI = 'https://ai.google.dev/gemini-api/docs/';
/** Effort levels each adapter serializes; a page cannot widen this. */
const ALLOWED_LEVELS = {
    openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
    gemini: ['minimal', 'low', 'medium', 'high'],
    ollama: []
};
const SAMPLING = { supported: 'always', unsupported: 'never', 'only-without-reasoning': 'reasoning-off' };

function parseJsonBlock(response) {
    if (typeof response !== 'string') return null;
    const start = response.indexOf('{');
    const end = response.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(response.slice(start, end + 1)); } catch { return null; }
}

function clean(value, max) {
    if (typeof value !== 'string') return null;
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat || /https?:\/\//i.test(flat)) return null;
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function stripHtml(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(?:p|div|li|tr|h[1-6]|br)>/gi, '\n').replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
        .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function tokenLimit(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 1024 ? n : null;
}

/** The provider documentation most likely to describe this model, most specific first. */
function docUrls(provider, id) {
    const dateless = id.replace(/-(?:20\d{2})-?\d{2}-?\d{2}$/, '');
    if (provider === 'anthropic') {
        const slug = dateless.replace(/^claude-/, '');
        return [`${CLAUDE}models/${slug}/overview.md`, `${CLAUDE}models/overview.md`, `${CLAUDE}build-with-claude/effort.md`];
    }
    if (provider === 'openai') return [`${OPENAI}models/${dateless}`, `${OPENAI}guides/latest-model`];
    if (provider === 'gemini') return [`${GEMINI}models/${dateless}`, `${GEMINI}models`];
    if (provider === 'ollama') return [`https://ollama.com/library/${encodeURIComponent(id.split(':')[0])}`];
    return [];
}

/** The passages of a page that mention the model, or null when none does. */
function excerpt(text, needles) {
    const haystack = String(text || '');
    const lower = haystack.toLowerCase();
    const spans = [];
    for (const needle of needles.filter(Boolean).map(value => value.toLowerCase())) {
        let from = 0;
        while (from < lower.length) {
            const at = lower.indexOf(needle, from);
            if (at < 0) break;
            spans.push([Math.max(0, at - WINDOW_CHARS), Math.min(haystack.length, at + needle.length + WINDOW_CHARS)]);
            from = at + needle.length;
            if (spans.length > 40) break;
        }
    }
    if (!spans.length) return null;
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
        else merged.push([...span]);
    }
    let out = '';
    for (const [start, end] of merged) {
        const piece = haystack.slice(start, end).trim();
        if (out.length + piece.length > EXCERPT_CHARS) { out += `\n…\n${piece.slice(0, Math.max(0, EXCERPT_CHARS - out.length))}`; break; }
        out += `${out ? '\n…\n' : ''}${piece}`;
    }
    return out;
}

/** Fetch one https page through the safeFetch stages; text or null, never throws. */
async function fetchDoc(rawUrl) {
    let current = rawUrl;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-model-doc-'));
    const destPath = path.join(tmpDir, 'page');
    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const { url, host } = safeFetch.assessUrl(current);
            const { address } = await safeFetch.resolvePinned(host);
            const result = await safeFetch.fetchToFile({
                url, address, destPath, maxBytes: DOC_BYTES, timeoutMs: DOC_TIMEOUT_MS, reportRedirects: true,
                headers: { 'User-Agent': 'Goobster-ModelDocs/1.0', Accept: 'text/markdown, text/plain, text/html;q=0.9, */*;q=0.1' }
            });
            if (result.redirectTo) { current = result.redirectTo; continue; }
            const body = fs.readFileSync(destPath, 'utf8');
            if (!body.trim()) return null;
            return /html/i.test(result.contentType || '') || /^\s*<!doctype html|^\s*<html/i.test(body) ? stripHtml(body) : body;
        }
        return null;
    } catch {
        return null;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Turn the model's reading of a page into registry controls. Only fields
 * the page stated are kept; effort levels are clamped to the adapter's set.
 */
function parseControls(provider, parsed, model) {
    const source = parsed?.controls && typeof parsed.controls === 'object' ? parsed.controls : null;
    if (!source || source.confidence === 'low') return null;
    const out = {};
    const contextWindow = tokenLimit(source.contextWindow);
    const maxOutputTokens = tokenLimit(source.maxOutputTokens);
    if (contextWindow) out.contextWindow = contextWindow;
    if (maxOutputTokens) out.maxOutputTokens = maxOutputTokens;
    if (typeof source.imageInput === 'boolean') out.imageInput = source.imageInput;
    if (typeof source.webSearch === 'boolean') out.nativeSearch = source.webSearch;
    const reasoning = source.reasoning && typeof source.reasoning === 'object' ? source.reasoning : null;
    if (reasoning && typeof reasoning.supported === 'boolean') {
        if (!reasoning.supported) out.reasoning = { levels: [], default: null };
        else {
            const allowed = ALLOWED_LEVELS[provider] || [];
            const levels = allowed.filter(level => (Array.isArray(reasoning.levels) ? reasoning.levels : []).map(value => String(value).toLowerCase()).includes(level));
            if (levels.length) {
                const wanted = typeof reasoning.default === 'string' ? reasoning.default.toLowerCase() : null;
                const fallback = levels.includes(model.reasoning?.default) ? model.reasoning.default : levels[Math.floor((levels.length - 1) / 2)];
                out.reasoning = { levels, default: levels.includes(wanted) ? wanted : fallback };
            }
        }
    }
    if (typeof source.sampling === 'string' && SAMPLING[source.sampling.toLowerCase()]) out.sampling = SAMPLING[source.sampling.toLowerCase()];
    return Object.keys(out).length ? out : null;
}

class ModelProfileGuessService {
    /**
     * @param {{ generateText?: Function, fetchDoc?: Function, enabled?: boolean }} [deps] test seams:
     *   the model call, the page fetch and the config switch. Production reads aiService,
     *   safeFetch and aiConfig.
     */
    constructor({ generateText = null, fetchDoc: fetchPage = null, enabled = null } = {}) {
        this._generateText = generateText;
        this._fetchDoc = fetchPage;
        this._enabled = enabled;
        this.retryAt = new Map();
        this.queued = new Map();
        this.chain = Promise.resolve();
        this.loaded = null;
    }

    get enabled() {
        return this._enabled ?? aiConfig.modelGuesses !== false;
    }

    static key(provider, modelId) {
        return `${provider}:${modelId}`;
    }

    /** Stored guesses for one provider, keyed by model id. */
    async getAll(provider) {
        const rows = await db.all(
            'SELECT modelId, description, bestFor, caveat, evidence, sourceUrl, controlsJson, writtenBy, updatedAt FROM model_profile_guesses WHERE provider = @provider',
            { provider }
        );
        return new Map(rows.map(row => [row.modelId, row]));
    }

    /**
     * Put every stored control overlay into this process's registry fallback.
     * Called on each listing and before each model call; cheap and best-effort.
     */
    async load() {
        const rows = await db.all('SELECT provider, modelId, controlsJson FROM model_profile_guesses WHERE controlsJson IS NOT NULL');
        const byProvider = { openai: {}, anthropic: {}, gemini: {}, ollama: {} };
        for (const row of rows) {
            try {
                const controls = JSON.parse(row.controlsJson);
                if (controls && typeof controls === 'object') (byProvider[row.provider] ||= {})[row.modelId] = controls;
            } catch { /* a bad row is simply not an overlay */ }
        }
        for (const [provider, controls] of Object.entries(byProvider)) providerDefaults.replaceStoredControls(provider, controls);
        return rows.length;
    }

    /** `load()` once per process (again after a failure); never throws. */
    ensureLoaded() {
        if (!this.loaded) {
            this.loaded = this.load().catch(error => {
                logger.warn?.(`[model guesses] Could not load stored controls: ${error.message}`);
                this.loaded = null;
            });
        }
        return this.loaded;
    }

    /** How many descriptions for this provider are still being written here. */
    pending(provider) {
        let count = 0;
        for (const key of this.queued.keys()) if (key.startsWith(`${provider}:`)) count++;
        return count;
    }

    /**
     * Merge stored text into a catalog and queue the listed unreviewed models
     * that have none. Never throws: a storage problem leaves the catalog as
     * discovery produced it.
     */
    async decorate(catalog) {
        if (!catalog || !Array.isArray(catalog.models)) return catalog;
        let stored = new Map();
        try {
            stored = await this.getAll(catalog.provider);
        } catch (error) {
            logger.warn?.(`[model guesses] Could not read stored guesses for ${catalog.provider}: ${error.message}`);
        }
        const missing = [];
        const models = catalog.models.map(model => {
            if (model.status !== 'discovered') return model;
            const row = stored.get(model.id);
            if (!row) {
                if (model.availability === 'listed') missing.push(model);
                return model;
            }
            return {
                ...model, description: row.description,
                guess: {
                    ...(model.guess || { source: 'heuristic', basis: null, basisName: null, profile: null }),
                    source: 'ai', evidence: row.evidence || 'name', sourceUrl: row.sourceUrl || null,
                    bestFor: row.bestFor || null, caveat: row.caveat || null, writtenAt: row.updatedAt || null
                }
            };
        });
        if (missing.length) this.schedule(catalog.provider, missing);
        return { ...catalog, models, pendingGuesses: this.pending(catalog.provider) };
    }

    /**
     * Queue up to a few models for a description. Sequential, one page read
     * and one model call each, an hour's back-off per model after a failure,
     * skipped entirely when the feature is off or no provider can answer.
     */
    schedule(provider, models) {
        if (!this.enabled || !this.canWrite()) return 0;
        const now = Date.now();
        let added = 0;
        for (const model of models) {
            if (added >= BATCH) break;
            const key = ModelProfileGuessService.key(provider, model.id);
            if (this.queued.has(key) || (this.retryAt.get(key) || 0) > now) continue;
            const task = this.chain.then(() => this.describe(provider, model)).catch(() => null)
                .finally(() => { this.queued.delete(key); });
            this.chain = task;
            this.queued.set(key, task);
            added++;
        }
        return added;
    }

    /** Whether some provider is configured to write text (Ollama needs no key). */
    canWrite() {
        if (this._generateText) return true;
        try {
            require('./aiService')._resolveProvider({});
            return true;
        } catch {
            return false;
        }
    }

    /** Wait for everything queued so far (tests and shutdown). */
    async settle() {
        await this.chain;
    }

    /** The first documentation page that mentions the model, as an excerpt. */
    async readDocs(provider, model) {
        const needles = [model.id, model.id.replace(/-(?:20\d{2})-?\d{2}-?\d{2}$/, ''), model.displayName !== model.id ? model.displayName : null];
        for (const url of docUrls(provider, model.id)) {
            const text = await (this._fetchDoc || fetchDoc)(url);
            const passages = text ? excerpt(text, needles) : null;
            if (passages) return { url, passages };
        }
        return null;
    }

    buildPrompt(provider, model, docs) {
        const siblings = MODELS.filter(entry => entry.provider === provider).slice(0, 12)
            .map(entry => `- ${entry.id}: ${entry.displayName} — ${entry.description}`).join('\n');
        const basis = model.guess?.basisName
            ? `Goobster's heuristic reads the name as ${model.guess.basisName}-like (${PHRASES[model.guess.profile] || 'provider defaults'}).`
            : 'Goobster\'s heuristic could not place the name in a known family, so it uses provider defaults.';
        const levels = (ALLOWED_LEVELS[provider] || []).join(', ') || 'none';
        const controls = docs
            ? `Also report, from the documentation only, the controls it states for this exact model. Use null for anything the documentation does not say; never guess a number.
 "controls": {"contextWindow": <integer tokens or null>, "maxOutputTokens": <integer tokens or null>,
   "imageInput": <true|false|null>, "webSearch": <true|false|null: a built-in web search tool>,
   "reasoning": {"supported": <true|false|null: an effort/reasoning level parameter>, "levels": [<names from: ${levels}>], "default": <name or null>},
   "sampling": <"supported"|"unsupported"|"only-without-reasoning"|null: temperature and top_p>,
   "confidence": <"high"|"medium"|"low">}`
            : '';
        return `You are Goobster, a Discord assistant, writing the "About this model" note for a settings page.
Provider: ${PROVIDER_LABELS[provider] || provider}. Model id: "${model.id}"${model.displayName && model.displayName !== model.id ? ` (shown as "${model.displayName}")` : ''}.
${basis}
Reviewed models on this provider, for comparison:
${siblings || '- (none)'}
${docs ? `\nPassages from the provider's documentation (${docs.url}) that mention this model:\n"""\n${docs.passages}\n"""\n` : '\nNo documentation page could be read; write a best guess from the name alone.\n'}
Write in plain words a non-expert understands. Do not invent benchmarks, prices, release dates, or token limits. Say nothing about Goobster's own features.
Reply with ONLY a JSON object:
{"description": "<one sentence, at most 140 characters, what this model is for>",
 "bestFor": "<at most 100 characters: the kind of work it probably suits>",
 "caveat": "<at most 140 characters: what is uncertain, or an empty string>"${controls ? `,\n${controls}` : ''}}`;
    }

    /** One page read and one model call, validated and stored. Returns the stored row or null. */
    async describe(provider, model) {
        const key = ModelProfileGuessService.key(provider, model.id);
        this.retryAt.set(key, Date.now() + RETRY_MS);
        let writtenBy = null;
        let response;
        let docs = null;
        try {
            docs = await this.readDocs(provider, model);
        } catch (error) {
            logger.warn?.(`[model guesses] Could not read documentation for ${key}: ${error.message}`);
        }
        try {
            const prompt = this.buildPrompt(provider, model, docs);
            if (this._generateText) {
                response = await this._generateText(prompt, { provider, model, docs });
            } else {
                const aiService = require('./aiService');
                writtenBy = aiService.getProvider();
                response = await aiService.generateText(prompt, { temperature: 0.2, max_tokens: docs ? 700 : 300, background: true });
            }
        } catch (error) {
            logger.warn?.(`[model guesses] Could not describe ${key}: ${error.message}`);
            return null;
        }
        const parsed = parseJsonBlock(response);
        const description = clean(parsed?.description, LIMITS.description);
        if (!description || description.length < 10) {
            logger.warn?.(`[model guesses] Unusable description for ${key}`);
            return null;
        }
        const controls = docs ? parseControls(provider, parsed, model) : null;
        const row = {
            provider, modelId: model.id, description,
            bestFor: clean(parsed?.bestFor, LIMITS.bestFor), caveat: clean(parsed?.caveat, LIMITS.caveat),
            evidence: docs ? 'docs' : 'name', sourceUrl: docs?.url || null,
            controlsJson: controls ? JSON.stringify(controls) : null, writtenBy
        };
        try {
            await db.run(
                `INSERT INTO model_profile_guesses (provider, modelId, description, bestFor, caveat, evidence, sourceUrl, controlsJson, writtenBy)
                 VALUES (@provider, @modelId, @description, @bestFor, @caveat, @evidence, @sourceUrl, @controlsJson, @writtenBy)
                 ON CONFLICT(provider, modelId) DO UPDATE SET
                    description = excluded.description, bestFor = excluded.bestFor, caveat = excluded.caveat,
                    evidence = excluded.evidence, sourceUrl = excluded.sourceUrl, controlsJson = excluded.controlsJson,
                    writtenBy = excluded.writtenBy, updatedAt = datetime('now')`,
                row
            );
        } catch (error) {
            logger.warn?.(`[model guesses] Could not store the description for ${key}: ${error.message}`);
            return null;
        }
        providerDefaults.setStoredControls(provider, model.id, controls);
        this.retryAt.delete(key);
        return row;
    }

    /** Drop stored text and controls for one model (or every model of a provider) so they are written again. */
    async forget(provider, modelId = null) {
        if (modelId) {
            await db.run('DELETE FROM model_profile_guesses WHERE provider = @provider AND modelId = @modelId', { provider, modelId });
            this.retryAt.delete(ModelProfileGuessService.key(provider, modelId));
            providerDefaults.setStoredControls(provider, modelId, null);
        } else {
            await db.run('DELETE FROM model_profile_guesses WHERE provider = @provider', { provider });
            for (const key of [...this.retryAt.keys()]) if (key.startsWith(`${provider}:`)) this.retryAt.delete(key);
            providerDefaults.replaceStoredControls(provider, {});
        }
    }
}

module.exports = new ModelProfileGuessService();
module.exports.ModelProfileGuessService = ModelProfileGuessService;
module.exports.LIMITS = LIMITS;
module.exports.ALLOWED_LEVELS = ALLOWED_LEVELS;
module.exports.docUrls = docUrls;
module.exports.excerpt = excerpt;
module.exports.parseControls = parseControls;
