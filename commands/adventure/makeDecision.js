const { SlashCommandBuilder } = require('discord.js');
const { Configuration, OpenAIApi } = require('openai');
const { sql, getConnection } = require('../../azureDb');
const config = require('./config');

const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const DECISION_PROMPT = `
Given the current situation and the player's choice, generate the consequences and the next decision point.
Current situation: {situation}
Party status: {partyStatus}
Player choice: {choice}

Format the response as JSON with the following structure:
{
    "consequence": "detailed description of what happens",
    "stateChanges": [
        {
            "adventurerId": "affected party member's ID",
            "changes": {
                "health": "health change (number)",
                "status": "new status if changed",
                "conditions": ["new condition 1", "new condition 2"],
                "inventory": ["new item 1", "new item 2"]
            }
        }
    ],
    "nextSituation": "description of the new situation",
    "nextChoices": ["choice1", "choice2", "choice3"],
    "nextPlayerId": "ID of the party member who should make the next decision"
}

Make the consequences meaningful and the story engaging.
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
                    AND ast.status != '${config.CHARACTER_STATUS.DEAD}'
                    AND ast.status != '${config.CHARACTER_STATUS.INCAPACITATED}'
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

// Add function for checking win condition
async function checkWinCondition(openai, adventure, currentState) {
    const winConditionCheck = await openai.createChatCompletion({
        model: "gpt-4",
        messages: [{
            role: "user",
            content: `
Given the win condition and current state:
Win Condition: ${adventure.winCondition}
Current State: ${currentState}

