require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config.json');

// Prefer env var over config.json
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || config.googleAIKey;

if (!GEMINI_API_KEY) {
    console.warn('[GeminiService] Google AI key not set; calls will fail until provided.');
}

// Target model referenced by the user
const GEMINI_MODEL_NAME = 'gemini-2.5-pro-preview-06-05';

class GeminiService {
    constructor() {
        if (GEMINI_API_KEY) {
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            this.model = genAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
        }
    }

    /**
     * Simple helper to convert OpenAI-style message array to a single prompt string.
     */
    _messagesToPrompt(messages) {
        if (!Array.isArray(messages)) {
            return String(messages);
        }
        return messages
            .map(m => `${m.role.toUpperCase()}: ${m.content}`)
            .join('\n');
    }

    /**
     * Generate text from a prompt (no multi-turn context).
     */
    async generateText(prompt, options = {}) {
        if (!this.model) throw new Error('Gemini model not initialized. Missing API key?');
        const { temperature = 0.7, max_tokens = 1024 } = options;
        const result = await this.model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature, maxOutputTokens: max_tokens }
        });
        return result.response.text();
    }

    /**
     * Chat completion analogue. Accepts messages array like OpenAI.
     */
    async chat(messages, options = {}) {
        if (!this.model) throw new Error('Gemini model not initialized. Missing API key?');
        const prompt = this._messagesToPrompt(messages);
        return this.generateText(prompt, options);
    }
}

module.exports = new GeminiService(); 