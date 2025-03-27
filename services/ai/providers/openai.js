const { OpenAI } = require('openai');
const { validateMessages, formatResponse } = require('../shared/utils');

class OpenAIProvider {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('OpenAI API key is required');
        }
        this.client = new OpenAI({ apiKey });
        this.name = 'OpenAI';
        this.models = [
            {
                id: 'o1',
                name: 'O1',
                description: 'Advanced reasoning model with 128k token context window and built-in chain-of-thought reasoning',
                provider: 'openai',
                maxTokens: 4096,
                contextWindow: 128000,
                capabilities: ['chat', 'completion', 'reasoning', 'thinking', 'analysis']
            },
            {
                id: 'o1-mini',
                name: 'O1 Mini',
                description: 'Cost-efficient reasoning model with 128k token context window',
                provider: 'openai',
                maxTokens: 4096,
                contextWindow: 128000,
                capabilities: ['chat', 'completion', 'reasoning', 'analysis']
            },
            {
                id: 'o3-mini',
                name: 'O3 Mini',
                description: 'Fast and efficient reasoning model with 200k token context window',
                provider: 'openai',
                maxTokens: 100000,
                contextWindow: 200000,
                capabilities: ['chat', 'completion', 'reasoning', 'analysis']
            },
            {
                id: 'gpt-4o',
                name: 'GPT-4 Turbo',
                description: 'Latest GPT-4 model with improved performance and lower latency',
                provider: 'openai',
                maxTokens: 4096,
                contextWindow: 128000,
                capabilities: ['chat', 'completion', 'function-calling']
            },
            {
                id: 'gpt-3.5-turbo',
                name: 'GPT-3.5 Turbo',
                description: 'Fast and efficient for most tasks',
                provider: 'openai',
                maxTokens: 4096,
                contextWindow: 16385,
                capabilities: ['chat', 'completion']
            }
        ];
    }

    validateModel(model) {
        if (!this.models.some(m => m.id === model)) {
            throw new Error(`Model ${model} is not supported. Available models: ${this.models.map(m => m.id).join(', ')}`);
        }
    }

    async generateResponse(params) {
        const startTime = Date.now();
        const { model, messages, temperature, maxTokens } = params;
        this.validateModel(model);
        validateMessages(messages);
        
        try {
            // Create base request parameters
            const requestParams = {
                model,
                messages: messages.map(msg => ({
                    role: msg.role === 'model' ? 'assistant' : msg.role,
                    content: msg.content,
                    name: msg.name
                })),
                max_completion_tokens: maxTokens || 1000
            };

            // Only add temperature for non-GPT-4 models
            if (temperature !== undefined && !model.startsWith('gpt-4')) {
                requestParams.temperature = temperature;
            }

            const response = await this.client.chat.completions.create(requestParams);

            const content = response.choices[0].message.content;
            if (!content) {
                throw new Error('No content in response');
            }

            const usage = response.usage;
            if (!usage) {
                throw new Error('No usage information in response');
            }

            return formatResponse(
                content,
                model,
                Date.now() - startTime,
                {
                    prompt: usage.prompt_tokens,
                    completion: usage.completion_tokens,
                    total: usage.total_tokens
                }
            );
        } catch (error) {
            if (error.response?.status === 429) {
                throw new Error('Rate limit exceeded. Please try again later.');
            }
            if (error.response?.status === 401) {
                throw new Error('Invalid API key. Please check your OpenAI API key.');
            }
            if (error.response?.status === 400) {
                throw new Error(`Invalid request: ${error.response.data?.error?.message || 'Unknown error'}`);
            }
            throw error;
        }
    }

    async generateImage(params) {
        const { model, prompt, size, quality, style } = params;
        try {
            const response = await this.client.images.generate({
                model: model || 'dall-e-3',
                prompt,
                size: size || '1024x1024',
                quality: quality || 'standard',
                style: style || 'natural',
                n: 1
            });

            const url = response.data[0].url;
            if (!url) {
                throw new Error('No URL in image generation response');
            }
            return url;
        } catch (error) {
            if (error.response?.status === 400) {
                throw new Error(`Invalid image generation request: ${error.response.data?.error?.message || 'Unknown error'}`);
            }
            if (error.response?.status === 429) {
                throw new Error('Image generation rate limit exceeded. Please try again later.');
            }
            throw error;
        }
    }

    async generateImageVariation(params) {
        const { image, n, size } = params;
        try {
            const response = await this.client.images.createVariation({
                image,
                n: n || 1,
                size: size || '1024x1024'
            });

            const urls = response.data.map(img => img.url).filter(url => url);
            if (urls.length === 0) {
                throw new Error('No URLs in image variation response');
            }
            return urls;
        } catch (error) {
            if (error.response?.status === 400) {
                throw new Error(`Invalid image variation request: ${error.response.data?.error?.message || 'Unknown error'}`);
            }
            if (error.response?.status === 429) {
                throw new Error('Image variation rate limit exceeded. Please try again later.');
            }
            throw error;
        }
    }
}

module.exports = { OpenAIProvider }; 