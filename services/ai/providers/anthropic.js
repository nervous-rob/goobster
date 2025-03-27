const Anthropic = require('@anthropic-ai/sdk');
const { validateMessages, formatResponse } = require('../shared/utils');

/**
 * @typedef {Object} AIModel
 * @property {string} id - Unique identifier for the model
 * @property {string} name - Display name of the model
 * @property {string} description - Description of the model's capabilities
 * @property {string} provider - Provider name (e.g., 'anthropic')
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

class AnthropicProvider {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('Anthropic API key is required');
        }
        this.client = new Anthropic({ apiKey });
    }

    /**
     * @type {string}
     */
    name = 'Anthropic';

    /**
     * @type {AIModel[]}
     */
    models = [
        {
            id: 'claude-3-7-sonnet-20250219',
            name: 'Claude 3.7 Sonnet',
            description: 'Most capable Claude model with advanced reasoning and analysis',
            provider: 'anthropic',
            maxTokens: 4096,
            contextWindow: 200000,
            capabilities: ['chat', 'completion', 'analysis', 'reasoning', 'thinking']
        },
        {
            id: 'claude-3-5-sonnet-20241022',
            name: 'Claude 3.5 Sonnet',
            description: 'Balanced performance and speed for most tasks',
            provider: 'anthropic',
            maxTokens: 4096,
            contextWindow: 200000,
            capabilities: ['chat', 'completion', 'analysis']
        },
        {
            id: 'claude-3-5-haiku-20241022',
            name: 'Claude 3.5 Haiku',
            description: 'Fastest Claude model for quick responses',
            provider: 'anthropic',
            maxTokens: 4096,
            contextWindow: 200000,
            capabilities: ['chat', 'completion']
        }
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
     * Generates a response using the Anthropic API
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
            
            // Extract system message if present
            const systemMessage = params.messages.find(msg => msg.role === 'system');
            const nonSystemMessages = params.messages.filter(msg => msg.role !== 'system');
            
            // Convert AIMessage to Anthropic's format
            const anthropicMessages = nonSystemMessages.map(msg => ({
                role: msg.role === 'model' ? 'assistant' : msg.role,
                content: msg.content
            }));
            
            const response = await this.client.messages.create({
                model: params.model,
                messages: anthropicMessages,
                system: systemMessage?.content,
                temperature: params.temperature || 0.7,
                max_tokens: params.maxTokens || 1000
            });

            const content = response.content[0].text;
            if (!content) {
                throw new Error('No content in response');
            }

            const usage = response.usage;
            if (!usage) {
                throw new Error('No usage information in response');
            }

            return formatResponse(
                content,
                params.model,
                Date.now() - startTime,
                {
                    prompt: usage.input_tokens,
                    completion: usage.output_tokens,
                    total: usage.input_tokens + usage.output_tokens
                }
            );
        } catch (error) {
            // Handle specific Anthropic API errors
            if (error.response?.status === 429) {
                throw new Error('Rate limit exceeded. Please try again later.');
            }
            if (error.response?.status === 401) {
                throw new Error('Invalid API key. Please check your Anthropic API key.');
            }
            if (error.response?.status === 400) {
                throw new Error(`Invalid request: ${error.response.data?.error?.message || 'Unknown error'}`);
            }
            
            console.error(`Error generating response with Anthropic ${params.model}:`, error);
            throw new Error(`Failed to generate response: ${error.message || 'Unknown error'}`);
        }
    }
}

module.exports = AnthropicProvider; 