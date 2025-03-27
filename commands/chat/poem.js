const { SlashCommandBuilder } = require('@discordjs/builders');
const { createLogger } = require('../../utils/logger');
const aiService = require('../../services/ai/instance');

const logger = createLogger('PoemCommand');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('poem')
        .setDescription('Generate a poem on any topic')
        .addStringOption(option =>
            option.setName('topic')
                .setDescription('The topic for the poem')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('style')
                .setDescription('The style of the poem')
                .setRequired(false)
                .addChoices(
                    { name: 'Haiku', value: 'haiku' },
                    { name: 'Sonnet', value: 'sonnet' },
                    { name: 'Free Verse', value: 'free' },
                    { name: 'Limerick', value: 'limerick' }
                )),

    async execute(interaction) {
        try {
            const topic = interaction.options.getString('topic');
            const style = interaction.options.getString('style') || 'free';

            // Generate poem using AI service
            const poemPrompt = `
Generate a ${style} poem about "${topic}".

Requirements:
1. Follow the ${style} style guidelines strictly
2. Be creative and engaging
3. Use appropriate imagery and metaphors
4. Maintain proper rhythm and flow
5. Keep the content appropriate for all audiences

Return ONLY the poem, nothing else.`;

            const poemResponse = await aiService.generateResponse({
                messages: [
                    { role: 'system', content: 'You are an expert poet who can write in various styles.' },
                    { role: 'user', content: poemPrompt }
                ],
                model: 'openai:o1', // Use O1 for creative writing
                temperature: 0.8,
                maxTokens: 500
            });

            await interaction.reply(poemResponse.content);
        } catch (error) {
            logger.error('Error executing poem command:', error);
            await interaction.reply({
                content: 'Sorry, I encountered an error while generating the poem. Please try again.',
                ephemeral: true
            });
        }
    }
};