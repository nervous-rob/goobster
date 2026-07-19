const { OpenAI, toFile } = require('openai');
const aiConfig = require('../config/aiConfig');
const { buildNativeToolGuidance } = require('../utils/toolPromptBuilder');
const usageTracker = require('./usageTracker');

// Default sampling presets (only applied to models that accept sampling params)
const SAMPLING_PRESETS = {
    chat:      { temperature: 0.5, top_p: 0.9, max_tokens: 1024 },
    creative:  { temperature: 0.8, top_p: 0.95, max_tokens: 1024 },
    deterministic: { temperature: 0.2, top_p: 1,   max_tokens: 1024 },
    code:      { temperature: 0.2, top_p: 0.1, max_tokens: 1024 },
};

/**
 * Reasoning models (GPT-5 family, o-series) reject temperature/top_p and use
 * the reasoning.effort parameter instead.
 */
function isReasoningModel(model) {
    return /^(gpt-5|o\d)/i.test(model);
}

/**
 * OpenAI provider built on the Responses API (the modern primitive replacing
 * Chat Completions).
 *
 * Contract (shared by all providers):
 *   chat(messages, opts) -> { content: string, toolCalls: [{ id, name, arguments }] }
 *   generateText(prompt, opts) -> string
 *
 * Accepted message roles: 'system', 'user', 'assistant' (optionally carrying
 * a toolCalls array from a previous turn), and 'tool' results shaped as
 * { role: 'tool', toolCallId, name, content }.
 */
class OpenAIService {
    constructor() {
        // Optional integration: don't crash at startup when the key is absent
        // (e.g. self-hosted setups using Ollama).
        this.apiKey = aiConfig.openai.apiKey;
        if (this.apiKey) {
            this.client = new OpenAI({ apiKey: this.apiKey });
        } else {
            this.client = null;
            console.warn('[OpenAIService] API key not set; OpenAI calls will fail until provided.');
        }

        this.defaultModel = aiConfig.openai.chatModel;
        this.defaultReasoningEffort = null;
    }

    isConfigured() {
        return Boolean(this.client);
    }

    _requireClient() {
        if (!this.client) {
            throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY in your environment or openaiKey in config.json.');
        }
        return this.client;
    }

    /**
     * Update the default model used for all requests that do not explicitly
     * override the model, e.g. "gpt-5.6-luna" or "gpt-5.6-sol".
     */
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
     * Set a default reasoning effort ('low' | 'medium' | 'high' | null) applied
     * to reasoning-capable models when the caller doesn't specify one.
     */
    setDefaultReasoningEffort(effort) {
        this.defaultReasoningEffort = effort || null;
    }

    getDefaultReasoningEffort() {
        return this.defaultReasoningEffort;
    }

    /**
     * Convert OpenAI function definitions to Responses API tool format.
     */
    _toResponsesTools(functions) {
        return functions.map(fn => ({
            type: 'function',
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters
        }));
    }

