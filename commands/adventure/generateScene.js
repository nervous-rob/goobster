const { SlashCommandBuilder } = require('discord.js');
const { sql, getConnection } = require('../../azureDb');
const adventureConfig = require('../../config/adventureConfig');
const imageGenerator = require('../../utils/imageGenerator');
const path = require('path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('generatescene')
        .setDescription('Generate a scene image based on the current adventure state')
        .addIntegerOption(option =>
            option.setName('partyid')
                .setDescription('The ID of your party')
                .setRequired(true)
        )
        .addBooleanOption(option =>
            option.setName('usereference')
                .setDescription('Use previous images as reference?')
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName('referencetype')
                .setDescription('Type of reference image to use')
                .setRequired(false)
                .addChoices(
                    { name: 'Last Scene', value: 'SCENE' },
                    { name: 'Location', value: 'LOCATION' },
                    { name: 'Character', value: 'CHARACTER' }
                )
        ),

    async execute(interaction) {
        let transaction;
        try {
            await interaction.deferReply();
            await getConnection();

            const username = interaction.user.username;
            const partyId = interaction.options.getInteger('partyid');
            const useReference = interaction.options.getBoolean('usereference') ?? false;
            const referenceType = interaction.options.getString('referencetype') || 'SCENE';

            // Get user ID
            const userResult = await sql.query`
                SELECT id FROM users WHERE username = ${username}
            `;
            
            if (!userResult.recordset.length) {
                throw new Error('User not found');
            }
            const userId = userResult.recordset[0].id;

            // Check party status and membership
            const partyResult = await sql.query`
                SELECT p.*, 
                       pm.id as membershipId,
                       a.id as adventureId,
                       a.currentState,
                       (SELECT COUNT(*) FROM partyMembers WHERE partyId = ${partyId}) as memberCount
                FROM parties p
                LEFT JOIN partyMembers pm ON p.id = pm.partyId AND pm.userId = ${userId}
                LEFT JOIN adventures a ON p.id = a.partyId
                WHERE p.id = ${partyId}
            `;

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
            if (party.adventureStatus !== 'IN_PROGRESS') {
                throw new Error('No active adventure found for this party');
            }

            // Get party members for the scene
            const membersResult = await sql.query`
                SELECT adventurerName, backstory
                FROM partyMembers
                WHERE partyId = ${partyId}
                ORDER BY joinedAt ASC
            `;

            // Parse current state
            const currentState = JSON.parse(party.currentState);
            const location = currentState.location;
            const environment = currentState.environment;

            // Generate scene description with fallbacks
            const sceneDescription = `
                ${location.place || 'Unknown location'} - ${location.surroundings || 'A mysterious place'}
                Current conditions: ${environment.timeOfDay || 'unknown time'}, ${environment.weather || 'clear weather'}, ${environment.visibility || 'normal visibility'}
                ${location.landmarks?.length ? `Notable landmarks: ${location.landmarks.join(', ')}` : ''}
                ${currentState.elements?.threats?.length ? `Threats: ${currentState.elements.threats.join(', ')}` : ''}
                ${currentState.elements?.opportunities?.length ? `Opportunities: ${currentState.elements.opportunities.join(', ')}` : ''}
            `.trim().replace(/\n\s+/g, ' ');

            // Get reference image if requested
            let referenceImage = null;
            if (useReference) {
                try {
                    // Get the most recent image of the specified type
                    const recentImage = await imageGenerator.getMostRecentImage(
                        party.adventureId,
                        referenceType
                    );

                    if (recentImage) {
                        referenceImage = recentImage.filepath;
                        console.log(`Using reference image: ${referenceImage}`);
                    }
                } catch (error) {
                    console.warn('Failed to get reference image:', error);
                    // Continue without reference if it fails
                }
            }

            // Generate the scene image with reference
            const sceneUrl = await imageGenerator.generateSceneImage(
                party.adventureId,
                sceneDescription,
                membersResult.recordset,
                referenceImage ? {
                    referenceImage,
                    referenceType,
                    styleWeight: 0.7 // How much to maintain the reference style (0-1)
                } : undefined
            );

            // Create embed with reference info
            const embed = {
                color: 0x0099ff,
                title: '🎨 Generated Scene',
                description: sceneDescription || 'A scene from your adventure',
                fields: [
                    {
                        name: 'Location',
                        value: location.place || 'Unknown location',
                        inline: true
                    },
                    {
                        name: 'Time',
                        value: environment.timeOfDay || 'Unknown time',
                        inline: true
                    },
                    {
                        name: 'Weather',
                        value: environment.weather || 'Unknown weather',
                        inline: true
                    }
                ],
                image: { url: `attachment://${path.basename(sceneUrl)}` },
                footer: useReference && referenceImage ? {
                    text: `Generated with reference to previous ${referenceType.toLowerCase()}`
                } : undefined
            };

            // Add optional fields if they exist
            if (location.landmarks?.length) {
                embed.fields.push({
                    name: 'Landmarks',
                    value: location.landmarks.join(', '),
                    inline: false
                });
            }

            if (currentState.elements?.threats?.length) {
                embed.fields.push({
                    name: 'Active Threats',
                    value: currentState.elements.threats.join(', '),
                    inline: false
                });
            }

            if (currentState.elements?.opportunities?.length) {
                embed.fields.push({
                    name: 'Opportunities',
                    value: currentState.elements.opportunities.join(', '),
                    inline: false
                });
            }

            // Send the embed with the image
            await interaction.editReply({
                embeds: [embed],
                files: [{
                    attachment: sceneUrl,
                    name: path.basename(sceneUrl)
                }]
            });

        } catch (error) {
            console.error('Error in generateScene:', error);
            
            const errorMessages = {
                'User not found': 'You need to be registered first. Use /register to get started.',
                'Party not found': 'Could not find a party with that ID.',
                'You are not a member of this party': 'You must be a member of the party to generate scenes.',
                'Party is no longer active': 'This party is no longer active.',
                'No active adventure found for this party': 'This party does not have an active adventure.',
                'Failed to generate image': 'Failed to generate the scene image. Please try again.',
                'No reference image found': 'Could not find a suitable reference image. Generating without reference.'
            };
            
            const errorMessage = errorMessages[error.message] || 'Failed to generate scene. Please try again.';
            
            if (!interaction.deferred) {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.editReply({ content: errorMessage });
            }
        }
    },
}; 