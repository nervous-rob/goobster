const OpenAIProvider = require('./providers/OpenAIProvider');
const AnthropicProvider = require('./providers/AnthropicProvider');
const GoogleAIProvider = require('./providers/GoogleAIProvider');
const { sql, getConnection } = require('../../azureDb');
const config = require('../../config.json');

/**
 * AI Model Manager
 * Manages multiple AI providers with intelligent model selection and fallback
 * 
 * Features:
 * - Multi-provider support (Google Gemini 2.0, OpenAI, Anthropic)
 * - Automatic model selection based on capabilities and requirements
 * - Rate limit management and monitoring
 * - Performance-based routing
 * - Comprehensive logging and analytics
 * 
 * @class ModelManager
 */
class ModelManager {
    constructor() {
        this.providers = new Map();
        this.fallbackOrder = ['openai', 'anthropic', 'google'];
        this.rateLimits = new Map();
        
        // Rate limit check interval (1 minute)
        this.RATE_LIMIT_INTERVAL = 60000;
        
        // Retry settings
        this.MAX_RETRIES = 3;
        this.RETRY_DELAY = 1000;
    }

    /**
     * Initialize the model manager and all providers
     * Loads configurations from database and sets up rate limit monitoring
     * 
     * @returns {Promise<void>}
     * @throws {Error} If initialization fails
     */
    async initialize() {
        try {
            // Load model configurations from database
            const db = await getConnection();
            const result = await db.query`
                SELECT id, provider, model_name, api_version, max_tokens, 
                       temperature, capabilities, rate_limit, is_active, priority
                FROM model_configs
                WHERE is_active = 1
                ORDER BY priority ASC
            `;

            // Initialize providers based on database config
            for (const config of result.recordset) {
                const provider = await this._initializeProvider(config);
                if (provider) {
                    this.providers.set(config.provider, provider);
                    this.rateLimits.set(config.provider, {
                        requests: 0,
                        tokens: 0,
                        lastReset: Date.now(),
                        limits: {
                            requestsPerMinute: config.rate_limit,
                            tokensPerMinute: config.max_tokens * config.rate_limit
                        }
                    });
                }
            }

            // Update fallback order based on priority
            this.fallbackOrder = result.recordset
                .sort((a, b) => a.priority - b.priority)
                .map(config => config.provider);

            // Start rate limit reset interval
            setInterval(() => this._resetRateLimits(), this.RATE_LIMIT_INTERVAL);
        } catch (error) {
            console.error('Error initializing providers:', error);
            throw new Error('Failed to initialize AI providers');
        }
    }

    /**
     * Initialize a specific provider with configuration
     * 
     * @private
     * @param {Object} config Provider configuration
     * @param {string} config.provider Provider name
     * @param {string} config.model_name Model identifier
     * @param {string} config.api_version API version
     * @param {number} config.max_tokens Maximum tokens
     * @param {number} config.temperature Temperature setting
     * @param {string[]} config.capabilities Supported capabilities
     * @returns {Promise<BaseProvider|null>} Initialized provider or null
     */
    async _initializeProvider(config) {
        const apiKey = this._getApiKey(config.provider);
        if (!apiKey) return null;

        let provider;
        switch (config.provider) {
            case 'openai':
                provider = new OpenAIProvider({ 
                    apiKey,
                    maxTokens: config.max_tokens,
                    temperature: config.temperature,
                    apiVersion: config.api_version
                });
                break;
            case 'anthropic':
                provider = new AnthropicProvider({ 
                    apiKey,
                    maxTokens: config.max_tokens,
                    temperature: config.temperature,
                    apiVersion: config.api_version
                });
                break;
            case 'google':
                provider = new GoogleAIProvider({ 
                    apiKey,
                    maxTokens: config.max_tokens,
                    temperature: config.temperature,
                    apiVersion: config.api_version,
                    defaultModel: 'gemini-2.0-pro' // Set default to newest model
                });
                break;
            default:
                return null;
        }

        await provider.initialize();
        return provider;
    }

    _getApiKey(provider) {
        switch (provider) {
            case 'openai': return config.openaiKey;
            case 'anthropic': return config.anthropicKey;
            case 'google': return config.googleAIKey;
            default: return null;
        }
    }

    /**
     * Reset rate limits for all providers
     * @private
     */
    _resetRateLimits() {
        const now = Date.now();
        for (const [provider, limits] of this.rateLimits.entries()) {
            if (now - limits.lastReset >= this.RATE_LIMIT_INTERVAL) {
                limits.requests = 0;
                limits.tokens = 0;
                limits.lastReset = now;
            }
        }
    }

