const { SlashCommandBuilder } = require('discord.js');
const { Configuration, OpenAIApi } = require('openai');
const { sql, getConnection } = require('../../azureDb');

const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const ADVENTURE_INIT_PROMPT = `
Create a fantasy adventure with the following elements:
1. A unique theme/setting
2. A compelling plot summary
3. A clear win condition for the party
4. An initial situation that sets up the first decision point

Format the response as JSON with the following structure:
{
    "theme": "brief theme description",
    "plotSummary": "detailed plot summary",
    "winCondition": "specific win condition",
    "initialSituation": "opening scenario",
    "initialChoices": ["choice1", "choice2", "choice3"]
}

Make it engaging and suitable for a text-based role-playing adventure.
`;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('beginadventure')
        .setDescription('Begin the adventure with your party.')
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

            // Start transaction
            const transaction = new sql.Transaction();
            await transaction.begin();

            try {
                // Get user ID
                const userResult = await transaction.request()
                    .input('username', sql.NVarChar, username)
                    .query('SELECT id FROM users WHERE username = @username');
                
                if (!userResult.recordset.length) {
                    throw new Error('User not found');
                }
                const userId = userResult.recordset[0].id;

                // Check if party exists and user is a member
                const partyResult = await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .input('userId', sql.Int, userId)
                    .query(`
                        SELECT p.*, 
                               pm.id as membershipId,
                               (SELECT COUNT(*) FROM partyMembers WHERE partyId = @partyId) as memberCount
                        FROM parties p
                        LEFT JOIN partyMembers pm ON p.id = pm.partyId AND pm.userId = @userId
                        WHERE p.id = @partyId
                    `);

                if (!partyResult.recordset.length) {
                    throw new Error('Party not found');
                }

                const party = partyResult.recordset[0];
                if (!party.membershipId) {
                    throw new Error('You are not a member of this party');
                }
                if (!party.isActive) {
                    throw new Error('Party is no longer active');
                }
                if (party.adventureStatus !== 'RECRUITING') {
                    throw new Error('Adventure has already begun');
                }
                if (party.memberCount < 1) {
                    throw new Error('Need at least one party member to begin');
                }

                // Generate adventure content using GPT-4
                const completion = await openai.createChatCompletion({
                    model: "gpt-4",
                    messages: [{ role: "user", content: ADVENTURE_INIT_PROMPT }],
                });

                const adventureContent = JSON.parse(completion.data.choices[0].message.content);

                // Create adventure entry
                const adventureResult = await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .input('theme', sql.NVarChar, adventureContent.theme)
                    .input('plotSummary', sql.NVarChar, adventureContent.plotSummary)
                    .input('winCondition', sql.NVarChar, adventureContent.winCondition)
                    .input('currentState', sql.NVarChar, adventureContent.initialSituation)
                    .query(`
                        INSERT INTO adventures (partyId, theme, plotSummary, winCondition, currentState)
                        VALUES (@partyId, @theme, @plotSummary, @winCondition, @currentState);
                        SELECT SCOPE_IDENTITY() AS adventureId;
                    `);

                const adventureId = adventureResult.recordset[0].adventureId;

                // Initialize adventurer states
                await transaction.request()
                    .input('adventureId', sql.Int, adventureId)
                    .query(`
                        INSERT INTO adventurerStates (adventureId, partyMemberId)
                        SELECT @adventureId, id
                        FROM partyMembers
                        WHERE partyId = ${partyId}
                    `);

                // Create initial decision point
                const firstMemberResult = await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .query(`
                        SELECT TOP 1 id, adventurerName
                        FROM partyMembers
                        WHERE partyId = @partyId
                        ORDER BY joinedAt ASC
                    `);

                const firstMember = firstMemberResult.recordset[0];
                await transaction.request()
                    .input('adventureId', sql.Int, adventureId)
                    .input('partyMemberId', sql.Int, firstMember.id)
                    .input('situation', sql.NVarChar, adventureContent.initialSituation)
                    .input('choices', sql.NVarChar, JSON.stringify(adventureContent.initialChoices))
                    .query(`
                        INSERT INTO decisionPoints (adventureId, partyMemberId, situation, choices)
                        VALUES (@adventureId, @partyMemberId, @situation, @choices)
                    `);

                // Update party status
                await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .query(`
                        UPDATE parties
                        SET adventureStatus = 'IN_PROGRESS'
                        WHERE id = @partyId
                    `);

                await transaction.commit();

                // Create response embed
                const embed = {
                    color: 0x0099ff,
                    title: '🎮 Adventure Begins!',
                    description: adventureContent.theme,
                    fields: [
                        {
                            name: 'Plot',
                            value: adventureContent.plotSummary
                        },
                        {
                            name: 'Win Condition',
                            value: adventureContent.winCondition
                        },
                        {
                            name: '\u200B',
                            value: '\u200B'
                        },
                        {
                            name: `${firstMember.adventurerName}'s Turn`,
                            value: adventureContent.initialSituation
                        },
                        {
                            name: 'Available Choices',
                            value: adventureContent.initialChoices.map((choice, index) => 
                                `${index + 1}. ${choice}`
                            ).join('\n')
                        }
                    ],
                    footer: {
                        text: `Use /makedecision to choose your action`
                    }
                };

                await interaction.editReply({ embeds: [embed] });

            } catch (error) {
                await transaction.rollback();
                throw error;
            }

        } catch (error) {
            console.error('Error in beginAdventure:', error);
            const errorMessages = {
                'User not found': 'You need to be registered first. Use /register to get started.',
                'Party not found': 'Could not find a party with that ID.',
                'You are not a member of this party': 'You must be a member of the party to begin the adventure.',
                'Party is no longer active': 'This party is no longer active.',
                'Adventure has already begun': 'This party\'s adventure has already started.',
                'Need at least one party member to begin': 'You need at least one party member to begin the adventure.'
            };
            
            const errorMessage = errorMessages[error.message] || 'Failed to begin adventure. Please try again.';
            
            if (!interaction.deferred) {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.editReply({ content: errorMessage });
            }
        }
    },
}; 