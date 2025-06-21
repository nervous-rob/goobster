require('dotenv').config();
const { OpenAI } = require('openai');
const config = require('../config.json');

// Prefer key from environment variables, fallback to config.json (to be deprecated)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || config.openaiKey;

// Hold current default model; allow runtime updates via setDefaultModel()
let CURRENT_DEFAULT_MODEL = 'gpt-4o';

// Default sampling presets
const SAMPLING_PRESETS = {
    chat:      { temperature: 0.5, top_p: 0.9, max_tokens: 1024 },
    creative:  { temperature: 0.8, top_p: 0.95, max_tokens: 1024 },
    deterministic: { temperature: 0.2, top_p: 1,   max_tokens: 1024 },
    code:      { temperature: 0.2, top_p: 0.1, max_tokens: 1024 },
};

class OpenAIService {
    constructor() {
        if (!OPENAI_API_KEY) {
            throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY in your environment variables.');
        }
        this.apiKey = OPENAI_API_KEY;
        this.client = new OpenAI({ apiKey: this.apiKey });

        // Keep an instance-level reference so each exported singleton stays in sync
        this.defaultModel = CURRENT_DEFAULT_MODEL;
    }

    /**
     * Update the default model used for all requests that do not explicitly override the model.
     * @param {string} modelName - e.g. "gpt-4o" or "o4-mini".
     */
    setDefaultModel(modelName) {
        if (typeof modelName !== 'string' || modelName.length === 0) {
            throw new Error('Model name must be a non-empty string');
        }
        CURRENT_DEFAULT_MODEL = modelName;
        this.defaultModel = modelName;
    }

    /**
     * Return the model that will be used by default.
     */
    getDefaultModel() {
        return this.defaultModel;
    }

    /**
     * Generate text using OpenAI's API
     * @param {string} prompt - The prompt to send to OpenAI
     * @param {Object} options - Options for the API call
     * @param {number} options.temperature - Controls randomness (0-2)
     * @param {number} options.max_tokens - Maximum tokens to generate
     * @param {string} options.model - Model to use (defaults to gpt-4o)
     * @param {boolean} options.includeCurrentDate - Whether to include current date in context
     * @param {('low'|'medium'|'high')} [options.reasoning_effort] - o-series specific setting controlling depth.
     * @returns {Promise<string>} The generated text
     */
    async generateText(prompt, options = {}) {
        try {
            const {
                temperature = 0.7,
                max_tokens = 1024,
                includeCurrentDate = false,
                reasoning_effort
            } = options;

            // Respect caller-supplied model but fall back to current default
            const model = options.model || this.defaultModel;

            // Add current date and time to the prompt if requested
            let finalPrompt = prompt;
            if (includeCurrentDate) {
                const now = new Date();
                const dateString = now.toLocaleDateString('en-US', { 
                    year: 'numeric', 
                    month: 'long', 
                    day: 'numeric' 
                });
                const timeString = now.toLocaleTimeString('en-US');
                finalPrompt = `Current date and time: ${dateString}, ${timeString}\n\n${prompt}`;
            }

            const requestBody = {
                model,
                messages: [
                    { role: 'user', content: finalPrompt }
                ],
                temperature,
                max_tokens
            };

            if (reasoning_effort) {
                requestBody.reasoning_effort = reasoning_effort; // Only affects o-series models
            }

            const response = await this.client.chat.completions.create(requestBody);

            if (!response.choices?.[0]?.message?.content) {
                throw new Error('Invalid response format from OpenAI API');
            }

            return response.choices[0].message.content;
        } catch (error) {
            console.error('OpenAI API Error:', error.response?.data || error.message);
            if (error.response?.data?.error?.type === 'invalid_request_error') {
                throw new Error('Invalid request to OpenAI API. Please check your parameters.');
            } else if (!this.apiKey) {
                throw new Error('OpenAI API key not configured. Please add it to your config.json file.');
            }
            throw new Error('Failed to generate text: ' + (error.response?.data?.error?.message || error.message));
        }
    }

