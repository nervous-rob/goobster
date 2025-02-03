const { SlashCommandBuilder } = require('discord.js');
const imageGenerator = require('../../utils/imageGenerator');
const path = require('path');
const adventureConfig = require('../../config/adventureConfig');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('generate')
        .setDescription('Generate an image using AI')
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
        .addStringOption(option =>
            option.setName('style')
                .setDescription('Style of the image')
                .setRequired(false)
                .addChoices(
                    { name: 'Fantasy (Default)', value: 'fantasy' },
                    { name: 'Realistic', value: 'realistic' },
                    { name: 'Anime', value: 'anime' },
                    { name: 'Comic', value: 'comic' },
                    { name: 'Watercolor', value: 'watercolor' },
                    { name: 'Oil Painting', value: 'oil_painting' }
                )
        )
        .addStringOption(option =>
            option.setName('quality')
                .setDescription('Quality of the generated image')
                .setRequired(false)
                .addChoices(
                    { name: 'Standard', value: 'standard' },
                    { name: 'HD', value: 'hd' }
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
            const style = interaction.options.getString('style') || 'fantasy';
            const quality = interaction.options.getString('quality') || 'standard';
            const useReference = interaction.options.getBoolean('usereference') ?? false;
            const referencePath = interaction.options.getString('referencepath');

            // Validate reference path if useReference is true
            if (useReference && !referencePath) {
                await interaction.editReply('If using a reference image, you must provide a reference path.');
                return;
            }

            // Create style parameters based on selected style
            const styleParams = {
                ...adventureConfig.IMAGES.DEFAULT_STYLE,
                quality: quality === 'hd' ? 'hd' : 'standard'
            };

            // Modify style parameters based on selected style
            switch (style) {
                case 'realistic':
                    styleParams.artStyle = 'photorealistic';
                    styleParams.colorPalette = 'natural and balanced';
                    break;
                case 'anime':
                    styleParams.artStyle = 'anime art style';
                    styleParams.colorPalette = 'vibrant anime colors';
                    break;
                case 'comic':
                    styleParams.artStyle = 'comic book art style';
                    styleParams.colorPalette = 'bold comic colors';
                    break;
                case 'watercolor':
                    styleParams.artStyle = 'watercolor painting';
                    styleParams.colorPalette = 'soft watercolor tones';
                    break;
                case 'oil_painting':
                    styleParams.artStyle = 'oil painting';
                    styleParams.colorPalette = 'rich oil paint colors';
                    break;
                // fantasy is default, uses DEFAULT_STYLE
            }

            // Add type-specific style parameters
            const typeStyle = adventureConfig.IMAGES[type] || {};
            Object.assign(styleParams, typeStyle);

            // Prepare reference options if using reference
            let referenceOptions = null;
            if (useReference && referencePath) {
                referenceOptions = {
                    referenceImage: referencePath,
                    styleWeight: 0.7
                };
            }

            // Show generating message
            await interaction.editReply({
                content: `🎨 Generating ${style} ${type.toLowerCase()} image in ${quality} quality...`,
                embeds: [{
                    color: 0x0099ff,
                    title: 'Image Generation Started',
                    description: prompt,
                    fields: [
                        { name: 'Type', value: type, inline: true },
                        { name: 'Style', value: style, inline: true },
                        { name: 'Quality', value: quality, inline: true }
                    ]
                }]
            });

            // Generate the image
            const imageUrl = await imageGenerator.generateImage(
                type,
                prompt,
                referenceOptions,
                interaction.user.id,  // Use as adventureId for rate limiting
                prompt.slice(0, 30)   // Use truncated prompt as reference key
            );

            // Create response embed
            const embed = {
                color: 0x00ff00,
                title: '🎨 Generated Image',
                description: prompt,
                fields: [
                    { name: 'Type', value: type, inline: true },
                    { name: 'Style', value: style, inline: true },
                    { name: 'Quality', value: quality, inline: true }
                ],
                image: { url: `attachment://${path.basename(imageUrl)}` },
                footer: { text: 'Generated with DALL-E 3' }
            };

            // Send the response
            await interaction.editReply({
                content: '✨ Image generated successfully!',
                embeds: [embed],
                files: [{
                    attachment: imageUrl,
                    name: path.basename(imageUrl)
                }]
            });

        } catch (error) {
            console.error('Error in generate command:', error);
            
            // Prepare user-friendly error message
            let errorMessage = 'Failed to generate image.';
            if (error.message.includes('Rate limit')) {
                errorMessage = 'You have reached the rate limit for image generation. Please try again later.';
            } else if (error.message.includes('content policy')) {
                errorMessage = 'The image could not be generated due to content policy restrictions. Please modify your prompt.';
            } else if (error.message.includes('Invalid reference')) {
                errorMessage = 'The reference image provided is invalid or inaccessible.';
            }

            const errorEmbed = {
                color: 0xff0000,
                title: '❌ Image Generation Failed',
                description: errorMessage,
                fields: [
                    { name: 'Error Details', value: error.message.slice(0, 1000), inline: false }
                ]
            };
            
            try {
                if (!interaction.deferred) {
                    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
                } else {
                    await interaction.editReply({ embeds: [errorEmbed] });
                }
            } catch (replyError) {
                console.error('Failed to send error message:', replyError);
            }
        }
    },
}; 