const openaiService = require('./openaiService');
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');

let config = {};
try {
    config = require('../config.json');
} catch {
    // config.json optional at load time
}

// Supported providers
const PROVIDERS = {
    openai: openaiService,
    gemini: geminiService,
    ollama: ollamaService
};

// Initial provider: explicit config/env wins, otherwise prefer OpenAI when
// configured and fall back to the local Ollama provider.
function resolveInitialProvider() {
    const requested = config.ai?.provider || process.env.AI_PROVIDER;
    if (requested && PROVIDERS[requested]) {
        return requested;
    }
    if (openaiService.isConfigured()) {
        return 'openai';
    }
    console.warn('[AIService] OpenAI not configured - defaulting to local Ollama provider.');
    return 'ollama';
}

let currentProviderKey = resolveInitialProvider();

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
     * Check if the current provider supports function calling
     */
    supportsFunctionCalling() {
        return currentProviderKey === 'openai';
    }

    /**
     * Get provider-specific capabilities
     */
    getProviderCapabilities() {
        const capabilities = {
            openai: {
                functionCalling: true,
                streaming: true,
                reasoningEffort: true,
                modelSwitching: true
            },
            gemini: {
                functionCalling: false, // Uses prompt-based tool integration
                streaming: false,
                reasoningEffort: false,
                modelSwitching: false
            },
            ollama: {
                functionCalling: false, // Plain chat completion only
                streaming: false,
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

    async generateText(prompt, opts = {}) {
        return await this.getProviderInstance().generateText(prompt, opts);
    }

    async chat(messages, opts = {}) {
        return await this.getProviderInstance().chat(messages, opts);
    }
}

module.exports = new AIServiceRouter();
