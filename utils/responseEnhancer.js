const { createLogger } = require('./logger');
const aiService = require('../services/ai/instance');

const logger = createLogger('ResponseEnhancer');

async function enhanceResponse(response, userId, guildId, userContext) {
    try {
        const enhancementPrompt = `
You are an AI response enhancer. Your task is to improve the following response while maintaining its core meaning and accuracy.

Original Response:
${response}

User Context:
- Interaction Count: ${userContext.interactionCount}
- Last Interaction: ${new Date(userContext.lastInteraction).toLocaleString()}
- Topics of Interest: ${Array.from(userContext.topics).join(', ')}

Enhance the response by:
1. Making it more engaging and natural
2. Adding relevant personality based on user context
3. Maintaining the original information and accuracy
4. Using appropriate emojis and formatting
5. Keeping the same core message

Return ONLY the enhanced response, nothing else.`;

        const enhancedResponse = await aiService.generateResponse({
            messages: [
                { role: 'system', content: 'You are an expert at enhancing AI responses while maintaining accuracy and adding personality.' },
                { role: 'user', content: enhancementPrompt }
            ],
            model: 'o1-mini', // Use O1 Mini for response enhancement
            temperature: 0.7,
            maxTokens: 1000
        });

        return enhancedResponse.content;
    } catch (error) {
        logger.error('Error enhancing response:', error);
        return response; // Return original response if enhancement fails
    }
}

module.exports = {
    enhanceResponse
};