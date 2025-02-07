const { SlashCommandBuilder } = require('discord.js');
const { PersonalityPresetManager } = require('../../services/ai/personality/PersonalityPresetManager');
const { ConversationAnalyzer } = require('../../services/ai/personality/ConversationAnalyzer');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('personality')
        .setDescription('Manage bot personality settings')
        .addSubcommand(subcommand =>
            subcommand
                .setName('preset')
                .setDescription('Set a personality preset')
                .addStringOption(option =>
                    option.setName('preset')
                        .setDescription('Choose a personality preset')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Helper - Balanced and helpful', value: 'helper' },
                            { name: 'Professional - Formal and precise', value: 'professional' },
                            { name: 'Casual - Friendly and relaxed', value: 'casual' },
                            { name: 'Meme - High energy and humorous', value: 'meme' }
                        )))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Check current personality settings'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('customize')
                .setDescription('Customize personality settings')
                .addStringOption(option =>
                    option.setName('energy')
                        .setDescription('Set energy level')
                        .addChoices(
                            { name: 'Low', value: 'low' },
                            { name: 'Medium', value: 'medium' },
                            { name: 'High', value: 'high' }
                        ))
                .addStringOption(option =>
                    option.setName('humor')
                        .setDescription('Set humor level')
                        .addChoices(
                            { name: 'Low', value: 'low' },
                            { name: 'Medium', value: 'medium' },
                            { name: 'High', value: 'high' },
                            { name: 'Very High', value: 'very_high' }
                        ))
                .addStringOption(option =>
                    option.setName('formality')
                        .setDescription('Set formality level')
                        .addChoices(
                            { name: 'Low', value: 'low' },
                            { name: 'Medium', value: 'medium' },
                            { name: 'High', value: 'high' }
                        ))),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const subcommand = interaction.options.getSubcommand();

            switch (subcommand) {
                case 'preset': {
                    const preset = interaction.options.getString('preset');
                    const result = await PersonalityPresetManager.setUserPreset(interaction.user.id, preset);
                    
                    const presetInfo = PersonalityPresetManager.getPreset(preset);
                    await interaction.editReply({
                        content: `✅ Personality preset set to **${preset}**!\n\n` +
                            `**Description:** ${presetInfo.description}\n` +
                            `**Energy:** ${presetInfo.energy}\n` +
                            `**Humor:** ${presetInfo.humor}\n` +
                            `**Formality:** ${presetInfo.formality}\n` +
                            `**Traits:** ${presetInfo.traits.join(', ')}`,
                        ephemeral: true
                    });
                    break;
                }

                case 'status': {
                    const status = await PersonalityPresetManager.getPersonalityStatus(interaction.user.id);
                    const history = await ConversationAnalyzer.getUserAnalysisHistory(interaction.user.id, 1);
                    
                    let replyContent = `🎭 **Current Personality Settings**\n\n`;
                    replyContent += `**Preset:** ${status.currentPersonality.preset || 'Custom'}\n`;
                    replyContent += `**Energy:** ${status.currentPersonality.energy}\n`;
                    replyContent += `**Humor:** ${status.currentPersonality.humor}\n`;
                    replyContent += `**Formality:** ${status.currentPersonality.formality}\n`;
                    replyContent += `**Traits:** ${status.currentPersonality.traits.join(', ')}\n\n`;

                    if (history.length > 0) {
                        const lastAnalysis = history[0];
                        replyContent += `**Recent Analysis**\n`;
                        replyContent += `Dominant Style: ${lastAnalysis.dominant_style}\n`;
                        replyContent += `Energy Level: ${lastAnalysis.energy_level}\n`;
                        replyContent += `Sentiment: ${lastAnalysis.dominant_sentiment}\n`;
                    }

                    await interaction.editReply({
                        content: replyContent,
                        ephemeral: true
                    });
                    break;
                }

                case 'customize': {
                    const energy = interaction.options.getString('energy');
                    const humor = interaction.options.getString('humor');
                    const formality = interaction.options.getString('formality');

                    if (!energy && !humor && !formality) {
                        await interaction.editReply({
                            content: '❌ Please specify at least one personality attribute to customize.',
                            ephemeral: true
                        });
                        return;
                    }

                    const currentSettings = await PersonalityPresetManager.getUserSettings(interaction.user.id);
                    const newSettings = {
                        ...currentSettings,
                        ...(energy && { energy }),
                        ...(humor && { humor }),
                        ...(formality && { formality })
                    };

                    await PersonalityPresetManager.updateUserSettings(interaction.user.id, newSettings);

                    await interaction.editReply({
                        content: `✅ Personality settings updated!\n\n` +
                            `**Energy:** ${newSettings.energy}\n` +
                            `**Humor:** ${newSettings.humor}\n` +
                            `**Formality:** ${newSettings.formality}\n` +
                            `**Traits:** ${newSettings.traits.join(', ')}`,
                        ephemeral: true
                    });
                    break;
                }
            }
        } catch (error) {
            console.error('Error in personality command:', error);
            await interaction.editReply({
                content: '❌ An error occurred while managing personality settings. Please try again.',
                ephemeral: true
            });
        }
    },
}; 