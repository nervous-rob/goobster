/**
 * Base AI Provider Interface
 * All AI providers must implement this interface
 */

class BaseProvider {
    constructor(config = {}) {
        if (this.constructor === BaseProvider) {
            throw new Error('BaseProvider is an abstract class and cannot be instantiated directly');
        }
        this.config = config;
    }

    /**
     * Initialize the provider with necessary credentials and configuration
     * @returns {Promise<void>}
     */
    async initialize() {
        throw new Error('initialize() must be implemented by provider');
    }

    /**
     * Generate a response from the AI model
     * @param {Object} params - Generation parameters
     * @param {string} params.prompt - The input prompt
     * @param {Object} params.options - Model-specific options
     * @returns {Promise<Object>} Generated response with metadata
     */
    async generateResponse(params) {
        throw new Error('generateResponse() must be implemented by provider');
    }

    /**
     * Check if the provider supports a specific capability
     * @param {string} capability - Capability to check
     * @returns {boolean} Whether the capability is supported
     */
    supportsCapability(capability) {
        throw new Error('supportsCapability() must be implemented by provider');
    }

    /**
     * Get the provider's rate limits and quotas
     * @returns {Object} Rate limit information
     */
    getRateLimits() {
        throw new Error('getRateLimits() must be implemented by provider');
    }

    /**
     * Validate provider-specific configuration
     * @param {Object} config - Configuration to validate
     * @returns {boolean} Whether the configuration is valid
     */
    validateConfig(config) {
        throw new Error('validateConfig() must be implemented by provider');
    }
}

module.exports = BaseProvider; 