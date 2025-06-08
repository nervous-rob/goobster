require('dotenv').config();
const { OpenAI } = require('openai');
const config = require('../config.json');

// Prefer key from environment variables, fallback to config.json (to be deprecated)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || config.openaiKey;

class OpenAIService {
    constructor() {
        if (!OPENAI_API_KEY) {
            throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY in your environment variables.');
        }
        this.apiKey = OPENAI_API_KEY;
        this.client = new OpenAI({ apiKey: this.apiKey });
    }

    /**
     * Generate text using OpenAI's API
     * @param {string} prompt - The prompt to send to OpenAI
     * @param {Object} options - Options for the API call
     * @param {number} options.temperature - Controls randomness (0-2)
     * @param {number} options.max_tokens - Maximum tokens to generate
     * @param {string} options.model - Model to use (defaults to gpt-4o)
     * @param {boolean} options.includeCurrentDate - Whether to include current date in context
     * @returns {Promise<string>} The generated text
     */
    async generateText(prompt, options = {}) {
        try {
            const {
                temperature = 0.7,
                max_tokens = 1024,
                model = 'gpt-4o',
                includeCurrentDate = false
            } = options;

            // Add current date and time to the prompt if requested
            let finalPrompt = prompt;
            if (includeCurrentDate) {
                const now = new Date();
                const dateString = now.toLocaleDateString('en-US', { 
                    year: 'numeric', 
                    month: 'long', 
                    day: 'numeric' 
                });
                const timeString = now.toLocaleTimeString('en-US');
                finalPrompt = `Current date and time: ${dateString}, ${timeString}\n\n${prompt}`;
            }

            const response = await this.client.chat.completions.create({
                model,
                messages: [
                    {
                        role: 'user',
                        content: finalPrompt
                    }
                ],
                temperature,
                max_tokens
            });

            if (!response.choices?.[0]?.message?.content) {
                throw new Error('Invalid response format from OpenAI API');
            }

            return response.choices[0].message.content;
        } catch (error) {
            console.error('OpenAI API Error:', error.response?.data || error.message);
            if (error.response?.data?.error?.type === 'invalid_request_error') {
                throw new Error('Invalid request to OpenAI API. Please check your parameters.');
            } else if (!this.apiKey) {
                throw new Error('OpenAI API key not configured. Please add it to your config.json file.');
            }
            throw new Error('Failed to generate text: ' + (error.response?.data?.error?.message || error.message));
        }
    }

    /**
     * Run a full chat completion with optional streaming
     * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
     * @param {Object} opts
     * @param {string} opts.model
     * @param {number} opts.temperature
     * @param {number} opts.max_tokens
     * @param {boolean} opts.stream - When true, returns an async iterable stream
     */
    async chat(messages, opts = {}) {
        const {
            model = 'gpt-4o',
            temperature = 0.7,
            max_tokens = 1000,
            stream = false
        } = opts;

        try {
            const response = await this.client.chat.completions.create({
                model,
                messages,
                temperature,
                max_tokens,
                stream
            });

            // If streaming, return the iterator directly
            if (stream) return response;

            if (!response.choices?.[0]?.message?.content) {
                throw new Error('Invalid response format from OpenAI API');
            }

            return response.choices[0].message.content;
        } catch (error) {
            console.error('OpenAI Chat API Error:', error.response?.data || error.message);
            throw new Error('Failed to complete chat request: ' + (error.response?.data?.error?.message || error.message));
        }
    }
}

module.exports = new OpenAIService(); 