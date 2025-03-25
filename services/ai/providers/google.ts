import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { AIProvider, AIModel, AIMessage, AIResponse } from '../types';
import { validateMessages, formatResponse } from '../shared/utils';

export class GoogleProvider implements AIProvider {
    private client: GoogleGenerativeAI;
    public name = 'Google';
    public models: AIModel[] = [
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

    private readonly DEFAULT_TIMEOUT = 30000; // 30 seconds
    private readonly SAFETY_SETTINGS = [
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

    constructor(apiKey: string) {
        if (!apiKey) {
            throw new Error('Google AI API key is required');
        }
        this.client = new GoogleGenerativeAI(apiKey);
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
        } catch (error: any) {
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