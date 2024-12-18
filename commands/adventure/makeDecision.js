const { SlashCommandBuilder } = require('discord.js');
const OpenAI = require('openai');
const { sql, getConnection } = require('../../azureDb');
const config = require('../../config.json');
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

const openai = new OpenAI({
    apiKey: config.openaiKey
});

const DECISION_PROMPT = `
You are continuing an ongoing adventure. You must maintain consistency with all established elements and advance the story meaningfully while respecting character states and recent events.

Adventure Context:
Theme: {theme}
Setting: {setting}
Plot Summary: {plotSummary}
Major Plot Points: {plotPoints}
Key Elements: {keyElements}
Win Condition: {winCondition}

Current Adventure State:
Location: {currentState.location}
Time: {currentState.timeOfDay}
Weather: {currentState.weather}
Recent Events: {currentState.recentEvents}
Environmental Effects: {currentState.environmentalEffects}

Party Status:
{partyStatus}

Current Situation: {situation}
Player Choice: {choice}

Generate the consequences and next decision point while ensuring:
1. Consistency with the theme, setting, and recent events
2. Progress toward or interaction with major plot points
3. Meaningful use of key elements (characters, items, antagonist)
4. Respect for win/failure conditions
5. Logical progression of time and environment
6. Realistic character state changes based on their current status and recent events
7. Clear connection between recent events and new developments

Format the response as JSON with the following structure:
{
    "consequence": {
        "description": "detailed description of what happens, referencing relevant recent events",
        "plotProgress": "how this advances the story",
        "keyElementsUsed": ["element1", "element2"]
    },
    "stateChanges": [
        {
            "adventurerId": number (must be numeric party member ID),
            "changes": {
                "health": number (0-100),
                "status": "ACTIVE|INJURED|INCAPACITATED|DEAD",
                "conditions": ["condition1", "condition2"],
                "inventory": ["item1", "item2"]
            },
            "reason": "detailed explanation for changes, referencing recent events and current situation"
        }
    ],
    "nextSituation": {
        "description": "description of the new situation, incorporating consequences of recent events",
        "location": "specific location",
        "timeOfDay": "specific time",
        "weather": "specific condition",
        "activeThreats": ["threat1", "threat2"],
        "availableOpportunities": ["opportunity1", "opportunity2"],
        "visibility": "visibility condition"
    },
    "nextChoices": [
        "choice that considers recent events and current party state",
        "choice that references available opportunities",
        "choice that acknowledges current threats"
    ]
}

Notes:
- All IDs must be numbers matching the party member IDs provided
- Health must be between 0 and 100
- Status must be one of: ACTIVE, INJURED, INCAPACITATED, DEAD
- Each choice should be distinct and impactful
- Consider party member status when determining consequences
- Maintain consistency with all established story elements
- Reference recent events to maintain narrative continuity
`;

// Add new function for getting next player in round-robin order
async function getNextPlayer(transaction, adventureId, currentPlayerId) {
    const result = await transaction.request()
        .input('adventureId', sql.Int, adventureId)
        .input('currentPlayerId', sql.Int, currentPlayerId)
        .query(`
            WITH PlayerOrder AS (
                SELECT 
                    pm.id,
                    pm.adventurerName,
                    ROW_NUMBER() OVER (ORDER BY pm.joinedAt) as turnOrder
                FROM partyMembers pm
                JOIN adventurerStates ast ON pm.id = ast.partyMemberId
                WHERE ast.adventureId = @adventureId
                    AND ast.status != '${adventureConfig.CHARACTER_STATUS.DEAD}'
                    AND ast.status != '${adventureConfig.CHARACTER_STATUS.INCAPACITATED}'
            )
            SELECT id, adventurerName
            FROM PlayerOrder
            WHERE turnOrder = (
                SELECT (turnOrder % (SELECT COUNT(*) FROM PlayerOrder)) + 1
                FROM PlayerOrder
                WHERE id = @currentPlayerId
            )
        `);
    
    return result.recordset[0];
}