Has the win condition been met? Respond with a JSON object:
{
    "isComplete": boolean,
    "reason": "brief explanation of why the condition is or isn't met"
}
`
        }]
    });

    return JSON.parse(winConditionCheck.data.choices[0].message.content);
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

            // Start transaction
            const transaction = new sql.Transaction();
            await transaction.begin();

            try {
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
                        SELECT pm.adventurerName, ast.*
                        FROM adventurerStates ast
                        JOIN partyMembers pm ON ast.partyMemberId = pm.id
                        WHERE ast.adventureId = @adventureId
                    `);

                const partyStatus = partyStatusResult.recordset.map(member => ({
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

                const completion = await openai.createChatCompletion({
                    model: "gpt-4",
                    messages: [{ role: "user", content: prompt }],
                });

                const result = JSON.parse(completion.data.choices[0].message.content);

                // Update adventurer states
                for (const change of result.stateChanges) {
                    await transaction.request()
                        .input('adventurerId', sql.Int, change.adventurerId)
                        .input('health', sql.Int, change.changes.health)
                        .input('status', sql.NVarChar, change.changes.status)
                        .input('conditions', sql.NVarChar, JSON.stringify(change.changes.conditions))
                        .input('inventory', sql.NVarChar, JSON.stringify(change.changes.inventory))
                        .query(`
                            UPDATE adventurerStates
                            SET health = @health,
                                status = @status,
                                conditions = @conditions,
                                inventory = @inventory,
                                lastUpdated = GETDATE()
                            WHERE partyMemberId = @adventurerId
                        `);
                }

                // Update current decision point
                await transaction.request()
                    .input('decisionId', sql.Int, currentDecision.id)
                    .input('choiceMade', sql.NVarChar, chosenOption)
                    .input('consequence', sql.NVarChar, result.consequence)
                    .query(`
                        UPDATE decisionPoints
                        SET choiceMade = @choiceMade,
                            consequence = @consequence,
                            resolvedAt = GETDATE()
                        WHERE id = @decisionId
                    `);

                // After processing GPT response and updating states
                const completionCheck = await checkWinCondition(openai, adventure, result.consequence);

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
                            SET adventureStatus = '${config.ADVENTURE_STATUS.COMPLETED}'
                            WHERE id = @partyId;
                        `);
                    
                    // Add completion announcement to embed
                    embed.fields.push(
                        {
                            name: '🎉 Adventure Complete!',
                            value: completionCheck.reason
                        }
                    );
                } else {
                    // Get next player based on turn order
                    const nextPlayer = await getNextPlayer(transaction, adventure.adventureId, partyMemberId);
                    result.nextPlayerId = nextPlayer.id;

                    // Create next decision point
                    await transaction.request()
                        .input('adventureId', sql.Int, adventure.adventureId)
                        .input('partyMemberId', sql.Int, nextPlayer.id)
                        .input('situation', sql.NVarChar, result.nextSituation)
                        .input('choices', sql.NVarChar, JSON.stringify(result.nextChoices))
                        .query(`
                            INSERT INTO decisionPoints (adventureId, partyMemberId, situation, choices)
                            VALUES (@adventureId, @partyMemberId, @situation, @choices)
                        `);

                    // Update adventure state with structured format
                    const newState = {
                        location: result.nextSituation.match(/(?:in|at) (.*?)(?:\.|\s|$)/i)?.[1] || 'unknown',
                        timeOfDay: result.nextSituation.match(/(?:morning|afternoon|evening|night|dawn|dusk)/i)?.[0] || 'unknown',
                        weather: result.nextSituation.match(/(?:sunny|rainy|cloudy|stormy|clear)/i)?.[0] || 'unknown',
                        threats: result.nextSituation.match(/(?:danger|threat|enemy|monster|trap)/gi) || [],
                        opportunities: result.nextSituation.match(/(?:treasure|reward|ally|help|resource)/gi) || [],
                        recentEvents: [result.consequence],
                        environmentalEffects: result.nextSituation.match(/(?:effect|affect|influence)/gi) || []
                    };

                    await transaction.request()
                        .input('adventureId', sql.Int, adventure.adventureId)
                        .input('currentState', sql.NVarChar, JSON.stringify(newState))
                        .query(`
                            UPDATE adventures
                            SET currentState = @currentState
                            WHERE id = @adventureId
                        `);
                }

                await transaction.commit();

                // Get next player's name
                const nextPlayerResult = await sql.query`
                    SELECT adventurerName
                    FROM partyMembers
                    WHERE id = ${result.nextPlayerId}
                `;

                const nextPlayerName = nextPlayerResult.recordset[0].adventurerName;

                // Create response embed
                const embed = {
                    color: 0x0099ff,
                    title: `🎲 ${adventurerName}'s Decision`,
                    description: `Chose: ${chosenOption}`,
                    fields: [
                        {
                            name: 'What Happened',
                            value: result.consequence
                        },
                        {
                            name: '\u200B',
                            value: '\u200B'
                        },
                        {
                            name: `${nextPlayerName}'s Turn`,
                            value: result.nextSituation
                        },
                        {
                            name: 'Available Choices',
                            value: result.nextChoices.map((choice, index) => 
                                `${index + 1}. ${choice}`
                            ).join('\n')
                        }
                    ],
                    footer: {
                        text: `Use /makedecision to choose your action`
                    }
                };

                // Add state changes if any occurred
                if (result.stateChanges.length > 0) {
                    const stateChangeText = result.stateChanges
                        .map(change => {
                            const member = partyStatus.find(m => m.id === change.adventurerId);
                            return `${member.name}:
                                ${change.changes.health ? `Health: ${change.changes.health}` : ''}
                                ${change.changes.status ? `Status: ${change.changes.status}` : ''}
                                ${change.changes.conditions?.length ? `Conditions: ${change.changes.conditions.join(', ')}` : ''}
                                ${change.changes.inventory?.length ? `Inventory: ${change.changes.inventory.join(', ')}` : ''}
                            `.trim();
                        })
                        .join('\n');

                    embed.fields.splice(1, 0, {
                        name: 'State Changes',
                        value: stateChangeText
                    });
                }

                await interaction.editReply({ embeds: [embed] });

            } catch (error) {
                await transaction.rollback();
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