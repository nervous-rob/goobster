const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const aiModelService = require('../../services/aiModelService');
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
                    { name: 'GPT-4', value: 'gpt-4' },
                    { name: 'GPT-4 Turbo', value: 'gpt-4-turbo' },
                    { name: 'GPT-3.5 Turbo', value: 'gpt-3.5-turbo' },
                    { name: 'Claude 3 Opus', value: 'claude-3-opus' },
                    { name: 'Claude 3 Sonnet', value: 'claude-3-sonnet' },
                    { name: 'Gemini Pro', value: 'gemini-pro' }
                )),

    async execute(interaction) {
        await interaction.deferReply();
        
        const message = interaction.options.getString('message');
        const model = interaction.options.getString('model') || 'gpt-4';
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
            const response = await aiModelService.generateResponse({
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
                    { name: 'Tokens Used', value: `${response.tokens.total}`, inline: true }
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