// Add new function for checking win condition
async function checkWinCondition(openai, adventure, currentState) {
    try {
        const winConditionCheck = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{
                role: "user",
                content: `
Evaluate if the win condition has been met based on the following context:

Adventure Details:
Theme: ${adventure.theme}
Plot Summary: ${adventure.plotSummary}

Win Condition Requirements:
Primary Objective: ${adventure.winCondition.primary}
Secondary Objectives: ${JSON.stringify(adventure.winCondition.secondary)}
Failure Conditions: ${JSON.stringify(adventure.winCondition.failureConditions)}
Required Elements: ${JSON.stringify(adventure.winCondition.requiredElements)}

Current State:
Location: ${currentState.location}
Recent Events: ${JSON.stringify(currentState.recentEvents)}
Party Status: ${currentState.partyStatus}
Key Items/Progress: ${JSON.stringify(currentState.keyElements)}

Evaluate and respond with a JSON object:
{
    "isComplete": boolean,
    "reason": "detailed explanation of why the condition is or isn't met",
    "progress": {
        "primaryObjective": "percentage or status of completion",
        "secondaryObjectives": [
            {
                "objective": "objective description",
                "status": "completion status"
            }
        ],
        "failureRisks": [
            {
                "condition": "failure condition",
                "status": "how close to failing"
            }
        ]
    },
    "missingElements": ["required elements not yet achieved"]
}

IMPORTANT: Respond ONLY with the JSON object, no additional text or markdown formatting.`
            }]
        });

        const cleanedResponse = cleanJsonResponse(winConditionCheck.choices[0].message.content);
        debugLog('INFO', 'Cleaned win condition response:', cleanedResponse);
        
        return JSON.parse(cleanedResponse);
    } catch (error) {
        debugLog('ERROR', 'Failed to parse win condition check response:', {
            error: error.message,
            stack: error.stack
        });
        return {
            isComplete: false,
            reason: 'Unable to determine win condition status',
            progress: {
                primaryObjective: "unknown",
                secondaryObjectives: [],
                failureRisks: []
            },
            missingElements: []
        };
    }
}

// Add function to update adventure state
async function updateAdventureState(transaction, adventureId, currentState, consequence) {
    try {
        const state = JSON.parse(currentState);
        const newState = {
            ...state,
            location: consequence.nextSituation.location || state.location,
            environment: {
                timeOfDay: consequence.nextSituation.timeOfDay || state.environment.timeOfDay,
                weather: consequence.nextSituation.weather || state.environment.weather,
                season: state.environment.season,
                visibility: consequence.nextSituation.visibility || state.environment.visibility
            },
            elements: {
                threats: consequence.nextSituation.activeThreats || [],
                opportunities: consequence.nextSituation.availableOpportunities || [],
                allies: state.elements.allies,
                hazards: state.elements.hazards
            },
            progress: {
                plotPointsEncountered: [
                    ...(state.progress?.plotPointsEncountered || []),
                    ...(consequence.plotProgress ? [consequence.plotProgress] : [])
                ].slice(-adventureConfig.STORY.MAX_TRACKED_ELEMENTS),
                objectivesCompleted: state.progress?.objectivesCompleted || [],
                keyElementsFound: [
                    ...(state.progress?.keyElementsFound || []),
                    ...(consequence.keyElementsUsed || [])
                ].slice(-adventureConfig.STORY.MAX_TRACKED_ELEMENTS)
            },
            recentEvents: [
                consequence.description,
                ...(state.recentEvents || [])
            ].slice(0, adventureConfig.STORY.MAX_RECENT_EVENTS)
        };

        // Log state update for debugging
        debugLog('INFO', 'Updating adventure state', {
            oldState: state,
            newState: newState,
            consequence: consequence
        });

        await transaction.request()
            .input('adventureId', sql.Int, adventureId)
            .input('currentState', sql.NVarChar, JSON.stringify(newState))
            .query(`
                UPDATE adventures
                SET currentState = @currentState
                WHERE id = @adventureId
            `);

        return newState;
    } catch (error) {
        debugLog('ERROR', 'Failed to update adventure state', error);
        throw error;
    }
}

