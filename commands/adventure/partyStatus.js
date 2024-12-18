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

// Add function to format state information
function formatState(stateJson) {
    try {
        const state = JSON.parse(stateJson);
        
        if (state.location || state.timeOfDay || state.weather) {
            return `**Location:** ${state.location}
**Time of Day:** ${state.timeOfDay}
**Weather:** ${state.weather}
${state.threats?.length ? `**Active Threats:** ${state.threats.join(', ')}` : ''}
${state.opportunities?.length ? `**Available Opportunities:** ${state.opportunities.join(', ')}` : ''}
${state.recentEvents?.length ? `**Recent Events:**\n${state.recentEvents.map(e => `• ${e}`).join('\n')}` : ''}
${state.environmentalEffects?.length ? `**Environmental Effects:** ${state.environmentalEffects.join(', ')}` : ''}`.trim();
        }
        
        return state;
    } catch (e) {
        debugLog('WARN', 'State is not in JSON format, using as plain text', stateJson);
        return stateJson || 'No state information available';
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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('partystatus')
        .setDescription('View the current status of your adventure party.')
        .addIntegerOption(option =>
            option.setName('partyid')
                .setDescription('The ID of your party')
                .setRequired(true)
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

            // Get party and adventure info
            const partyResult = await sql.query`
                SELECT p.*, a.id as adventureId, a.theme, a.plotSummary, a.winCondition, a.currentState
                FROM parties p
                LEFT JOIN adventures a ON p.id = a.partyId
                WHERE p.id = ${partyId}
            `;

            if (!partyResult.recordset.length) {
                throw new Error('Party not found');
            }

            const party = partyResult.recordset[0];

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
                WHERE pm.partyId = ${partyId}
                ORDER BY pm.joinedAt ASC
            `;

            // Create response embed
            const embed = {
                color: 0x0099ff,
                title: '🎭 Party Status',
                description: party.adventureId ? `Current Adventure: ${party.theme}` : 'No active adventure',
                fields: []
            };

            // Add party status
            embed.fields.push({
                name: 'Party Status',
                value: `Status: ${party.adventureStatus}\nActive: ${party.isActive ? 'Yes' : 'No'}`
            });

            // Add adventure details if exists
            if (party.adventureId) {
                embed.fields.push(
                    {
                        name: 'Plot Summary',
                        value: party.plotSummary
                    },
                    {
                        name: 'Win Condition',
                        value: party.winCondition
                    },
                    {
                        name: 'Current State',
                        value: formatState(party.currentState)
                    }
                );

                // Add progress indicator if the adventure is in progress
                if (party.adventureStatus === adventureConfig.ADVENTURE_STATUS.IN_PROGRESS) {
                    const progressResult = await sql.query`
                        SELECT 
                            COUNT(*) as totalDecisions,
                            SUM(CASE WHEN resolvedAt IS NOT NULL THEN 1 ELSE 0 END) as resolvedDecisions
                        FROM decisionPoints
                        WHERE adventureId = ${party.adventureId}
                    `;

                    const progress = progressResult.recordset[0];
                    const progressPercentage = Math.round((progress.resolvedDecisions / progress.totalDecisions) * 100);
                    
                    embed.fields.push({
                        name: 'Progress',
                        value: `${progressPercentage}% (${progress.resolvedDecisions}/${progress.totalDecisions} decisions made)`
                    });
                }
            }

            // Add member details
            embed.fields.push({
                name: '\u200B',
                value: '**Party Members**'
            });

            for (const member of membersResult.recordset) {
                const conditions = member.conditions ? JSON.parse(member.conditions) : [];
                const inventory = member.inventory ? JSON.parse(member.inventory) : [];
                
                const statusIcon = getStatusIcon(member.status);
                const healthBar = getHealthBar(member.health);
                
                const statusInfo = [
                    `❤️ Health: ${healthBar}`,
                    `📊 Status: ${statusIcon} ${member.status}`,
                    conditions.length ? `🔮 Conditions: ${conditions.join(', ')}` : null,
                    inventory.length ? `🎒 Inventory: ${inventory.join(', ')}` : null
                ].filter(Boolean);

                const memberField = {
                    name: `${statusIcon} ${member.adventurerName}`,
                    value: `${member.backstory ? `*${member.backstory}*\n` : ''}${
                        statusInfo.join('\n')
                    }`
                };
                embed.fields.push(memberField);
            }

            // Get current decision point if exists
            if (party.adventureId) {
                const decisionResult = await sql.query`
                    SELECT TOP 1 dp.situation, dp.choices, pm.adventurerName
                    FROM decisionPoints dp
                    JOIN partyMembers pm ON dp.partyMemberId = pm.id
                    WHERE dp.adventureId = ${party.adventureId}
                    AND dp.resolvedAt IS NULL
                    ORDER BY dp.createdAt DESC
                `;

                if (decisionResult.recordset.length > 0) {
                    const decision = decisionResult.recordset[0];
                    embed.fields.push(
                        {
                            name: '\u200B',
                            value: '**Current Decision Point**'
                        },
                        {
                            name: `${decision.adventurerName}'s Turn`,
                            value: decision.situation
                        },
                        {
                            name: 'Available Choices',
                            value: JSON.parse(decision.choices)
                                .map((choice, index) => `${index + 1}. ${choice}`)
                                .join('\n')
                        }
                    );
                }
            }

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('Error in partyStatus:', error);
            const errorMessages = {
                'Not a party member': 'You must be a member of this party to view its status.',
                'Party not found': 'Could not find a party with that ID.'
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