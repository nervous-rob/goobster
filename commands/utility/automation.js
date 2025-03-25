const { SlashCommandBuilder } = require('@discordjs/builders');
const { createLogger } = require('../../utils/logger');
const aiService = require('../../services/ai/instance');

const logger = createLogger('AutomationCommand');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('automation')
        .setDescription('Generate automation suggestions')
        .addStringOption(option =>
            option.setName('task')
                .setDescription('The task you want to automate')
                .setRequired(true)),

    async execute(interaction) {
        try {
            const task = interaction.options.getString('task');
            
            // Generate automation suggestions using AI service
            const automationPrompt = `
Generate automation suggestions for this task: "${task}"

Provide a detailed response that includes:
1. Possible automation approaches
2. Required tools or technologies
3. Step-by-step implementation guide
4. Potential challenges and solutions
5. Best practices and tips

Format the response with clear sections and bullet points.
Return ONLY the automation suggestions, nothing else.`;

            const automationResponse = await aiService.generateResponse({
                messages: [
                    { role: 'system', content: 'You are an expert at suggesting automation solutions for various tasks.' },
                    { role: 'user', content: automationPrompt }
                ],
                model: 'o1', // Use O1 for automation suggestions
                temperature: 0.7,
                maxTokens: 1000
            });

            await interaction.reply(automationResponse.content);
        } catch (error) {
            logger.error('Error executing automation command:', error);
            await interaction.reply({
                content: 'Sorry, I encountered an error while generating automation suggestions. Please try again.',
                ephemeral: true
            });
        }
    }
}; 