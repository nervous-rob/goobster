import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, AIModel, AIMessage, AIResponse } from '../types';
import { validateMessages, formatResponse } from '../shared/utils';

export class AnthropicProvider implements AIProvider {
    private client: Anthropic;
    public name = 'Anthropic';
    public models: AIModel[] = [
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

    constructor(apiKey: string) {
        if (!apiKey) {
            throw new Error('Anthropic API key is required');
        }
        this.client = new Anthropic({ apiKey });
    }

    private validateModel(model: string): void {
        if (!this.models.some(m => m.id === model)) {
            throw new Error(`Model ${model} is not supported. Available models: ${this.models.map(m => m.id).join(', ')}`);
        }
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
            
            // Extract system message if present
            const systemMessage = params.messages.find(msg => msg.role === 'system');
            const nonSystemMessages = params.messages.filter(msg => msg.role !== 'system');
            
            // Convert AIMessage to Anthropic's format
            const anthropicMessages = nonSystemMessages.map(msg => ({
                role: msg.role === 'model' ? 'assistant' : msg.role,
                content: msg.content
            })) as { role: 'user' | 'assistant'; content: string }[];
            
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
        } catch (error: any) {
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