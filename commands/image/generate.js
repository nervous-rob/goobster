const { SlashCommandBuilder } = require('discord.js');
const imageGenerator = require('../../utils/imageGenerator');
const path = require('path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('generate')
        .setDescription('Generate an image')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('What to generate')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('type')
                .setDescription('Type of image to generate')
                .setRequired(true)
                .addChoices(
                    { name: 'Character', value: 'CHARACTER' },
                    { name: 'Location', value: 'LOCATION' },
                    { name: 'Item', value: 'ITEM' },
                    { name: 'Scene', value: 'SCENE' }
                )
        )
        .addBooleanOption(option =>
            option.setName('usereference')
                .setDescription('Use a reference image?')
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName('referencepath')
                .setDescription('Path to reference image (if using reference)')
                .setRequired(false)
        ),

    async execute(interaction) {
        try {
            await interaction.deferReply();

            const prompt = interaction.options.getString('prompt');
            const type = interaction.options.getString('type');
            const useReference = interaction.options.getBoolean('usereference') ?? false;
            const referencePath = interaction.options.getString('referencepath');

            let referenceOptions = null;
            if (useReference && referencePath) {
                referenceOptions = {
                    referenceImage: referencePath,
                    styleWeight: 0.7
                };
            }

            const imageUrl = await imageGenerator.generateImage(
                type,
                prompt,
                referenceOptions
            );

            const embed = {
                color: 0x0099ff,
                title: '🎨 Generated Image',
                description: prompt,
                fields: [
                    {
                        name: 'Type',
                        value: type,
                        inline: true
                    }
                ],
                image: { url: `attachment://${path.basename(imageUrl)}` }
            };

            await interaction.editReply({
                embeds: [embed],
                files: [{
                    attachment: imageUrl,
                    name: path.basename(imageUrl)
                }]
            });

        } catch (error) {
            console.error('Error in generate:', error);
            const errorMessage = 'Failed to generate image. Please try again.';
            
            if (!interaction.deferred) {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.editReply({ content: errorMessage });
            }
        }
    },
}; 