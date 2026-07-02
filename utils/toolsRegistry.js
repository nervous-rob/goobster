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
    },
    echoMessage: {
        definition: {
            name: 'echoMessage',
            description: 'Echo back the provided text.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Text to echo back' }
 
                },
                required: ['text']
            }
        },
        execute: async ({ text }) => text
    },
    rememberFact: {
        definition: {
            name: 'rememberFact',
            description: 'Save a durable fact to long-term memory, e.g. a user preference, ongoing project, or important server detail. Use when you learn something worth remembering beyond this conversation.',
            parameters: {
                type: 'object',
                properties: {
                    fact: { type: 'string', description: 'Short declarative statement, e.g. "Rob prefers concise answers".' },
                    about: {
                        type: 'string',
                        enum: ['user', 'server'],
                        description: 'Whether this fact is about the current user or the server as a whole.'
                    }
                },
                required: ['fact', 'about']
            }
        },
        execute: async ({ fact, about = 'user', interactionContext }) => {
            const factsService = require('../services/factsService');
            const guildId = interactionContext?.guildId;
            if (!guildId) return '❌ Facts can only be saved inside a server.';

            const isUser = about === 'user';
            const id = factsService.addFact({
                guildId,
                subjectType: isUser ? 'USER' : 'GUILD',
                subjectId: isUser ? interactionContext.user?.id : null,
                content: fact,
                source: 'model'
            });
            return id ? `🧠 Remembered: "${fact}"` : '❌ Could not save that fact.';
        }
    },
    forgetFact: {
        definition: {
            name: 'forgetFact',
            description: 'Delete facts from long-term memory that match a phrase. Use when a saved fact is wrong or outdated, or when a user asks you to forget something about them.',
            parameters: {
                type: 'object',
                properties: {
                    match: { type: 'string', description: 'Phrase to match against stored facts (substring match).' },
                    about: {
                        type: 'string',
                        enum: ['user', 'server', 'any'],
                        description: 'Scope: facts about the current user, the server, or both.'
                    }
                },
                required: ['match']
            }
        },
        execute: async ({ match, about = 'any', interactionContext }) => {
            const factsService = require('../services/factsService');
            const guildId = interactionContext?.guildId;
            if (!guildId) return '❌ Facts only exist inside servers.';

            const removed = factsService.removeFacts({
                guildId,
                subjectType: about === 'user' ? 'USER' : about === 'server' ? 'GUILD' : null,
                subjectId: about === 'user' ? interactionContext.user?.id : null,
                match
            });
            return removed > 0
                ? `🗑️ Forgot ${removed} fact${removed === 1 ? '' : 's'} matching "${match}".`
                : `I didn't have any facts matching "${match}".`;
        }
    },
    scheduleFollowUp: {
        definition: {
            name: 'scheduleFollowUp',
            description: 'Schedule a one-time follow-up so you can circle back later, e.g. when a user mentions a deadline, plan, or event ("I\'ll deploy it tomorrow"). You will post in this channel at the scheduled time.',
            parameters: {
                type: 'object',
                properties: {
                    note: { type: 'string', description: 'What to follow up about, e.g. "Ask Rob how the deploy went".' },
                    when: { type: 'string', description: 'When to follow up, in natural language, e.g. "tomorrow at 3pm" or "in 2 hours".' }
                },
                required: ['note', 'when']
            }
        },
        execute: async ({ note, when, interactionContext }) => {
            const followupService = require('../services/followupService');
            const guildId = interactionContext?.guildId;
            const channelId = interactionContext?.channel?.id || interactionContext?.channelId;
            if (!guildId || !channelId) return '❌ Follow-ups can only be scheduled inside a server channel.';

            try {
                const { dueAt } = await followupService.schedule({
                    guildId,
                    channelId,
                    userId: interactionContext.user?.id || null,
                    note,
                    whenDescription: when
                });
                return `⏰ Follow-up scheduled for ${dueAt} UTC: "${note}"`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    executePlan: {
        definition: {
            name: 'executePlan',
            description: 'Execute a dynamic plan where each step can access previous results and modify future steps.',
            parameters: {
                type: 'object',
                properties: {
                    plan: {
                        type: 'array',
                        description: 'Array of commands to execute. Steps can use ${stepN.fieldName} to reference results from previous steps.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Tool name to execute' },
                                args: { type: 'object', description: 'Arguments for the tool. Can use ${stepN.field} syntax.' },
                                condition: { type: 'string', description: 'Optional condition using ${stepN} references' },
                                forEach: { type: 'string', description: 'Optional: iterate over array from previous step (e.g., "${step1.results}")' }
                            },
                            required: ['name']
                        }
                    },
                    stopOnError: {
                        type: 'boolean',
                        description: 'Whether to stop execution if any step fails',
                        default: false
                    }
                },
                required: ['plan']
            }
        },
        execute: async ({ plan = [], stopOnError = false, interactionContext }) => {
            if (!Array.isArray(plan)) throw new Error('Plan must be an array');
            if (plan.length === 0) return 'No actions to execute';
            
            console.log(`Executing dynamic plan with ${plan.length} initial steps...`);
            
            const results = [];
            const stepResults = {}; // Store results for reference by later steps
            const errors = [];
            let successCount = 0;
            let totalStepsExecuted = 0;
            
            // Helper function to resolve template strings with step results
            const resolveTemplate = (value, context) => {
                if (typeof value !== 'string') return value;
                
                // Replace ${stepN.field} with actual values
                value = value.replace(/\$\{step(\d+)\.?([^}]*)\}/g, (match, stepNum, field) => {
                    const stepIdx = parseInt(stepNum) - 1;
                    const stepResult = context[`step${stepNum}`];
                    
                    if (!stepResult) {
                        console.warn(`Reference to non-existent step${stepNum}`);
                        return match;
                    }
                    
                    if (!field) return JSON.stringify(stepResult);
                    
                    // Navigate nested fields (e.g., step1.results.0.id)
                    const fields = field.split('.');
                    let value = stepResult;
                    
                    for (const f of fields) {
                        if (value === null || value === undefined) break;
                        value = value[f];
                    }
                    
                    return value !== undefined ? value : match;
                });
                
                // Replace ${item.field} with actual values from forEach context
                value = value.replace(/\$\{item\.?([^}]*)\}/g, (match, field) => {
                    const item = context.item;
                    
                    if (!item) {
                        console.warn(`Reference to item but no item in context`);
                        return match;
                    }
                    
                    if (!field) return JSON.stringify(item);
                    
                    // Navigate nested fields (e.g., item.results.0.id)
                    const fields = field.split('.');
                    let value = item;
                    
                    for (const f of fields) {
                        if (value === null || value === undefined) break;
                        value = value[f];
                    }
                    
                    return value !== undefined ? value : match;
                });
                
                return value;
            };
            
            // Helper to resolve all args in an object
            const resolveArgs = (args, context) => {
                if (!args) return {};
                
                const resolved = {};
                for (const [key, value] of Object.entries(args)) {
                    if (typeof value === 'string') {
                        resolved[key] = resolveTemplate(value, context);
                    } else if (typeof value === 'object' && value !== null) {
                        resolved[key] = resolveArgs(value, context);
                    } else {
                        resolved[key] = value;
                    }
                }
                return resolved;
            };
            
            // Validate plan references before execution
            const validatePlanReferences = (steps) => {
                const errors = [];
                steps.forEach((step, index) => {
                    const stepNum = index + 1;
                    const { args, forEach } = step;
                    
                    // Check references in args
                    const argsStr = JSON.stringify(args || {});
                    const argRefs = argsStr.match(/\$\{step(\d+)[^}]*\}/g) || [];
                    argRefs.forEach(ref => {
                        const refStepNum = parseInt(ref.match(/step(\d+)/)[1]);
                        if (refStepNum >= stepNum) {
                            errors.push(`Step ${stepNum} references step ${refStepNum} which hasn't executed yet`);
                        }
                    });
                    
                    // Check forEach references
                    if (forEach) {
                        const forEachRefs = forEach.match(/\$\{step(\d+)[^}]*\}/g) || [];
                        forEachRefs.forEach(ref => {
                            const refStepNum = parseInt(ref.match(/step(\d+)/)[1]);
                            if (refStepNum >= stepNum) {
                                errors.push(`Step ${stepNum} forEach references step ${refStepNum} which hasn't executed yet`);
                            }
                        });
                    }
                });
                return errors;
            };
            
            // Validate the plan before execution
            const validationErrors = validatePlanReferences(plan);
            if (validationErrors.length > 0) {
                console.error('Plan validation errors:', validationErrors);
                return `❌ **Plan Validation Failed**\n\nThe execution plan has invalid references:\n${validationErrors.map(e => `• ${e}`).join('\n')}\n\n💡 **Tip**: Steps can only reference previous steps. Make sure all steps are in the correct order.`;
            }
            
            // Process the plan with support for dynamic expansion
            const processSteps = async (steps, startIdx = 0) => {
                for (let i = 0; i < steps.length; i++) {
                    const step = steps[i];
                    const stepNum = startIdx + i + 1;
                    const { name, args, condition, forEach } = step;
                    
                    // Check condition if present
                    if (condition) {
                        const evaluatedCondition = resolveTemplate(condition, stepResults);
                        if (evaluatedCondition === 'false' || evaluatedCondition === false) {
                            results.push(`⏭️ Step ${stepNum}: Skipped (condition not met)`);
                            continue;
                        }
                    }
                    
                    // Handle forEach - expand into multiple steps
                    if (forEach) {
                        // Directly evaluate the forEach expression to get the array
                        let items = [];
                        
                        // Extract the step reference (e.g., "step1.results" -> ["step1", "results"])
                        const forEachMatch = forEach.match(/\$\{step(\d+)\.?([^}]*)\}/);
                        if (forEachMatch) {
                            const stepNum = forEachMatch[1];
                            const fieldPath = forEachMatch[2];
                            const stepResult = stepResults[`step${stepNum}`];
                            
                            if (stepResult) {
                                if (fieldPath) {
                                    // Navigate to the nested field
                                    const fields = fieldPath.split('.');
                                    let value = stepResult;
                                    for (const field of fields) {
                                        if (value && typeof value === 'object') {
                                            value = value[field];
                                        }
                                    }
                                    items = Array.isArray(value) ? value : [];
                                } else {
                                    items = Array.isArray(stepResult) ? stepResult : [];
                                }
                            }
                        }
                        
                        if (!Array.isArray(items)) {
                            console.error('forEach did not resolve to an array:', { forEach, resolved: items });
                            items = [];
                        }
                        
                        if (Array.isArray(items) && items.length > 0) {
                            console.log(`Expanding step ${stepNum} into ${items.length} iterations`);
                            console.log('First item structure:', JSON.stringify(items[0], null, 2));
                            
                            const expandedSteps = items.map((item, idx) => ({
                                name: step.name,
                                args: {
                                    ...resolveArgs(args, { ...stepResults, item }),
                                    // Special handling for common patterns
                                    ...(item.id !== undefined && { id: item.id })
                                }
                            }));
                            
                            // Log the first expanded step for debugging
                            if (expandedSteps.length > 0) {
                                console.log('First expanded step:', JSON.stringify(expandedSteps[0], null, 2));
                            }
                            
                            // Insert expanded steps and continue
                            await processSteps(expandedSteps, stepNum - 1);
                            continue;
                        } else if (forEach.includes('${step')) {
                            // If forEach references a step but no items were found, log a warning
                            console.warn(`Step ${stepNum}: forEach referenced "${forEach}" but no items found to iterate over`);
                            console.warn('Step result structure:', JSON.stringify(stepResults, null, 2));
                            results.push(`⚠️ Step ${stepNum}: No items found to iterate over`);
                            continue;
                        }
                    }
                    
                    // Regular step execution
                    try {
                        // Validate tool exists
                        if (!tools[name]) {
                            throw new Error(`Unknown tool: ${name}`);
                        }
                        
                        console.log(`Executing step ${stepNum}: ${name}`);
                        
                        // Resolve args with context from previous steps
                        const resolvedArgs = resolveArgs(args, stepResults);
                        
                        console.log(`Step ${stepNum} resolved args:`, JSON.stringify(resolvedArgs, null, 2));
                        
                        const result = await tools[name].execute({ 
                            ...resolvedArgs, 
                            interactionContext 
                        });
                        
                        // Store result for future steps
                        stepResults[`step${stepNum}`] = result;
                        totalStepsExecuted++;
                        
                        // Handle special result formats
                        if (result && typeof result === 'object') {
                            // If result has both display and data properties (used by some tools)
                            if (result._display && result._data) {
                                stepResults[`step${stepNum}`] = result._data;
                                results.push(`✅ Step ${stepNum}: ${result._display}`);
                                successCount++;
                                console.log(`Step ${stepNum} completed successfully`);
                                continue;
                            }
                        }
                        
                        // Try to parse JSON results for easier access
                        try {
                            if (typeof result === 'string' && (result.startsWith('{') || result.startsWith('['))) {
                                stepResults[`step${stepNum}`] = JSON.parse(result);
                            }
                        } catch (e) {
                            // Keep original if not valid JSON
                        }
                        
                        results.push(`✅ Step ${stepNum}: ${typeof result === 'string' ? result : 'Completed successfully'}`);
                        successCount++;
                        
                        console.log(`Step ${stepNum} completed successfully`);
                    
                } catch (err) {
                        const errorMsg = `❌ Step ${stepNum} (${name}): ${err.message}`;
                    results.push(errorMsg);
                    errors.push(errorMsg);
                        totalStepsExecuted++;
                    
                        console.error(`Step ${stepNum} failed:`, err.message);
                    
                    if (stopOnError) {
                            results.push(`🛑 Execution stopped due to error in step ${stepNum}`);
                            return;
                        }
                    }
                }
            };
            
            // Execute the plan
            await processSteps(plan);
            
            // Build summary
            const summary = [
                `📊 Execution Summary: ${successCount}/${totalStepsExecuted} steps completed successfully`
            ];
            
            if (totalStepsExecuted > plan.length) {
                summary.push(`📈 Dynamically expanded from ${plan.length} to ${totalStepsExecuted} steps`);
            }
            
            if (errors.length > 0) {
                summary.push(`⚠️ ${errors.length} errors encountered`);
            }
            
            // Combine summary with results
            const finalResult = [...summary, '', ...results].join('\n');
            
            console.log(`Dynamic plan execution completed: ${successCount}/${totalStepsExecuted} successful`);
            
            return finalResult;
        }
    }
};

// Helper – mirrors playtrack's internal check
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