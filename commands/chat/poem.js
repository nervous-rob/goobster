const { SlashCommandBuilder } = require('discord.js');
const aiService = require('../../services/aiService');
const { getPromptWithGuildPersonality } = require('../../utils/memeMode');
const { chunkMessage } = require('../../utils/index');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('poem')
        .setDescription('Generate a poem about a topic')
        .addStringOption(option =>
            option.setName('topic')
                .setDescription('Topic for the poem')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('style')
                .setDescription('Style of the poem')
                .setRequired(false)
                .addChoices(
                    { name: 'Free Verse', value: 'free' },
                    { name: 'Haiku', value: 'haiku' },
                    { name: 'Sonnet', value: 'sonnet' },
                    { name: 'Limerick', value: 'limerick' },
                    { name: 'Epic', value: 'epic' }
                )),

    async execute(interaction) {
        await interaction.deferReply();

        const topic = interaction.options.getString('topic') || 'random';
        const style = interaction.options.getString('style') || 'free';
        const guildId = interaction.guild?.id;
        const systemPrompt = await getPromptWithGuildPersonality(interaction.user.id, guildId);
        
        try {
            const response = await aiService.chat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Write a ${style} poem about ${topic}. Be creative and expressive!` }
            ], {
                preset: 'creative',
                max_tokens: 250
            });

            await interaction.editReply(response);
        } catch (error) {
            console.error('Error generating poem:', error);
            await interaction.editReply('Sorry, my poetic muse seems to be taking a break! Try again later. 📝');
        }
    },
};