import { GenerateContentResult } from '@google/generative-ai';

export interface ModelConfig {
    provider: string;
    model_name: string;
    api_version: string;
    max_tokens: number;
    temperature: number;
    capabilities: string[];
    rate_limit: number;
    is_active: boolean;
    priority: number;
}

export interface ModelResponse {
    content: string;
    metadata: {
        model: string;
        provider: string;
        usage: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
        };
        finishReason: string | null;
        safetyRatings: any[];
        candidates: number;
        citationMetadata: any | null;
    };
}

export interface GenerateOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    topK?: number;
    topP?: number;
    requireLowLatency?: boolean;
    requireHighPerformance?: boolean;
    requireEfficiency?: boolean;
    safetySettings?: any;
    requirements?: {
        minTokens?: number;
        maxLatency?: number;
        minReliability?: number;
    };
}

export interface PersonalitySettings {
    energy: 'low' | 'medium' | 'high' | 'absolute_zero';
    humor: 'low' | 'medium' | 'high' | 'very_high' | 'absolute_zero';
    formality: 'low' | 'medium' | 'high' | 'absolute_zero';
    traits?: string[];
    source?: string;
}

export interface ConversationAnalysis {
    sentiment: {
        dominant: string;
        emotions: Array<{ emotion: string; intensity: number }>;
        progression: string;
    };
    style: {
        dominant: string;
        confidence: number;
        scores: Record<string, number>;
    };
    energy: {
        level: string;
        confidence: number;
        scores: Record<string, number>;
    };
    context: {
        topics: string[];
        messageCount: number;
        averageLength: number;
        timeSpan: number;
    };
}

export class ModelManager {
    initialize(): Promise<void>;
    generateResponse(params: {
        prompt: string | Array<{ role: string; content: string }>;
        capability?: string;
        options?: GenerateOptions;
    }): Promise<ModelResponse>;
    getRateLimitStatus(): Record<string, {
        isLimited: boolean;
        currentRequests: number;
        currentTokens: number;
        maxRequestsPerMinute: number;
        maxTokensPerMinute: number;
        timeUntilReset: number;
    }>;
}

export class PersonalityAdapter {
    getUserPersonality(userId: string): Promise<PersonalitySettings>;
    enhancePrompt(basePrompt: string, userId: string, recentMessages?: any[]): Promise<{
        prompt: string;
        personality: PersonalitySettings & {
            directive: string;
            analysis: ConversationAnalysis | null;
        };
        modelInfo: { model: string } | null;
    }>;
    analyzeConversation(messages: any[], userId: string): Promise<ConversationAnalysis>;
}

export class PromptManager {
    buildPrompt(input: string, options?: {
        system?: string;
        user?: string;
        assistant?: string;
        personality?: string;
        userId?: string;
    }): Promise<{
        system: string;
        user: string;
        assistant: string | null;
    }>;
    getPrompt(userId: string, model?: string): Promise<string>;
    getEnhancedPrompt(userId: string, model?: string, recentMessages?: any[]): Promise<{
        prompt: string;
        personality: PersonalitySettings;
    }>;
}

export namespace providers {
    export class BaseProvider {
        initialize(): Promise<void>;
        generateResponse(params: {
            prompt: string | Array<{ role: string; content: string }>;
            options?: GenerateOptions;
        }): Promise<ModelResponse>;
        supportsCapability(capability: string): boolean;
        getRateLimits(): {
            requestsPerMinute: number;
            tokensPerMinute: number;
            provider: string;
        };
    }

    export class GoogleAIProvider extends BaseProvider {
        supportedModels: Record<string, {
            capabilities: string[];
            maxTokens: number;
            temperature: number;
        }>;
    }

    export class OpenAIProvider extends BaseProvider {}
    export class AnthropicProvider extends BaseProvider {}
}

export const constants: {
    DEFAULT_MODEL: 'gemini-2.0-pro';
    FALLBACK_MODEL: 'gemini-2.0-flash';
    EFFICIENT_MODEL: 'gemini-2.0-flash-lite';
}; 