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
    createDevOpsWorkItem: {
        definition: {
            name: 'createDevOpsWorkItem',
            description: 'Create a work item in the connected Azure DevOps project.',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', description: 'Work item type (Bug, Task, User Story, etc.)' },
                    title: { type: 'string', description: 'Title for the work item' },
                    description: { type: 'string', description: 'Optional description' }
                },
                required: ['type', 'title']
            }
        },
        execute: async ({ type, title, description, interactionContext }) => {
            if (!interactionContext) throw new Error('No interaction context');
            const { user } = interactionContext;
            const devopsService = require('../services/azureDevOpsService');
            const item = await devopsService.createWorkItem(user.id, type, title, description);
            return `✅ **Created ${type} #${item.id}**\n\n📋 **Title**: ${title}${description ? `\n📝 **Description**: ${description}` : ''}\n\n🔗 **Work Item URL**: ${item.url || 'Available in Azure DevOps'}`;
        }
    },
    queryDevOpsWorkItems: {
        definition: {
            name: 'queryDevOpsWorkItems',
            description: 'Query Azure DevOps work items with WIQL or by ID.',
            parameters: {
                type: 'object',
                properties: {
                    wiql: { type: 'string', description: 'WIQL query string' },
                    id: { type: 'integer', description: 'Work item ID' }
                },
                required: []
            }
        },
        execute: async ({ wiql, id, interactionContext }) => {
            if (!interactionContext) throw new Error('No interaction context');
            const { user } = interactionContext;
            const devopsService = require('../services/azureDevOpsService');
            let result;
            if (wiql) {
                result = await devopsService.queryWIQL(user.id, wiql);
                
                // Store the raw result for potential use in execution plans
                const rawResult = result;
                
                // Format WIQL query results in a user-friendly way
                if (result && result.workItems && result.workItems.length > 0) {
                    const workItemSummary = result.workItems.map(wi => `• Work Item ${wi.id}`).join('\n');
                    const totalCount = result.workItems.length;
                    
                    // Get detailed work item information if available
                    if (result.workItems.length <= 10) {
                        try {
                            const ids = result.workItems.map(wi => wi.id);
                            const detailedItems = await devopsService.getWorkItems(user.id, ids, [
                                'System.Title', 'System.State', 'System.WorkItemType', 
                                'System.AssignedTo', 'System.CreatedDate', 'System.Tags'
                            ]);
                            
                            const detailedSummary = detailedItems.map(item => {
                                const fields = item.fields || {};
                                return `📋 **${fields['System.WorkItemType'] || 'Item'} #${item.id}**: ${fields['System.Title'] || 'No title'}
   └ State: ${fields['System.State'] || 'Unknown'}
   └ Assigned: ${fields['System.AssignedTo']?.displayName || 'Unassigned'}
   └ Created: ${fields['System.CreatedDate'] ? new Date(fields['System.CreatedDate']).toLocaleDateString() : 'Unknown'}
   ${fields['System.Tags'] ? `└ Tags: ${fields['System.Tags']}` : ''}`;
                            }).join('\n\n');
                            
                            // Return both display text and structured data
                            return {
                                _display: `📊 **Azure DevOps Query Results** (${totalCount} items found):\n\n${detailedSummary}`,
                                _data: rawResult
                            };
                        } catch (detailError) {
                            console.warn('Failed to get detailed work item info:', detailError.message);
                            return {
                                _display: `📊 **Azure DevOps Query Results** (${totalCount} items found):\n\n${workItemSummary}`,
                                _data: rawResult
                            };
                        }
                    } else {
                        return {
                            _display: `📊 **Azure DevOps Query Results** (${totalCount} items found):\n\n${workItemSummary}\n\n💡 *Too many results to show details. Consider refining your query for more specific results.*`,
                            _data: rawResult
                        };
                    }
                } else {
                    return {
                        _display: `📊 **Azure DevOps Query Results**: No work items found matching your query.`,
                        _data: rawResult
                    };
                }
            } else if (id) {
                result = await devopsService.getWorkItem(user.id, id);
                
                // Format single work item result
                if (result && result.fields) {
                    const fields = result.fields;
                    const workItemType = fields['System.WorkItemType'] || 'Work Item';
                    const title = fields['System.Title'] || 'No title';
                    const state = fields['System.State'] || 'Unknown';
                    const assignedTo = fields['System.AssignedTo']?.displayName || 'Unassigned';
                    const createdBy = fields['System.CreatedBy']?.displayName || 'Unknown';
                    const createdDate = fields['System.CreatedDate'] ? new Date(fields['System.CreatedDate']).toLocaleDateString() : 'Unknown';
                    const changedDate = fields['System.ChangedDate'] ? new Date(fields['System.ChangedDate']).toLocaleDateString() : 'Unknown';
                    const description = fields['System.Description'] || 'No description';
                    const tags = fields['System.Tags'] || '';
                    const priority = fields['Microsoft.VSTS.Common.Priority'] || '';
                    const severity = fields['Microsoft.VSTS.Common.Severity'] || '';
                    
                    let formattedResult = `📋 **${workItemType} #${id}**: ${title}

**Details:**
• **State**: ${state}
• **Assigned To**: ${assignedTo}
• **Created By**: ${createdBy}
• **Created Date**: ${createdDate}
• **Last Changed**: ${changedDate}`;

                    if (priority) formattedResult += `\n• **Priority**: ${priority}`;
                    if (severity) formattedResult += `\n• **Severity**: ${severity}`;
                    if (tags) formattedResult += `\n• **Tags**: ${tags}`;
                    
                    // Add description if it's not too long
                    if (description && description.length < 500) {
                        // Remove HTML tags for readability
                        const cleanDescription = description.replace(/<[^>]*>/g, '').trim();
                        if (cleanDescription) {
                            formattedResult += `\n\n**Description:**\n${cleanDescription}`;
                        }
                    } else if (description && description.length >= 500) {
                        formattedResult += `\n\n**Description**: *Long description available (${description.length} characters)*`;
                    }
                    
                    return formattedResult;
                } else {
                    return `❌ Work item #${id} not found or you don't have access to it.`;
                }
            } else {
                throw new Error('Must provide wiql or id');
            }
        }
    },
    updateDevOpsWorkItem: {
        definition: {
            name: 'updateDevOpsWorkItem',
            description: 'Update a field on an Azure DevOps work item.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'integer', description: 'Work item ID' },
                    field: { type: 'string', description: 'Field reference name' },
                    value: { type: 'string', description: 'New value for the field' }
                },
                required: ['id', 'field', 'value']
            }
        },
        execute: async ({ id, field, value, interactionContext }) => {
            if (!interactionContext) throw new Error('No interaction context');
            const { user } = interactionContext;
            const devopsService = require('../services/azureDevOpsService');
            const item = await devopsService.updateWorkItem(user.id, id, { [field]: value });
            
            // Format the field name for better readability
            const friendlyField = field.replace('System.', '').replace('Microsoft.VSTS.Common.', '');
            
            return `✅ **Updated Work Item #${item.id}**\n\n🔧 **Field**: ${friendlyField}\n📝 **New Value**: ${value}\n\n🔗 **Work Item URL**: ${item.url || 'Available in Azure DevOps'}`;
        }
    },
    addCommentToDevOpsWorkItem: {
        definition: {
            name: 'addCommentToDevOpsWorkItem',
            description: 'Add a comment to an Azure DevOps work item.',
            parameters: {
                type: 'object',
                properties: {
                    workItemId: { 
                        type: 'integer', 
                        description: 'Work item ID to add comment to' 
                    },
                    text: { 
                        type: 'string', 
                        description: 'Comment text to add' 
                    }
                },
                required: ['workItemId', 'text']
            }
        },
        execute: async ({ workItemId, text, interactionContext }) => {
            if (!interactionContext) throw new Error('No interaction context');
            const { user } = interactionContext;
            const devopsService = require('../services/azureDevOpsService');
            const comment = await devopsService.addComment(user.id, workItemId, text);
            return `✅ **Added Comment to Work Item #${workItemId}**\n\n💬 **Comment**: "${text}"\n\n🕒 **Added**: ${new Date().toLocaleString()}`;
        }
    },
    setDevOpsParent: {
        definition: {
            name: 'setDevOpsParent',
            description: 'Set parent-child relationship between Azure DevOps work items. Removes any existing parent relationship and sets the new one.',
            parameters: {
                type: 'object',
                properties: {
                    childId: { 
                        type: 'integer', 
                        description: 'Child work item ID' 
                    },
                    parentId: { 
                        type: 'integer', 
                        description: 'Parent work item ID' 
                    }
                },
                required: ['childId', 'parentId']
            }
        },
        execute: async ({ childId, parentId, interactionContext }) => {
            if (!interactionContext) throw new Error('No interaction context');
            const { user } = interactionContext;
            const devopsService = require('../services/azureDevOpsService');
            await devopsService.setParent(user.id, childId, parentId);
            return `✅ **Set Parent-Child Relationship**\n\n👨‍👧 **Parent**: Work Item #${parentId}\n👶 **Child**: Work Item #${childId}\n\n✔️ The parent-child relationship has been established successfully.`;
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
                                forEach: { type: 'string', description: 'Optional: iterate over array from previous step (e.g., "${step1.workItems}")' }
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
                    
                    // Navigate nested fields (e.g., step1.workItems.0.id)
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
                    
                    // Navigate nested fields (e.g., item.workItems.0.id)
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
                        
                        // Extract the step reference (e.g., "step1.workItems" -> ["step1", "workItems"])
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
                                    ...(item.id !== undefined && { id: item.id }),
                                    ...(item.workItemId !== undefined && { workItemId: item.workItemId })
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
                        
                        // Add delay between Azure DevOps operations
                        if (totalStepsExecuted > 0 && name.includes('DevOps')) {
                            console.log('Adding delay for Azure DevOps rate limiting...');
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                        
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