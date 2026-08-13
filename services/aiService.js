const openaiService = require('./openaiService');
const anthropicService = require('./anthropicService');
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const aiConfig = require('../config/aiConfig');

// Supported providers
const PROVIDERS = {
    openai: openaiService,
    anthropic: anthropicService,
    gemini: geminiService,
    ollama: ollamaService
};

// Initial provider: explicit config/env wins, otherwise prefer OpenAI when
// configured, then Anthropic, then Gemini, and fall back to the local
// Ollama provider.
function resolveInitialProvider() {
    const requested = aiConfig.provider;
    if (requested && PROVIDERS[requested]) {
        return requested;
    }
    if (openaiService.isConfigured()) {
        return 'openai';
    }
    if (anthropicService.isConfigured()) {
        return 'anthropic';
    }
    if (geminiService.isConfigured()) {
        return 'gemini';
    }
    console.warn('[AIService] No cloud AI provider configured - defaulting to local Ollama provider.');
    return 'ollama';
}

let currentProviderKey = resolveInitialProvider();

const PROVIDER_LABELS = {
    openai: 'OpenAI',
    anthropic: 'Anthropic Claude',
    gemini: 'Google Gemini',
    ollama: 'Ollama (local)'
};

// Live model listings per provider (the web portal's model dropdown).
// In-memory TTL cache - transient and re-derivable, an allowed exception
// to the SQLite rule.
const modelListCache = new Map();
const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 8000;

// OpenAI's /v1/models mixes chat models with embeddings/audio/image/etc.;
// only chat-capable ids belong in a chat-model dropdown.
const OPENAI_NON_CHAT = /(embedding|whisper|tts|audio|realtime|transcribe|moderation|dall-e|image|davinci|babbage|codex|computer-use)/i;

