require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
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
            this.ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        }
    }

    /**
     * Simple helper to convert OpenAI-style message array to a single prompt string.
     */
    _messagesToContents(messages) {
        if (!Array.isArray(messages)) {
            return [{ role: 'user', parts: [{ text: String(messages) }] }];
        }
        return messages.map(m => {
            let role = m.role;
            if (role !== 'user') {
                // Gemini accepts 'model' instead of 'assistant' and disallows 'system'.
                role = 'model';
            }
            return { role, parts: [{ text: m.content }] };
        });
    }

    /**
     * Generate text from a prompt (no multi-turn context).
     */
    async generateText(prompt, options = {}) {
        if (!this.ai) throw new Error('Gemini service not initialized. Missing API key?');
        const { temperature = 0.7, max_tokens = 1024 } = options;
        const response = await this.ai.models.generateContent({
            model: GEMINI_MODEL_NAME,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature, maxOutputTokens: max_tokens },
        });
        const text = response.text;
        return text;
    }

    /**
     * Chat completion analogue. Accepts messages array like OpenAI.
     */
    async chat(messages, options = {}) {
        // Simpler: flatten conversation into plain text prompt
        const prompt = Array.isArray(messages)
            ? messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')
            : String(messages);
        return this.generateText(prompt, options);
    }
}

module.exports = new GeminiService(); 