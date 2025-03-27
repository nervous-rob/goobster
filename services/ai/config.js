/**
 * @typedef {Object} ProviderConfig
 * @property {string} apiKey - API key for the provider
 * @property {Object} [options] - Additional provider-specific options
 */

/**
 * @typedef {Object} AIConfig
 * @property {ProviderConfig} [openai] - OpenAI configuration
 * @property {ProviderConfig} [anthropic] - Anthropic configuration
 * @property {ProviderConfig} [google] - Google configuration
 * @property {ProviderConfig} [perplexity] - Perplexity configuration
 * @property {Object} [defaults] - Default configuration for all providers
 */

/**
 * Default configuration for AI providers
 * @type {AIConfig}
 */
const defaultConfig = {
    defaults: {
        timeout: 30000, // 30 seconds
        maxRetries: 3,
        retryDelay: 1000, // 1 second
        temperature: 0.7,
        maxTokens: 1000
    }
};

/**
 * Provider-specific rate limits
 * @type {Object.<string, {maxRequests: number, windowMs: number}>}
 */
const rateLimits = {
    openai: {
        maxRequests: 60,
        windowMs: 60000 // 1 minute
    },
    anthropic: {
        maxRequests: 50,
        windowMs: 60000 // 1 minute
    },
    google: {
        maxRequests: 60,
        windowMs: 60000 // 1 minute
    },
    perplexity: {
        maxRequests: 50,
        windowMs: 60000 // 1 minute
    }
};

/**
 * Validates provider configuration
 * @param {ProviderConfig} config - Provider configuration to validate
 * @param {string} provider - Provider name
 * @throws {Error} If configuration is invalid
 */
function validateProviderConfig(config, provider) {
    if (!config) {
        return null; // Return null for missing providers
    }
    if (!config.apiKey) {
        return null; // Return null for providers without API keys
    }
    if (typeof config.apiKey !== 'string') {
        throw new Error(`${provider} API key must be a string`);
    }
    return config;
}

/**
 * Merges provider configuration with defaults
 * @param {ProviderConfig} config - Provider configuration
 * @param {string} provider - Provider name
 * @returns {ProviderConfig} Merged configuration
 */
function mergeProviderConfig(config, provider) {
    const validatedConfig = validateProviderConfig(config, provider);
    if (!validatedConfig) {
        return null;
    }

    return {
        ...validatedConfig,
        options: {
            ...defaultConfig.defaults,
            ...validatedConfig.options,
            rateLimit: rateLimits[provider]
        }
    };
}

/**
 * Creates a complete AI configuration
 * @param {AIConfig} config - User configuration
 * @returns {AIConfig} Complete configuration
 */
function createConfig(config = {}) {
    const result = { ...defaultConfig };

    // Merge provider configurations
    if (config.openai) {
        const openaiConfig = mergeProviderConfig(config.openai, 'openai');
        if (openaiConfig) result.openai = openaiConfig;
    }
    if (config.anthropic) {
        const anthropicConfig = mergeProviderConfig(config.anthropic, 'anthropic');
        if (anthropicConfig) result.anthropic = anthropicConfig;
    }
    if (config.google) {
        const googleConfig = mergeProviderConfig(config.google, 'google');
        if (googleConfig) result.google = googleConfig;
    }
    if (config.perplexity) {
        const perplexityConfig = mergeProviderConfig(config.perplexity, 'perplexity');
        if (perplexityConfig) result.perplexity = perplexityConfig;
    }

    // Merge defaults if provided
    if (config.defaults) {
        result.defaults = {
            ...result.defaults,
            ...config.defaults
        };
    }

    return result;
}

module.exports = {
    createConfig,
    defaultConfig,
    rateLimits
}; 