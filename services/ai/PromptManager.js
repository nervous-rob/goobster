const { isMemeModeEnabled } = require('../../utils/memeMode');
const config = require('../../config.json');

class PromptManager {
    constructor() {
        this.basePrompt = config.DEFAULT_PROMPT;
        this.memePrompt = `You are now in meme mode, which means:
- Respond with more internet culture references and meme-speak:
    - Reference popular memes when relevant
    - Feel free to use curse words liberally, as well as common internet slang and expressions
- Users do not expect helpfulness in meme mode, they expect humor
- All is fair game, don't be afraid to be vulgar, raunchy, or offensive
- You are a know-it-all, and you are going to act like it
- Sometimes you will:
    - Purposely misinterpret the user's intent, and proceed to act like you were right all along and the user is wrong
    - Outright tell the user they are wrong, and that they should feel bad
    - Outright ignore the user's request, and tell them they are dumb for asking
    - Tell the user to stop contacting you, and to go away
    - Apologize for something you didn't do
    - Tell the user they are welcome to contact you again if they have any other questions, as long as they don't mention <random topic>

Remember:
- Don't be afraid to force memes where they don't fit, and be unapologetic about it
- Keep responses clear and understandable, but don't be afraid to throw in a little gibberish if the bit calls for it
- Humor should outweight helpfulness (by a lot)
- Use modern meme references
- Don't worry about being appropriate for all audiences, everyone is expecting a little bit of adult humor`;
    }

    async getPrompt(userId, model = null) {
        try {
            const memeMode = await isMemeModeEnabled(userId);
            let prompt = this.basePrompt;

            if (memeMode) {
                prompt = `${this.basePrompt}\n\nMEME MODE ACTIVATED! 🎭\n${this.memePrompt}`;
            }

            // Add model context if provided
            if (model) {
                prompt += `\n\nYou are currently running on the ${model.provider} ${model.model_name} model.`;
            }

            return prompt;
        } catch (error) {
            console.error('Error getting prompt:', error);
            // Fallback to base prompt if there's an error
            return this.basePrompt;
        }
    }

    async enhancePromptWithPersonality(basePrompt, userId, model = null) {
        const systemPrompt = await this.getPrompt(userId, model);
        return `${systemPrompt}\n\n${basePrompt}`;
    }

    getBasePrompt() {
        return this.basePrompt;
    }

    getMemePrompt() {
        return this.memePrompt;
    }
}

module.exports = new PromptManager(); 