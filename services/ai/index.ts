import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';
import { GoogleProvider } from './providers/google';
import { PerplexityProvider } from './providers/perplexity';
import { AIServiceConfig, AIResponse, AIModel } from './types';
import { ImageGenerationParams, ImageVariationParams } from './types';

export class AIService {
    private providers: Map<string, OpenAIProvider | AnthropicProvider | GoogleProvider | PerplexityProvider>;
    private defaultModel: string;
    private temperature: number;
    private maxTokens: number;
    private fallbackModels: Map<string, string[]>; // Maps model to fallback models
    private retryAttempts: number;
    private retryDelay: number;

    constructor(config: AIServiceConfig) {
        this.providers = new Map();
        this.defaultModel = config.defaultModel || 'gpt-4o';
        this.temperature = config.temperature || 0.7;
        this.maxTokens = config.maxTokens || 1000;
        this.retryAttempts = config.retryAttempts || 3;
        this.retryDelay = config.retryDelay || 1000; // 1 second

        // Initialize providers
        if (config.openaiKey) {
            this.providers.set('openai', new OpenAIProvider(config.openaiKey));
        }
        if (config.anthropicKey) {
            this.providers.set('anthropic', new AnthropicProvider(config.anthropicKey));
        }
        if (config.googleAIKey) {
            this.providers.set('google', new GoogleProvider(config.googleAIKey));
        }
        if (config.perplexityKey) {
            this.providers.set('perplexity', new PerplexityProvider(config.perplexityKey));
        }

        // Initialize fallback models
        this.initializeFallbackModels();
    }

    /**
     * Initialize fallback models for each provider
     */
    private initializeFallbackModels(): void {
        this.fallbackModels = new Map();
        
        // OpenAI fallbacks
        this.fallbackModels.set('gpt-4o', ['gpt-3.5-turbo', 'o1-mini']);
        this.fallbackModels.set('o1', ['o1-mini', 'gpt-4o']);
        this.fallbackModels.set('o1-mini', ['gpt-3.5-turbo']);
        
        // Anthropic fallbacks
        this.fallbackModels.set('claude-3-7-sonnet-20250219', ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022']);
        this.fallbackModels.set('claude-3-5-sonnet-20241022', ['claude-3-5-haiku-20241022']);
        
        // Google fallbacks
        this.fallbackModels.set('gemini-2.0-pro', ['gemini-2.0-flash', 'gemini-1.5-pro']);
        this.fallbackModels.set('gemini-2.0-flash', ['gemini-2.0-flash-lite', 'gemini-1.5-pro']);
    }

    /**
     * Get fallback models for a given model
     */
    private getFallbackModels(model: string): string[] {
        return this.fallbackModels.get(model) || [];
    }

    /**
     * Sleep for a specified duration
     */
    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get all available models across all providers
     */
    getAvailableModels(): AIModel[] {
        const models: AIModel[] = [];
        for (const provider of this.providers.values()) {
            models.push(...provider.models);
        }
        return models;
    }

    /**
     * Get models from a specific provider
     */
    getProviderModels(providerName: string): AIModel[] {
        const provider = this.providers.get(providerName);
        return provider ? provider.models : [];
    }

    /**
     * Generate a response using the specified model with fallback support
     */
    async generateResponse(params: {
        model: string;
        messages: any[];
        temperature?: number;
        maxTokens?: number;
    }): Promise<AIResponse> {
        let lastError: Error | null = null;
        let attempts = 0;

        while (attempts < this.retryAttempts) {
            try {
                const provider = this.findProviderForModel(params.model);
                if (!provider) {
                    throw new Error(`No provider found for model: ${params.model}`);
                }

                return await provider.generateResponse({
                    model: params.model,
                    messages: params.messages,
                    temperature: params.temperature || this.temperature,
                    maxTokens: params.maxTokens || this.maxTokens
                });
            } catch (error) {
                lastError = error as Error;
                attempts++;

                if (attempts < this.retryAttempts) {
                    // Try fallback models
                    const fallbacks = this.getFallbackModels(params.model);
                    for (const fallbackModel of fallbacks) {
                        try {
                            const fallbackProvider = this.findProviderForModel(fallbackModel);
                            if (fallbackProvider) {
                                return await fallbackProvider.generateResponse({
                                    model: fallbackModel,
                                    messages: params.messages,
                                    temperature: params.temperature || this.temperature,
                                    maxTokens: params.maxTokens || this.maxTokens
                                });
                            }
                        } catch (fallbackError) {
                            console.warn(`Fallback model ${fallbackModel} failed:`, fallbackError);
                        }
                    }

                    // Wait before retrying
                    await this.sleep(this.retryDelay * attempts);
                }
            }
        }

        throw lastError || new Error('All attempts to generate response failed');
    }

    /**
     * Find the provider that supports the given model
     */
    private findProviderForModel(model: string): OpenAIProvider | AnthropicProvider | GoogleProvider | PerplexityProvider | undefined {
        for (const provider of this.providers.values()) {
            if (provider.models.some(m => m.id === model)) {
                return provider;
            }
        }
        return undefined;
    }

    /**
     * Get the default model
     */
    getDefaultModel(): string {
        return this.defaultModel;
    }

    /**
     * Set the default model
     */
    setDefaultModel(model: string): void {
        if (!this.findProviderForModel(model)) {
            throw new Error(`Model ${model} is not available`);
        }
        this.defaultModel = model;
    }

    /**
     * Get the current temperature setting
     */
    getTemperature(): number {
        return this.temperature;
    }

    /**
     * Set the temperature
     */
    setTemperature(temperature: number): void {
        if (temperature < 0 || temperature > 1) {
            throw new Error('Temperature must be between 0 and 1');
        }
        this.temperature = temperature;
    }

    /**
     * Get the current max tokens setting
     */
    getMaxTokens(): number {
        return this.maxTokens;
    }

    /**
     * Set the max tokens
     */
    setMaxTokens(maxTokens: number): void {
        if (maxTokens < 1) {
            throw new Error('Max tokens must be greater than 0');
        }
        this.maxTokens = maxTokens;
    }

    async generateImage(params: ImageGenerationParams): Promise<string> {
        const provider = this.findProviderForModel(params.model || 'dall-e-3');
        if (!provider || !('generateImage' in provider)) {
            throw new Error(`No provider found for model ${params.model} or provider does not support image generation`);
        }

        return provider.generateImage(params);
    }

    async generateImageVariation(params: ImageVariationParams): Promise<string[]> {
        const provider = this.findProviderForModel(params.model || 'dall-e-3');
        if (!provider || !('generateImageVariation' in provider)) {
            throw new Error(`No provider found for model ${params.model} or provider does not support image variations`);
        }

        return provider.generateImageVariation(params);
    }
} 