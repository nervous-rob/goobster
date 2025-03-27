const axios = require('axios');
const { validateMessages, formatResponse } = require('../shared/utils');

/**
 * @typedef {Object} AIModel
 * @property {string} id - Unique identifier for the model
 * @property {string} name - Display name of the model
 * @property {string} description - Description of the model's capabilities
 * @property {string} provider - Provider name (e.g., 'perplexity')
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

class PerplexityProvider {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('Perplexity API key is required');
        }
        this.apiKey = apiKey;
        this.baseURL = 'https://api.perplexity.ai';
    }

    /**
     * @type {string}
     */
    name = 'Perplexity';

    /**
     * @type {AIModel[]}
     */
    models = [
        {
            id: 'sonar-pro',
            name: 'Sonar Pro',
            description: 'Advanced reasoning model with real-time web search capabilities',
            provider: 'perplexity',
            maxTokens: 4096,
            contextWindow: 8192,
            capabilities: ['chat', 'completion', 'search', 'analysis']
        },
        {
            id: 'sonar-medium',
            name: 'Sonar Medium',
            description: 'Balanced performance model with web search capabilities',
            provider: 'perplexity',
            maxTokens: 2048,
            contextWindow: 4096,
            capabilities: ['chat', 'completion', 'search']
        }
    ];

    /**
     * @type {number}
     * @private
     */
    DEFAULT_TIMEOUT = 30000; // 30 seconds

    /**
     * @type {number}
     * @private
     */
    MAX_RETRIES = 3;

    /**
     * @type {number}
     * @private
     */
    RETRY_DELAY = 1000; // 1 second

    /**
     * Validates if the provided model is supported
     * @param {string} model - Model ID to validate
     * @throws {Error} If model is not supported
     */
    validateModel(model) {
        if (!this.models.some(m => m.id === model)) {
            throw new Error(`Model ${model} is not supported. Available models: ${this.models.map(m => m.id).join(', ')}`);
        }
    }

    /**
     * Sleeps for the specified number of milliseconds
     * @param {number} ms - Milliseconds to sleep
     * @returns {Promise<void>}
     * @private
     */
    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Retries an operation with exponential backoff
     * @template T
     * @param {() => Promise<T>} operation - Operation to retry
     * @param {number} [retries=3] - Number of retry attempts
     * @returns {Promise<T>} Result of the operation
     * @private
     */
    async retryWithBackoff(operation, retries = this.MAX_RETRIES) {
        let lastError = null;
        
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                
                // Don't retry on certain errors
                if (error.response?.status === 400 || 
                    error.response?.status === 401 || 
                    error.response?.status === 403) {
                    throw error;
                }

                // Wait before retrying with exponential backoff
                if (attempt < retries - 1) {
                    await this.sleep(this.RETRY_DELAY * Math.pow(2, attempt));
                }
            }
        }

        throw lastError || new Error('All retry attempts failed');
    }

    /**
     * Generates a response using the Perplexity API
     * @param {Object} params - Generation parameters
     * @param {string} params.model - Model ID to use
     * @param {AIMessage[]} params.messages - Array of messages
     * @param {number} [params.temperature=0.7] - Temperature for response generation
     * @param {number} [params.maxTokens=1000] - Maximum tokens to generate
     * @returns {Promise<AIResponse>} Generated response
     * @throws {Error} If generation fails
     */
    async generateResponse(params) {
        const startTime = Date.now();
        
        try {
            this.validateModel(params.model);
            validateMessages(params.messages);
            
            const response = await this.retryWithBackoff(() =>
                axios.post(
                    `${this.baseURL}/chat/completions`,
                    {
                        model: params.model,
                        messages: params.messages.map(msg => ({
                            role: msg.role === 'model' ? 'assistant' : msg.role,
                            content: msg.content
                        })),
                        temperature: params.temperature || 0.7,
                        max_tokens: params.maxTokens || 1000
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: this.DEFAULT_TIMEOUT
                    }
                )
            );

            const content = response.data?.choices?.[0]?.message?.content;
            if (!content) {
                throw new Error('No content in response');
            }

            // Note: Perplexity API doesn't provide token usage information
            const estimatedTokens = Math.ceil(content.length / 4);
            
            return formatResponse(
                content,
                params.model,
                Date.now() - startTime,
                {
                    prompt: estimatedTokens,
                    completion: estimatedTokens,
                    total: estimatedTokens * 2
                }
            );
        } catch (error) {
            if (axios.isAxiosError(error)) {
                // Handle specific Perplexity API errors
                if (error.code === 'ECONNABORTED') {
                    throw new Error('Request timed out. Please try again.');
                }
                if (error.response?.status === 429) {
                    throw new Error('Rate limit exceeded. Please try again later.');
                }
                if (error.response?.status === 401) {
                    throw new Error('Invalid API key. Please check your Perplexity API key.');
                }
                if (error.response?.status === 403) {
                    throw new Error('Access denied. Please check your API key permissions.');
                }
                if (error.response?.status === 400) {
                    const errorData = error.response.data;
                    throw new Error(`Invalid request: ${errorData.error?.message || 'Unknown error'}`);
                }
            }
            
            console.error(`Error generating response with Perplexity ${params.model}:`, error);
            throw new Error(`Failed to generate response: ${error.message || 'Unknown error'}`);
        }
    }
}

module.exports = { PerplexityProvider }; 