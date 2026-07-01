require('dotenv').config();
const axios = require('axios');

let config = {};
try {
    config = require('../config.json');
} catch {
    // config.json optional at load time
}

/**
 * Ollama service - local LLM provider.
 *
 * Runs against a local (or LAN) Ollama server, letting the bot chat with no
 * cloud dependency at all. On a Raspberry Pi 4B (4GB+), small quantized
 * models such as llama3.2:3b, phi3:mini or qwen2.5:3b work well; the Ollama
 * host can also point at a beefier machine on the network.
 *
 * Configuration (config.json takes precedence over environment):
 *   config.ollama.host   / OLLAMA_HOST   - default http://127.0.0.1:11434
 *   config.ollama.model  / OLLAMA_MODEL  - default llama3.2:3b
 */
class OllamaService {
    constructor() {
        this.host = (config.ollama?.host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
        this.defaultModel = config.ollama?.model || process.env.OLLAMA_MODEL || 'llama3.2:3b';
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
     * Normalize an OpenAI-style message array for the Ollama chat API.
     * Ollama accepts the same {role, content} shape, including 'system'.
     * @param {Array|string} messages
     * @returns {Array<{role: string, content: string}>}
     */
    _normalizeMessages(messages) {
        if (!Array.isArray(messages)) {
            return [{ role: 'user', content: String(messages) }];
        }
        return messages
            .filter(m => m && typeof m.content === 'string')
            .map(m => ({
                role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user',
                content: m.content
            }));
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
        return this.chat([{ role: 'user', content: finalPrompt }], options);
    }

    /**
     * Chat completion. Returns the assistant's reply text.
     * @param {Array|string} messages
     * @param {Object} opts - temperature, top_p, max_tokens, model
     * @returns {Promise<string>}
     */
    async chat(messages, opts = {}) {
        const model = opts.model || this.defaultModel;

        try {
            const response = await axios.post(
                `${this.host}/api/chat`,
                {
                    model,
                    messages: this._normalizeMessages(messages),
                    stream: false,
                    options: {
                        temperature: opts.temperature ?? 0.7,
                        top_p: opts.top_p ?? 0.9,
                        num_predict: opts.max_tokens ?? 1024
                    }
                },
                { timeout: opts.timeout ?? 300000 } // local inference can be slow on a Pi
            );

            const content = response.data?.message?.content;
            if (!content) {
                throw new Error('Invalid response format from Ollama API');
            }
            return content;
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
}

module.exports = new OllamaService();
