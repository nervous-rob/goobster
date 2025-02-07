const { OpenAI } = require('openai');
const BaseProvider = require('./BaseProvider');

class OpenAIProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.client = null;
        this.supportedModels = {
            'gpt-4o': {
                capabilities: ['chat', 'search', 'adventure', 'analysis'],
                maxTokens: 8192,
                temperature: 0.7
            },
            'gpt-3.5-turbo': {
                capabilities: ['chat', 'search'],
                maxTokens: 4096,
                temperature: 0.7
            }
        };
    }

    async initialize() {
        if (!this.config.apiKey) {
            throw new Error('OpenAI API key is required');
        }
        this.client = new OpenAI({ apiKey: this.config.apiKey });
    }

    async generateResponse({ prompt, options = {} }) {
        if (!this.client) {
            throw new Error('Provider not initialized');
        }

        const model = options.model || 'gpt-4o';
        if (!this.supportedModels[model]) {
            throw new Error(`Unsupported model: ${model}`);
        }

        try {
            const completion = await this.client.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: model,
                temperature: options.temperature || this.supportedModels[model].temperature,
                max_tokens: options.maxTokens || this.supportedModels[model].maxTokens,
                ...options
            });

            return {
                content: completion.choices[0].message.content,
                metadata: {
                    model: model,
                    provider: 'openai',
                    usage: completion.usage,
                    finishReason: completion.choices[0].finish_reason
                }
            };
        } catch (error) {
            throw new Error(`OpenAI API Error: ${error.message}`);
        }
    }

    supportsCapability(capability) {
        return Object.values(this.supportedModels).some(
            model => model.capabilities.includes(capability)
        );
    }

    getRateLimits() {
        return {
            requestsPerMinute: 60,
            tokensPerMinute: 90000,
            provider: 'openai'
        };
    }

    validateConfig(config) {
        return Boolean(config.apiKey);
    }
}

module.exports = OpenAIProvider; 