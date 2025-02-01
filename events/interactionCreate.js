const AISearchHandler = require('../utils/aiSearchHandler');
const perplexityService = require('../services/perplexityService');
const { OpenAI } = require('openai');
const config = require('../config.json');

const openai = new OpenAI({ apiKey: config.openaiKey });

module.exports = {
    name: 'interactionCreate',
    async execute(interaction) {
        // Handle button interactions
        if (interaction.isButton()) {
            const [action, type, requestId] = interaction.customId.split('_');
            
            if (type === 'search') {
                await interaction.deferUpdate();

                if (action === 'approve') {
                    const result = await AISearchHandler.handleSearchApproval(requestId, interaction);
                    if (result) {
                        // Get the original conversation context
                        const messages = await interaction.channel.messages.fetch({ limit: 10 });
                        const originalQuestion = messages.find(m => 
                            !m.author.bot && 
                            (m.content.toLowerCase().includes('search') || 
                             m.content.toLowerCase().includes('look up'))
                        );

                        if (originalQuestion) {
                            // Create a follow-up response using the search results
                            const followUpResponse = await interaction.channel.send({
                                content: "Now that I have the information, let me analyze it and provide a detailed response! 🤔"
                            });

                            // Prepare context for the AI response
                            const context = [
                                { role: 'user', content: originalQuestion.content },
                                { role: 'assistant', content: `I found this information: ${result.result}` },
                                { role: 'user', content: 'Please analyze this information and provide a detailed, helpful response.' }
                            ];

                            // Generate AI response with the search results
                            const completion = await openai.chat.completions.create({
                                messages: context,
                                model: "gpt-4o",
                                temperature: 0.7,
                                max_tokens: 500
                            });

                            // Send the final analysis
                            await followUpResponse.edit({
                                content: completion.choices[0].message.content
                            });
                        }
                    }
                }

                if (action === 'deny') {
                    await AISearchHandler.handleSearchDenial(requestId, interaction);
                }
            }
        }
    }
}; 