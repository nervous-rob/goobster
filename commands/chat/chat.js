const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const aiService = require('../../services/ai/instance');
const conversationManager = require('../../utils/conversationManager');
const responseEnhancer = require('../../utils/responseEnhancer');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Chat with Goobster using different AI models')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('Your message to Goobster')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('model')
                .setDescription('Choose the AI model to use')
                .setRequired(false)
                .addChoices(
                    { name: 'O1', value: 'openai:o1' },
                    { name: 'O1 Mini', value: 'openai:o1-mini' },
                    { name: 'O3 Mini', value: 'openai:o3-mini' },
                    { name: 'GPT-4 Turbo', value: 'openai:gpt-4o' },
                    { name: 'GPT-3.5 Turbo', value: 'openai:gpt-3.5-turbo' },
                    { name: 'Claude 3.7 Sonnet', value: 'anthropic:claude-3-7-sonnet-20250219' },
                    { name: 'Claude 3.5 Sonnet', value: 'anthropic:claude-3-5-sonnet-20241022' },
                    { name: 'Claude 3.5 Haiku', value: 'anthropic:claude-3-5-haiku-20241022' },
                    { name: 'Gemini 2.0 Pro', value: 'google:gemini-2.0-pro' },
                    { name: 'Gemini 2.0 Flash', value: 'google:gemini-2.0-flash' },
                    { name: 'Gemini 2.0 Flash-Lite', value: 'google:gemini-2.0-flash-lite' },
                    { name: 'Gemini 1.5 Pro', value: 'google:gemini-1.5-pro' },
                    { name: 'Sonar Pro', value: 'perplexity:sonar-pro' },
                    { name: 'Sonar Medium', value: 'perplexity:sonar-medium' }
                )),

    async execute(interaction) {
        await interaction.deferReply();
        
        const message = interaction.options.getString('message');
        const model = interaction.options.getString('model') || 'openai:o1';
        const userId = interaction.user.id;
        
        try {
            // Get conversation history
            const conversation = await conversationManager.getConversation(userId);
            
            // Add user message to conversation
            conversation.messages.push({
                role: 'user',
                content: message
            });
            
            // Generate response using selected model
            const response = await aiService.generateResponse({
                model,
                messages: conversation.messages,
                temperature: 0.7
            });
            
            // Enhance the response
            const enhancedResponse = await responseEnhancer.enhanceResponse(response.content, interaction);
            
            // Add assistant response to conversation
            conversation.messages.push({
                role: 'assistant',
                content: enhancedResponse
            });
            
            // Update conversation in database
            await conversationManager.updateConversation(userId, conversation);
            
            // Create embed for response
            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('Goobster\'s Response')
                .setDescription(enhancedResponse)
                .addFields(
                    { name: 'Model Used', value: model, inline: true },
                    { name: 'Response Time', value: `${response.latency}ms`, inline: true },
                    { name: 'Tokens Used', value: `${response.usage.total}`, inline: true }
                )
                .setFooter({ text: 'Powered by AI' })
                .setTimestamp();
            
            await interaction.editReply({ embeds: [embed] });
            
        } catch (error) {
            console.error('Error in chat command:', error);
            await interaction.editReply({
                content: 'Sorry, I encountered an error while processing your message. Please try again later.',
                ephemeral: true
            });
        }
    }
}; 