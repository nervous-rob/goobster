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
const { sql, getConnection } = require('../../azureDb');
const adventureConfig = require('../../config/adventureConfig');

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
        .setDescription('View the current status of your adventure party.')
        .addIntegerOption(option =>
            option.setName('partyid')
                .setDescription('The ID of your party')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('section')
                .setDescription('Which section of information to display')
                .addChoices(
                    { name: 'Overview', value: 'overview' },
                    { name: 'Story', value: 'story' },
                    { name: 'Current State', value: 'state' },
                    { name: 'Party Members', value: 'members' },
                    { name: 'Recent Events', value: 'events' }
                )
        ),

    async execute(interaction) {
        try {
            await interaction.deferReply();
            await getConnection();

            const username = interaction.user.username;
            const partyId = interaction.options.getInteger('partyid');

            // Get user ID and verify membership
            const userResult = await sql.query`
                SELECT u.id as userId, pm.id as partyMemberId
                FROM users u
                LEFT JOIN partyMembers pm ON u.id = pm.userId AND pm.partyId = ${partyId}
                WHERE u.username = ${username}
            `;

            if (!userResult.recordset.length || !userResult.recordset[0].partyMemberId) {
                throw new Error('Not a party member');
            }

            // Get party and adventure info with enhanced details
            const partyResult = await sql.query`
                SELECT p.*, 
                       a.id as adventureId, 
                       a.theme,
                       a.setting,
                       a.plotSummary,
                       a.plotPoints,
                       a.keyElements,
                       a.winCondition,
                       a.currentState
                FROM parties p
                LEFT JOIN adventures a ON p.id = a.partyId
                WHERE p.id = ${partyId}
            `;

            if (!partyResult.recordset.length) {
                throw new Error('Party not found');
            }

            const party = partyResult.recordset[0];

            const section = interaction.options.getString('section') || 'overview';
            const embed = {
                color: 0x0099ff,
                title: '🎭 Party Status',
                description: party.adventureId ? truncateText(`Current Adventure: ${party.theme}`, 4096) : 'No active adventure',
                fields: []
            };

            // Basic info always shown
            embed.fields.push(createEmbedField(
                'Party Status',
                `Status: ${party.adventureStatus}\nActive: ${party.isActive ? 'Yes' : 'No'}`
            ));

            if (party.adventureId) {
                switch(section) {
                    case 'overview':
                        if (party.setting) {
                            try {
                                const setting = JSON.parse(party.setting);
                                embed.fields.push(createEmbedField(
                                    'Setting',
                                    `Geography: ${setting.geography}\nEra: ${setting.era}\nCulture: ${setting.culture}`
                                ));
                            } catch (error) {
                                debugLog('WARN', 'Failed to parse setting', { error, setting: party.setting });
                            }
                        }
                        
                        // Add condensed state info
                        try {
                            if (party.currentState) {
                                const overviewState = JSON.parse(party.currentState);
                                embed.fields.push(createEmbedField('Current Location', 
                                    `${overviewState.location?.place || 'Unknown'}\n` +
                                    `Time: ${overviewState.environment?.timeOfDay || 'Unknown'}, Weather: ${overviewState.environment?.weather || 'Unknown'}`
                                ));
                            }
                        } catch (error) {
                            debugLog('WARN', 'Failed to parse current state in overview', { error, state: party.currentState });
                            embed.fields.push(createEmbedField('Current Location', 'Status information unavailable'));
                        }
                        
                        // Add progress
                        if (party.adventureStatus === adventureConfig.ADVENTURE_STATUS.IN_PROGRESS) {
                            try {
                                const progressResult = await sql.query`
                                    SELECT COUNT(*) as totalDecisions,
                                           SUM(CASE WHEN resolvedAt IS NOT NULL THEN 1 ELSE 0 END) as resolvedDecisions
                                    FROM decisionPoints
                                    WHERE adventureId = ${party.adventureId}
                                `;
                                const progress = progressResult.recordset[0];
                                if (progress.totalDecisions > 0) {
                                    const progressPercentage = Math.round((progress.resolvedDecisions / progress.totalDecisions) * 100);
                                    embed.fields.push(createEmbedField(
                                        'Progress',
                                        `${progressPercentage}% (${progress.resolvedDecisions}/${progress.totalDecisions} decisions made)`
                                    ));
                                } else {
                                    embed.fields.push(createEmbedField('Progress', 'Adventure just started'));
                                }
                            } catch (error) {
                                debugLog('WARN', 'Failed to calculate progress', { error });
                                embed.fields.push(createEmbedField('Progress', 'Progress information unavailable'));
                            }
                        }
                        break;

                    case 'story':
                        embed.fields.push(createEmbedField('Plot Summary', party.plotSummary));
                        embed.fields.push(createEmbedField('Plot Points', formatPlotPoints(party.plotPoints)));
                        embed.fields.push(createEmbedField('Key Elements', formatKeyElements(party.keyElements)));
                        embed.fields.push(createEmbedField('Objectives', formatWinCondition(party.winCondition)));
                        break;

                    case 'state':
                        embed.fields.push(createEmbedField('Current State', formatState(party.currentState)));
                        
                        // Get current decision point
                        const decisionResult = await sql.query`
                            SELECT TOP 1 
                                dp.situation, 
                                dp.choices, 
                                pm.adventurerName
                            FROM decisionPoints dp
                            JOIN partyMembers pm ON dp.partyMemberId = pm.id
                            WHERE dp.adventureId = ${party.adventureId}
                            AND dp.resolvedAt IS NULL
                            ORDER BY dp.createdAt DESC
                        `;
                        
                        // Add current decision point if exists
                        if (decisionResult?.recordset.length > 0) {
                            const decision = decisionResult.recordset[0];
                            embed.fields.push(
                                createEmbedField(`${decision.adventurerName}'s Turn`, decision.situation),
                                createEmbedField(
                                    'Available Choices',
                                    JSON.parse(decision.choices)
                                        .map((choice, index) => `${index + 1}. ${choice}`)
                                        .join('\n')
                                )
                            );
                        }
                        break;

                    case 'members':
                        // Get all party members and their states
                        const membersResult = await sql.query`
                            SELECT 
                                pm.adventurerName,
                                pm.backstory,
                                ast.health,
                                ast.status,
                                ast.conditions,
                                ast.inventory
                            FROM partyMembers pm
                            LEFT JOIN adventurerStates ast ON pm.id = ast.partyMemberId 
                                AND ast.adventureId = ${party.adventureId}
                            WHERE pm.partyId = ${partyId}
                            ORDER BY pm.joinedAt ASC
                        `;

                        embed.fields.push(createEmbedField('\u200B', '**Party Members**'));
                        for (const member of membersResult.recordset) {
                            try {
                                const conditions = member.conditions ? JSON.parse(member.conditions) : [];
                                const inventory = member.inventory ? JSON.parse(member.inventory) : [];
                                const statusIcon = getStatusIcon(member.status || adventureConfig.CHARACTER_STATUS.ACTIVE);
                                const healthBar = getHealthBar(member.health || adventureConfig.HEALTH.MAX);
                                const statusInfo = [
                                    `❤️ Health: ${healthBar}`,
                                    `📊 Status: ${statusIcon} ${member.status || adventureConfig.CHARACTER_STATUS.ACTIVE}`,
                                    conditions.length ? `🔮 Conditions: ${conditions.join(', ')}` : null,
                                    inventory.length ? `🎒 Inventory: ${inventory.join(', ')}` : null
                                ].filter(Boolean);
                                embed.fields.push(createEmbedField(
                                    `${statusIcon} ${member.adventurerName}`,
                                    `${member.backstory ? `*${member.backstory}*\n` : ''}${statusInfo.join('\n')}`
                                ));
                            } catch (error) {
                                debugLog('WARN', `Failed to process member ${member.adventurerName}`, { error, member });
                                embed.fields.push(createEmbedField(
                                    `❓ ${member.adventurerName}`,
                                    member.backstory ? `*${member.backstory}*\n` : 'Status information unavailable'
                                ));
                            }
                        }
                        break;

                    case 'events':
                        // Get recent decisions with summarized descriptions
                        const recentDecisionsResult = await sql.query`
                            SELECT TOP 5 
                                dp.choiceMade,
                                dp.consequence,
                                dp.resolvedAt,
                                pm.adventurerName
                            FROM decisionPoints dp
                            JOIN partyMembers pm ON dp.partyMemberId = pm.id
                            WHERE dp.adventureId = ${party.adventureId}
                            AND dp.resolvedAt IS NOT NULL
                            ORDER BY dp.resolvedAt DESC
                        `;

                        if (recentDecisionsResult.recordset.length > 0) {
                            const recentDecisions = recentDecisionsResult.recordset
                                .map(decision => {
                                    try {
                                        const consequence = JSON.parse(decision.consequence);
                                        return `${decision.adventurerName} chose: ${decision.choiceMade}\n→ ${summarizeEvents([consequence.description])}`;
                                    } catch (error) {
                                        debugLog('WARN', 'Failed to parse consequence', { error, consequence: decision.consequence });
                                        return `${decision.adventurerName} chose: ${decision.choiceMade}`;
                                    }
                                })
                                .join('\n\n');

                            embed.fields.push(createEmbedField('Recent Decisions', recentDecisions));
                        }

                        // Add current state's recent events
                        try {
                            const eventsState = JSON.parse(party.currentState);
                            if (eventsState.recentEvents?.length) {
                                embed.fields.push(createEmbedField(
                                    'Recent Events',
                                    summarizeEvents(eventsState.recentEvents)
                                ));
                            }
                        } catch (error) {
                            debugLog('WARN', 'Failed to parse current state for recent events', { error, state: party.currentState });
                        }
                        break;
                }
            }

            // Ensure total length of all fields doesn't exceed Discord's limits
            let totalLength = embed.description.length;
            embed.fields = embed.fields.map(field => {
                totalLength += field.name.length + field.value.length;
                if (totalLength > 6000) { // Discord's total embed limit
                    return createEmbedField(
                        field.name,
                        'Content truncated due to length limits. Please check previous messages for full details.'
                    );
                }
                return field;
            });

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('Error in partyStatus:', error);
            const errorMessages = {
                'Not a party member': 'You must be a member of this party to view its status.',
                'Party not found': 'Could not find a party with that ID.',
                'Failed to format state': 'Failed to format party state. Please try again.'
            };
            
            const errorMessage = errorMessages[error.message] || 'Failed to get party status. Please try again.';
            
            if (!interaction.deferred) {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.editReply({ content: errorMessage });
            }
        }
    },
}; 