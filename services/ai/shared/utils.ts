import { AIMessage, AIResponse } from '../types';

export function calculateTokens(messages: AIMessage[]): number {
    // Rough estimation of tokens (can be improved with actual tokenizers)
    return messages.reduce((total, msg) => {
        return total + Math.ceil(msg.content.length / 4);
    }, 0);
}

export function formatResponse(
    content: string,
    model: string,
    latency: number,
    tokens: { prompt: number; completion: number; total: number }
): AIResponse {
    return {
        content,
        model,
        latency,
        tokens
    };
}

export function validateMessages(messages: AIMessage[]): void {
    if (!Array.isArray(messages)) {
        throw new Error('Messages must be an array');
    }
    
    if (messages.length === 0) {
        throw new Error('Messages array cannot be empty');
    }
    
    messages.forEach((msg, index) => {
        if (!msg.role || !msg.content) {
            throw new Error(`Invalid message at index ${index}: missing role or content`);
        }
        
        if (!['system', 'user', 'assistant', 'model'].includes(msg.role)) {
            throw new Error(`Invalid role "${msg.role}" at index ${index}`);
        }
    });
}

export function truncateMessages(messages: AIMessage[], maxTokens: number): AIMessage[] {
    let totalTokens = 0;
    const truncated: AIMessage[] = [];
    
    // Always keep system messages
    const systemMessages = messages.filter(msg => msg.role === 'system');
    truncated.push(...systemMessages);
    
    // Add other messages until we hit the token limit
    for (const msg of messages.filter(msg => msg.role !== 'system')) {
        const msgTokens = Math.ceil(msg.content.length / 4);
        if (totalTokens + msgTokens > maxTokens) {
            break;
        }
        truncated.push(msg);
        totalTokens += msgTokens;
    }
    
    return truncated;
} 