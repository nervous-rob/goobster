import axios, { AxiosError } from 'axios';
import { AIProvider, AIModel, AIMessage, AIResponse } from '../types';
import { validateMessages, formatResponse } from '../shared/utils';

export class PerplexityProvider implements AIProvider {
    private apiKey: string;
    private baseURL: string;
    public name = 'Perplexity';
    public models: AIModel[] = [
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

    private readonly DEFAULT_TIMEOUT = 30000; // 30 seconds
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAY = 1000; // 1 second

    constructor(apiKey: string) {
        if (!apiKey) {
            throw new Error('Perplexity API key is required');
        }
        this.apiKey = apiKey;
        this.baseURL = 'https://api.perplexity.ai';
    }

    private validateModel(model: string): void {
        if (!this.models.some(m => m.id === model)) {
            throw new Error(`Model ${model} is not supported. Available models: ${this.models.map(m => m.id).join(', ')}`);
        }
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
        } catch (error: any) {
            if (axios.isAxiosError(error)) {
                const axiosError = error as AxiosError;
                
                // Handle specific Perplexity API errors
                if (axiosError.code === 'ECONNABORTED') {
                    throw new Error('Request timed out. Please try again.');
                }
                if (axiosError.response?.status === 429) {
                    throw new Error('Rate limit exceeded. Please try again later.');
                }
                if (axiosError.response?.status === 401) {
                    throw new Error('Invalid API key. Please check your Perplexity API key.');
                }
                if (axiosError.response?.status === 403) {
                    throw new Error('Access denied. Please check your API key permissions.');
                }
                if (axiosError.response?.status === 400) {
                    const errorData = axiosError.response.data as { error?: { message?: string } };
                    throw new Error(`Invalid request: ${errorData.error?.message || 'Unknown error'}`);
                }
            }
            
            console.error(`Error generating response with Perplexity ${params.model}:`, error);
            throw new Error(`Failed to generate response: ${error.message || 'Unknown error'}`);
        }
    }
} 