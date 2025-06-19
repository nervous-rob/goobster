const openaiService = require('./openaiService');
const geminiService = require('./geminiService');

// Supported providers
const PROVIDERS = {
    openai: openaiService,
    gemini: geminiService
};

let currentProviderKey = 'openai';

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
            }
        };
        return capabilities[currentProviderKey] || {};
    }

    setDefaultModel(modelName) {
        // Only relevant for OpenAI right now
        if (currentProviderKey === 'openai') {
            openaiService.setDefaultModel(modelName);
        }
    }

    getDefaultModel() {
        if (currentProviderKey === 'openai') {
            return openaiService.getDefaultModel();
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