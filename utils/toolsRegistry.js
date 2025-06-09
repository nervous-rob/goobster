// A lightweight registry that exposes internal capabilities as "functions" to OpenAI function-calling.
// Each entry includes an OpenAI-style definition and a runtime execute() helper.
// NOTE: Only minimal tools are wired for now – extend as needed.

const perplexityService = require('../services/perplexityService');
const imageDetectionHandler = require('./imageDetectionHandler');
// Discord command modules
const playTrackCmd = require('../commands/music/playtrack');
const nicknameCmd = require('../commands/settings/nickname');
const speakCmd = require('../commands/chat/speak');
const { PermissionFlagsBits } = require('discord.js');

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
        execute: async ({ prompt, type = 'SCENE', style = 'fantasy', interactionContext }) => {
            const imagePath = await imageDetectionHandler.generateImage(prompt, type, style);

            // If we have an interaction context (original Discord interaction) send the attachment right away
            if (interactionContext && interactionContext.channel) {
                const { default: path } = await import('node:path');
                await interactionContext.channel.send({
                    files: [{ attachment: imagePath, name: path.basename(imagePath) }]
                });
                return '✨ I have generated and sent the image above.';
            }

            // Fallback: just return the local path (may not render in Discord)
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
                    track: { type: 'string', description: 'Search query or track name (artist - title)' },
                    subcommand: { 
                        type: 'string', 
                        enum: ['play', 'list', 'queue', 'skip', 'pause', 'resume', 'stop', 'volume', 'playlist_create', 'playlist_add', 'playlist_play', 'playlist_list', 'playlist_delete', 'play_all', 'shuffle_all', 'playlist_create_from_search'],
                        description: 'Music command subcommand',
                        default: 'play'
                    },
                    volume: { 
                        type: 'integer', 
                        description: 'Volume level (0-100)',
                        minimum: 0,
                        maximum: 100
                    },
                    playlistName: { 
                        type: 'string', 
                        description: 'Name of the playlist for playlist operations'
                    },
                    searchQuery: {
                        type: 'string',
                        description: 'Search query for playlist creation'
                    }
                },
                required: ['track']
            }
        },
        execute: async ({ track, subcommand = 'play', volume, playlistName, searchQuery, interactionContext }) => {
            if (!interactionContext) return '❌ Cannot play music without an interaction context.';

            // Check if user is in a voice channel for relevant commands
            if (['play', 'pause', 'resume', 'skip', 'stop', 'volume'].includes(subcommand)) {
                const voiceChannel = interactionContext.member.voice.channel;
                if (!voiceChannel) {
                    return '❌ You need to be in a voice channel to use this command!';
                }

                // For commands other than 'play', check if user is in the same channel as the bot
                if (subcommand !== 'play' && !isUserInBotVoiceChannel(interactionContext)) {
                    return '❌ You need to be in the same voice channel as the bot to control music.';
                }

                // Check bot permissions
                const permissions = voiceChannel.permissionsFor(interactionContext.client.user);
                if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
                    return '❌ I need permissions to join and speak in your voice channel.';
                }
            }

            // Build a faux options resolver for the command
            interactionContext.options = {
                getSubcommand: () => subcommand,
                getString: (name) => {
                    if (name === 'track') return track;
                    if (name === 'name' || name === 'playlist_name') return playlistName;
                    if (name === 'search_query') return searchQuery;
                    return null;
                },
                getInteger: (name) => {
                    if (name === 'level') return volume;
                    return null;
                }
            };

            try {
                await playTrackCmd.execute(interactionContext);
                return `🎵 ${getCommandResponse(subcommand, track, playlistName)}`;
            } catch (error) {
                console.error('PlayTrack command error:', error);
                return `❌ Error: ${error.message || 'An error occurred while processing your request.'}`;
            }
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

// Helper – replicate playtrack internal check
function isUserInBotVoiceChannel(interaction) {
    const botVoiceChannel = interaction.guild?.members?.me?.voice?.channel;
    if (!botVoiceChannel) return false;
    const userVoiceChannel = interaction.member?.voice?.channel;
    if (!userVoiceChannel) return false;
    return botVoiceChannel.id === userVoiceChannel.id;
}

function getCommandResponse(sub, track, playlistName) {
    switch (sub) {
        case 'play':
            return `Attempting to play **${track}**`;
        case 'pause':
            return '⏸️ Pausing playback';
        case 'resume':
            return '▶️ Resuming playback';
        case 'skip':
            return '⏭️ Skipping track';
        case 'stop':
            return '⏹️ Stopping playback';
        case 'volume':
            return '🔊 Adjusting volume';
        case 'list':
            return '📋 Listing available tracks';
        case 'queue':
            return '📋 Showing queue';
        case 'play_all':
            return '🎵 Playing all tracks';
        case 'shuffle_all':
            return '🔀 Shuffling all tracks';
        case 'playlist_create':
            return `✅ Creating playlist **${playlistName}**`;
        case 'playlist_add':
            return `➕ Adding to playlist **${playlistName}**`;
        case 'playlist_play':
            return `▶️ Playing playlist **${playlistName}**`;
        case 'playlist_list':
            return '📋 Listing playlists';
        case 'playlist_delete':
            return `🗑️ Deleting playlist **${playlistName}**`;
        case 'playlist_create_from_search':
            return `🔍 Creating playlist **${playlistName}** from search`;
        default:
            return '🎵 Executing music command';
    }
}

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