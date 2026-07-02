const axios = require('axios');
const aiConfig = require('../config/aiConfig');
const { buildPromptBasedToolPrompt, parseToolCall } = require('../utils/toolPromptBuilder');

/**
 * Ollama service - local LLM provider.
 *
 * Runs against a local (or LAN) Ollama server, letting the bot chat with no
 * cloud dependency at all. On a Raspberry Pi 4B (4GB+), small quantized
 * models such as llama3.2:3b, phi3:mini or qwen2.5:3b work well; the Ollama
 * host can also point at a beefier machine on the network.
 *
 * Tool support is prompt-based: tool schemas are injected as a system prompt
 * and JSON tool calls are parsed out of the model's text response, so tools
 * work even with models that lack native function calling.
 *
 * Contract (shared by all providers):
 *   chat(messages, opts) -> { content: string, toolCalls: [{ id, name, arguments }] }
 *   generateText(prompt, opts) -> string
 *
 * Configuration (environment takes precedence over config.json):
 *   OLLAMA_HOST  / config.ollama.host   - default http://127.0.0.1:11434
 *   OLLAMA_MODEL / config.ollama.model  - default llama3.2:3b
 */
class OllamaService {
    constructor() {
        this.host = aiConfig.ollama.host;
        this.defaultModel = aiConfig.ollama.model;
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
     * Check whether the Ollama server is reachable.
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        try {
            await axios.get(`${this.host}/api/tags`, { timeout: 3000 });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Normalize a provider-agnostic message array for the Ollama chat API.
     * Tool results become user messages; assistant tool calls are replayed
     * as assistant text so the model retains conversational context.
     * @param {Array|string} messages
     * @returns {Array<{role: string, content: string}>}
     */
    _normalizeMessages(messages) {
        if (!Array.isArray(messages)) {
            return [{ role: 'user', content: String(messages) }];
        }
        const normalized = [];
        for (const m of messages) {
            if (!m) continue;
            if (m.role === 'tool') {
                normalized.push({
                    role: 'user',
                    content: `Tool "${m.name}" returned: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
                });
            } else if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
                const calls = m.toolCalls.map(c => `${c.name}(${typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments)})`).join(', ');
                normalized.push({
                    role: 'assistant',
                    content: m.content ? `${m.content}\n[Called tools: ${calls}]` : `[Called tools: ${calls}]`
                });
            } else if (typeof m.content === 'string') {
                normalized.push({
                    role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user',
                    content: m.content
                });
            }
        }
        return normalized;
    }

    /**
     * Generate text from a single prompt.
     * @param {string} prompt
     * @param {Object} options - temperature, max_tokens, model, includeCurrentDate
     * @returns {Promise<string>}
     */
    async generateText(prompt, options = {}) {
        let finalPrompt = prompt;
        if (options.includeCurrentDate) {
            const now = new Date();
            finalPrompt = `Current date and time: ${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}, ${now.toLocaleTimeString('en-US')}\n\n${prompt}`;
        }
        const { content } = await this.chat([{ role: 'user', content: finalPrompt }], options);
        return content;
    }

    /**
     * Chat completion with optional prompt-based tool support and streaming.
     * @param {Array|string} messages
     * @param {Object} opts - temperature, top_p, max_tokens, model, functions, onDelta
     * @returns {Promise<{content: string, toolCalls: Array}>}
     */
    async chat(messages, opts = {}) {
        const model = opts.model || this.defaultModel;
        const hasTools = Boolean(opts.functions && opts.functions.length > 0);

        let finalMessages = this._normalizeMessages(messages);
        if (hasTools) {
            finalMessages = [
                { role: 'system', content: buildPromptBasedToolPrompt(opts.functions) },
                ...finalMessages
            ];
        }

        const useStreaming = typeof opts.onDelta === 'function' && !hasTools;

        try {
            const requestBody = {
                model,
                messages: finalMessages,
                stream: useStreaming,
                options: {
                    temperature: opts.temperature ?? 0.7,
                    top_p: opts.top_p ?? 0.9,
                    num_predict: opts.max_tokens ?? 1024
                }
            };
            const requestConfig = { timeout: opts.timeout ?? 300000 }; // local inference can be slow on a Pi

            let content;
            if (useStreaming) {
                content = await this._streamChat(requestBody, requestConfig, opts.onDelta);
            } else {
                const response = await axios.post(`${this.host}/api/chat`, requestBody, requestConfig);
                content = response.data?.message?.content;
            }

            if (!content) {
                throw new Error('Invalid response format from Ollama API');
            }

            // Parse prompt-based tool calls out of the text response
            if (hasTools) {
                const toolCall = parseToolCall(content);
                if (toolCall) {
                    return {
                        content: '',
                        toolCalls: [{
                            id: `ollama_call_${Date.now()}`,
                            name: toolCall.name,
                            arguments: JSON.stringify(toolCall.arguments || {})
                        }]
                    };
                }
            }

            return { content, toolCalls: [] };
        } catch (error) {
            if (error.code === 'ECONNREFUSED') {
                throw new Error(`Ollama server not reachable at ${this.host}. Is Ollama running? (https://ollama.com)`);
            }
            if (error.response?.status === 404) {
                throw new Error(`Model '${model}' not found on the Ollama server. Pull it first: ollama pull ${model}`);
            }
            console.error('Ollama API Error:', error.response?.data || error.message);
            throw new Error('Failed to complete Ollama chat request: ' + (error.response?.data?.error || error.message));
        }
    }

    /**
     * Stream an Ollama chat response, invoking onDelta per token chunk.
     * Ollama streams newline-delimited JSON objects.
     */
    async _streamChat(requestBody, requestConfig, onDelta) {
        const response = await axios.post(`${this.host}/api/chat`, requestBody, {
            ...requestConfig,
            responseType: 'stream'
        });

        return await new Promise((resolve, reject) => {
            let content = '';
            let buffer = '';

            response.data.on('data', (chunk) => {
                buffer += chunk.toString();
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIndex).trim();
                    buffer = buffer.slice(newlineIndex + 1);
                    if (!line) continue;
                    try {
                        const parsed = JSON.parse(line);
                        const delta = parsed.message?.content;
                        if (delta) {
                            content += delta;
                            onDelta(delta);
                        }
                    } catch {
                        // Ignore malformed stream lines
                    }
                }
            });
            response.data.on('end', () => resolve(content));
            response.data.on('error', reject);
        });
    }
}

module.exports = new OllamaService();
