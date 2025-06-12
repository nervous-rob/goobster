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
        
        try {
            const response = await this.ai.models.generateContent({
                model: GEMINI_MODEL_NAME,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { temperature, maxOutputTokens: max_tokens },
            });

            // Check if response has candidates
            if (!response.candidates?.[0]?.content?.parts?.[0]?.text) {
                throw new Error('Invalid response format from Gemini API');
            }

            // Return the text from the first candidate
            return response.candidates[0].content.parts[0].text;
        } catch (error) {
            console.error('Gemini API Error:', error);
            throw new Error('Failed to generate text: ' + error.message);
        }
    }

    /**
     * Chat completion analogue. Accepts messages array like OpenAI.
     */
    async chat(messages, options = {}) {
        if (!this.ai) throw new Error('Gemini service not initialized. Missing API key?');
        
        try {
            const { temperature = 0.7, max_tokens = 1024 } = options;
            
            // Convert messages to Gemini format
            const contents = this._messagesToContents(messages);
            
            const response = await this.ai.models.generateContent({
                model: GEMINI_MODEL_NAME,
                contents,
                generationConfig: { temperature, maxOutputTokens: max_tokens },
            });

            // Check if response has candidates
            if (!response.candidates?.[0]?.content?.parts?.[0]?.text) {
                throw new Error('Invalid response format from Gemini API');
            }

            // If function calling is requested, return a response object that matches OpenAI's format
            if (options.functions) {
                return {
                    choices: [{
                        message: {
                            content: response.candidates[0].content.parts[0].text,
                            function_call: null // Gemini doesn't support function calling yet
                        }
                    }]
                };
            }

            // Otherwise just return the text
            return response.candidates[0].content.parts[0].text;
        } catch (error) {
            console.error('Gemini API Error:', error);
            throw new Error('Failed to complete chat request: ' + error.message);
        }
    }
}

module.exports = new GeminiService(); 