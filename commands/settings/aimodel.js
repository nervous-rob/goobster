const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const aiService = require('../../services/ai/instance');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('AIModelCommand');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('aimodel')
        .setDescription('Configure which AI model Goobster should use')
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Set the AI model to use')
                .addStringOption(option =>
                    option.setName('model')
                        .setDescription('The AI model to use')
                        .setRequired(true)
                        .addChoices(
                            // OpenAI Models
                            { name: 'OpenAI - O1', value: 'openai:o1' },
                            { name: 'OpenAI - O1 Mini', value: 'openai:o1-mini' },
                            { name: 'OpenAI - O3 Mini', value: 'openai:o3-mini' },
                            { name: 'OpenAI - GPT-4 Turbo', value: 'openai:gpt-4o' },
                            { name: 'OpenAI - GPT-3.5 Turbo', value: 'openai:gpt-3.5-turbo' },
                            // Anthropic Models
                            { name: 'Anthropic - Claude 3.7 Sonnet', value: 'anthropic:claude-3-7-sonnet-20250219' },
                            { name: 'Anthropic - Claude 3.5 Sonnet', value: 'anthropic:claude-3-5-sonnet-20241022' },
                            { name: 'Anthropic - Claude 3.5 Haiku', value: 'anthropic:claude-3-5-haiku-20241022' },
                            // Google Models
                            { name: 'Google - Gemini 2.0 Pro', value: 'google:gemini-2.0-pro' },
                            { name: 'Google - Gemini 2.0 Flash', value: 'google:gemini-2.0-flash' },
                            { name: 'Google - Gemini 2.0 Flash-Lite', value: 'google:gemini-2.0-flash-lite' },
                            { name: 'Google - Gemini 1.5 Pro', value: 'google:gemini-1.5-pro' },
                            // Perplexity Models
                            { name: 'Perplexity - Sonar Pro', value: 'perplexity:sonar-pro' },
                            { name: 'Perplexity - Sonar Medium', value: 'perplexity:sonar-medium' }
                        )))
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View the current AI model configuration'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        try {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'set') {
                const model = interaction.options.getString('model');
                
                // Validate model availability
                const availableModels = aiService.getAvailableModels();
                const [providerName, modelName] = model.split(':');
                if (!availableModels.some(m => m.provider === providerName && m.id === modelName)) {
                    await interaction.reply({
                        content: `❌ The model "${model}" is not available. Please choose from the available models.`,
                        ephemeral: true
                    });
                    return;
                }

                // Set the model
                aiService.setDefaultModel(model);
                
                // Get model details for response
                const modelDetails = availableModels.find(m => m.provider === providerName && m.id === modelName);
                
                // Format capabilities for display
                const capabilities = modelDetails.capabilities.map(cap => 
                    cap.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
                ).join(', ');

                await interaction.reply({
                    content: `✅ Successfully set AI model to ${modelDetails.name}\n\n📝 Model details:\n• ${modelDetails.description}\n• Max tokens: ${modelDetails.maxTokens}\n• Context window: ${modelDetails.contextWindow} tokens\n• Capabilities: ${capabilities}`,
                    ephemeral: true
                });

            } else if (subcommand === 'view') {
                const currentModel = aiService.getDefaultModel();
                const modelDetails = aiService.getAvailableModels().find(m => 
                    m.provider === currentModel.provider && m.id === currentModel.model
                );

                if (!modelDetails) {
                    await interaction.reply({
                        content: '❌ Could not retrieve current model configuration.',
                        ephemeral: true
                    });
                    return;
                }

                // Format capabilities for display
                const capabilities = modelDetails.capabilities.map(cap => 
                    cap.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
                ).join(', ');

                await interaction.reply({
                    content: `🤖 Current AI model: ${modelDetails.name}\n\n📝 Model details:\n• ${modelDetails.description}\n• Max tokens: ${modelDetails.maxTokens}\n• Context window: ${modelDetails.contextWindow} tokens\n• Capabilities: ${capabilities}`,
                    ephemeral: true
                });
            }
        } catch (error) {
            logger.error('Error in aimodel command:', error);
            await interaction.reply({
                content: '❌ An error occurred while managing AI model settings.',
                ephemeral: true
            });
        }
    }
}; 