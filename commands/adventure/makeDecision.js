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
You are continuing an ongoing adventure. You must maintain consistency with all established elements and advance the story meaningfully while respecting character states.

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
1. Consistency with the theme and setting
2. Progress toward or interaction with major plot points
3. Meaningful use of key elements (characters, items, antagonist)
4. Respect for win/failure conditions
5. Logical progression of time and environment
6. Realistic character state changes based on their current status

Format the response as JSON with the following structure:
{
    "consequence": {
        "description": "detailed description of what happens",
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
            "reason": "explanation for changes"
        }
    ],
    "nextSituation": {
        "description": "description of the new situation",
        "location": "specific location",
        "timeOfDay": "specific time",
        "weather": "specific condition",
        "activeThreats": ["threat1", "threat2"],
        "availableOpportunities": ["opportunity1", "opportunity2"]
    },
    "nextChoices": ["choice1", "choice2", "choice3"],
    "nextPlayerId": number (must be numeric party member ID)
}

Notes:
- All IDs must be numbers matching the party member IDs provided
- Health must be between 0 and 100
- Status must be one of: ACTIVE, INJURED, INCAPACITATED, DEAD
- Each choice should be distinct and impactful
- Consider party member status when determining consequences
- Maintain consistency with all established story elements
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
    const winConditionCheck = await openai.chat.completions.create({
        model: "gpt-4",
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
`
        }]
    });

    try {
        return JSON.parse(winConditionCheck.choices[0].message.content);
    } catch (error) {
        console.error('Failed to parse win condition check response:', error);
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

                // Get current adventure and verify it's in progress
                const adventureResult = await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .query(`
                        SELECT a.id as adventureId, a.currentState, p.adventureStatus
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

                // Get current decision point and verify it's the user's turn
                const decisionResult = await transaction.request()
                    .input('adventureId', sql.Int, adventure.adventureId)
                    .query(`
                        SELECT TOP 1 id, partyMemberId, situation, choices
                        FROM decisionPoints
                        WHERE adventureId = @adventureId
                        AND resolvedAt IS NULL
                        ORDER BY createdAt DESC
                    `);

                console.log('Decision Result:', JSON.stringify(decisionResult, null, 2));

                if (!decisionResult.recordset.length) {
                    throw new Error('No pending decisions');
                }

                const currentDecision = decisionResult.recordset[0];
                debugLog('DEBUG', 'Current Decision', currentDecision);
                
                if (!currentDecision) {
                    throw new Error('Failed to retrieve current decision');
                }

                if (!currentDecision.choices) {
                    debugLog('ERROR', 'Choices property missing from currentDecision');
                    throw new Error('No choices available for current decision');
                }

                debugLog('DEBUG', 'Raw choices value', currentDecision.choices);

                let choices;
                try {
                    choices = JSON.parse(currentDecision.choices);
                    debugLog('DEBUG', 'Parsed choices', choices);
                } catch (error) {
                    debugLog('ERROR', 'Failed to parse choices', error);
                    throw new Error('Invalid choice data format');
                }

                if (!Array.isArray(choices) || choices.length === 0) {
                    debugLog('ERROR', 'Choices validation failed - not an array or empty', choices);
                    throw new Error('No valid choices available');
                }

                if (currentDecision.partyMemberId !== partyMemberId) {
                    throw new Error('Not your turn');
                }

                if (choiceNumber > choices.length) {
                    throw new Error('Invalid choice number');
                }

                const chosenOption = choices[choiceNumber - 1];

                // Get party status for context
                const partyStatusResult = await transaction.request()
                    .input('adventureId', sql.Int, adventure.adventureId)
                    .query(`
                        SELECT pm.adventurerName, ast.*
                        FROM adventurerStates ast
                        JOIN partyMembers pm ON ast.partyMemberId = pm.id
                        WHERE ast.adventureId = @adventureId
                    `);

                const partyStatus = partyStatusResult.recordset.map(member => ({
                    id: member.partyMemberId,
                    name: member.adventurerName,
                    health: member.health,
                    status: member.status,
                    conditions: member.conditions ? JSON.parse(member.conditions) : [],
                    inventory: member.inventory ? JSON.parse(member.inventory) : []
                }));

                // Generate consequence and next situation
                const prompt = DECISION_PROMPT
                    .replace('{situation}', currentDecision.situation)
                    .replace('{partyStatus}', JSON.stringify(partyStatus))
                    .replace('{choice}', chosenOption);

                const completion = await openai.chat.completions.create({
                    model: "gpt-4",
                    messages: [{ role: "user", content: prompt }]
                });

                console.log('OpenAI Response:', completion.choices[0].message.content);

                const response = JSON.parse(completion.choices[0].message.content);

                // Parse current state
                let currentState;
                try {
                    currentState = JSON.parse(adventure.currentState);
                } catch (error) {
                    console.error('Failed to parse current state:', error);
                    currentState = {
                        location: 'unknown',
                        timeOfDay: 'unknown',
                        weather: 'unknown',
                        threats: [],
                        opportunities: [],
                        recentEvents: [],
                        environmentalEffects: []
                    };
                }

                // Update state with new information
                const newState = {
                    ...currentState,
                    recentEvents: [
                        response.consequence,
                        ...(currentState.recentEvents || []).slice(0, 4) // Keep last 5 events
                    ]
                };

                // Extract location, time, weather, and effects from the next situation
                const locationMatch = response.nextSituation.match(/(?:in|at) (.*?)(?:\.|\s|$)/i);
                if (locationMatch) {
                    newState.location = locationMatch[1];
                }

                const timeMatch = response.nextSituation.match(/(?:morning|afternoon|evening|night|dawn|dusk)/i);
                if (timeMatch) {
                    newState.timeOfDay = timeMatch[0];
                }

                const weatherMatch = response.nextSituation.match(/(?:sunny|rainy|cloudy|stormy|clear)/i);
                if (weatherMatch) {
                    newState.weather = weatherMatch[0];
                }

                // Update threats and opportunities based on the new situation
                newState.threats = response.nextSituation.match(/(?:danger|threat|enemy|monster|trap)/gi) || [];
                newState.opportunities = response.nextSituation.match(/(?:treasure|reward|ally|help|resource)/gi) || [];
                newState.environmentalEffects = response.nextSituation.match(/(?:effect|affect|influence)/gi) || [];

                // Update adventure state
                await transaction.request()
                    .input('adventureId', sql.Int, adventure.adventureId)
                    .input('currentState', sql.NVarChar, JSON.stringify(newState))
                    .query(`
                        UPDATE adventures
                        SET currentState = @currentState
                        WHERE id = @adventureId
                    `);

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
                                inventory = @inventory
                            WHERE adventureId = @adventureId
                            AND partyMemberId = @partyMemberId
                        `);
                }

                // Mark current decision as resolved
                await transaction.request()
                    .input('decisionId', sql.Int, currentDecision.id)
                    .input('resolvedAt', sql.DateTime, new Date())
                    .query(`
                        UPDATE decisionPoints
                        SET resolvedAt = @resolvedAt
                        WHERE id = @decisionId
                    `);

                // Create next decision point
                await transaction.request()
                    .input('adventureId', sql.Int, adventure.adventureId)
                    .input('partyMemberId', sql.Int, response.nextPlayerId)
                    .input('situation', sql.NVarChar, response.nextSituation)
                    .input('choices', sql.NVarChar, JSON.stringify(response.nextChoices))
                    .query(`
                        INSERT INTO decisionPoints (adventureId, partyMemberId, situation, choices)
                        VALUES (@adventureId, @partyMemberId, @situation, @choices)
                    `);

                // Check win condition
                const winCheck = await checkWinCondition(openai, adventure, JSON.stringify(newState));
                if (winCheck.isComplete) {
                    await transaction.request()
                        .input('partyId', sql.Int, partyId)
                        .query(`
                            UPDATE parties
                            SET adventureStatus = 'COMPLETED'
                            WHERE id = @partyId
                        `);
                }

                // Create response embed early
                const embed = {
                    color: 0x0099ff,
                    title: `Decision for ${adventurerName}`,
                    description: `Chose: ${chosenOption}`,
                    fields: []
                };

                // After processing GPT response and updating states
                const completionCheck = await checkWinCondition(openai, adventure, response.consequence);

                if (completionCheck.isComplete) {
                    await transaction.request()
                        .input('adventureId', sql.Int, adventure.adventureId)
                        .input('partyId', sql.Int, partyId)
                        .input('completedAt', sql.DateTime, new Date())
                        .query(`
                            UPDATE adventures 
                            SET completedAt = @completedAt 
                            WHERE id = @adventureId;
                            
                            UPDATE parties
                            SET adventureStatus = '${adventureConfig.ADVENTURE_STATUS.COMPLETED}'
                            WHERE id = @partyId;
                        `);
                    
                    embed.fields.push(
                        {
                            name: 'What Happened',
                            value: response.consequence || 'No consequence provided'
                        },
                        {
                            name: '🎉 Adventure Complete!',
                            value: completionCheck.reason
                        }
                    );
                } else {
                    // Get next player based on turn order
                    const nextPlayer = await getNextPlayer(transaction, adventure.adventureId, partyMemberId);

                    // Create next decision point
                    await transaction.request()
                        .input('adventureId', sql.Int, adventure.adventureId)
                        .input('partyMemberId', sql.Int, nextPlayer.id)
                        .input('situation', sql.NVarChar, response.nextSituation)
                        .input('choices', sql.NVarChar, JSON.stringify(response.nextChoices))
                        .query(`
                            INSERT INTO decisionPoints (adventureId, partyMemberId, situation, choices)
                            VALUES (@adventureId, @partyMemberId, @situation, @choices)
                        `);

                    // Update adventure state with structured format
                    const newState = {
                        location: response.nextSituation.match(/(?:in|at) (.*?)(?:\.|\s|$)/i)?.[1] || 'unknown',
                        timeOfDay: response.nextSituation.match(/(?:morning|afternoon|evening|night|dawn|dusk)/i)?.[0] || 'unknown',
                        weather: response.nextSituation.match(/(?:sunny|rainy|cloudy|stormy|clear)/i)?.[0] || 'unknown',
                        threats: response.nextSituation.match(/(?:danger|threat|enemy|monster|trap)/gi) || [],
                        opportunities: response.nextSituation.match(/(?:treasure|reward|ally|help|resource)/gi) || [],
                        recentEvents: [response.consequence],
                        environmentalEffects: response.nextSituation.match(/(?:effect|affect|influence)/gi) || []
                    };

                    await transaction.request()
                        .input('adventureId', sql.Int, adventure.adventureId)
                        .input('currentState', sql.NVarChar, JSON.stringify(newState))
                        .query(`
                            UPDATE adventures
                            SET currentState = @currentState
                            WHERE id = @adventureId
                        `);

                    // Add fields to embed
                    embed.fields.push(
                        {
                            name: 'What Happened',
                            value: response.consequence || 'No consequence provided'
                        },
                        {
                            name: '\u200B',
                            value: '\u200B'
                        },
                        {
                            name: `${nextPlayer.adventurerName}'s Turn`,
                            value: response.nextSituation
                        },
                        {
                            name: 'Available Choices',
                            value: Array.isArray(response.nextChoices) 
                                ? response.nextChoices.map((choice, index) => `${index + 1}. ${choice}`).join('\n')
                                : 'No choices available'
                        }
                    );
                }

                // Add state changes if any occurred
                if (response.stateChanges.length > 0) {
                    const stateChangeText = response.stateChanges
                        .map(change => {
                            const member = partyStatus.find(m => m.id === change.adventurerId);
                            if (!member) return null;
                            
                            const changes = [];
                            if (change.changes.health !== undefined) changes.push(`Health: ${change.changes.health}`);
                            if (change.changes.status) changes.push(`Status: ${change.changes.status}`);
                            if (change.changes.conditions?.length) changes.push(`Conditions: ${change.changes.conditions.join(', ')}`);
                            if (change.changes.inventory?.length) changes.push(`Inventory: ${change.changes.inventory.join(', ')}`);
                            
                            return changes.length ? `${member.name}:\n${changes.join('\n')}` : null;
                        })
                        .filter(text => text !== null)
                        .join('\n\n');

                    if (stateChangeText) {
                        embed.fields.splice(1, 0, {
                            name: 'State Changes',
                            value: stateChangeText
                        });
                    }
                }

                await interaction.editReply({ embeds: [embed] });
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
                'Invalid choice number': 'Please choose a valid option number.'
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