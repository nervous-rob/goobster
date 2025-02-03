// TODO: Add proper handling for status validation
// TODO: Add proper handling for status timeouts
// TODO: Add proper handling for status caching
// TODO: Add proper handling for status updates
// TODO: Add proper handling for status persistence
// TODO: Add proper handling for status notifications
// TODO: Add proper handling for status permissions
// TODO: Add proper handling for status rate limiting
// TODO: Add proper handling for status metadata
// TODO: Add proper handling for status error recovery

const { SlashCommandBuilder } = require('discord.js');
const AdventureService = require('../../services/adventure');
const logger = require('../../services/adventure/utils/logger');

const adventureService = new AdventureService();

// Add debug logging function
function debugLog(level, message, data = null) {
    if (!adventureConfig.DEBUG.ENABLED) return;
    
    const logLevels = {
        'ERROR': 0,
        'WARN': 1,
        'INFO': 2,
        'DEBUG': 3
    };
    
    if (logLevels[level] <= logLevels[adventureConfig.DEBUG.LOG_LEVEL]) {
        if (data) {
            console.log(`[${level}] ${message}:`, JSON.stringify(data, null, 2));
        } else {
            console.log(`[${level}] ${message}`);
        }
    }
}

// Add function to clean JSON response
function cleanJsonResponse(response) {
    if (typeof response !== 'string') return response;
    return response
        .replace(/```json\n/g, '')
        .replace(/```\n/g, '')
        .replace(/```/g, '')
        .trim();
}

// Add function to format state information
function formatState(stateJson) {
    try {
        const state = JSON.parse(cleanJsonResponse(stateJson));
        
        const sections = [];

        // Location section
        if (state.location) {
            sections.push(`**Location**
Place: ${state.location.place}
${state.location.landmarks?.length ? `Landmarks: ${state.location.landmarks.join(', ')}` : ''}
${state.location.surroundings ? `Surroundings: ${state.location.surroundings}` : ''}`);
        }

        // Environment section
        if (state.environment) {
            sections.push(`**Environment**
Time: ${state.environment.timeOfDay}
Weather: ${state.environment.weather}
${state.environment.season ? `Season: ${state.environment.season}` : ''}
${state.environment.visibility ? `Visibility: ${state.environment.visibility}` : ''}`);
        }

        // Elements section
        if (state.elements) {
            const elements = [];
            if (state.elements.threats?.length) elements.push(`Threats: ${state.elements.threats.join(', ')}`);
            if (state.elements.opportunities?.length) elements.push(`Opportunities: ${state.elements.opportunities.join(', ')}`);
            if (state.elements.allies?.length) elements.push(`Potential Allies: ${state.elements.allies.join(', ')}`);
            if (state.elements.hazards?.length) elements.push(`Hazards: ${state.elements.hazards.join(', ')}`);
            
            if (elements.length) {
                sections.push(`**Current Elements**\n${elements.join('\n')}`);
            }
        }

        // Progress section
        if (state.progress) {
            const progress = [];
            if (state.progress.plotPointsEncountered?.length) {
                progress.push(`Plot Points Encountered: ${state.progress.plotPointsEncountered.length}`);
            }
            if (state.progress.objectivesCompleted?.length) {
                progress.push(`Objectives Completed: ${state.progress.objectivesCompleted.length}`);
            }
            if (state.progress.keyElementsFound?.length) {
                progress.push(`Key Elements Found: ${state.progress.keyElementsFound.length}`);
            }
            
            if (progress.length) {
                sections.push(`**Progress**\n${progress.join('\n')}`);
            }
        }

        // Recent events section - Enhanced to show actual events
        if (state.recentEvents?.length) {
            const recentEventsSection = ['**Recent Events**'];
            state.recentEvents.forEach((event, index) => {
                if (event) { // Only add non-null events
                    recentEventsSection.push(`${index + 1}. ${event}`);
                }
            });
            if (recentEventsSection.length > 1) { // Only add if there are actual events
                sections.push(recentEventsSection.join('\n'));
            }
        }

        return sections.join('\n\n');
    } catch (e) {
        debugLog('WARN', 'State is not in JSON format, using as plain text', stateJson);
        return stateJson || 'No state information available';
    }
}

// Add function to format win condition
function formatWinCondition(winConditionJson) {
    try {
        const winCondition = JSON.parse(cleanJsonResponse(winConditionJson));
        const sections = [];

        if (winCondition.primary) {
            sections.push(`**Primary Objective**\n${winCondition.primary}`);
        }

        if (winCondition.secondary?.length) {
            sections.push(`**Secondary Objectives**\n${winCondition.secondary.map(obj => `• ${obj}`).join('\n')}`);
        }

        if (winCondition.failureConditions?.length) {
            sections.push(`**Failure Conditions**\n${winCondition.failureConditions.map(cond => `❌ ${cond}`).join('\n')}`);
        }

        if (winCondition.requiredElements?.length) {
            sections.push(`**Required Elements**\n${winCondition.requiredElements.map(elem => `📍 ${elem}`).join('\n')}`);
        }

        return sections.join('\n\n');
    } catch (e) {
        debugLog('WARN', 'Win condition is not in JSON format, using as plain text', winConditionJson);
        return winConditionJson || 'No win condition available';
    }
}

// Add function to format plot points
function formatPlotPoints(plotPointsJson) {
    try {
        const plotPoints = JSON.parse(cleanJsonResponse(plotPointsJson));
        if (!Array.isArray(plotPoints) || !plotPoints.length) return 'No plot points available';

        return plotPoints.map((point, index) => `${index + 1}. ${point}`).join('\n');
    } catch (e) {
        debugLog('WARN', 'Plot points are not in JSON format, using as plain text', plotPointsJson);
        return plotPointsJson || 'No plot points available';
    }
}

// Add function to format key elements
function formatKeyElements(keyElementsJson) {
    try {
        const elements = JSON.parse(cleanJsonResponse(keyElementsJson));
        const sections = [];

        if (elements.characters?.length) {
            sections.push(`**Characters**\n${elements.characters.map(char => `👤 ${char}`).join('\n')}`);
        }

        if (elements.items?.length) {
            sections.push(`**Items**\n${elements.items.map(item => `📦 ${item}`).join('\n')}`);
        }

        if (elements.antagonist) {
            sections.push(`**Antagonist**\n😈 ${elements.antagonist}`);
        }

        return sections.join('\n\n');
    } catch (e) {
        debugLog('WARN', 'Key elements are not in JSON format, using as plain text', keyElementsJson);
        return keyElementsJson || 'No key elements available';
    }
}

// Add function to format status icons
function getStatusIcon(status) {
    switch(status) {
        case adventureConfig.CHARACTER_STATUS.ACTIVE: return '⚔️';
        case adventureConfig.CHARACTER_STATUS.INJURED: return '🤕';
        case adventureConfig.CHARACTER_STATUS.INCAPACITATED: return '💫';
        case adventureConfig.CHARACTER_STATUS.DEAD: return '☠️';
        default: return '❓';
    }
}

// Add function to format health bar
function getHealthBar(health) {
    const maxBars = 10;
    const filledBars = Math.round((health / adventureConfig.HEALTH.MAX) * maxBars);
    const emptyBars = maxBars - filledBars;
    return `[${'🟩'.repeat(filledBars)}${'⬜'.repeat(emptyBars)}] ${health}/${adventureConfig.HEALTH.MAX}`;
}

// Add helper function to truncate text
function truncateText(text, maxLength = 1024) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
}

// Add helper function to create embed field
function createEmbedField(name, value, inline = false) {
    return {
        name: name,
        value: truncateText(value),
        inline: inline
    };
}

// Add helper function to summarize events
function summarizeEvents(events, maxEvents = 3) {
    if (!events?.length) return 'No recent events';
    
    // Take only the most recent events
    const recentEvents = events.slice(0, maxEvents);
    
    // Summarize each event to be more concise
    return recentEvents.map((event, index) => {
        // Remove unnecessary details and shorten the text
        let summary = event
            .replace(/^As .+?,\s*/i, '') // Remove "As X..." prefix
            .replace(/\s*\b(?:however|meanwhile|furthermore)\b\s*/gi, ' ') // Remove transitional words
            .split('.')[0]; // Take only the first sentence
        
        // Ensure the summary isn't too long
        if (summary.length > 100) {
            summary = summary.substring(0, 97) + '...';
        }
        
        return `${index + 1}. ${summary}`;
    }).join('\n');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('partystatus')
        .setDescription('Check the status of your adventure party')
        .addStringOption(option =>
            option.setName('section')
                .setDescription('Which section of status to view')
                .setRequired(false)
                .addChoices(
                    { name: 'Overview', value: 'overview' },
                    { name: 'Members', value: 'members' },
                    { name: 'Objectives', value: 'objectives' },
                    { name: 'Inventory', value: 'inventory' },
                    { name: 'History', value: 'history' }
                )),

    async execute(interaction) {
        try {
            await interaction.deferReply();
            
            const userId = interaction.user.id;
            const section = interaction.options.getString('section') || 'overview';
            
            // Get party status using the service
            const response = await adventureService.getPartyStatus(userId, section);

            // Send the formatted response
            await interaction.editReply(response);

        } catch (error) {
            logger.error('Failed to get party status', { error });
            const errorMessage = error.userMessage || 'Failed to get party status. Please try again later.';
            
            if (interaction.deferred) {
                await interaction.editReply({ content: errorMessage });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },
}; 