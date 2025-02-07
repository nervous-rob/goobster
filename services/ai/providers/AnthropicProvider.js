const Anthropic = require('@anthropic-ai/sdk');
const BaseProvider = require('./BaseProvider');

class AnthropicProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.client = null;
        this.supportedModels = {
            'claude-3.5-sonnet': {
                capabilities: ['chat', 'search', 'adventure', 'analysis'],
                maxTokens: 4096,
                temperature: 0.7
            },
            'claude-3-opus': {
                capabilities: ['chat', 'search', 'adventure', 'analysis'],
                maxTokens: 8192,
                temperature: 0.7
            }
        };
    }

    async initialize() {
        if (!this.config.apiKey) {
            throw new Error('Anthropic API key is required');
        }
        this.client = new Anthropic({ apiKey: this.config.apiKey });
    }

    async generateResponse({ prompt, options = {} }) {
        if (!this.client) {
            throw new Error('Provider not initialized');
        }

        const model = options.model || 'claude-3.5-sonnet';
        if (!this.supportedModels[model]) {
            throw new Error(`Unsupported model: ${model}`);
        }

        try {
            const completion = await this.client.messages.create({
                model: model,
                messages: [{ role: 'user', content: prompt }],
                temperature: options.temperature || this.supportedModels[model].temperature,
                max_tokens: options.maxTokens || this.supportedModels[model].maxTokens,
                ...options
            });

            return {
                content: completion.content[0].text,
                metadata: {
                    model: model,
                    provider: 'anthropic',
                    usage: {
                        total_tokens: completion.usage?.total_tokens,
                        prompt_tokens: completion.usage?.prompt_tokens,
                        completion_tokens: completion.usage?.completion_tokens
                    },
                    finishReason: completion.stop_reason
                }
            };
        } catch (error) {
            throw new Error(`Anthropic API Error: ${error.message}`);
        }
    }

    supportsCapability(capability) {
        return Object.values(this.supportedModels).some(
            model => model.capabilities.includes(capability)
        );
    }

    getRateLimits() {
        return {
            requestsPerMinute: 50,
            tokensPerMinute: 100000,
            provider: 'anthropic'
        };
    }

    validateConfig(config) {
        return Boolean(config.apiKey);
    }
}

module.exports = AnthropicProvider; 