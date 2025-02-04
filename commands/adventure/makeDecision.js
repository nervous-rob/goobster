const { SlashCommandBuilder } = require('discord.js');
const AdventureService = require('../../services/adventure');
const logger = require('../../services/adventure/utils/logger');
const sql = require('mssql');

const adventureService = new AdventureService();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('makedecision')
        .setDescription('Make a decision in your current adventure')
        .addStringOption(option =>
            option.setName('decision')
                .setDescription('Your decision or action')
                .setRequired(true)),

    async execute(interaction) {
        try {
            await interaction.deferReply();
            
            const userId = interaction.user.id;
            const decision = interaction.options.getString('decision');
            
            // Get the user's current party and adventure
            const partyQuery = `
                SELECT TOP 1 pa.adventureId
                FROM parties p
                JOIN partyMembers pm ON p.id = pm.partyId
                JOIN partyAdventures pa ON p.id = pa.partyId
                JOIN adventures a ON pa.adventureId = a.id
                WHERE pm.userId = @userId
                AND p.adventureStatus = 'ACTIVE'
                AND a.status = 'active'
                ORDER BY pa.joinedAt DESC`;

            const result = await sql.query(partyQuery, {
                userId: { type: sql.NVarChar, value: userId }
            });

            if (!result.recordset || !result.recordset.length) {
                throw {
                    userMessage: "You're not currently in an active adventure. Join or create a party and start an adventure first!"
                };
            }

            const adventureId = result.recordset[0].adventureId;
            
            // Process the decision using the service
            const response = await adventureService.processDecision({
                userId,
                adventureId,
                decision,
                voiceChannel: interaction.member?.voice?.channel || null
            });

            // Send the formatted response
            await interaction.editReply(response);

        } catch (error) {
            logger.error('Failed to process decision', { error });
            const errorMessage = error.userMessage || 'Failed to process your decision. Please try again later.';
            
            if (interaction.deferred) {
                await interaction.editReply({ content: errorMessage });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },
};