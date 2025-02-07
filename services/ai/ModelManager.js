const { sql, getConnection } = require('../../azureDb');
const config = require('../../config.json');
const { OpenAI } = require('openai');
const { Anthropic } = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const promptManager = require('./PromptManager');

class APIError extends Error {
    constructor(message, code, statusCode = 500) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}

class ModelManager {
    constructor() {
        this.API_VERSION = 'v1';
        
        // Initialize provider clients with proper configuration
        this.providers = {
            openai: new OpenAI({ 
                apiKey: config.openaiKey 
            }),
            anthropic: new Anthropic({ 
                apiKey: config.anthropicKey,
                maxRetries: 3 // Add retries for reliability
            }),
            google: new GoogleGenerativeAI(config.googleAiKey)
        };
        
        // Cache for model configs
        this.modelConfigCache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
        this.lastCacheUpdate = 0;

        // Rate limiting cache
        this.rateLimitCache = new Map();
    }

    async refreshCache() {
        const now = Date.now();
        if (now - this.lastCacheUpdate < this.cacheTimeout) return;

        const db = await getConnection();
        const result = await db.query`
            SELECT id, provider, model_name, max_tokens, temperature, capabilities, 
                   priority, rate_limit, api_version
            FROM model_configs
            WHERE is_active = 1
            ORDER BY priority ASC
        `;

        this.modelConfigCache.clear();
        for (const model of result.recordset) {
            this.modelConfigCache.set(model.id, {
                ...model,
                capabilities: JSON.parse(model.capabilities)
            });
        }

        this.lastCacheUpdate = now;
    }

    async checkRateLimit(userId, modelId) {
        const model = this.modelConfigCache.get(modelId);
        if (!model) throw new APIError('Model not found', 'MODEL_NOT_FOUND', 404);

        const key = `${userId}:${modelId}`;
        const now = Date.now();
        const minute = 60 * 1000;

        // Clean up old entries
        for (const [k, v] of this.rateLimitCache.entries()) {
            if (now - v.timestamp > minute) {
                this.rateLimitCache.delete(k);
            }
        }

        // Check current rate
        const current = this.rateLimitCache.get(key) || { count: 0, timestamp: now };
        if (now - current.timestamp > minute) {
            current.count = 1;
            current.timestamp = now;
        } else if (current.count >= model.rate_limit) {
            throw new APIError('Rate limit exceeded', 'RATE_LIMIT_EXCEEDED', 429);
        } else {
            current.count++;
        }

        this.rateLimitCache.set(key, current);
        return true;
    }

    async getModelForCapability(capability, userId = null) {
        await this.refreshCache();
        
        // Check user preference first
        if (userId) {
            const db = await getConnection();
            const prefResult = await db.query`
                SELECT mc.*
                FROM model_configs mc
                JOIN UserPreferences up ON up.preferred_model_id = mc.id
                WHERE up.userId = ${userId}
                AND mc.is_active = 1
                AND mc.api_version = ${this.API_VERSION}
            `;
            
            if (prefResult.recordset.length > 0) {
                const model = prefResult.recordset[0];
                const capabilities = JSON.parse(model.capabilities);
                if (capabilities.includes(capability)) {
                    return model;
                }
            }
        }

        // Find first available model with capability
        for (const [_, model] of this.modelConfigCache) {
            if (model.capabilities.includes(capability) && model.api_version === this.API_VERSION) {
                return model;
            }
        }

        throw new APIError(`No model available for capability: ${capability}`, 'CAPABILITY_NOT_FOUND', 404);
    }

