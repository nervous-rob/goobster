const { SlashCommandBuilder } = require('discord.js');
const { sql, getConnection } = require('../../azureDb');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('startadventure')
        .setDescription('Start a new adventure party.')
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

            // Get user info
            const username = interaction.user.username;
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

                // Create new party
                const partyResult = await transaction.request()
                    .query('INSERT INTO parties DEFAULT VALUES; SELECT SCOPE_IDENTITY() AS partyId;');
                const partyId = partyResult.recordset[0].partyId;

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

                await transaction.commit();

                const embed = {
                    color: 0x0099ff,
                    title: '🎭 Adventure Party Created!',
                    description: `A new adventure party has been formed with ${adventurerName} as the first member!`,
                    fields: [
                        {
                            name: 'Party ID',
                            value: `\`${partyId}\``,
                            inline: true
                        },
                        {
                            name: 'Status',
                            value: 'Recruiting',
                            inline: true
                        }
                    ],
                    footer: {
                        text: 'Other players can join using /joinparty'
                    }
                };

                if (backstory) {
                    embed.fields.push({
                        name: 'Backstory',
                        value: backstory
                    });
                }

                await interaction.editReply({ embeds: [embed] });

            } catch (error) {
                await transaction.rollback();
                throw error;
            }

        } catch (error) {
            console.error('Error in startAdventure:', error);
            const errorMessage = error.message === 'User not found' 
                ? 'You need to be registered first. Use /register to get started.'
                : 'Failed to create adventure party. Please try again.';
            
            if (!interaction.deferred) {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.editReply({ content: errorMessage });
            }
        }
    },
}; 