async function fetchJson(url, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
    try {
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

/** Query one provider's models endpoint with the configured key. */
async function fetchProviderModels(key) {
    if (key === 'openai') {
        if (!aiConfig.openai.apiKey) return [];
        const json = await fetchJson('https://api.openai.com/v1/models', {
            Authorization: `Bearer ${aiConfig.openai.apiKey}`
        });
        return (json.data || [])
            .map(m => m.id)
            .filter(id => /^(gpt-|o\d|chatgpt-)/.test(id) && !OPENAI_NON_CHAT.test(id))
            .sort();
    }
    if (key === 'anthropic') {
        if (!aiConfig.anthropic.apiKey) return [];
        const json = await fetchJson('https://api.anthropic.com/v1/models?limit=100', {
            'x-api-key': aiConfig.anthropic.apiKey,
            'anthropic-version': '2023-06-01'
        });
        return (json.data || []).map(m => m.id).sort();
    }
    if (key === 'gemini') {
        if (!aiConfig.gemini.apiKey) return [];
        const json = await fetchJson(
            `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(aiConfig.gemini.apiKey)}`
        );
        return (json.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => String(m.name || '').replace(/^models\//, ''))
            .filter(id => id && !/embedding|aqa/i.test(id))
            .sort();
    }
    if (key === 'ollama') {
        const json = await fetchJson(`${aiConfig.ollama.host}/api/tags`);
        return (json.models || []).map(m => m.name).sort();
    }
    return [];
}

/**
 * Router over the AI providers. Every provider implements the same contract:
 *   chat(messages, opts) -> { content: string, toolCalls: [{ id, name, arguments }] }
 *   generateText(prompt, opts) -> string
 *
 * opts may include: model, temperature, top_p, max_tokens, preset (OpenAI),
 * reasoning_effort (OpenAI/Anthropic/Gemini), functions (tool definitions),
 * and onDelta (streaming text callback).
 */
class AIServiceRouter {
    setProvider(providerKey) {
        if (!PROVIDERS[providerKey]) {
            throw new Error(`Unknown AI provider: ${providerKey}`);
        }
        currentProviderKey = providerKey;
    }

    getProvider() {
        return currentProviderKey;
    }

    getProviderInstance() {
        return PROVIDERS[currentProviderKey];
    }

    /**
     * All providers support tool calling now (natively or prompt-based).
     */
    supportsFunctionCalling() {
        return true;
    }

    /**
     * Get provider-specific capabilities
     */
    getProviderCapabilities() {
        const capabilities = {
            openai: {
                functionCalling: 'native',
                streaming: true,
                reasoningEffort: true,
                modelSwitching: true,
                nativeWebSearch: true
            },
            anthropic: {
                functionCalling: 'native',
                streaming: true,
                reasoningEffort: true,
                modelSwitching: true,
                nativeWebSearch: true
            },
            gemini: {
                functionCalling: 'native',
                streaming: true,
                reasoningEffort: true,
                modelSwitching: true,
                nativeWebSearch: true
            },
            ollama: {
                functionCalling: 'prompt-based',
                streaming: true,
                reasoningEffort: false,
                modelSwitching: true,
                local: true,
                nativeWebSearch: false
            }
        };
        return capabilities[currentProviderKey] || {};
    }

    /**
     * Whether a provider can search the web natively mid-response
     * (OpenAI web_search tool / Anthropic web_search server tool / Gemini
     * Search Grounding).
     * @param {string} [providerKey] - defaults to the current provider
     */
    supportsNativeWebSearch(providerKey) {
        const key = providerKey && PROVIDERS[providerKey] ? providerKey : currentProviderKey;
        return key === 'openai' || key === 'anthropic' || key === 'gemini';
    }

    /**
     * The provider catalog for settings UIs (the web portal's model picker):
     * every provider with its display name, whether it is configured and
     * usable, its default model ids from aiConfig, and whether it honors
     * reasoning effort. Never hardcode model ids elsewhere - these come
     * straight from aiConfig.
     * @returns {Array<{key, name, configured, isDefault, chatModel, thoughtfulModel, reasoningEffort}>}
     */
    listProviders() {
        return Object.entries(PROVIDERS).map(([key, instance]) => ({
            key,
            name: PROVIDER_LABELS[key] || key,
            configured: key === 'ollama'
                || typeof instance.isConfigured !== 'function'
                || instance.isConfigured(),
            isDefault: key === currentProviderKey,
            chatModel: aiConfig[key]?.chatModel || aiConfig[key]?.model || null,
            thoughtfulModel: aiConfig[key]?.thoughtfulModel || null,
            reasoningEffort: key !== 'ollama'
        }));
    }

    /**
     * The chat-capable models the configured API key can actually use,
     * fetched live from the provider's models endpoint (cached 10 minutes -
     * transient, re-derivable). Feeds the web portal's model dropdown so it
     * never guesses at model ids. Returns [] when the provider is not
     * configured or the listing fails - the UI falls back to the catalog
     * defaults.
     * @param {string} [providerKey] - defaults to the current provider
     * @returns {Promise<string[]>} sorted model ids
     */
    async listModels(providerKey) {
        const key = providerKey && PROVIDERS[providerKey] ? providerKey : currentProviderKey;
        const cached = modelListCache.get(key);
        if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) {
            return cached.models;
        }
        let models;
        try {
            models = await fetchProviderModels(key);
        } catch (error) {
            console.warn(`Model listing failed for ${key}:`, error.message);
            return [];
        }
        modelListCache.set(key, { models, at: Date.now() });
        return models;
    }

    /**
     * The Thoughtful Mode preset for a cloud provider: its state-of-the-art
     * model with high reasoning effort. Returns null for providers without a
     * thoughtful tier (Ollama).
     * @param {string} [providerKey] - defaults to the current provider
     * @returns {{provider: string, model: string, reasoningEffort: 'high'}|null}
     */
    getThoughtfulPreset(providerKey) {
        const key = providerKey && PROVIDERS[providerKey] ? providerKey : currentProviderKey;
        const model = aiConfig[key]?.thoughtfulModel;
        if (!model) return null;
        return { provider: key, model, reasoningEffort: 'high' };
    }

    /**
     * Resolve the provider for a request: opts.provider (per-guild override)
     * wins when valid and configured, otherwise the global current provider.
     */
    _resolveProvider(opts = {}) {
        const requested = opts.provider;
        if (requested && PROVIDERS[requested]) {
            const instance = PROVIDERS[requested];
            if (typeof instance.isConfigured !== 'function' || instance.isConfigured() || requested === 'ollama') {
                return instance;
            }
            console.warn(`[AIService] Guild requested provider '${requested}' but it is not configured; using ${currentProviderKey}.`);
        }
        return this.getProviderInstance();
    }

    setDefaultModel(modelName) {
        const provider = this.getProviderInstance();
        if (typeof provider.setDefaultModel === 'function') {
            provider.setDefaultModel(modelName);
        }
    }

    getDefaultModel() {
        const provider = this.getProviderInstance();
        if (typeof provider.getDefaultModel === 'function') {
            return provider.getDefaultModel();
        }
        return null;
    }

    /**
     * Set the default reasoning effort on providers that support it
     * (OpenAI, Anthropic, Gemini).
     * @param {('minimal'|'low'|'medium'|'high'|null)} effort
     */
    setDefaultReasoningEffort(effort) {
        const provider = this.getProviderInstance();
        if (typeof provider.setDefaultReasoningEffort === 'function') {
            provider.setDefaultReasoningEffort(effort);
        }
    }

    async generateText(prompt, opts = {}) {
        return await this._resolveProvider(opts).generateText(prompt, opts);
    }

    /**
     * @returns {Promise<{content: string, toolCalls: Array<{id: string, name: string, arguments: string}>}>}
     */
    async chat(messages, opts = {}) {
        return await this._resolveProvider(opts).chat(messages, opts);
    }

    /**
     * Convenience helper for callers that only need the reply text.
     * @returns {Promise<string>}
     */
    async chatText(messages, opts = {}) {
        const { content } = await this.chat(messages, opts);
        return content;
    }
}

module.exports = new AIServiceRouter();