    /**
     * Check if a provider is rate limited
     * @private
     */
    _isRateLimited(provider) {
        const limits = this.rateLimits.get(provider);
        if (!limits) return true;

        const { requests, tokens, limits: { requestsPerMinute, tokensPerMinute } } = limits;
        return requests >= requestsPerMinute || tokens >= tokensPerMinute;
    }

    /**
     * Update rate limit counters for a provider
     * @private
     */
    _updateRateLimits(provider, tokenCount) {
        const limits = this.rateLimits.get(provider);
        if (limits) {
            limits.requests++;
            limits.tokens += tokenCount;
        }
    }

    /**
     * Get the best available provider for a capability
     * 
     * @private
     * @param {string} capability Required capability
     * @param {Object} options Additional options
     * @param {string} [options.model] Specific model request
     * @param {boolean} [options.requireLowLatency] Require low latency response
     * @param {boolean} [options.requireHighPerformance] Require high performance
     * @param {Object} [options.requirements] Specific requirements
     * @returns {Object} Provider and name
     * @throws {Error} If no suitable provider is available
     */
    _getBestProvider(capability, options = {}) {
        // Prioritize specific model requests
        if (options.model) {
            for (const providerName of this.fallbackOrder) {
                const provider = this.providers.get(providerName);
                if (provider && 
                    provider.supportedModels?.[options.model]?.capabilities.includes(capability) && 
                    !this._isRateLimited(providerName)) {
                    return { provider, name: providerName };
                }
            }
        }

        // Prioritize providers based on capability and performance requirements
        const priorityOrder = this._getProviderPriorityOrder(capability, options);
        
        for (const providerName of priorityOrder) {
            const provider = this.providers.get(providerName);
            if (provider && 
                provider.supportsCapability(capability) && 
                !this._isRateLimited(providerName) &&
                this._meetsPerformanceRequirements(provider, options)) {
                return { provider, name: providerName };
            }
        }
        
        throw new Error('No available providers for the requested capability');
    }

    /**
     * Get provider priority order based on capability and requirements
     * @private
     */
    _getProviderPriorityOrder(capability, options = {}) {
        // Default provider order
        let order = [...this.fallbackOrder];

        // Adjust order based on capability
        switch (capability) {
            case 'code':
                // Prioritize providers with strong coding capabilities
                order = ['google', 'anthropic', 'openai'];
                break;
            case 'search':
                // Prioritize providers with search integration
                order = ['google', 'openai', 'anthropic'];
                break;
            case 'analysis':
                // Prioritize providers with large context windows
                order = ['google', 'anthropic', 'openai'];
                break;
        }

        // Adjust order based on performance requirements
        if (options.requireLowLatency) {
            // Prioritize faster models
            order = order.map(provider => 
                provider === 'google' ? ['gemini-2.0-flash', 'gemini-2.0-flash-lite'] : provider
            ).flat();
        }

        return order;
    }

    /**
     * Check if provider meets performance requirements
     * @private
     */
    _meetsPerformanceRequirements(provider, options = {}) {
        if (!options.requirements) return true;

        const {
            minTokens,
            maxLatency,
            minReliability
        } = options.requirements;

        // Check token capacity
        if (minTokens && provider.supportedModels?.[options.model]?.maxTokens < minTokens) {
            return false;
        }

        // Check latency requirements
        if (maxLatency && provider.getAverageLatency() > maxLatency) {
            return false;
        }

        // Check reliability
        if (minReliability && provider.getReliabilityScore() < minReliability) {
            return false;
        }

        return true;
    }

