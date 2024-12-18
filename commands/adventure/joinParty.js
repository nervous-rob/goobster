const { SlashCommandBuilder } = require('discord.js');
const { sql, getConnection } = require('../../azureDb');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('joinparty')
        .setDescription('Join an existing adventure party.')
        .addIntegerOption(option =>
            option.setName('partyid')
                .setDescription('The ID of the party to join')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Your adventurer name')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('backstory')
                .setDescription('Your adventurer\'s backstory (optional)')
                .setRequired(false)
        ),

    async execute(interaction) {
        try {
            await interaction.deferReply();
            await getConnection();

            // Get user info and options
            const username = interaction.user.username;
            const partyId = interaction.options.getInteger('partyid');
            const adventurerName = interaction.options.getString('name');
            const backstory = interaction.options.getString('backstory') || null;

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

                // Check if party exists and is recruiting
                const partyResult = await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .query(`
                        SELECT isActive, adventureStatus 
                        FROM parties 
                        WHERE id = @partyId
                    `);

                if (!partyResult.recordset.length) {
                    throw new Error('Party not found');
                }

                const party = partyResult.recordset[0];
                if (!party.isActive) {
                    throw new Error('Party is no longer active');
                }
                if (party.adventureStatus !== 'RECRUITING') {
                    throw new Error('Party is not recruiting new members');
                }

                // Check if user is already in the party
                const memberCheckResult = await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .input('userId', sql.Int, userId)
                    .query(`
                        SELECT id 
                        FROM partyMembers 
                        WHERE partyId = @partyId AND userId = @userId
                    `);

                if (memberCheckResult.recordset.length > 0) {
                    throw new Error('You are already a member of this party');
                }

                // Add user as party member
                await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .input('userId', sql.Int, userId)
                    .input('adventurerName', sql.NVarChar, adventurerName)
                    .input('backstory', sql.NVarChar, backstory)
                    .query(`
                        INSERT INTO partyMembers (partyId, userId, adventurerName, backstory)
                        VALUES (@partyId, @userId, @adventurerName, @backstory)
                    `);

                // Get current party members
                const membersResult = await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .query(`
                        SELECT adventurerName
                        FROM partyMembers
                        WHERE partyId = @partyId
                        ORDER BY joinedAt ASC
                    `);

                await transaction.commit();

                const membersList = membersResult.recordset
                    .map(m => m.adventurerName)
                    .join('\n• ');

                const embed = {
                    color: 0x0099ff,
                    title: '🎭 Joined Adventure Party!',
                    description: `${adventurerName} has joined the party!`,
                    fields: [
                        {
                            name: 'Party ID',
                            value: `\`${partyId}\``,
                            inline: true
                        },
                        {
                            name: 'Party Members',
                            value: `• ${membersList}`
                        }
                    ]
                };

                if (backstory) {
                    embed.fields.push({
                        name: `${adventurerName}'s Backstory`,
                        value: backstory
                    });
                }

                await interaction.editReply({ embeds: [embed] });

            } catch (error) {
                await transaction.rollback();
                throw error;
            }

        } catch (error) {
            console.error('Error in joinParty:', error);
            const errorMessages = {
                'User not found': 'You need to be registered first. Use /register to get started.',
                'Party not found': 'Could not find a party with that ID.',
                'Party is no longer active': 'This party is no longer active.',
                'Party is not recruiting new members': 'This party is not accepting new members at the moment.',
                'You are already a member of this party': 'You are already a member of this party.'
            };
            
            const errorMessage = errorMessages[error.message] || 'Failed to join party. Please try again.';
            
            if (!interaction.deferred) {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.editReply({ content: errorMessage });
            }
        }
    },
}; 