// TODO: Add proper handling for API version changes
// TODO: Add proper handling for model configuration validation
// TODO: Add proper handling for token limit management
// TODO: Add proper handling for rate limit backoff
// TODO: Add proper handling for API key rotation
// TODO: Add proper handling for request retries
// TODO: Add proper handling for response validation
// TODO: Add proper handling for streaming responses
// TODO: Add proper handling for concurrent request limits
// TODO: Add proper handling for request timeouts

const axios = require('axios');
const aiConfig = require('../config/aiConfig');

class PerplexityService {
    constructor() {
        // Optional integration: the key may be absent on self-hosted setups.
        // We only fail when a search is actually attempted.
        this.apiKey = aiConfig.perplexity.apiKey;
        this.model = aiConfig.perplexity.model;
        this.baseURL = 'https://api.perplexity.ai';
        if (!this.apiKey) {
            console.warn('[PerplexityService] API key not set; web search is disabled until provided.');
        }
    }

    isConfigured() {
        return Boolean(this.apiKey);
    }

    async search(query) {
        if (!this.apiKey) {
            throw new Error('Web search is not available: Perplexity API key is not configured.');
        }
        try {
            const response = await axios.post(
                `${this.baseURL}/chat/completions`,
                {
                    model: this.model,
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a helpful assistant that provides accurate and concise information.'
                        },
                        {
                            role: 'user',
                            content: query
                        }
                    ],
                    max_tokens: 4096  // Half of the 8k max output token limit for sonar-pro
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!response.data?.choices?.[0]?.message?.content) {
                throw new Error('Invalid response format from Perplexity API');
            }

            return response.data.choices[0].message.content;
        } catch (error) {
            console.error('Perplexity API Error:', error.response?.data || error.message);
            if (error.response?.data?.error?.type === 'invalid_model') {
                throw new Error('Invalid model configuration. Please check your Perplexity API settings.', { cause: error });
            } else if (!this.apiKey) {
                throw new Error('Perplexity API key not configured. Please add it to your environment variables.', { cause: error });
            }
            throw new Error('Failed to get search results: ' + (error.response?.data?.error?.message || error.message), { cause: error });
        }
    }
}

module.exports = new PerplexityService(); 