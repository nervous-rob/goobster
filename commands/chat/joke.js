const { SlashCommandBuilder } = require('@discordjs/builders');
const { createLogger } = require('../../utils/logger');
const aiService = require('../../services/ai/instance');

const logger = createLogger('JokeCommand');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('joke')
        .setDescription('Generate a joke')
        .addStringOption(option =>
            option.setName('category')
                .setDescription('Category of the joke')
                .setRequired(false)
                .addChoices(
                    { name: 'General', value: 'general' },
                    { name: 'Puns', value: 'puns' },
                    { name: 'Dad Jokes', value: 'dad' },
                    { name: 'Knock Knock', value: 'knock' }
                )),

    async execute(interaction) {
        try {
            const category = interaction.options.getString('category') || 'general';

            // Generate joke using AI service
            const jokePrompt = `
Generate a ${category} joke.

Requirements:
1. Keep it family-friendly and appropriate for all audiences
2. Make it funny and engaging
3. If it's a pun, make it clever
4. If it's a dad joke, make it appropriately cheesy
5. If it's a knock-knock joke, follow the proper format

Return ONLY the joke, nothing else.`;

            const jokeResponse = await aiService.generateResponse({
                messages: [
                    { role: 'system', content: 'You are a professional comedian who specializes in creating family-friendly jokes.' },
                    { role: 'user', content: jokePrompt }
                ],
                model: 'openai:o1', // Use O1 for creative writing
                temperature: 0.7,
                maxTokens: 200
            });

            await interaction.reply(jokeResponse.content);
        } catch (error) {
            logger.error('Error executing joke command:', error);
            await interaction.reply({
                content: 'Sorry, I encountered an error while generating the joke. Please try again.',
                ephemeral: true
            });
        }
    }
};
