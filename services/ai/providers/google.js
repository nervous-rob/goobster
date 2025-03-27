const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { validateMessages, formatResponse } = require('../shared/utils');

/**
 * @typedef {Object} AIModel
 * @property {string} id - Unique identifier for the model
 * @property {string} name - Display name of the model
 * @property {string} description - Description of the model's capabilities
 * @property {string} provider - Provider name (e.g., 'google')
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

class GoogleProvider {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('Google AI API key is required');
        }
        this.client = new GoogleGenerativeAI(apiKey);
    }

    /**
     * @type {string}
     */
    name = 'Google';

    /**
     * @type {AIModel[]}
     */
    models = [
        {
            id: 'gemini-2.0-pro',
            name: 'Gemini 2.0 Pro',
            description: 'Most powerful Gemini model with advanced reasoning and 2M token context window',
            provider: 'google',
            maxTokens: 4096,
            contextWindow: 2000000,
            capabilities: ['chat', 'completion', 'analysis', 'reasoning', 'thinking', 'tool_use']
        },
        {
            id: 'gemini-2.0-flash',
            name: 'Gemini 2.0 Flash',
            description: 'Balanced performance with 1M token context window and multimodal input',
            provider: 'google',
            maxTokens: 4096,
            contextWindow: 1000000,
            capabilities: ['chat', 'completion', 'analysis', 'multimodal']
        },
        {
            id: 'gemini-2.0-flash-lite',
            name: 'Gemini 2.0 Flash-Lite',
            description: 'Cost-efficient model optimized for text output with 1M token context window',
            provider: 'google',
            maxTokens: 4096,
            contextWindow: 1000000,
            capabilities: ['chat', 'completion']
        },
        {
            id: 'gemini-1.5-pro',
            name: 'Gemini 1.5 Pro',
            description: 'Previous generation model with balanced capabilities',
            provider: 'google',
            maxTokens: 2048,
            contextWindow: 32768,
            capabilities: ['chat', 'completion', 'analysis']
        }
    ];

    /**
     * @type {number}
     * @private
     */
    DEFAULT_TIMEOUT = 30000; // 30 seconds

    /**
     * @type {Array<{category: string, threshold: string}>}
     * @private
     */
    SAFETY_SETTINGS = [
        {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
    ];

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
     * Executes a promise with a timeout
     * @template T
     * @param {Promise<T>} promise - Promise to execute
     * @param {number} [timeout=30000] - Timeout in milliseconds
     * @returns {Promise<T>} Result of the promise
     * @private
     */
    async executeWithTimeout(promise, timeout = this.DEFAULT_TIMEOUT) {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Request timed out')), timeout);
        });

        return Promise.race([promise, timeoutPromise]);
    }

    /**
     * Generates a response using the Google AI API
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
            
            const model = this.client.getGenerativeModel({ model: params.model });
            
            // Convert AIMessage to Google's format
            const googleMessages = params.messages.map(msg => ({
                role: msg.role === 'model' ? 'model' : msg.role,
                parts: [{ text: msg.content }]
            }));
            
            const response = await this.executeWithTimeout(
                model.generateContent({
                    contents: googleMessages,
                    generationConfig: {
                        temperature: params.temperature || 0.7,
                        maxOutputTokens: params.maxTokens || 1000
                    },
                    safetySettings: this.SAFETY_SETTINGS
                })
            );

            const content = response.response.text();
            if (!content) {
                throw new Error('No content in response');
            }

            // Note: Google's API doesn't provide token usage information
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
            // Handle specific Google API errors
            if (error.message === 'Request timed out') {
                throw new Error('Request timed out. Please try again.');
            }
            if (error.response?.status === 429) {
                throw new Error('Rate limit exceeded. Please try again later.');
            }
            if (error.response?.status === 401) {
                throw new Error('Invalid API key. Please check your Google AI API key.');
            }
            if (error.response?.status === 400) {
                throw new Error(`Invalid request: ${error.response.data?.error?.message || 'Unknown error'}`);
            }
            if (error.message?.includes('SAFETY')) {
                throw new Error('Content was blocked by safety filters. Please modify your request.');
            }
            
            console.error(`Error generating response with Google ${params.model}:`, error);
            throw new Error(`Failed to generate response: ${error.message || 'Unknown error'}`);
        }
    }
}

module.exports = { GoogleProvider }; 