    /**
     * Generate a response using the best available provider
     * 
     * Supports Gemini 2.0 models:
     * - gemini-2.0-pro: Best for complex tasks, 2M token context
     * - gemini-2.0-flash: Balanced performance, 1M token context
     * - gemini-2.0-flash-lite: Efficient option, 128K token context
     * 
     * @param {Object} params Generation parameters
     * @param {string|Array} params.prompt Input prompt or message array
     * @param {string} [params.capability='chat'] Required capability
     * @param {Object} [params.options={}] Provider-specific options
     * @param {string} [params.options.model] Specific model request
     * @param {boolean} [params.options.requireLowLatency] Optimize for latency
     * @param {boolean} [params.options.requireHighPerformance] Optimize for performance
     * @param {Object} [params.options.requirements] Specific requirements
     * @returns {Promise<Object>} Generated response with metadata
     * @throws {Error} If generation fails
     */
    async generateResponse({ prompt, capability = 'chat', options = {} }) {
        let lastError = null;
        let retries = 0;

        while (retries < this.MAX_RETRIES) {
            try {
                const { provider, name } = this._getBestProvider(capability, options);
                
                // Add model-specific optimizations
                const enhancedOptions = this._enhanceOptions(options, name);
                
                const response = await provider.generateResponse({ 
                    prompt, 
                    options: enhancedOptions 
                });
                
                // Log response to database
                await this._logModelResponse({
                    provider: name,
                    response,
                    options: enhancedOptions
                });
                
                // Update rate limits
                const tokenCount = response.metadata.usage?.total_tokens || 0;
                this._updateRateLimits(name, tokenCount);
                
                return response;
            } catch (error) {
                lastError = error;
                retries++;
                
                if (retries < this.MAX_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY * retries));
                    continue;
                }
                
                // Log failed attempt
                await this._logModelResponse({
                    provider: lastError.provider || 'unknown',
                    error: lastError,
                    options
                });
                
                throw new Error(`Failed to generate response after ${retries} retries: ${lastError.message}`);
            }
        }
    }

    /**
     * Enhance options with model-specific optimizations
     * @private
     */
    _enhanceOptions(options, providerName) {
        const enhanced = { ...options };

        if (providerName === 'google') {
            // Add Gemini-specific optimizations
            enhanced.topK = options.topK || 40;
            enhanced.topP = options.topP || 0.95;
            
            // Select appropriate model based on requirements
            if (!enhanced.model) {
                if (options.requireLowLatency) {
                    enhanced.model = 'gemini-2.0-flash';
                } else if (options.requireHighPerformance) {
                    enhanced.model = 'gemini-2.0-pro';
                } else if (options.requireEfficiency) {
                    enhanced.model = 'gemini-2.0-flash-lite';
                }
            }
        }

        return enhanced;
    }

    /**
     * Log model response to database
     * @private
     * @param {Object} params - Logging parameters
     * @param {string} params.provider - Provider name
     * @param {Object} [params.response] - Response object
     * @param {Error} [params.error] - Error object if request failed
     * @param {Object} [params.options] - Request options
     * @returns {Promise<void>}
     */
    async _logModelResponse({ provider, response, error = null, options = {} }) {
        try {
            const db = await getConnection();
            
            // Get model config ID
            const configResult = await db.query`
                SELECT id 
                FROM model_configs 
                WHERE provider = ${provider} 
                AND model_name = ${options.model || 'default'}
            `;
            
            if (!configResult.recordset.length) return;
            
            const modelConfigId = configResult.recordset[0].id;
            
            await db.query`
                INSERT INTO model_responses (
                    request_id,
                    api_version,
                    model_config_id,
                    message_id,
                    user_id,
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    latency_ms,
                    success,
                    error_message,
                    error_code
                )
                VALUES (
                    ${response?.metadata?.requestId || null},
                    ${options.apiVersion || 'v1'},
                    ${modelConfigId},
                    ${options.messageId || null},
                    ${options.userId || null},
                    ${response?.metadata?.usage?.prompt_tokens || 0},
                    ${response?.metadata?.usage?.completion_tokens || 0},
                    ${response?.metadata?.usage?.total_tokens || 0},
                    ${response?.metadata?.latency || 0},
                    ${!error},
                    ${error?.message || null},
                    ${error?.code || null}
                )
            `;
        } catch (dbError) {
            console.error('Error logging model response:', dbError);
        }
    }

    /**
     * Get current rate limit status for all providers
     * 
     * @returns {Object} Rate limit status by provider
     * @property {Object} google Gemini rate limits
     * @property {Object} openai OpenAI rate limits
     * @property {Object} anthropic Anthropic rate limits
     */
    getRateLimitStatus() {
        const status = {};
        for (const [provider, limits] of this.rateLimits.entries()) {
            status[provider] = {
                isLimited: this._isRateLimited(provider),
                currentRequests: limits.requests,
                currentTokens: limits.tokens,
                maxRequestsPerMinute: limits.limits.requestsPerMinute,
                maxTokensPerMinute: limits.limits.tokensPerMinute,
                timeUntilReset: Math.max(0, this.RATE_LIMIT_INTERVAL - (Date.now() - limits.lastReset))
            };
        }
        return status;
    }
}

module.exports = new ModelManager(); 