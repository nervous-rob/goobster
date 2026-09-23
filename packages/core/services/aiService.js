const openaiService = require('./openaiService');
const anthropicService = require('./anthropicService');
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const aiConfig = require('../config/aiConfig');
const modelRegistry = require('../models/registry');
const modelDiscovery = require('../models/discovery');

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
    if (requested && Object.hasOwn(PROVIDERS, requested)) {
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
    return 'ollama';
}

let currentProviderKey = resolveInitialProvider();

const PROVIDER_LABELS = {
    openai: 'OpenAI',
    anthropic: 'Anthropic Claude',
    gemini: 'Google Gemini',
    ollama: 'Ollama (local)'
};

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
        if (!Object.hasOwn(PROVIDERS, providerKey)) {
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
        return Boolean(modelRegistry.get(currentProviderKey, this.defaultModelFor(currentProviderKey))?.capabilities.tools);
    }

    /**
     * Get provider-specific capabilities
     */
    getProviderCapabilities() {
        const model = modelRegistry.get(currentProviderKey, this.defaultModelFor(currentProviderKey));
        return {
            functionCalling: model?.capabilities.tools || false,
            streaming: Boolean(model?.capabilities.streaming),
            reasoningEffort: Boolean(model?.reasoning.levels.length),
            modelSwitching: true,
            nativeWebSearch: this.supportsNativeWebSearch(),
            local: currentProviderKey === 'ollama'
        };
    }

    /**
     * Whether a provider can search the web natively mid-response
     * (OpenAI web_search tool / Anthropic web_search server tool / Gemini
     * Search Grounding).
     * @param {string} [providerKey] - defaults to the current provider
     */
    supportsNativeWebSearch(providerKey, modelId, reasoningEffort) {
        const key = providerKey || currentProviderKey;
        const model = modelRegistry.get(key, modelId || this.defaultModelFor(key));
        if (!model) return false;
        return modelRegistry.allowsNativeSearch(model, reasoningEffort || PROVIDERS[key]?.getDefaultReasoningEffort?.());
    }

    defaultModelFor(providerKey) {
        return PROVIDERS[providerKey]?.getDefaultModel?.()
            || aiConfig[providerKey]?.chatModel || aiConfig[providerKey]?.model || null;
    }

    /** Validate model-related edits without performing discovery or changing saved state. */
    validateModelSelection(current = {}, changes = {}, workflow = 'chat') {
        const patch = { ...changes };
        if (patch.model != null) patch.model = String(patch.model).trim() || null;
        if (patch.provider !== undefined && patch.provider !== current.provider) {
            if (patch.model === undefined) patch.model = null;
            if (patch.reasoningEffort === undefined) patch.reasoningEffort = null;
        } else if (patch.model !== undefined && patch.model !== current.model && patch.reasoningEffort === undefined) {
            patch.reasoningEffort = null;
        }
        // A reset must remain possible even when a host default is unsupported.
        if (Object.values(patch).every(value => value === null)) return patch;
        const next = { ...current, ...patch };
        const provider = next.provider || currentProviderKey;
        if (!Object.hasOwn(PROVIDERS, provider)) throw new modelRegistry.ModelPolicyError('BAD_PROVIDER', 'Unknown AI provider.');
        if (patch.provider && !this.listProviders().find(p => p.key === provider)?.configured) {
            throw new modelRegistry.ModelPolicyError('PROVIDER_NOT_CONFIGURED', `${PROVIDER_LABELS[provider]} is not configured on this host.`);
        }
        const model = modelRegistry.requireModel(provider, next.model || this.defaultModelFor(provider), workflow);
        if (patch.reasoningEffort) patch.reasoningEffort = modelRegistry.resolveEffort(model, patch.reasoningEffort, { strict: true });
        return patch;
    }

    describeModel(provider, modelId, requestedEffort) {
        const model = modelRegistry.get(provider, modelId);
        if (!model) return { supported: false, effectiveEffort: null };
        try {
            return { supported: true, effectiveEffort: modelRegistry.resolveEffort(model, requestedEffort) || model.reasoning.default };
        } catch {
            return { supported: false, effectiveEffort: null };
        }
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
            chatModel: this.defaultModelFor(key),
            thoughtfulModel: aiConfig[key]?.thoughtfulModel || null,
            reasoningEffort: key !== 'ollama'
        }));
    }

    /** Metadata and live availability are separate; discovery cannot add support. */
    async listModelCatalog(providerKey, workflow = 'chat') {
        return modelDiscovery.listCatalog(providerKey || currentProviderKey, workflow);
    }

    /** Legacy ID-only view for older clients. */
    async listModels(providerKey) {
        const catalog = await this.listModelCatalog(providerKey);
        return catalog.models.filter(model => model.selectable).map(model => model.id).sort();
    }

    /**
     * The Thoughtful Mode preset for a cloud provider: its state-of-the-art
     * model with high reasoning effort. Returns null for providers without a
     * thoughtful tier (Ollama).
     * @param {string} [providerKey] - defaults to the current provider
     * @returns {{provider: string, model: string, reasoningEffort: 'high'}|null}
     */
    getThoughtfulPreset(providerKey) {
        const key = providerKey || currentProviderKey;
        if (!Object.hasOwn(PROVIDERS, key)) return null;
        const model = aiConfig[key]?.thoughtfulModel;
        const definition = modelRegistry.get(key, model);
        if (!definition?.reasoning.levels.includes('high')) return null;
        return { provider: key, model, reasoningEffort: 'high' };
    }

    /**
     * Resolve the provider for a request: opts.provider (per-guild override)
     * wins; invalid or unconfigured selections fail without rerouting.
     */
    _resolveProvider(opts = {}) {
        const requested = opts.provider || currentProviderKey;
        const instance = Object.hasOwn(PROVIDERS, requested) ? PROVIDERS[requested] : null;
        if (!instance) throw new modelRegistry.ModelPolicyError('BAD_PROVIDER', 'Unknown AI provider.');
        if (requested !== 'ollama' && typeof instance.isConfigured === 'function' && !instance.isConfigured()) {
            throw new modelRegistry.ModelPolicyError('PROVIDER_NOT_CONFIGURED', `${PROVIDER_LABELS[requested]} is not configured on this host.`);
        }
        return instance;
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
        const provider = this._resolveProvider(opts);
        return this._admit(opts, signal => provider.generateText(prompt, { ...opts, signal }), prompt);
    }

    /**
     * @returns {Promise<{content: string, toolCalls: Array<{id: string, name: string, arguments: string}>}>}
     */
    async chat(messages, opts = {}) {
        const provider = this._resolveProvider(opts);
        return this._admit(opts, signal => provider.chat(messages, { ...opts, signal }), messages);
    }

    async _admit(opts, work, input = '') {
        const providerKey = opts.provider || currentProviderKey;
        const provider = PROVIDERS[providerKey];
        const request = modelRegistry.resolveRequest(providerKey, opts.model || this.defaultModelFor(providerKey), {
            ...opts, reasoning_effort: opts.reasoning_effort || provider?.getDefaultReasoningEffort?.()
        }, Array.isArray(input) ? input : []);
        // Conservative text estimate, including tool definitions and framing.
        // No prompt content is persisted. Provider usage replaces the hold.
        const promptBytes = Buffer.byteLength(JSON.stringify({ input, functions: opts.functions || [] }), 'utf8');
        const estimatedTokens = promptBytes + 1024 + request.maxOutputTokens;
        const policy = require('../config/admissionConfig');
        const timeout = AbortSignal.timeout(policy.modelTimeoutMs);
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
        return require('./usageBudgetService').run({ estimatedTokens, background: opts.background === true, admissionOptions: {
            resource: 'model', actorId: opts.usageContext?.actorId || opts.usageContext?.userId || null,
            scopeId: opts.usageContext?.guildId || null,
            limit: policy.modelConcurrent, perActor: policy.modelPerAccount,
            waitMs: policy.modelQueueMs, leaseMs: policy.modelTimeoutMs + 30000, signal, onWaiting: opts.onAdmission
        } }, work);
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