    /**
     * Build enhanced messages with tool documentation for function calling
     */
    _buildToolAwareMessages(messages, functions) {
        if (!functions || functions.length === 0) {
            return messages;
        }

        // Build tool documentation
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

        // Create enhanced system message
        const toolSystemMessage = `You are an AI assistant with access to powerful tools. When using the executePlan tool for complex operations:

**DYNAMIC EXECUTION PLANS:**
When using executePlan for operations that require data from one step to inform later steps:

1. **CRITICAL**: The plan array MUST contain ALL steps in order. Step 2 cannot reference step 1 if step 1 doesn't exist!

2. **Query first, then act**: If you need to act on multiple items but don't know their IDs, query first:
   - Step 1: Query for items with WIQL
   - Step 2: Use forEach with \${step1.workItems} to iterate over results

3. **Reference previous results**: Use \${stepN.field} to access data from step N:
   - \${step1} - The entire result from step 1
   - \${step1.workItems} - The workItems array from step 1 (Azure DevOps WIQL queries return results in a 'workItems' array)
   - \${item.id} - When inside a forEach loop, refers to current item's id property

4. **Complete Example - Assign all work items in project "Spitball" to rob@nervouslabs.com**:
   {
     "name": "executePlan", 
     "arguments": {
       "plan": [
         {
           "name": "queryDevOpsWorkItems",
           "args": { 
             "wiql": "SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.TeamProject] = 'Spitball' AND [System.AssignedTo] = ''"
           }
         },
         {
           "name": "updateDevOpsWorkItem",
           "args": {
             "id": "\${item.id}",
             "field": "System.AssignedTo", 
             "value": "rob@nervouslabs.com"
           },
           "forEach": "\${step1.workItems}"
         }
       ]
     }
   }

**Common Patterns:**
- "Review and assign all work items" → Query first (step 1), then forEach update (step 2)
- Query MUST include project name: [System.TeamProject] = 'ProjectName'

Available tools:
${toolDocs}`;

        // Inject as first system message
        const enhancedMessages = [
            { role: 'system', content: toolSystemMessage },
            ...messages
        ];

        return enhancedMessages;
    }

    /**
     * Chat completion helper
     * messages: Array or single string (will be wrapped as user)
     * opts: may include preset name to pull defaults from SAMPLING_PRESETS
     */
    async chat(messages, opts = {}) {
        // Allow caller to pass preset string
        let finalOpts = { ...opts };
        if (typeof opts === 'string') {
            // Legacy signature not used now
            finalOpts = { preset: opts };
        }

        const {
            preset,
            model,
            temperature,
            top_p,
            max_tokens,
            stream = false,
            reasoning_effort
        } = finalOpts;

        const modelToUse = model || this.defaultModel;

        // Merge preset defaults
        const presetDefaults = preset && SAMPLING_PRESETS[preset] ? SAMPLING_PRESETS[preset] : {};

        // Enhance messages if functions are provided
        const finalMessages = finalOpts.functions ? 
            this._buildToolAwareMessages(Array.isArray(messages) ? messages : [{ role: 'user', content: messages }], finalOpts.functions) :
            (Array.isArray(messages) ? messages : [{ role: 'user', content: messages }]);

        const requestOptions = {
            model: modelToUse,
            messages: finalMessages,
            temperature: temperature ?? presetDefaults.temperature ?? 0.7,
            top_p: top_p ?? presetDefaults.top_p ?? 1,
            max_tokens: max_tokens ?? presetDefaults.max_tokens ?? 1000,
            stream
        };

        if (reasoning_effort) {
            requestOptions.reasoning_effort = reasoning_effort;
        }

        // Optional OpenAI function-calling support
        if (finalOpts.functions) {
            requestOptions.functions = finalOpts.functions;
            if (finalOpts.function_call) requestOptions.function_call = finalOpts.function_call;
        }

        try {
            const response = await this.client.chat.completions.create(requestOptions);

            if (stream || finalOpts.functions) {
                // Return raw response so caller can handle function calls or streaming iterator
                return response;
            }

            if (!response.choices?.[0]?.message?.content) {
                throw new Error('Invalid response format from OpenAI API');
            }

            return response.choices[0].message.content;
        } catch (error) {
            console.error('OpenAI Chat API Error:', error.response?.data || error.message);
            throw new Error('Failed to complete chat request: ' + (error.response?.data?.error?.message || error.message));
        }
    }
}

module.exports = new OpenAIService(); 