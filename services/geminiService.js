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
            try {
                this.ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
            } catch (error) {
                console.error('[GeminiService] Failed to initialize GoogleGenAI:', error.message);
                this.ai = null;
            }
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
     * Enhanced tool integration for Gemini through prompt engineering
     */
    _buildToolAwarePrompt(messages, functions = []) {
        if (!functions || functions.length === 0) {
            return this._messagesToContents(messages);
        }

        // Build tool documentation for the prompt
        const toolDocs = functions.map(fn => {
            const { name, description, parameters } = fn;
            const params = parameters?.properties ? 
                Object.entries(parameters.properties)
                    .map(([key, prop]) => `  - ${key}: ${prop.type || 'any'}${prop.description ? ` (${prop.description})` : ''}`)
                    .join('\n') : 'No parameters';
            
            return `**${name}**: ${description || 'No description available'}
Parameters:
${params}`;
        }).join('\n\n');

        // Create enhanced system message with tool capabilities
        const toolSystemMessage = `You have access to the following tools. When you need to use a tool, respond with a JSON object in this exact format:

\`\`\`json
{
  "tool_call": {
    "name": "tool_name",
    "arguments": {
      "param1": "value1",
      "param2": "value2"
    }
  }
}
\`\`\`

Available tools:
${toolDocs}

If you don't need to use any tools, respond normally with text.`;

        // Inject tool system message at the beginning
        const enhancedMessages = [
            { role: 'user', content: toolSystemMessage },
            ...messages
        ];

        return this._messagesToContents(enhancedMessages);
    }

    /**
     * Parse Gemini response for tool calls
     */
    _parseToolCall(responseText) {
        try {
            // Look for JSON blocks in the response (more flexible pattern)
            const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
            if (!jsonMatch) {
                // Also try to find JSON without code blocks
                const directJsonMatch = responseText.match(/\{[\s\S]*?tool_call[\s\S]*?\}/);
                if (!directJsonMatch) return null;
                
                const parsed = JSON.parse(directJsonMatch[0]);
                if (parsed.tool_call && parsed.tool_call.name && parsed.tool_call.arguments) {
                    return {
                        name: parsed.tool_call.name,
                        arguments: parsed.tool_call.arguments
                    };
                }
                return null;
            }

            const parsed = JSON.parse(jsonMatch[1]);
            if (parsed.tool_call && parsed.tool_call.name && parsed.tool_call.arguments) {
                return {
                    name: parsed.tool_call.name,
                    arguments: parsed.tool_call.arguments
                };
            }
        } catch (error) {
            console.warn('Failed to parse tool call from Gemini response:', error.message);
            console.warn('Response preview:', responseText.substring(0, 200) + '...');
        }
        return null;
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
     * Enhanced chat completion with tool support for Gemini
     */
    async chat(messages, options = {}) {
        if (!this.ai) throw new Error('Gemini service not initialized. Missing API key?');
        
        try {
            const { temperature = 0.7, max_tokens = 1024, functions } = options;
            
            // Use enhanced prompt if functions are provided
            const contents = functions ? 
                this._buildToolAwarePrompt(messages, functions) : 
                this._messagesToContents(messages);
            
            const response = await this.ai.models.generateContent({
                model: GEMINI_MODEL_NAME,
                contents,
                generationConfig: { temperature, maxOutputTokens: max_tokens },
            });

            // Check if response has candidates
            if (!response.candidates?.[0]?.content?.parts?.[0]?.text) {
                throw new Error('Invalid response format from Gemini API');
            }

            const responseText = response.candidates[0].content.parts[0].text;

            // If function calling is requested, check for tool calls in the response
            if (functions) {
                const toolCall = this._parseToolCall(responseText);
                
                if (toolCall) {
                    // Return OpenAI-compatible format with function call
                    return {
                        choices: [{
                            message: {
                                content: responseText,
                                function_call: {
                                    name: toolCall.name,
                                    arguments: JSON.stringify(toolCall.arguments)
                                }
                            },
                            finish_reason: 'function_call'
                        }]
                    };
                } else {
                    // Return OpenAI-compatible format without function call
                    return {
                        choices: [{
                            message: {
                                content: responseText,
                                function_call: null
                            },
                            finish_reason: 'stop'
                        }]
                    };
                }
            }

            // Otherwise just return the text
            return responseText;
        } catch (error) {
            console.error('Gemini API Error:', error);
            throw new Error('Failed to complete chat request: ' + error.message);
        }
    }
}

module.exports = new GeminiService(); 