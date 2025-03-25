import { OpenAI } from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AIProvider, AIModel, AIMessage, AIResponse, ImageGenerationParams, ImageVariationParams } from '../types';
import { validateMessages, formatResponse } from '../shared/utils';

export class OpenAIProvider implements AIProvider {
    private client: OpenAI;
    public name = 'OpenAI';
    public models: AIModel[] = [
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

    private readonly DEFAULT_TIMEOUT = 30000; // 30 seconds
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAY = 1000; // 1 second

    constructor(apiKey: string) {
        if (!apiKey) {
            throw new Error('OpenAI API key is required');
        }
        this.client = new OpenAI({ apiKey });
    }

    private validateModel(model: string): void {
        if (!this.models.some(m => m.id === model)) {
            throw new Error(`Model ${model} is not supported. Available models: ${this.models.map(m => m.id).join(', ')}`);
        }
    }

    private async executeWithTimeout<T>(
        promise: Promise<T>,
        timeout: number = this.DEFAULT_TIMEOUT
    ): Promise<T> {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Request timed out')), timeout);
        });

        return Promise.race([promise, timeoutPromise]);
    }

    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async retryWithBackoff<T>(
        operation: () => Promise<T>,
        retries: number = this.MAX_RETRIES
    ): Promise<T> {
        let lastError: Error | null = null;
        
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                return await operation();
            } catch (error: any) {
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

    async generateResponse(params: {
        model: string;
        messages: AIMessage[];
        temperature?: number;
        maxTokens?: number;
    }): Promise<AIResponse> {
        const startTime = Date.now();
        
        try {
            this.validateModel(params.model);
            validateMessages(params.messages);
            
            // Convert AIMessage to OpenAI's ChatCompletionMessageParam format
            const openaiMessages: ChatCompletionMessageParam[] = params.messages.map(msg => ({
                role: msg.role === 'model' ? 'assistant' : msg.role,
                content: msg.content,
                name: msg.name
            }));
            
            const response = await this.retryWithBackoff(() =>
                this.executeWithTimeout(
                    this.client.chat.completions.create({
                        model: params.model,
                        messages: openaiMessages,
                        temperature: params.temperature || 0.7,
                        max_tokens: params.maxTokens || 1000
                    })
                )
            );

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
                params.model,
                Date.now() - startTime,
                {
                    prompt: usage.prompt_tokens,
                    completion: usage.completion_tokens,
                    total: usage.total_tokens
                }
            );
        } catch (error: any) {
            // Handle specific OpenAI API errors
            if (error.message === 'Request timed out') {
                throw new Error('Request timed out. Please try again.');
            }
            if (error.response?.status === 429) {
                throw new Error('Rate limit exceeded. Please try again later.');
            }
            if (error.response?.status === 401) {
                throw new Error('Invalid API key. Please check your OpenAI API key.');
            }
            if (error.response?.status === 403) {
                throw new Error('Access denied. Please check your API key permissions.');
            }
            if (error.response?.status === 400) {
                throw new Error(`Invalid request: ${error.response.data?.error?.message || 'Unknown error'}`);
            }
            
            console.error(`Error generating response with OpenAI ${params.model}:`, error);
            throw new Error(`Failed to generate response: ${error.message || 'Unknown error'}`);
        }
    }

    async generateImage(params: ImageGenerationParams): Promise<string> {
        try {
            const response = await this.retryWithBackoff(() =>
                this.executeWithTimeout(
                    this.client.images.generate({
                        model: params.model || 'dall-e-3',
                        prompt: params.prompt,
                        size: params.size || '1024x1024',
                        quality: params.quality || 'standard',
                        style: params.style || 'natural',
                        n: 1
                    })
                )
            );

            const url = response.data[0].url;
            if (!url) {
                throw new Error('No URL in image generation response');
            }
            return url;
        } catch (error: any) {
            if (error.response?.status === 400) {
                throw new Error(`Invalid image generation request: ${error.response.data?.error?.message || 'Unknown error'}`);
            }
            if (error.response?.status === 429) {
                throw new Error('Image generation rate limit exceeded. Please try again later.');
            }
            console.error('Error generating image with OpenAI:', error);
            throw new Error(`Failed to generate image: ${error.message || 'Unknown error'}`);
        }
    }

    async generateImageVariation(params: ImageVariationParams): Promise<string[]> {
        try {
            const file = new File([params.image], 'image.png', { type: 'image/png' });
            const response = await this.retryWithBackoff(() =>
                this.executeWithTimeout(
                    this.client.images.createVariation({
                        image: file,
                        n: params.n || 1,
                        size: params.size || '1024x1024'
                    })
                )
            );

            const urls = response.data.map(img => img.url).filter((url): url is string => !!url);
            if (urls.length === 0) {
                throw new Error('No URLs in image variation response');
            }
            return urls;
        } catch (error: any) {
            if (error.response?.status === 400) {
                throw new Error(`Invalid image variation request: ${error.response.data?.error?.message || 'Unknown error'}`);
            }
            if (error.response?.status === 429) {
                throw new Error('Image variation rate limit exceeded. Please try again later.');
            }
            console.error('Error generating image variations with OpenAI:', error);
            throw new Error(`Failed to generate image variations: ${error.message || 'Unknown error'}`);
        }
    }
} 