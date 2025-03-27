const { OpenAIProvider } = require('./providers/openai');
const AnthropicProvider = require('./providers/anthropic');
const { GoogleProvider } = require('./providers/google');
const { PerplexityProvider } = require('./providers/perplexity');
const { createLogger } = require('../../utils/logger');
const { createConfig } = require('./config');

const logger = createLogger('AIService');

class AIService {
    constructor(config = {}) {
        this.config = {
            defaultModel: config.defaults?.defaultModel || 'openai:o1-mini',
            temperature: config.defaults?.temperature || 0.7,
            maxTokens: config.defaults?.maxTokens || 1000,
            retryAttempts: config.defaults?.retryAttempts || 3,
            retryDelay: config.defaults?.retryDelay || 1000
        };

        this.providers = new Map();
        this.initializeProviders(config);
        this.initializeFallbackModels();
    }

    initializeProviders(config) {
        const aiConfig = createConfig(config);

        // Initialize OpenAI provider
        if (aiConfig.openai?.apiKey) {
            try {
                this.providers.set('openai', new OpenAIProvider(aiConfig.openai.apiKey));
            } catch (error) {
                logger.error('Failed to initialize OpenAI provider:', error);
            }
        }

        // Initialize Anthropic provider
        if (aiConfig.anthropic?.apiKey) {
            try {
                this.providers.set('anthropic', new AnthropicProvider(aiConfig.anthropic.apiKey));
            } catch (error) {
                logger.error('Failed to initialize Anthropic provider:', error);
            }
        }

        // Initialize Google provider
        if (aiConfig.google?.apiKey) {
            try {
                this.providers.set('google', new GoogleProvider(aiConfig.google.apiKey));
            } catch (error) {
                logger.error('Failed to initialize Google provider:', error);
            }
        }

        // Initialize Perplexity provider
        if (aiConfig.perplexity?.apiKey) {
            try {
                this.providers.set('perplexity', new PerplexityProvider(aiConfig.perplexity.apiKey));
            } catch (error) {
                logger.error('Failed to initialize Perplexity provider:', error);
            }
        }

        // Log available providers
        logger.info('Initialized AI providers:', Array.from(this.providers.keys()));
    }

    initializeFallbackModels() {
        // Start with OpenAI fallbacks
        if (this.providers.has('openai')) {
            const openaiProvider = this.providers.get('openai');
            const openaiModels = openaiProvider.models;
            
            // Set up fallback chain
            openaiModels.forEach(model => {
                if (model.id === 'gpt-4o') {
                    model.fallbackModel = 'gpt-3.5-turbo';
                } else if (model.id === 'o1') {
                    model.fallbackModel = 'o1-mini';
                } else if (model.id === 'o3-mini') {
                    model.fallbackModel = 'o1';
                }
            });
        }

        // Add Anthropic fallbacks
        if (this.providers.has('anthropic')) {
            const anthropicProvider = this.providers.get('anthropic');
            const anthropicModels = anthropicProvider.models;
            
            anthropicModels.forEach(model => {
                if (model.id === 'claude-3-7-sonnet-20250219') {
                    model.fallbackModel = 'claude-3-5-sonnet-20241022';
                } else if (model.id === 'claude-3-5-sonnet-20241022') {
                    model.fallbackModel = 'claude-3-5-haiku-20241022';
                }
            });
        }

        // Add Google fallbacks
        if (this.providers.has('google')) {
            const googleProvider = this.providers.get('google');
            const googleModels = googleProvider.models;
            
            googleModels.forEach(model => {
                if (model.id === 'gemini-2.0-pro') {
                    model.fallbackModel = 'gemini-2.0-flash';
                } else if (model.id === 'gemini-2.0-flash') {
                    model.fallbackModel = 'gemini-2.0-flash-lite';
                } else if (model.id === 'gemini-2.0-flash-lite') {
                    model.fallbackModel = 'gemini-1.5-pro';
                }
            });
        }

        // Add Perplexity fallbacks
        if (this.providers.has('perplexity')) {
            const perplexityProvider = this.providers.get('perplexity');
            const perplexityModels = perplexityProvider.models;
            
            perplexityModels.forEach(model => {
                if (model.id === 'sonar-pro') {
                    model.fallbackModel = 'sonar-medium';
                }
            });
        }
    }

