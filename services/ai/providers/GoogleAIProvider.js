const { GoogleGenerativeAI } = require('@google/generative-ai');
const BaseProvider = require('./BaseProvider');

class GoogleAIProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.client = null;
        this.supportedModels = {
            'gemini-2.0-pro': {
                capabilities: ['chat', 'search', 'code', 'analysis'],
                maxTokens: 2000000, // 2M token context window
                temperature: 0.7
            },
            'gemini-2.0-flash': {
                capabilities: ['chat', 'search'],
                maxTokens: 1000000, // 1M token context window
                temperature: 0.7
            },
            'gemini-2.0-flash-lite': {
                capabilities: ['chat'],
                maxTokens: 128000,
                temperature: 0.7
            },
            'gemini-pro': {
                capabilities: ['chat'],
                maxTokens: 4096,
                temperature: 0.7
            }
        };
    }

    async initialize() {
        if (!this.config.apiKey) {
            throw new Error('Google AI API key is required');
        }
        this.client = new GoogleGenerativeAI(this.config.apiKey);
    }

    async generateResponse({ prompt, options = {} }) {
        if (!this.client) {
            throw new Error('Provider not initialized');
        }

        const model = options.model || 'gemini-2.0-pro';
        if (!this.supportedModels[model]) {
            throw new Error(`Unsupported model: ${model}`);
        }

        try {
            const geminiModel = this.client.getGenerativeModel({ model });
            
            const generationConfig = {
                temperature: options.temperature || this.supportedModels[model].temperature,
                maxOutputTokens: options.maxTokens || this.supportedModels[model].maxTokens,
                topK: options.topK || 40,
                topP: options.topP || 0.95,
                candidateCount: options.candidateCount || 1,
                stopSequences: options.stopSequences || [],
                ...options
            };

            let contents = [];
            if (Array.isArray(prompt)) {
                contents = prompt.map(msg => ({
                    role: msg.role || 'user',
                    parts: [{ text: msg.content }]
                }));
            } else if (typeof prompt === 'string') {
                contents = [{ role: 'user', parts: [{ text: prompt }] }];
            } else {
                throw new Error('Invalid prompt format');
            }

            const result = await geminiModel.generateContent({
                contents,
                generationConfig,
                safetySettings: options.safetySettings
            });

            const response = result.response;
            
            return {
                content: response.text(),
                metadata: {
                    model,
                    provider: 'google',
                    usage: {
                        prompt_tokens: response.promptFeedback?.tokenCount || 0,
                        completion_tokens: response.candidates?.[0]?.tokenCount || 0,
                        total_tokens: (response.promptFeedback?.tokenCount || 0) + 
                                    (response.candidates?.[0]?.tokenCount || 0)
                    },
                    finishReason: response.promptFeedback?.blockReason || null,
                    safetyRatings: response.promptFeedback?.safetyRatings || [],
                    candidates: response.candidates?.length || 1,
                    citationMetadata: response.citationMetadata || null
                }
            };
        } catch (error) {
            throw new Error(`Google AI API Error: ${error.message}`);
        }
    }

    supportsCapability(capability) {
        return Object.values(this.supportedModels).some(
            model => model.capabilities.includes(capability)
        );
    }

    getRateLimits() {
        return {
            requestsPerMinute: 120,
            tokensPerMinute: 1000000,
            provider: 'google',
            modelLimits: {
                'gemini-2.0-pro': {
                    requestsPerMinute: 120,
                    tokensPerMinute: 1000000
                },
                'gemini-2.0-flash': {
                    requestsPerMinute: 180,
                    tokensPerMinute: 1500000
                },
                'gemini-2.0-flash-lite': {
                    requestsPerMinute: 240,
                    tokensPerMinute: 2000000
                },
                'gemini-pro': {
                    requestsPerMinute: 60,
                    tokensPerMinute: 60000
                }
            }
        };
    }

    validateConfig(config) {
        return Boolean(config.apiKey);
    }
}

module.exports = GoogleAIProvider; 