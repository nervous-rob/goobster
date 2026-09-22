const { VERSION, PROFILES, MODELS } = require('./catalog');
const { withThinkingHeadroom } = require('../utils/aiTokenBudget');

class ModelPolicyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ModelPolicyError';
        this.code = code;
        this.status = 400;
    }
}

function freeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

function createRegistry(customModels = []) {
    const models = new Map();
    const key = (provider, id) => `${provider}:${id}`;
    const add = definition => {
        const profile = PROFILES[definition.profile];
        if (!profile || profile.provider !== definition.provider) throw new Error(`Invalid profile for ${definition.id}`);
        const model = freeze({
            ...profile, ...definition,
            capabilities: { ...profile.capabilities, ...definition.capabilities },
            reasoning: { ...profile.reasoning, ...definition.reasoning },
            sampling: { ...profile.sampling, ...definition.sampling }
        });
        for (const id of [model.id, ...model.aliases]) {
            if (models.has(key(model.provider, id))) throw new Error(`Duplicate model: ${key(model.provider, id)}`);
            models.set(key(model.provider, id), freeze({ ...model, id, canonicalId: model.id }));
        }
    };
    MODELS.forEach(add);
    if (!Array.isArray(customModels)) throw new Error('ai.customModels must be an array');
    for (const custom of customModels) {
        if (!custom || typeof custom.id !== 'string' || !custom.id.trim() || custom.id.length > 100) {
            throw new Error('Each ai.customModels entry needs an id of 1–100 characters');
        }
        const profile = PROFILES[custom.profile];
        if (!profile || profile.provider !== custom.provider) throw new Error(`Invalid provider/profile for custom model ${custom.id}`);
        for (const field of ['contextWindow', 'maxOutputTokens']) {
            if (custom[field] != null && (!Number.isSafeInteger(custom[field]) || custom[field] < 16)) {
                throw new Error(`Invalid ${field} for custom model ${custom.id}`);
            }
        }
        add({
            provider: custom.provider, id: custom.id.trim(), profile: custom.profile,
            displayName: String(custom.displayName || custom.id),
            description: String(custom.description || 'Custom model configured by the host operator.'),
            status: 'custom', workflows: ['chat', 'parlor', 'research'], aliases: [],
            input: ['text', ...(profile.capabilities.imageInput ? ['image'] : [])], output: ['text'],
            contextWindow: custom.contextWindow ?? null, maxOutputTokens: custom.maxOutputTokens ?? null,
            pricing: null, checkedAt: null, sources: []
        });
    }

    function get(provider, id) {
        let clean = typeof id === 'string' ? id.trim() : '';
        if (provider === 'gemini') clean = clean.replace(/^models\//, '');
        return models.get(key(provider, clean)) || null;
    }

    function requireModel(provider, id, workflow = 'chat') {
        const model = get(provider, id);
        if (!model) throw new ModelPolicyError('UNSUPPORTED_MODEL', `Model "${id}" has no Goobster profile for ${provider}. Choose a listed model or ask the host operator to configure ai.customModels.`);
        if (!model.workflows.includes(workflow) || model.status === 'disabled') {
            throw new ModelPolicyError('UNSUPPORTED_MODEL_WORKFLOW', `${model.displayName} is not supported for ${workflow}.`);
        }
        return model;
    }

    function resolveEffort(model, requested, { strict = false } = {}) {
        const { levels, aliases } = model.reasoning;
        if (!requested) return null;
        const mapped = aliases[requested] || requested;
        if (levels.includes(mapped)) return mapped;
        // Legacy saved global effort settings can accompany a model with no
        // effort control. Request construction omits that inapplicable field.
        if (!strict && !levels.length) return null;
        throw new ModelPolicyError('BAD_REASONING', `${model.displayName} supports reasoning levels: ${levels.join(', ') || 'provider default only'}.`);
    }

    function allowsSampling(model, effort) {
        return model.sampling.mode === 'always'
            || (model.sampling.mode === 'reasoning-off' && effort === 'none');
    }

    function allowsNativeSearch(model, effort) {
        return Boolean(model?.capabilities.nativeSearch)
            && !(model.capabilities.nativeSearchExcludedEfforts || []).includes(effort || model.reasoning.default);
    }

    function resolveRequest(provider, id, opts = {}, messages = []) {
        const model = requireModel(provider, id, opts.workflow || 'chat');
        const effort = resolveEffort(model, opts.reasoning_effort);
        const effectiveEffort = effort || model.reasoning.default;
        if (opts.functions?.length && !model.capabilities.tools) throw new ModelPolicyError('UNSUPPORTED_TOOLS', `${model.displayName} cannot use tools.`);
        if (opts.webSearch && !allowsNativeSearch(model, effectiveEffort)) throw new ModelPolicyError('UNSUPPORTED_SEARCH', `${model.displayName} does not support built-in search with this reasoning setting.`);
        if (Array.isArray(messages) && messages.some(m => m?.images?.length) && !model.capabilities.imageInput) {
            throw new ModelPolicyError('UNSUPPORTED_IMAGES', `${model.displayName} does not accept image input.`);
        }
        const visibleBudget = opts.max_tokens ?? 1024;
        if (!Number.isFinite(visibleBudget) || visibleBudget < 0) throw new ModelPolicyError('BAD_TOKEN_BUDGET', 'Output token budget must be a finite non-negative number.');
        const budget = Math.max(16, Math.ceil(withThinkingHeadroom(visibleBudget, effectiveEffort)));
        const sampling = {};
        if (allowsSampling(model, effectiveEffort)) {
            if (opts.temperature !== undefined || opts.top_p === undefined || !model.sampling.exclusive) {
                const value = opts.temperature ?? 0.7;
                if (!Number.isFinite(value) || value < 0) throw new ModelPolicyError('BAD_TEMPERATURE', 'Temperature must be a finite non-negative number.');
                sampling.temperature = Math.min(model.sampling.temperatureMax, value);
            }
            if (!model.sampling.exclusive || sampling.temperature === undefined) {
                const value = opts.top_p ?? 1;
                if (!Number.isFinite(value) || value < 0 || value > 1) throw new ModelPolicyError('BAD_TOP_P', 'Top-p must be between 0 and 1.');
                sampling.top_p = value;
            }
        }
        return {
            model, effort, effectiveEffort, sampling,
            maxOutputTokens: model.maxOutputTokens ? Math.min(model.maxOutputTokens, budget) : budget
        };
    }

    return { version: VERSION, get, requireModel, resolveEffort, allowsSampling, allowsNativeSearch, resolveRequest,
        list: provider => [...models.values()].filter(m => !provider || m.provider === provider) };
}

// No remote requests or key reads: this is deterministic deployment policy.
const registry = createRegistry(require('../config/aiConfig').customModels || []);
module.exports = { ...registry, createRegistry, ModelPolicyError };