// Add function to format decision prompt
function formatDecisionPrompt(adventure, currentState, situation, choice, partyStatus) {
    return DECISION_PROMPT
        .replace('{theme}', adventure.theme)
        .replace('{setting}', adventure.setting)
        .replace('{plotSummary}', adventure.plotSummary)
        .replace('{plotPoints}', adventure.plotPoints)
        .replace('{keyElements}', adventure.keyElements)
        .replace('{winCondition}', adventure.winCondition)
        .replace('{currentState.location}', JSON.stringify(currentState.location))
        .replace('{currentState.timeOfDay}', currentState.environment.timeOfDay)
        .replace('{currentState.weather}', currentState.environment.weather)
        .replace('{currentState.recentEvents}', JSON.stringify(currentState.recentEvents))
        .replace('{currentState.environmentalEffects}', JSON.stringify(currentState.elements))
        .replace('{partyStatus}', JSON.stringify(partyStatus))
        .replace('{situation}', situation)
        .replace('{choice}', choice);
}

// Add function to clean JSON response
function cleanJsonResponse(response) {
    return response
        .replace(/```json\n/g, '')
        .replace(/```\n/g, '')
        .replace(/```/g, '')
        .trim();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('makedecision')
        .setDescription('Make a decision in your adventure.')
        .addIntegerOption(option =>
            option.setName('partyid')
                .setDescription('The ID of your party')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option.setName('choice')
                .setDescription('The number of your chosen option')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(5)
        ),

    async execute(interaction) {
        try {
            await interaction.deferReply();
            await getConnection();

            const username = interaction.user.username;
            const partyId = interaction.options.getInteger('partyid');
            const choiceNumber = interaction.options.getInteger('choice');

            let transaction;
            let committed = false;
            try {
                // Start transaction
                transaction = new sql.Transaction();
                await transaction.begin();

                // Get user ID and verify membership
                const userResult = await transaction.request()
                    .input('username', sql.NVarChar, username)
                    .input('partyId', sql.Int, partyId)
                    .query(`
                        SELECT u.id as userId, pm.id as partyMemberId, pm.adventurerName
                        FROM users u
                        LEFT JOIN partyMembers pm ON u.id = pm.userId AND pm.partyId = @partyId
                        WHERE u.username = @username
                    `);

                if (!userResult.recordset.length || !userResult.recordset[0].partyMemberId) {
                    throw new Error('Not a party member');
                }

                const { userId, partyMemberId, adventurerName } = userResult.recordset[0];

                // Get current adventure with all story elements
                const adventureResult = await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .query(`
                        SELECT a.id as adventureId, 
                               a.theme,
                               a.setting,
                               a.plotSummary,
                               a.plotPoints,
                               a.keyElements,
                               a.winCondition,
                               a.currentState,
                               p.adventureStatus
                        FROM adventures a
                        JOIN parties p ON a.partyId = p.id
                        WHERE p.id = @partyId
                    `);

                if (!adventureResult.recordset.length) {
                    throw new Error('No active adventure');
                }

                const adventure = adventureResult.recordset[0];
                if (adventure.adventureStatus !== 'IN_PROGRESS') {
                    throw new Error('Adventure is not in progress');
                }

                // Get current decision point
                const decisionResult = await transaction.request()
                    .input('adventureId', sql.Int, adventure.adventureId)
                    .query(`
                        SELECT TOP 1 id, partyMemberId, situation, choices
                        FROM decisionPoints
                        WHERE adventureId = @adventureId
                        AND resolvedAt IS NULL
                        ORDER BY createdAt DESC
                    `);

                if (!decisionResult.recordset.length) {
                    throw new Error('No pending decisions');
                }

                const currentDecision = decisionResult.recordset[0];
                if (currentDecision.partyMemberId !== partyMemberId) {
                    throw new Error('Not your turn');
                }

                const choices = JSON.parse(currentDecision.choices);
                if (choiceNumber > choices.length) {
                    throw new Error('Invalid choice number');
                }

                const chosenOption = choices[choiceNumber - 1];

                // Get party status for context
                const partyStatusResult = await transaction.request()
                    .input('adventureId', sql.Int, adventure.adventureId)
                    .query(`
                        SELECT pm.id, pm.adventurerName, ast.*
                        FROM adventurerStates ast
                        JOIN partyMembers pm ON ast.partyMemberId = pm.id
                        WHERE ast.adventureId = @adventureId
                    `);

                const partyStatus = partyStatusResult.recordset.map(member => ({
                    id: member.id,
                    name: member.adventurerName,
                    health: member.health,
                    status: member.status,
                    conditions: member.conditions ? JSON.parse(member.conditions) : [],
                    inventory: member.inventory ? JSON.parse(member.inventory) : []
                }));

                // Generate consequence and next situation
                const prompt = formatDecisionPrompt(
                    adventure,
                    JSON.parse(adventure.currentState),
                    currentDecision.situation,
                    chosenOption,
                    partyStatus
                );

                const completion = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [{ role: "user", content: prompt }]
                });

                const response = JSON.parse(cleanJsonResponse(completion.choices[0].message.content));

                // Update adventure state
                const newState = await updateAdventureState(
                    transaction,
                    adventure.adventureId,
                    adventure.currentState,
                    response
                );

                // Update adventurer states
                for (const stateChange of response.stateChanges) {
                    await transaction.request()
                        .input('adventureId', sql.Int, adventure.adventureId)
                        .input('partyMemberId', sql.Int, stateChange.adventurerId)
                        .input('health', sql.Int, stateChange.changes.health)
                        .input('status', sql.NVarChar, stateChange.changes.status)
                        .input('conditions', sql.NVarChar, JSON.stringify(stateChange.changes.conditions || []))
                        .input('inventory', sql.NVarChar, JSON.stringify(stateChange.changes.inventory || []))
                        .query(`
                            UPDATE adventurerStates
                            SET health = @health,
                                status = @status,
                                conditions = @conditions,
                                inventory = @inventory,
                                lastUpdated = GETDATE()
                            WHERE adventureId = @adventureId
                            AND partyMemberId = @partyMemberId
                        `);
                }

                // Mark current decision as resolved
                await transaction.request()
                    .input('decisionId', sql.Int, currentDecision.id)
                    .input('choiceMade', sql.NVarChar, chosenOption)
                    .input('consequence', sql.NVarChar, JSON.stringify(response.consequence))
                    .input('plotProgress', sql.NVarChar, response.consequence.plotProgress || null)
                    .input('keyElementsUsed', sql.NVarChar, JSON.stringify(response.consequence.keyElementsUsed || []))
                    .input('resolvedAt', sql.DateTime, new Date())
                    .query(`
                        UPDATE decisionPoints
                        SET resolvedAt = @resolvedAt,
                            choiceMade = @choiceMade,
                            consequence = @consequence,
                            plotProgress = @plotProgress,
                            keyElementsUsed = @keyElementsUsed
                        WHERE id = @decisionId
                    `);

                // Check win condition
                const winCheck = await checkWinCondition(openai, adventure, JSON.stringify(newState));
                if (winCheck.isComplete) {
                    await transaction.request()
                        .input('partyId', sql.Int, partyId)
                        .input('adventureId', sql.Int, adventure.adventureId)
                        .input('completedAt', sql.DateTime, new Date())
                        .query(`
                            UPDATE adventures 
                            SET completedAt = @completedAt 
                            WHERE id = @adventureId;
                            
                            UPDATE parties
                            SET adventureStatus = '${adventureConfig.ADVENTURE_STATUS.COMPLETED}'
                            WHERE id = @partyId;
                        `);

                    const embed = {
                        color: 0x0099ff,
                        title: `Decision for ${adventurerName}`,
                        description: `Chose: ${chosenOption}`,
                        fields: [
                            {
                                name: 'What Happened',
                                value: response.consequence.description
                            },
                            {
                                name: '🎉 Adventure Complete!',
                                value: winCheck.reason
                            }
                        ]
                    };

                    await interaction.editReply({ embeds: [embed] });
                } else {
                    // Get next player
                    const nextPlayer = await getNextPlayer(transaction, adventure.adventureId, partyMemberId);

                    // Create next decision point
                    await transaction.request()
                        .input('adventureId', sql.Int, adventure.adventureId)
                        .input('partyMemberId', sql.Int, nextPlayer.id)
                        .input('situation', sql.NVarChar, response.nextSituation.description)
                        .input('choices', sql.NVarChar, JSON.stringify(response.nextChoices))
                        .query(`
                            INSERT INTO decisionPoints (adventureId, partyMemberId, situation, choices)
                            VALUES (@adventureId, @partyMemberId, @situation, @choices)
                        `);

                    // Create response embed
                    const embed = {
                        color: 0x0099ff,
                        title: `Decision for ${adventurerName}`,
                        description: `Chose: ${chosenOption}`,
                        fields: [
                            {
                                name: 'What Happened',
                                value: response.consequence.description
                            },
                            {
                                name: 'Story Progress',
                                value: response.consequence.plotProgress || 'The story continues...'
                            }
                        ]
                    };

                    // Add state changes if any occurred
                    if (response.stateChanges.length > 0) {
                        const stateChangeText = response.stateChanges
                            .map(change => {
                                const member = partyStatus.find(m => m.id === change.adventurerId);
                                if (!member) return null;
                                
                                const healthChange = member.health !== change.changes.health 
                                    ? `\nHealth: ${member.health} → ${change.changes.health}`
                                    : '';
                                const statusChange = member.status !== change.changes.status
                                    ? `\nStatus: ${member.status} → ${change.changes.status}`
                                    : '';
                                const conditionsChange = !arraysEqual(member.conditions, change.changes.conditions)
                                    ? `\nConditions: ${formatArrayChange(member.conditions, change.changes.conditions)}`
                                    : '';
                                const inventoryChange = !arraysEqual(member.inventory, change.changes.inventory)
                                    ? `\nInventory: ${formatArrayChange(member.inventory, change.changes.inventory)}`
                                    : '';
                                
                                return `${member.name}:${healthChange}${statusChange}${conditionsChange}${inventoryChange}\nReason: ${change.reason}`;
                            })
                            .filter(text => text !== null)
                            .join('\n\n');

                        if (stateChangeText) {
                            embed.fields.push({
                                name: 'State Changes',
                                value: stateChangeText
                            });
                        }
                    }

                    // Add next turn information
                    embed.fields.push(
                        {
                            name: '\u200B',
                            value: '\u200B'
                        },
                        {
                            name: `${nextPlayer.adventurerName}'s Turn`,
                            value: response.nextSituation.description
                        },
                        {
                            name: 'Available Choices',
                            value: response.nextChoices.map((choice, index) => 
                                `${index + 1}. ${choice}`
                            ).join('\n')
                        }
                    );

                    await interaction.editReply({ embeds: [embed] });
                }

                await transaction.commit();
                committed = true;

            } catch (error) {
                if (transaction && !committed) {
                    try {
                        await transaction.rollback();
                    } catch (rollbackError) {
                        console.error('Error rolling back transaction:', rollbackError);
                    }
                }
                throw error;
            }

        } catch (error) {
            console.error('Error in makeDecision:', error);
            const errorMessages = {
                'Not a party member': 'You must be a member of this party to make decisions.',
                'No active adventure': 'This party does not have an active adventure.',
                'Adventure is not in progress': 'The adventure is not currently in progress.',
                'No pending decisions': 'There are no decisions to make at this time.',
                'Not your turn': 'It\'s not your turn to make a decision.',
                'Invalid choice number': 'Please choose a valid option number.',
                'Failed to update adventure state': 'Failed to update adventure state. Please try again.'
            };
            
            const errorMessage = errorMessages[error.message] || 'Failed to process decision. Please try again.';
            
            if (!interaction.deferred) {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.editReply({ content: errorMessage });
            }
        }
    },
}; 