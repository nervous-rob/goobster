// A lightweight registry that exposes internal capabilities as "functions" to OpenAI function-calling.
// Each entry includes an OpenAI-style definition and a runtime execute() helper.
// NOTE: Only minimal tools are wired for now – extend as needed.

const perplexityService = require('../services/perplexityService');
const imageDetectionHandler = require('./imageDetectionHandler');

const tools = {
    performSearch: {
        definition: {
            name: 'performSearch',
            description: 'Run a web search and return a concise text summary of the results.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query to pass to the external search API.'
                    }
                },
                required: ['query']
            }
        },
        /**
         * @param {object} args – Function arguments from the LLM (query:string)
         * @returns {Promise<string>} Search summary text
         */
        execute: async ({ query }) => {
            if (!query) throw new Error('Missing search query');
            const result = await perplexityService.search(query);
            return result;
        }
    },
    generateImage: {
        definition: {
            name: 'generateImage',
            description: 'Generate an image with the bot\'s image service and return a CDN URL or local path.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Detailed description of what to generate.' },
                    type: {
                        type: 'string',
                        enum: ['CHARACTER', 'SCENE', 'LOCATION', 'ITEM'],
                        description: 'Image category'
                    },
                    style: {
                        type: 'string',
                        description: 'Artistic style to apply (e.g. fantasy, realistic, anime)',
                        default: 'fantasy'
                    }
                },
                required: ['prompt']
            }
        },
        /**
         * Use the existing imageDetectionHandler.generateImage helper.
         * @param {{prompt:string,type?:string,style?:string}} args
         * @returns {Promise<string>} Relative path to generated image
         */
        execute: async ({ prompt, type = 'SCENE', style = 'fantasy' }) => {
            const imagePath = await imageDetectionHandler.generateImage(prompt, type, style);
            return imagePath;
        }
    }
};

module.exports = {
    /**
     * Return array of OpenAI function definitions.
     */
    getDefinitions() {
        return Object.values(tools).map(t => t.definition);
    },

    /**
     * Execute a tool by name with args. Throws if unknown.
     * @param {string} name
     * @param {object} args
     */
    async execute(name, args) {
        if (!tools[name]) throw new Error(`Unknown tool: ${name}`);
        return tools[name].execute(args || {});
    }
}; 