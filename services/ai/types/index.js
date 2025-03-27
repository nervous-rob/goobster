/**
 * @typedef {Object} AIModel
 * @property {string} id - Unique identifier for the model
 * @property {string} name - Display name of the model
 * @property {string} description - Description of the model's capabilities
 * @property {string} provider - Provider name (e.g., 'openai', 'anthropic', 'google', 'perplexity')
 * @property {number} maxTokens - Maximum tokens per request
 * @property {number} contextWindow - Maximum context window size
 * @property {string[]} capabilities - List of model capabilities
 */

/**
 * @typedef {Object} AIMessage
 * @property {string} role - Message role ('user', 'assistant', 'system', 'model')
 * @property {string} content - Message content
 * @property {string} [name] - Optional name for the message sender
 */

/**
 * @typedef {Object} AIResponse
 * @property {string} content - Generated response content
 * @property {string} model - Model used for generation
 * @property {number} latency - Response time in milliseconds
 * @property {Object} usage - Token usage information
 * @property {number} usage.prompt - Number of tokens in prompt
 * @property {number} usage.completion - Number of tokens in completion
 * @property {number} usage.total - Total tokens used
 */

/**
 * @typedef {Object} ImageGenerationParams
 * @property {string} prompt - Text prompt for image generation
 * @property {string} [model] - Model to use for generation
 * @property {string} [size] - Image size (e.g., '1024x1024')
 * @property {string} [quality] - Image quality ('standard' or 'hd')
 * @property {string} [style] - Image style ('natural' or 'vivid')
 */

/**
 * @typedef {Object} ImageVariationParams
 * @property {Buffer|string} image - Base image for variations
 * @property {number} [n] - Number of variations to generate
 * @property {string} [size] - Image size (e.g., '1024x1024')
 */

/**
 * @typedef {Object} AIProvider
 * @property {string} name - Provider name
 * @property {AIModel[]} models - List of supported models
 * @property {function(Object): Promise<AIResponse>} generateResponse - Generate text response
 * @property {function(ImageGenerationParams): Promise<string>} [generateImage] - Generate image (optional)
 * @property {function(ImageVariationParams): Promise<string[]>} [generateImageVariation] - Generate image variations (optional)
 */

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
 * @typedef {Object} RateLimitConfig
 * @property {number} maxRequests - Maximum number of requests allowed
 * @property {number} windowMs - Time window in milliseconds
 */

/**
 * @typedef {Object} RateLimitState
 * @property {number[]} timestamps - Array of request timestamps
 * @property {number} lastReset - Last time the state was reset
 */

/**
 * @typedef {Object} APIError
 * @property {number} status - HTTP status code
 * @property {string} message - Error message
 * @property {Object} [data] - Additional error data
 */

module.exports = {
    // Re-export types for convenience
    AIModel: /** @type {AIModel} */ ({}),
    AIMessage: /** @type {AIMessage} */ ({}),
    AIResponse: /** @type {AIResponse} */ ({}),
    ImageGenerationParams: /** @type {ImageGenerationParams} */ ({}),
    ImageVariationParams: /** @type {ImageVariationParams} */ ({}),
    AIProvider: /** @type {AIProvider} */ ({}),
    ProviderConfig: /** @type {ProviderConfig} */ ({}),
    AIConfig: /** @type {AIConfig} */ ({}),
    RateLimitConfig: /** @type {RateLimitConfig} */ ({}),
    RateLimitState: /** @type {RateLimitState} */ ({}),
    APIError: /** @type {APIError} */ ({})
}; 