const openaiService = require('./openaiService');
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const aiConfig = require('../config/aiConfig');

// Supported providers
const PROVIDERS = {
    openai: openaiService,
    gemini: geminiService,
    ollama: ollamaService
};

// Initial provider: explicit config/env wins, otherwise prefer OpenAI when
// configured, then Gemini, and fall back to the local Ollama provider.
function resolveInitialProvider() {
    const requested = aiConfig.provider;
    if (requested && PROVIDERS[requested]) {
        return requested;
    }
    if (openaiService.isConfigured()) {
        return 'openai';
    }
    if (geminiService.isConfigured()) {
        return 'gemini';
    }
    console.warn('[AIService] No cloud AI provider configured - defaulting to local Ollama provider.');
    return 'ollama';
}

let currentProviderKey = resolveInitialProvider();

/**
 * Router over the AI providers. Every provider implements the same contract:
 *   chat(messages, opts) -> { content: string, toolCalls: [{ id, name, arguments }] }
 *   generateText(prompt, opts) -> string
 *
 * opts may include: model, temperature, top_p, max_tokens, preset (OpenAI),
 * reasoning_effort (OpenAI), functions (tool definitions), and onDelta
 * (streaming text callback).
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
                modelSwitching: true
            },
            gemini: {
                functionCalling: 'native',
                streaming: true,
                reasoningEffort: false,
                modelSwitching: true
            },
            ollama: {
                functionCalling: 'prompt-based',
                streaming: true,
                reasoningEffort: false,
                modelSwitching: true,
                local: true
            }
        };
        return capabilities[currentProviderKey] || {};
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
     * Set the default reasoning effort on providers that support it (OpenAI).
     * @param {('minimal'|'low'|'medium'|'high'|null)} effort
     */
    setDefaultReasoningEffort(effort) {
        const provider = this.getProviderInstance();
        if (typeof provider.setDefaultReasoningEffort === 'function') {
            provider.setDefaultReasoningEffort(effort);
        }
    }

    async generateText(prompt, opts = {}) {
        return await this.getProviderInstance().generateText(prompt, opts);
    }

    /**
     * @returns {Promise<{content: string, toolCalls: Array<{id: string, name: string, arguments: string}>}>}
     */
    async chat(messages, opts = {}) {
        return await this.getProviderInstance().chat(messages, opts);
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
