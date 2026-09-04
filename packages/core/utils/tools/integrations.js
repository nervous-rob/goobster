/**
 * Chat tools: search, media, voice commands, and host integrations.
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 */

const path = require('node:path');
const perplexityService = require('../../services/perplexityService');
const imageDetectionHandler = require('../imageDetectionHandler');
const { PermissionFlagsBits } = require('discord.js');
const { windowLines, formatTextWindow, fenceLanguage } = require('../toolResultWindow');
const {
    getCommandAdapter,
    resolveNotionAccess,
    isUserInBotVoiceChannel,
    getCommandResponse,
    resolveGithubAccess
} = require('./helpers');

module.exports = {
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
                await interactionContext.channel.send({
                    files: [{ attachment: imagePath, name: path.basename(imagePath) }]
                });
                // Record the file on the interaction so the chat pipeline can
                // persist it with the reply (the web portal rebuilds message
                // history from SQLite, so unstored attachments would vanish).
                if (!Array.isArray(interactionContext.generatedFiles)) {
                    interactionContext.generatedFiles = [];
                }
                interactionContext.generatedFiles.push(imagePath);
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

            const playTrackCmd = getCommandAdapter('playTrack');
            if (!playTrackCmd) return '❌ Music playback is not available in this context.';

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

            const nicknameCmd = getCommandAdapter('nickname');
            if (!nicknameCmd) return '❌ Nickname changes are not available in this context.';

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

            const speakCmd = getCommandAdapter('speak');
            if (!speakCmd) return '❌ Text-to-speech is not available in this context.';

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
    searchGithubCode: {
        definition: {
            name: 'searchGithubCode',
            description: 'Search code in a GitHub repository. In a server: repos the server watches (via /github watch). In DMs or the web portal: any repo the user\'s connected GitHub account can read (connected in the web portal\'s Integrations dialog). Returns matching file paths.',
            parameters: {
                type: 'object',
                properties: {
                    repo: { type: 'string', description: 'Repository as owner/name, e.g. "nervous-rob/goobster".' },
                    query: { type: 'string', description: 'Code search query (keywords, symbol names).' }
                },
                required: ['repo', 'query']
            }
        },
        execute: async ({ repo, query, interactionContext }) => {
            const githubService = require('../../services/githubService');
            try {
                const { service, parsed, error } = await resolveGithubAccess(interactionContext, githubService, repo);
                if (error) return error;
                const results = await service.searchCode(parsed, query);
                if (!results.length) return `No code matches for "${query}" in ${parsed}.`;
                return `Code matches in ${parsed}:\n` + results.map(item => `- ${item.path} (${item.url})`).join('\n');
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    readGithubFile: {
        definition: {
            name: 'readGithubFile',
            description: 'Read a file from a GitHub repository. In a server: repos the server watches (via /github watch). In DMs or the web portal: any repo the user\'s connected GitHub account can read (connected in the web portal\'s Integrations dialog).',
            parameters: {
                type: 'object',
                properties: {
                    repo: { type: 'string', description: 'Repository as owner/name.' },
                    path: { type: 'string', description: 'File path within the repo, e.g. "src/index.js".' },
                    ref: { type: 'string', description: 'Optional branch, tag, or commit SHA (default branch when omitted).' },
                    offset: { type: 'integer', description: '1-based line to start at (default 1).' },
                    limit: { type: 'integer', description: 'Max lines to return (default 400, max 800).' }
                },
                required: ['repo', 'path']
            }
        },
        execute: async ({ repo, path: filePath, ref, offset, limit, interactionContext }) => {
            const githubService = require('../../services/githubService');
            try {
                const { service, parsed, error } = await resolveGithubAccess(interactionContext, githubService, repo);
                if (error) return error;
                const file = await service.getFileContent(parsed, filePath, { ref: ref || null });
                const win = windowLines(file.content, { offset, limit });
                return formatTextWindow({
                    label: `${parsed}:${file.path}${file.ref ? `@${file.ref}` : ''}`,
                    size: file.size,
                    window: win,
                    fence: fenceLanguage(file.path)
                });
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    searchNotion: {
        definition: {
            name: 'searchNotion',
            description: 'Search the user\'s Notion workspace (pages and databases shared with their connected integration). Personal integration: only available in DMs and the web portal, after the user connects Notion in the web portal\'s Integrations dialog. Use it whenever the user references their notes, docs, or workspace.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search terms (page titles and content).' }
                },
                required: ['query']
            }
        },
        execute: async ({ query, interactionContext }) => {
            const notionService = require('../../services/notionService');
            const { token, error } = await resolveNotionAccess(interactionContext);
            if (error) return error;
            try {
                const results = await notionService.search(token, query);
                if (!results.length) return `No Notion matches for "${query}" (pages must be shared with the integration).`;
                return 'Notion matches:\n' + results.map(item =>
                    `- [${item.kind}] ${item.title} (id: ${item.id})${item.lastEdited ? ` last edited ${item.lastEdited}` : ''}`
                ).join('\n');
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    readNotionPage: {
        definition: {
            name: 'readNotionPage',
            description: 'Read the content of one Notion page (title + body as text) from the user\'s connected workspace. Personal integration: only available in DMs and the web portal. Pass a page id or URL, usually from a searchNotion result.',
            parameters: {
                type: 'object',
                properties: {
                    page: { type: 'string', description: 'Notion page id (UUID) or page URL.' },
                    offset: { type: 'integer', description: '1-based line to start at (default 1).' },
                    limit: { type: 'integer', description: 'Max lines to return (default 400, max 800).' }
                },
                required: ['page']
            }
        },
        execute: async ({ page, offset, limit, interactionContext }) => {
            const notionService = require('../../services/notionService');
            const { token, error } = await resolveNotionAccess(interactionContext);
            if (error) return error;
            try {
                const result = await notionService.getPageText(token, page);
                const body = `${result.title ? `# ${result.title}\n` : ''}${result.url ? `${result.url}\n\n` : '\n'}${result.content || '(empty page)'}`;
                const win = windowLines(body, { offset, limit });
                const formatted = formatTextWindow({
                    label: result.title ? `Notion: ${result.title}` : 'Notion page',
                    window: win,
                    fence: 'markdown'
                });
                return result.truncated && !win.nextOffset
                    ? `${formatted}\n…(page fetch itself was capped; continue with a more specific page)`
                    : formatted;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    launchCursorAgent: {
        definition: {
            name: 'launchCursorAgent',
            description: 'Propose launching a Cursor cloud coding agent against a GitHub repo this server watches. Posts a confirmation button — a member with Manage Server must confirm before anything runs. Use when a user asks you to implement, fix, or investigate something in a repo.',
            parameters: {
                type: 'object',
                properties: {
                    repo: { type: 'string', description: 'Repository as owner/name.' },
                    prompt: { type: 'string', description: 'Clear task instructions for the coding agent (what to build/fix, relevant context).' },
                    branch: { type: 'string', description: 'Optional starting branch (default branch when omitted).' }
                },
                required: ['repo', 'prompt']
            }
        },
        execute: async ({ repo, prompt, branch, interactionContext }) => {
            const githubService = require('../../services/githubService');
            const repoWatchService = require('../../services/repoWatchService');
            const cursorAgentService = require('../../services/cursorAgentService');
            const integrationActionService = require('../../services/integrationActionService');

            const guildId = interactionContext?.guildId || interactionContext?.guild?.id;
            const channel = interactionContext?.channel;
            if (!guildId || !channel) return '❌ Agents can only be launched from a server channel.';
            if (!cursorAgentService.isConfigured()) return '❌ The Cursor integration is not configured (CURSOR_API_KEY).';

            try {
                const parsed = githubService.parseRepo(repo);
                if (!await repoWatchService.isRepoAllowed(guildId, parsed)) {
                    return `❌ ${parsed} isn't allowlisted in this server. An admin must run /github watch first.`;
                }
                const { message } = await integrationActionService.createPending({
                    type: 'agent-launch',
                    guildId,
                    channelId: channel.id,
                    requestedBy: interactionContext.user?.id || null,
                    payload: { repo: parsed, prompt, branch: branch || null }
                });
                await channel.send(message);
                return '🟡 I proposed the agent launch — a member with Manage Server needs to press Confirm on the message I just posted.';
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    createGithubIssue: {
        definition: {
            name: 'createGithubIssue',
            description: 'Propose filing a GitHub issue on a repo this server watches, e.g. when a user reports a bug or requests a feature. Posts a confirmation button — a member with Manage Server must confirm before the issue is created. Write a clear title and a body that captures the conversation context.',
            parameters: {
                type: 'object',
                properties: {
                    repo: { type: 'string', description: 'Repository as owner/name.' },
                    title: { type: 'string', description: 'Concise issue title.' },
                    body: { type: 'string', description: 'Issue body: what happened, expected behavior, reproduction details from the conversation.' }
                },
                required: ['repo', 'title']
            }
        },
        execute: async ({ repo, title, body, interactionContext }) => {
            const githubService = require('../../services/githubService');
            const repoWatchService = require('../../services/repoWatchService');
            const integrationActionService = require('../../services/integrationActionService');

            const guildId = interactionContext?.guildId || interactionContext?.guild?.id;
            const channel = interactionContext?.channel;
            if (!guildId || !channel) return '❌ Issues can only be filed from a server channel.';
            if (!githubService.hasToken()) return '❌ Creating issues needs a GITHUB_TOKEN with Issues write access.';

            try {
                const parsed = githubService.parseRepo(repo);
                if (!await repoWatchService.isRepoAllowed(guildId, parsed)) {
                    return `❌ ${parsed} isn't allowlisted in this server. An admin must run /github watch first.`;
                }
                const { message } = await integrationActionService.createPending({
                    type: 'github-issue',
                    guildId,
                    channelId: channel.id,
                    requestedBy: interactionContext.user?.id || null,
                    payload: { repo: parsed, title, body: body || '' }
                });
                await channel.send(message);
                return '🟡 I drafted the issue — a member with Manage Server needs to press Confirm on the message I just posted.';
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
                        // toolsRegistry.execute throws if the name is unknown
                        
                        console.log(`Executing step ${stepNum}: ${name}`);
                        
                        // Resolve args with context from previous steps
                        const resolvedArgs = resolveArgs(args, stepResults);
                        
                        console.log(`Step ${stepNum} resolved args:`, JSON.stringify(resolvedArgs, null, 2));
                        
                        const result = await require('../toolsRegistry').execute(name, {
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
