export interface AIMessage {
    role: 'system' | 'user' | 'assistant' | 'model';
    content: string;
    name?: string;
}

export interface AIResponse {
    content: string;
    model: string;
    latency: number;
    tokens: {
        prompt: number;
        completion: number;
        total: number;
    };
}

export interface AIModel {
    id: string;
    name: string;
    description: string;
    provider: string;
    maxTokens: number;
    contextWindow: number;
    capabilities: string[];
}

export interface AIProvider {
    name: string;
    models: AIModel[];
    generateResponse(params: {
        model: string;
        messages: AIMessage[];
        temperature?: number;
        maxTokens?: number;
    }): Promise<AIResponse>;
    generateImage?(params: ImageGenerationParams): Promise<string>;
}

export interface AIServiceConfig {
    openaiKey?: string;
    anthropicKey?: string;
    googleAIKey?: string;
    perplexityKey?: string;
    defaultModel?: string;
    temperature?: number;
    maxTokens?: number;
    retryAttempts?: number;
    retryDelay?: number;
}

export interface ImageGenerationParams {
    model?: string;
    prompt: string;
    size?: '1024x1024' | '256x256' | '512x512' | '1792x1024' | '1024x1792';
    quality?: 'standard' | 'hd';
    style?: 'natural' | 'vivid';
}

export interface ImageVariationParams {
    model?: string;
    image: Buffer;
    n?: number;
    size?: '1024x1024' | '256x256' | '512x512';
} 