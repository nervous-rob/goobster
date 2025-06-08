// A lightweight registry that exposes internal capabilities as "functions" to OpenAI function-calling.
// Each entry includes an OpenAI-style definition and a runtime execute() helper.
// NOTE: Only minimal tools are wired for now – extend as needed.

const perplexityService = require('../services/perplexityService');
const imageDetectionHandler = require('./imageDetectionHandler');
// Discord command modules
const playTrackCmd = require('../commands/music/playtrack');
const nicknameCmd = require('../commands/settings/nickname');
const speakCmd = require('../commands/chat/speak');

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
    },
    playTrack: {
        definition: {
            name: 'playTrack',
            description: 'Queue or play a music track in the user\'s current voice channel.',
            parameters: {
                type: 'object',
                properties: {
                    track: { type: 'string', description: 'Search query or track name (artist - title)' }
                },
                required: ['track']
            }
        },
        execute: async ({ track, interactionContext }) => {
            if (!interactionContext) return '❌ Cannot play music without an interaction context.';

            // Build a faux options resolver for the command
            interactionContext.options = {
                getSubcommand: () => 'play',
                getString: (name) => (name === 'track' ? track : null)
            };

            await playTrackCmd.execute(interactionContext);
            return `🎵 Attempting to play **${track}**`;
        }
    },
    setNickname: {
        definition: {
            name: 'setNickname',
            description: 'Set or clear a nickname (bot or user).',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'string', enum: ['bot', 'user'], description: 'Whose nickname to change' },
                    nickname: { type: 'string', description: 'Nickname text (omit for clear)' }
                },
                required: ['target']
            }
        },
        execute: async ({ target, nickname, interactionContext }) => {
            if (!interactionContext) return '❌ Cannot change nickname without interaction context.';

            const action = nickname ? 'set' : 'clear';

            interactionContext.options = {
                getSubcommandGroup: () => target,
                getSubcommand: () => action,
                getString: (name) => (name === 'nickname' ? nickname : null)
            };

            await nicknameCmd.execute(interactionContext);
            return nickname ? `✅ ${target} nickname set to ${nickname}` : `✅ ${target} nickname cleared.`;
        }
    },
    speakMessage: {
        definition: {
            name: 'speakMessage',
            description: 'Convert text to speech in the user\'s voice channel.',
            parameters: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'Text to speak' },
                    voice: { type: 'string', description: 'Voice style (optional)' },
                    style: { type: 'string', description: 'Speech effect style (optional)' }
                },
                required: ['message']
            }
        },
        execute: async ({ message, voice, style, interactionContext }) => {
            if (!interactionContext) return '❌ Cannot speak without interaction context.';

            interactionContext.options = {
                getString: (name) => {
                    if (name === 'message') return message;
                    if (name === 'voice') return voice || null;
                    if (name === 'style') return style || null;
                    return null;
                },
                getBoolean: () => false // default for other bool options
            };

            await speakCmd.execute(interactionContext);
            return `🔊 Speaking your message...`;
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