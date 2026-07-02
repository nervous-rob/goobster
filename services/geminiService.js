const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const aiConfig = require('../config/aiConfig');
const { buildNativeToolGuidance } = require('../utils/toolPromptBuilder');
const usageTracker = require('./usageTracker');

/**
 * Google Gemini provider using native function calling.
 *
 * Contract (shared by all providers):
 *   chat(messages, opts) -> { content: string, toolCalls: [{ id, name, arguments }] }
 *   generateText(prompt, opts) -> string
 */
class GeminiService {
    constructor() {
        this.apiKey = aiConfig.gemini.apiKey;
        this.defaultModel = aiConfig.gemini.model;
        this.ai = null;

        if (this.apiKey) {
            try {
                this.ai = new GoogleGenAI({ apiKey: this.apiKey });
            } catch (error) {
                console.error('[GeminiService] Failed to initialize GoogleGenAI:', error.message);
            }
        } else {
            console.warn('[GeminiService] Google AI key not set; Gemini calls will fail until provided.');
        }
    }

    isConfigured() {
        return Boolean(this.ai);
    }

    _requireClient() {
        if (!this.ai) {
            throw new Error('Gemini not configured. Set GEMINI_API_KEY in your environment or googleAIKey in config.json.');
        }
        return this.ai;
    }

    setDefaultModel(modelName) {
        if (typeof modelName !== 'string' || modelName.length === 0) {
            throw new Error('Model name must be a non-empty string');
        }
        this.defaultModel = modelName;
    }

    getDefaultModel() {
        return this.defaultModel;
    }

    /**
     * Convert OpenAI-style function definitions to Gemini function
     * declarations. parametersJsonSchema accepts standard JSON Schema.
     */
    _toFunctionDeclarations(functions) {
        return functions.map(fn => ({
            name: fn.name,
            description: fn.description,
            parametersJsonSchema: fn.parameters
        }));
    }