    generateRequestId() {
        return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    async generateResponse(prompt, capability, userId = null) {
        const requestId = this.generateRequestId();
        const model = await this.getModelForCapability(capability, userId);
        
        // Check rate limit
        await this.checkRateLimit(userId, model.id);

        const startTime = Date.now();
        let success = true;
        let errorMessage = null;
        let errorCode = null;
        let response = null;

        try {
            // Get the system prompt using the PromptManager
            const systemPrompt = await promptManager.getPrompt(userId, model);
            
            // Prepare messages array with system prompt
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
            ];

            switch (model.provider) {
                case 'openai':
                    response = await this.providers.openai.chat.completions.create({
                        model: model.model_name,
                        messages: messages,
                        max_tokens: model.max_tokens,
                        temperature: model.temperature
                    });
                    break;

                case 'anthropic':
                    response = await this.providers.anthropic.messages.create({
                        model: model.model_name,
                        max_tokens: model.max_tokens,
                        temperature: model.temperature,
                        system: systemPrompt,
                        messages: [{ role: 'user', content: prompt }]
                    });
                    break;

                case 'google':
                    const genAI = this.providers.google;
                    const geminiModel = genAI.getGenerativeModel({
                        model: model.model_name,
                        generationConfig: {
                            temperature: model.temperature,
                            maxOutputTokens: model.max_tokens,
                            topP: 0.8,
                            topK: 40
                        },
                        safetySettings: [
                            {
                                category: "HARM_CATEGORY_HARASSMENT",
                                threshold: "BLOCK_MEDIUM_AND_ABOVE",
                            },
                            {
                                category: "HARM_CATEGORY_HATE_SPEECH",
                                threshold: "BLOCK_MEDIUM_AND_ABOVE",
                            },
                            {
                                category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                                threshold: "BLOCK_MEDIUM_AND_ABOVE",
                            },
                            {
                                category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                                threshold: "BLOCK_MEDIUM_AND_ABOVE",
                            },
                        ],
                    });

                    // For Google, we need to combine system prompt and user message
                    const combinedPrompt = `${systemPrompt}\n\nUser: ${prompt}`;
                    const result = await geminiModel.generateContent({
                        contents: [{ role: 'user', content: combinedPrompt }]
                    });
                    
                    if (!result.response) {
                        throw new APIError('Failed to generate response from Google AI', 'GOOGLE_AI_ERROR', 500);
                    }
                    
                    response = result.response;
                    break;

                default:
                    throw new APIError(`Unsupported provider: ${model.provider}`, 'PROVIDER_NOT_SUPPORTED', 400);
            }
        } catch (error) {
            success = false;
            errorMessage = error.message;
            errorCode = error.code || 'INTERNAL_ERROR';

            // Enhanced error handling for specific provider errors
            if (error.name === 'AnthropicError') {
                errorCode = 'ANTHROPIC_API_ERROR';
            } else if (error.name === 'GoogleGenerativeAIError') {
                errorCode = 'GOOGLE_AI_ERROR';
            }

            throw error;
        } finally {
            // Log response metrics
            const db = await getConnection();
            await db.query`
                INSERT INTO model_responses (
                    model_config_id,
                    request_id,
                    api_version,
                    user_id,
                    message_id,
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    latency_ms,
                    success,
                    error_message,
                    error_code
                )
                VALUES (
                    ${model.id},
                    ${requestId},
                    ${this.API_VERSION},
                    ${userId},
                    ${response?.id || null},
                    ${response?.usage?.prompt_tokens || 0},
                    ${response?.usage?.completion_tokens || 0},
                    ${response?.usage?.total_tokens || 0},
                    ${Date.now() - startTime},
                    ${success},
                    ${errorMessage},
                    ${errorCode}
                )
            `;
        }

        return {
            requestId,
            apiVersion: this.API_VERSION,
            content: this.normalizeResponse(response, model.provider),
            model: {
                provider: model.provider,
                name: model.model_name
            },
            usage: {
                promptTokens: response?.usage?.prompt_tokens || 0,
                completionTokens: response?.usage?.completion_tokens || 0,
                totalTokens: response?.usage?.total_tokens || 0,
                latencyMs: Date.now() - startTime
            }
        };
    }

    async generateBatchResponses(prompts, capability, userId = null) {
        if (!Array.isArray(prompts)) {
            throw new APIError('Prompts must be an array', 'INVALID_INPUT', 400);
        }
        
        if (prompts.length > 10) {
            throw new APIError('Batch size cannot exceed 10 prompts', 'BATCH_TOO_LARGE', 400);
        }

        return Promise.all(prompts.map(prompt => 
            this.generateResponse(prompt, capability, userId)
        ));
    }

    normalizeResponse(response, provider) {
        try {
            switch (provider) {
                case 'openai':
                    return response.choices[0].message.content;
                case 'anthropic':
                    return response.content[0].text;
                case 'google':
                    // Updated to handle Google's response format correctly
                    if (!response.text) {
                        throw new APIError('Invalid response format from Google AI', 'GOOGLE_AI_ERROR', 500);
                    }
                    return response.text();
                default:
                    throw new APIError(`Unsupported provider: ${provider}`, 'PROVIDER_NOT_SUPPORTED', 400);
            }
        } catch (error) {
            throw new APIError('Failed to normalize response: ' + error.message, 'NORMALIZATION_ERROR', 500);
        }
    }
}

module.exports = new ModelManager(); 