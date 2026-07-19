const aiConfig = require('../config/aiConfig');
const { buildNativeToolGuidance } = require('../utils/toolPromptBuilder');
const usageTracker = require('./usageTracker');

const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Models with always-on adaptive thinking (Claude Fable/Mythos 5 generation)
 * reject sampling parameters, like OpenAI's reasoning models.
 */
function isAdaptiveThinkingModel(model) {
    return /claude-(fable|mythos)/i.test(model);
}

/**
 * Anthropic Claude provider using the Messages API with native tool use.
 *
 * Contract (shared by all providers):
 *   chat(messages, opts) -> { content: string, toolCalls: [{ id, name, arguments }] }
 *   generateText(prompt, opts) -> string
 */
class AnthropicService {
    constructor() {
        this.apiKey = aiConfig.anthropic.apiKey;
        this.defaultModel = aiConfig.anthropic.model;
        this.baseUrl = ANTHROPIC_API_BASE_URL;

        if (!this.apiKey) {
            console.warn('[AnthropicService] Anthropic key not set; Claude calls will fail until provided.');
        }
    }

    isConfigured() {
        return Boolean(this.apiKey);
    }

    _requireApiKey() {
        if (!this.apiKey) {
            throw new Error('Anthropic not configured. Set ANTHROPIC_API_KEY in your environment or anthropicKey in config.json.');
        }
        return this.apiKey;
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
     * Convert OpenAI-style function definitions to Anthropic tool
     * definitions. input_schema accepts standard JSON Schema.
     */
    _toAnthropicTools(functions) {
        return functions.map(fn => ({
            name: fn.name,
            description: fn.description,
            input_schema: fn.parameters
        }));
    }

    /**
     * Translate our provider-agnostic message array into Anthropic messages
     * plus a system string (Claude takes system prompts out-of-band). The
     * API merges consecutive same-role messages itself, so tool results can
     * be emitted as standalone user messages.
     */
    _toAnthropicRequest(messages, { withToolGuidance = false } = {}) {
        const systemParts = [];
        const anthropicMessages = [];

        const messageArray = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages) }];

        for (const message of messageArray) {
            if (!message) continue;

            if (message.role === 'system') {
                systemParts.push(message.content);
            } else if (message.role === 'tool') {
                anthropicMessages.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: message.toolCallId,
                        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
                    }]
                });
            } else if (message.role === 'assistant') {
                const blocks = [];
                if (message.content) {
                    blocks.push({ type: 'text', text: message.content });
                }
                if (Array.isArray(message.toolCalls)) {
                    for (const call of message.toolCalls) {
                        blocks.push({
                            type: 'tool_use',
                            id: call.id,
                            name: call.name,
                            input: typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : (call.arguments || {})
                        });
                    }
                }
                if (blocks.length > 0) {
                    anthropicMessages.push({ role: 'assistant', content: blocks });
                }
            } else {
                const blocks = [];
                if (message.content) {
                    blocks.push({ type: 'text', text: String(message.content) });
                }
                if (message.role === 'user' && Array.isArray(message.images)) {
                    // Vision: Claude accepts public URLs directly
                    for (const url of message.images.slice(0, 4)) {
                        blocks.push({ type: 'image', source: { type: 'url', url } });
                    }
                }
                if (blocks.length > 0) {
                    anthropicMessages.push({ role: 'user', content: blocks });
                }
            }
        }

        if (withToolGuidance) {
            systemParts.unshift(buildNativeToolGuidance());
        }

        return {
            system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
            messages: anthropicMessages
        };
    }

    /**
     * Extract the normalized { content, toolCalls } shape from a Messages
     * API response. Server-tool blocks (web search) are skipped: only text
     * and custom tool_use blocks are ours to surface.
     */
    _parseResponse(response) {
        let content = '';
        const toolCalls = [];

        for (const block of response.content || []) {
            if (block.type === 'text') {
                content += block.text;
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                });
            }
        }

        return { content, toolCalls };
    }

    _buildRequestBody(request, { stream = false } = {}) {
        const body = {
            model: request.model,
            max_tokens: request.max_tokens,
            messages: request.messages
        };
        if (request.system) body.system = request.system;
        if (request.tools && request.tools.length > 0) body.tools = request.tools;
        if (request.temperature !== undefined) body.temperature = request.temperature;
        if (request.top_p !== undefined) body.top_p = request.top_p;
        if (stream) body.stream = true;
        return body;
    }

    async _postMessages(request, { stream = false } = {}) {
        const apiKey = this._requireApiKey();
        const response = await fetch(`${this.baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_VERSION
            },
            body: JSON.stringify(this._buildRequestBody(request, { stream }))
        });

        if (!response.ok) {
            const message = await this._readErrorMessage(response);
            throw new Error(`Anthropic API error ${response.status}: ${message}`);
        }

        return response;
    }

    async _readErrorMessage(response) {
        try {
            const body = await response.json();
            return body.error?.message || JSON.stringify(body);
        } catch (_error) {
            return response.statusText || 'Unknown error';
        }
    }

    async *_readSseJson(response) {
        const reader = response.body?.getReader?.();
        if (!reader) {
            throw new Error('Anthropic streaming response body is not readable');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            yield* this._drainSseBuffer(buffer, chunk => {
                buffer = chunk;
            });
        }

        buffer += decoder.decode();
        yield* this._drainSseBuffer(`${buffer}\n\n`, chunk => {
            buffer = chunk;
        });
    }

    *_drainSseBuffer(buffer, updateBuffer) {
        let separatorIndex;
        while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
            const event = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            const data = event
                .split('\n')
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trim())
                .join('');
            if (data && data !== '[DONE]') {
                yield JSON.parse(data);
            }
        }
        updateBuffer(buffer);
    }

    /**
     * Consume an Anthropic SSE stream, invoking onDelta for text chunks and
     * accumulating tool_use inputs (which arrive as partial JSON deltas).
     */
    async _consumeStream(response, onDelta) {
        let content = '';
        const toolCalls = [];
        // Index in the response content array -> pending tool call being built
        const pendingToolCalls = new Map();
        const usage = { inputTokens: 0, outputTokens: 0 };

        for await (const event of this._readSseJson(response)) {
            if (event.type === 'message_start') {
                usage.inputTokens = event.message?.usage?.input_tokens || 0;
            } else if (event.type === 'content_block_start') {
                if (event.content_block?.type === 'tool_use') {
                    pendingToolCalls.set(event.index, {
                        id: event.content_block.id,
                        name: event.content_block.name,
                        argumentsJson: ''
                    });
                }
            } else if (event.type === 'content_block_delta') {
                if (event.delta?.type === 'text_delta' && event.delta.text) {
                    content += event.delta.text;
                    onDelta(event.delta.text);
                } else if (event.delta?.type === 'input_json_delta' && pendingToolCalls.has(event.index)) {
                    pendingToolCalls.get(event.index).argumentsJson += event.delta.partial_json || '';
                }
            } else if (event.type === 'content_block_stop') {
                const pending = pendingToolCalls.get(event.index);
                if (pending) {
                    toolCalls.push({
                        id: pending.id,
                        name: pending.name,
                        arguments: pending.argumentsJson || '{}'
                    });
                    pendingToolCalls.delete(event.index);
                }
            } else if (event.type === 'message_delta') {
                if (event.usage?.output_tokens) usage.outputTokens = event.usage.output_tokens;
            } else if (event.type === 'error') {
                throw new Error(event.error?.message || 'Anthropic stream error');
            }
        }

        return { content, toolCalls, usage };
    }

    /**
     * Chat completion with optional native tool use, server-side web search,
     * and streaming.
     *
     * @param {Array|string} messages
     * @param {Object} opts - temperature, top_p, max_tokens, model, functions, webSearch, onDelta
     * @returns {Promise<{content: string, toolCalls: Array}>}
     */
    async chat(messages, opts = {}) {
        this._requireApiKey();
        const { temperature, top_p, max_tokens = 1024, model, functions, webSearch, onDelta } = opts;

        const modelToUse = model || this.defaultModel;
        const hasTools = Boolean(functions && functions.length > 0);
        const { system, messages: anthropicMessages } = this._toAnthropicRequest(messages, { withToolGuidance: hasTools });

        const tools = [];
        if (hasTools) {
            tools.push(...this._toAnthropicTools(functions));
        }
        if (webSearch) {
            // Server tool: Claude searches the web server-side mid-response
            tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
        }

        const request = {
            model: modelToUse,
            messages: anthropicMessages,
            system,
            max_tokens,
            tools
        };

        // Adaptive-thinking models reject sampling params; on newer Claude
        // models temperature and top_p are mutually exclusive, so prefer
        // temperature and only pass top_p when it's the sole override.
        if (!isAdaptiveThinkingModel(modelToUse)) {
            if (temperature !== undefined) {
                request.temperature = Math.min(1, temperature);
            } else if (top_p !== undefined) {
                request.top_p = top_p;
            } else {
                request.temperature = 0.7;
            }
        }

        try {
            if (typeof onDelta === 'function') {
                const response = await this._postMessages(request, { stream: true });
                const { content, toolCalls, usage } = await this._consumeStream(response, onDelta);
                this._logUsage(usage, modelToUse, opts.usageContext);
                return { content, toolCalls };
            }

            const httpResponse = await this._postMessages(request);
            const response = await httpResponse.json();
            this._logUsage({
                inputTokens: response.usage?.input_tokens || 0,
                outputTokens: response.usage?.output_tokens || 0
            }, modelToUse, opts.usageContext);
            return this._parseResponse(response);
        } catch (error) {
            console.error('Anthropic API Error:', error.message);
            throw new Error('Failed to complete chat request: ' + error.message, { cause: error });
        }
    }

    _logUsage(usage, model, usageContext = {}) {
        usageTracker.log({
            provider: 'anthropic',
            model,
            operation: 'chat',
            inputTokens: usage?.inputTokens || 0,
            outputTokens: usage?.outputTokens || 0,
            guildId: usageContext?.guildId,
            userId: usageContext?.userId
        });
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
            throw new Error('Empty response from Anthropic API');
        }
        return content;
    }
}

module.exports = new AnthropicService();
module.exports.AnthropicService = AnthropicService;