    /**
     * Translate our provider-agnostic message array into Responses API input
     * items plus an instructions string (from system messages).
     */
    _toResponsesInput(messages, { withToolGuidance = false } = {}) {
        const systemParts = [];
        const input = [];

        for (const message of messages) {
            if (!message) continue;

            if (message.role === 'system') {
                systemParts.push(message.content);
            } else if (message.role === 'tool') {
                input.push({
                    type: 'function_call_output',
                    call_id: message.toolCallId,
                    output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
                });
            } else if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
                if (message.content) {
                    input.push({ role: 'assistant', content: message.content });
                }
                for (const call of message.toolCalls) {
                    input.push({
                        type: 'function_call',
                        call_id: call.id,
                        name: call.name,
                        arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)
                    });
                }
            } else if (message.role === 'user' && Array.isArray(message.images) && message.images.length > 0) {
                // Vision: mix text and image parts (OpenAI accepts public URLs)
                const parts = [];
                if (message.content) {
                    parts.push({ type: 'input_text', text: message.content });
                }
                for (const url of message.images.slice(0, 4)) {
                    parts.push({ type: 'input_image', image_url: url });
                }
                input.push({ role: 'user', content: parts });
            } else {
                input.push({ role: message.role, content: message.content });
            }
        }

        if (withToolGuidance) {
            systemParts.unshift(buildNativeToolGuidance());
        }

        return {
            instructions: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
            input
        };
    }

    _logUsage(response, model, usageContext = {}) {
        usageTracker.log({
            provider: 'openai',
            model,
            operation: 'chat',
            inputTokens: response.usage?.input_tokens || 0,
            outputTokens: response.usage?.output_tokens || 0,
            guildId: usageContext?.guildId,
            userId: usageContext?.userId
        });
    }

    /**
     * Extract the normalized { content, toolCalls } shape from a Responses
     * API response object.
     */
    _parseResponse(response) {
        const toolCalls = [];
        let content = '';

        for (const item of response.output || []) {
            if (item.type === 'function_call') {
                toolCalls.push({
                    id: item.call_id,
                    name: item.name,
                    arguments: item.arguments
                });
            } else if (item.type === 'message') {
                for (const part of item.content || []) {
                    if (part.type === 'output_text') {
                        content += part.text;
                    }
                }
            }
        }

        return { content, toolCalls };
    }

    /**
     * Chat completion via the Responses API.
     *
     * @param {Array|string} messages
     * @param {Object} opts
     * @param {string} [opts.preset] - SAMPLING_PRESETS key
     * @param {string} [opts.model]
     * @param {number} [opts.temperature]
     * @param {number} [opts.top_p]
     * @param {number} [opts.max_tokens]
     * @param {('minimal'|'low'|'medium'|'high')} [opts.reasoning_effort]
     * @param {Array} [opts.functions] - OpenAI-style function definitions
     * @param {boolean} [opts.webSearch] - enable the built-in web_search tool
     * @param {function(string):void} [opts.onDelta] - streaming text callback
     * @returns {Promise<{content: string, toolCalls: Array<{id: string, name: string, arguments: string}>}>}
     */
    async chat(messages, opts = {}) {
        const {
            preset,
            model,
            temperature,
            top_p,
            max_tokens,
            reasoning_effort,
            functions,
            webSearch,
            onDelta
        } = opts;

        const modelToUse = model || this.defaultModel;
        const presetDefaults = preset && SAMPLING_PRESETS[preset] ? SAMPLING_PRESETS[preset] : {};
        const messageArray = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages) }];

        const { instructions, input } = this._toResponsesInput(messageArray, {
            withToolGuidance: Boolean(functions && functions.length > 0)
        });

        const request = {
            model: modelToUse,
            input,
            // Responses API enforces a minimum of 16 output tokens
            max_output_tokens: Math.max(16, max_tokens ?? presetDefaults.max_tokens ?? 1024),
            store: false
        };
        if (instructions) {
            request.instructions = instructions;
        }

        const effort = reasoning_effort || this.defaultReasoningEffort;
        if (isReasoningModel(modelToUse)) {
            if (effort) {
                request.reasoning = { effort };
            }
            // Reasoning models reject temperature/top_p; omit them entirely.
        } else {
            request.temperature = temperature ?? presetDefaults.temperature ?? 0.7;
            request.top_p = top_p ?? presetDefaults.top_p ?? 1;
        }

        const tools = [];
        if (functions && functions.length > 0) {
            tools.push(...this._toResponsesTools(functions));
        }
        if (webSearch) {
            // Built-in tool: the model searches the web server-side mid-response
            tools.push({ type: 'web_search' });
        }
        if (tools.length > 0) {
            request.tools = tools;
        }

        try {
            const client = this._requireClient();

            if (typeof onDelta === 'function') {
                const stream = await client.responses.create({ ...request, stream: true });
                let finalResponse = null;
                for await (const event of stream) {
                    if (event.type === 'response.output_text.delta' && event.delta) {
                        onDelta(event.delta);
                    } else if (event.type === 'response.completed') {
                        finalResponse = event.response;
                    } else if (event.type === 'response.failed') {
                        throw new Error(event.response?.error?.message || 'OpenAI response failed');
                    }
                }
                if (!finalResponse) {
                    throw new Error('OpenAI stream ended without a completed response');
                }
                this._logUsage(finalResponse, modelToUse, opts.usageContext);
                return this._parseResponse(finalResponse);
            }

            const response = await this.client.responses.create(request);
            if (response.status === 'incomplete' && response.incomplete_details?.reason) {
                console.warn(`[OpenAIService] Response incomplete: ${response.incomplete_details.reason}`);
            }
            this._logUsage(response, modelToUse, opts.usageContext);
            return this._parseResponse(response);
        } catch (error) {
            console.error('OpenAI Responses API Error:', error.response?.data || error.message);
            throw new Error('Failed to complete chat request: ' + (error.response?.data?.error?.message || error.message), { cause: error });
        }
    }

    /**
     * Generate an image and return it as a PNG buffer. GPT Image models
     * return base64 data rather than URLs.
     * @param {string} prompt
     * @param {Object} options - model, size, quality ('low'|'medium'|'high'|'auto')
     * @returns {Promise<Buffer>}
     */
    async generateImage(prompt, options = {}) {
        const client = this._requireClient();
        const {
            model = aiConfig.openai.imageModel,
            size = '1024x1024',
            quality = 'medium'
        } = options;

        const response = await client.images.generate({ model, prompt, size, quality, n: 1 });
        const b64 = response.data?.[0]?.b64_json;
        if (!b64) {
            throw new Error('Invalid response format from OpenAI Images API');
        }
        usageTracker.log({
            provider: 'openai',
            model,
            operation: 'image',
            guildId: options.usageContext?.guildId,
            userId: options.usageContext?.userId
        });
        return Buffer.from(b64, 'base64');
    }

    /**
     * Edit/reimagine an image guided by a prompt (replaces the retired
     * DALL-E 2 variations endpoint for reference-based generation).
     * @param {Buffer} imageBuffer - source image (PNG)
     * @param {string} prompt
     * @param {Object} options - model, size
     * @returns {Promise<Buffer>}
     */
    async editImage(imageBuffer, prompt, options = {}) {
        const client = this._requireClient();
        const {
            model = aiConfig.openai.imageModel,
            size = '1024x1024'
        } = options;

        const image = await toFile(imageBuffer, 'reference.png', { type: 'image/png' });
        const response = await client.images.edit({ model, image, prompt, size });
        const b64 = response.data?.[0]?.b64_json;
        if (!b64) {
            throw new Error('Invalid response format from OpenAI Images API');
        }
        usageTracker.log({
            provider: 'openai',
            model,
            operation: 'image-edit',
            guildId: options.usageContext?.guildId,
            userId: options.usageContext?.userId
        });
        return Buffer.from(b64, 'base64');
    }

    /**
     * Generate text from a single prompt.
     * @param {string} prompt
     * @param {Object} options - temperature, max_tokens, model, includeCurrentDate, reasoning_effort
     * @returns {Promise<string>}
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
            throw new Error('Empty response from OpenAI API');
        }
        return content;
    }
}

module.exports = new OpenAIService();
