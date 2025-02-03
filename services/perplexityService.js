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
const config = require('../config.json');

class PerplexityService {
    constructor() {
        if (!config.perplexity?.apiKey) {
            throw new Error('Perplexity API key not found in config.json. Please add perplexity.apiKey to your config.');
        }
        this.apiKey = config.perplexity.apiKey;
        this.baseURL = 'https://api.perplexity.ai';
    }

    async search(query) {
        try {
            const response = await axios.post(
                `${this.baseURL}/chat/completions`,
                {
                    model: 'sonar-pro',
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
                throw new Error('Invalid model configuration. Please check your Perplexity API settings.');
            } else if (!this.apiKey) {
                throw new Error('Perplexity API key not configured. Please add it to your environment variables.');
            }
            throw new Error('Failed to get search results: ' + (error.response?.data?.error?.message || error.message));
        }
    }
}

module.exports = new PerplexityService(); 