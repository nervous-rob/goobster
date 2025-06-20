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
        const toolSystemMessage = `You are an AI assistant with access to powerful tools. When a user asks you to perform an action that matches one of your available tools, you MUST use the tool instead of just describing what you would do.

**IMPORTANT**: If the user asks you to:
- Search for information → use performSearch
- Generate an image → use generateImage  
- Play music → use playTrack
- Set a nickname → use setNickname
- Speak text → use speakMessage
- Create/query/update Azure DevOps work items → use the appropriate DevOps tool
- Execute multiple actions → use executePlan

When you need to use a tool, respond with ONLY a JSON object in this exact format:

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

**Examples:**
- User: "Create a bug work item called 'Login broken'" → Use createDevOpsWorkItem
- User: "Search for Node.js tutorials" → Use performSearch  
- User: "Generate a picture of a cat" → Use generateImage
- User: "Play some music" → Use playTrack

Available tools:
${toolDocs}

If the user's request doesn't match any available tools, respond normally with text.`;

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
                // Also try to find JSON without code blocks - more aggressive search
                const directJsonPatterns = [
                    /\{[\s\S]*?"tool_call"[\s\S]*?\}/g,
                    /\{[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?\}/g
                ];
                
                for (const pattern of directJsonPatterns) {
                    const matches = responseText.match(pattern);
                    if (matches) {
                        for (const match of matches) {
                            try {
                                const parsed = JSON.parse(match);
                                if (parsed.tool_call && parsed.tool_call.name && parsed.tool_call.arguments) {
                                    console.log('Successfully parsed tool call from direct JSON:', parsed.tool_call.name);
                                    return {
                                        name: parsed.tool_call.name,
                                        arguments: parsed.tool_call.arguments
                                    };
                                }
                                // Also check for direct function call format
                                if (parsed.name && parsed.arguments) {
                                    console.log('Successfully parsed direct function call:', parsed.name);
                                    return {
                                        name: parsed.name,
                                        arguments: parsed.arguments
                                    };
                                }
                            } catch (parseError) {
                                // Continue to next match
                                continue;
                            }
                        }
                    }
                }
                
                console.log('No tool call patterns found in response:', responseText.substring(0, 200) + '...');
                return null;
            }

            const parsed = JSON.parse(jsonMatch[1]);
            if (parsed.tool_call && parsed.tool_call.name && parsed.tool_call.arguments) {
                console.log('Successfully parsed tool call from code block:', parsed.tool_call.name);
                return {
                    name: parsed.tool_call.name,
                    arguments: parsed.tool_call.arguments
                };
            }
            
            // Also check for direct function call format in code blocks
            if (parsed.name && parsed.arguments) {
                console.log('Successfully parsed direct function call from code block:', parsed.name);
                return {
                    name: parsed.name,
                    arguments: parsed.arguments
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

            // Enhanced response validation with better error handling
            if (!response || !response.candidates || response.candidates.length === 0) {
                console.warn('Gemini API returned no candidates:', JSON.stringify(response, null, 2));
                throw new Error('No candidates returned from Gemini API');
            }

            const candidate = response.candidates[0];
            if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
                console.warn('Gemini API candidate has no content parts:', JSON.stringify(candidate, null, 2));
                
                // Check if there's a safety reason for blocking
                if (candidate.finishReason === 'SAFETY') {
                    throw new Error('Response blocked by Gemini safety filters');
                }
                
                // Check if response was stopped for other reasons
                if (candidate.finishReason && candidate.finishReason !== 'STOP') {
                    throw new Error(`Response incomplete: ${candidate.finishReason}`);
                }
                
                throw new Error('Invalid response structure from Gemini API');
            }

            const responseText = candidate.content.parts[0].text;
            
            // Check if we got any actual text content
            if (!responseText || responseText.trim() === '') {
                console.warn('Gemini API returned empty response text');
                throw new Error('Empty response from Gemini API');
            }

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
            console.error('Error details:', {
                message: error.message,
                stack: error.stack,
                name: error.name
            });
            throw new Error('Failed to complete chat request: ' + error.message);
        }
    }
}

module.exports = new GeminiService(); 