    async generateResponse(params) {
        const { model, messages, temperature, maxTokens } = params;
        const [providerName, modelName] = model.split(':');
        
        if (!this.providers.has(providerName)) {
            throw new Error(`Provider ${providerName} is not available`);
        }

        const provider = this.providers.get(providerName);
        let attempts = 0;
        let lastError = null;

        while (attempts < this.config.retryAttempts) {
            try {
                // Create request parameters without temperature
                const requestParams = {
                    model: modelName,
                    messages,
                    maxTokens: maxTokens || this.config.maxTokens
                };

                // Only add temperature if it's explicitly provided and the model supports it
                if (temperature !== undefined && !modelName.startsWith('gpt-4')) {
                    requestParams.temperature = temperature;
                }

                return await provider.generateResponse(requestParams);
            } catch (error) {
                lastError = error;
                attempts++;
                
                if (attempts < this.config.retryAttempts) {
                    await new Promise(resolve => setTimeout(resolve, this.config.retryDelay * attempts));
                }
            }
        }

        throw lastError || new Error('Failed to generate response after multiple attempts');
    }

    async generateImage(params) {
        const { model, prompt, size, quality, style } = params;
        const [providerName, modelName] = model.split(':');
        
        if (!this.providers.has(providerName)) {
            throw new Error(`Provider ${providerName} is not available`);
        }

        const provider = this.providers.get(providerName);
        if (!provider.generateImage) {
            throw new Error(`Provider ${providerName} does not support image generation`);
        }

        return await provider.generateImage({
            model: modelName,
            prompt,
            size,
            quality,
            style
        });
    }

    async generateImageVariation(params) {
        const { model, image, n, size } = params;
        const [providerName, modelName] = model.split(':');
        
        if (!this.providers.has(providerName)) {
            throw new Error(`Provider ${providerName} is not available`);
        }

        const provider = this.providers.get(providerName);
        if (!provider.generateImageVariation) {
            throw new Error(`Provider ${providerName} does not support image variation`);
        }

        return await provider.generateImageVariation({
            model: modelName,
            image,
            n,
            size
        });
    }

    getAvailableModels() {
        const models = [];
        for (const [providerName, provider] of this.providers) {
            models.push(...provider.models.map(model => ({
                ...model,
                provider: providerName
            })));
        }
        return models;
    }

    getProvider(providerName) {
        return this.providers.get(providerName);
    }

    getDefaultModel() {
        try {
            const [providerName, modelName] = this.config.defaultModel.split(':');
            const provider = this.providers.get(providerName);
            
            if (!provider) {
                // If the default provider is not available, try to find any available provider
                const firstProvider = this.providers.values().next().value;
                if (!firstProvider) {
                    logger.error('No AI providers are available. Please check your API keys and configuration.');
                    throw new Error('No AI providers are available. Please check your API keys and configuration.');
                }
                return {
                    provider: firstProvider.name.toLowerCase(),
                    model: firstProvider.models[0].id
                };
            }

            // Check if the default model exists in the provider
            const model = provider.models.find(m => m.id === modelName);
            if (!model) {
                logger.warn(`Default model ${modelName} not found in provider ${providerName}, using first available model`);
                return {
                    provider: providerName,
                    model: provider.models[0].id
                };
            }

            return {
                provider: providerName,
                model: modelName
            };
        } catch (error) {
            logger.error('Error getting default model:', error);
            throw error;
        }
    }

    setDefaultModel(model) {
        try {
            const [providerName, modelName] = model.split(':');
            const provider = this.providers.get(providerName);
            
            if (!provider) {
                throw new Error(`Provider ${providerName} is not available`);
            }

            // Check if the model exists in the provider
            const modelExists = provider.models.some(m => m.id === modelName);
            if (!modelExists) {
                throw new Error(`Model ${modelName} is not available in provider ${providerName}`);
            }

            this.config.defaultModel = model;
            logger.info(`Default model set to ${model}`);
        } catch (error) {
            logger.error('Error setting default model:', error);
            throw error;
        }
    }
}

module.exports = { AIService }; 