    /**
     * Download an image URL and convert it to a Gemini inlineData part.
     * Returns null (skipping the image) on any failure.
     */
    async _fetchImagePart(url) {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 15000,
                maxContentLength: 8 * 1024 * 1024
            });
            const mimeType = response.headers['content-type']?.split(';')[0] || 'image/png';
            if (!mimeType.startsWith('image/')) return null;
            return {
                inlineData: {
                    mimeType,
                    data: Buffer.from(response.data).toString('base64')
                }
            };
        } catch (error) {
            console.warn('[GeminiService] Failed to fetch image for vision:', error.message);
            return null;
        }
    }

    /**
     * Translate our provider-agnostic message array into Gemini contents plus
     * a systemInstruction string (Gemini takes system prompts out-of-band).
     */
    async _toGeminiRequest(messages, { withToolGuidance = false } = {}) {
        const systemParts = [];
        const contents = [];

        const messageArray = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages) }];

        for (const message of messageArray) {
            if (!message) continue;

            if (message.role === 'system') {
                systemParts.push(message.content);
            } else if (message.role === 'tool') {
                contents.push({
                    role: 'user',
                    parts: [{
                        functionResponse: {
                            name: message.name,
                            response: { result: message.content }
                        }
                    }]
                });
            } else if (message.role === 'assistant') {
                const parts = [];
                if (message.content) {
                    parts.push({ text: message.content });
                }
                if (Array.isArray(message.toolCalls)) {
                    for (const call of message.toolCalls) {
                        parts.push({
                            functionCall: {
                                name: call.name,
                                args: typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : (call.arguments || {})
                            }
                        });
                    }
                }
                if (parts.length > 0) {
                    contents.push({ role: 'model', parts });
                }
            } else {
                const parts = [];
                if (message.content) {
                    parts.push({ text: String(message.content) });
                }
                if (message.role === 'user' && Array.isArray(message.images)) {
                    for (const url of message.images.slice(0, 4)) {
                        const imagePart = await this._fetchImagePart(url);
                        if (imagePart) parts.push(imagePart);
                    }
                }
                if (parts.length > 0) {
                    contents.push({ role: 'user', parts });
                }
            }
        }

        if (withToolGuidance) {
            systemParts.unshift(buildNativeToolGuidance());
        }

        return {
            systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
            contents
        };
    }

    /**
     * Extract the normalized { content, toolCalls } shape from a Gemini
     * response. Gemini doesn't assign call IDs, so synthesize stable ones.
     */
    _parseResponse(response) {
        const candidate = response.candidates?.[0];
        if (!candidate) {
            if (response.promptFeedback?.blockReason) {
                throw new Error(`Response blocked by Gemini: ${response.promptFeedback.blockReason}`);
            }
            throw new Error('No candidates returned from Gemini API');
        }

        if (candidate.finishReason === 'SAFETY') {
            throw new Error('Response blocked by Gemini safety filters');
        }

        let content = '';
        const toolCalls = [];

        for (const part of candidate.content?.parts || []) {
            if (part.text) {
                content += part.text;
            }
            if (part.functionCall) {
                toolCalls.push({
                    id: `gemini_call_${toolCalls.length}_${Date.now()}`,
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args || {})
                });
            }
        }

        return { content, toolCalls };
    }

    /**
     * Chat completion with optional native function calling, Google Search
     * grounding, and streaming.
     *
     * @param {Array|string} messages
     * @param {Object} opts - temperature, top_p, max_tokens, model, functions, webSearch, onDelta
     * @returns {Promise<{content: string, toolCalls: Array}>}
     */
    async chat(messages, opts = {}) {
        const ai = this._requireClient();
        const { temperature = 0.7, top_p, max_tokens = 1024, model, functions, webSearch, onDelta } = opts;

        const hasTools = Boolean(functions && functions.length > 0);
        const { systemInstruction, contents } = await this._toGeminiRequest(messages, { withToolGuidance: hasTools });

        const config = {
            temperature,
            maxOutputTokens: max_tokens
        };
        if (top_p !== undefined) config.topP = top_p;
        if (systemInstruction) config.systemInstruction = systemInstruction;

        const tools = [];
        if (hasTools) {
            tools.push({ functionDeclarations: this._toFunctionDeclarations(functions) });
        }
        if (webSearch) {
            // Google Search grounding: the model searches server-side mid-response
            tools.push({ googleSearch: {} });
        }
        if (tools.length > 0) {
            config.tools = tools;
        }

        const request = {
            model: model || this.defaultModel,
            contents,
            config
        };

        try {
            if (typeof onDelta === 'function') {
                const stream = await ai.models.generateContentStream(request);
                let content = '';
                const toolCalls = [];
                let usageMetadata = null;
                for await (const chunk of stream) {
                    const parsed = this._parseChunk(chunk);
                    if (parsed.text) {
                        content += parsed.text;
                        onDelta(parsed.text);
                    }
                    toolCalls.push(...parsed.toolCalls);
                    if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
                }
                this._logUsage(usageMetadata, request.model, opts.usageContext);
                return { content, toolCalls };
            }

            const response = await ai.models.generateContent(request);
            this._logUsage(response.usageMetadata, request.model, opts.usageContext);
            return this._parseResponse(response);
        } catch (error) {
            console.error('Gemini API Error:', error.message);
            throw new Error('Failed to complete chat request: ' + error.message);
        }
    }

    _logUsage(usageMetadata, model, usageContext = {}) {
        usageTracker.log({
            provider: 'gemini',
            model,
            operation: 'chat',
            inputTokens: usageMetadata?.promptTokenCount || 0,
            outputTokens: usageMetadata?.candidatesTokenCount || 0,
            guildId: usageContext?.guildId,
            userId: usageContext?.userId
        });
    }

    /**
     * Extract text and tool calls from one streamed chunk.
     */
    _parseChunk(chunk) {
        let text = '';
        const toolCalls = [];
        for (const part of chunk.candidates?.[0]?.content?.parts || []) {
            if (part.text) text += part.text;
            if (part.functionCall) {
                toolCalls.push({
                    id: `gemini_call_${toolCalls.length}_${Date.now()}`,
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args || {})
                });
            }
        }
        return { text, toolCalls };
    }

    /**
     * Generate text from a single prompt (no multi-turn context).
     */
    async generateText(prompt, options = {}) {
        let finalPrompt = prompt;
        if (options.includeCurrentDate) {
            const now = new Date();
            const dateString = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            finalPrompt = `Current date and time: ${dateString}, ${now.toLocaleTimeString('en-US')}\n\n${prompt}`;
        }

        const { content } = await this.chat([{ role: 'user', content: finalPrompt }], options);
        if (!content) {
            throw new Error('Empty response from Gemini API');
        }
        return content;
    }
}

module.exports = new GeminiService();
