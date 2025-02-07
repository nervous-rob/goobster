const { sql, getConnection } = require('../../azureDb');

// Personality validation schemas
const VALID_LEVELS = {
    energy: ['low', 'medium', 'high'],
    humor: ['low', 'medium', 'high', 'very_high'],
    formality: ['low', 'medium', 'high']
};

// Personality presets with their characteristics
const PERSONALITY_PRESETS = {
    helper: {
        energy: 'medium',
        humor: 'medium',
        formality: 'medium',
        traits: ['helpful', 'friendly', 'clear']
    },
    meme: {
        energy: 'high',
        humor: 'very_high',
        formality: 'low',
        traits: ['internet_culture', 'playful', 'witty']
    },
    professional: {
        energy: 'medium',
        humor: 'low',
        formality: 'high',
        traits: ['professional', 'precise', 'formal']
    }
};

class ValidationError extends Error {
    constructor(message, field = null) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
    }
}

class PersonalityAdapter {
    constructor() {
        this.API_VERSION = 'v1';
        this.presets = PERSONALITY_PRESETS;
        this.validLevels = VALID_LEVELS;
    }

    validatePersonalitySettings(settings) {
        if (!settings || typeof settings !== 'object') {
            throw new ValidationError('Invalid personality settings format');
        }

        // Validate required fields
        for (const [field, levels] of Object.entries(this.validLevels)) {
            if (settings[field] && !levels.includes(settings[field])) {
                throw new ValidationError(`Invalid ${field} level: ${settings[field]}`, field);
            }
        }

        // Validate traits
        if (settings.traits) {
            if (!Array.isArray(settings.traits)) {
                throw new ValidationError('Traits must be an array', 'traits');
            }
            if (settings.traits.some(trait => typeof trait !== 'string')) {
                throw new ValidationError('All traits must be strings', 'traits');
            }
        }

        return true;
    }

    async getUserPersonality(userId) {
        if (!userId) {
            throw new ValidationError('User ID is required');
        }

        const db = await getConnection();
        const result = await db.query`
            SELECT personality_preset, personality_settings, memeMode
            FROM UserPreferences
            WHERE userId = ${userId}
        `;

        if (!result.recordset.length) {
            return {
                ...this.presets.helper,
                source: 'default'
            };
        }

        const { personality_preset, personality_settings, memeMode } = result.recordset[0];
        
        // If meme mode is on, override with meme personality
        if (memeMode) {
            return {
                ...this.presets.meme,
                source: 'meme_mode'
            };
        }

        // Use preset if no custom settings
        if (!personality_settings) {
            return {
                ...this.presets[personality_preset] || this.presets.helper,
                source: personality_preset ? 'preset' : 'default'
            };
        }

        try {
            // Merge preset with custom settings
            const basePreset = this.presets[personality_preset] || this.presets.helper;
            const customSettings = JSON.parse(personality_settings);
            
            // Validate merged settings
            const mergedSettings = {
                ...basePreset,
                ...customSettings
            };
            this.validatePersonalitySettings(mergedSettings);

            return {
                ...mergedSettings,
                source: 'custom'
            };
        } catch (error) {
            console.error('Error parsing personality settings:', error);
            return {
                ...this.presets.helper,
                source: 'default_fallback',
                error: error.message
            };
        }
    }

    async enhancePrompt(basePrompt, userId) {
        if (!basePrompt) {
            throw new ValidationError('Base prompt is required');
        }

        const personality = await this.getUserPersonality(userId);
        
        // Build personality directive
        const directive = [
            `Respond with ${personality.energy} energy and ${personality.formality} formality.`,
            personality.humor === 'very_high' ? 'Be very humorous and playful.' :
            personality.humor === 'high' ? 'Include appropriate humor.' :
            personality.humor === 'low' ? 'Be serious and focused.' : 'Use balanced humor.',
            `Embody these traits: ${personality.traits.join(', ')}.`
        ].join(' ');

        return {
            enhancedPrompt: `${directive}\n\n${basePrompt}`,
            personality: {
                ...personality,
                apiVersion: this.API_VERSION
            }
        };
    }

    async analyzeConversation(messages, userId) {
        if (!Array.isArray(messages)) {
            throw new ValidationError('Messages must be an array');
        }

        if (!messages.length) {
            throw new ValidationError('At least one message is required');
        }

        // Get last 5 messages for quick style analysis
        const recentMessages = messages.slice(-5);
        
        // Simple sentiment/style analysis
        const style = {
            energy: this.analyzeEnergy(recentMessages),
            humor: this.analyzeHumor(recentMessages),
            formality: this.analyzeFormality(recentMessages),
            analyzedAt: new Date().toISOString(),
            messageCount: recentMessages.length
        };

        try {
            // Validate analysis results
            this.validatePersonalitySettings(style);

            // Store analysis for future reference
            const db = await getConnection();
            await db.query`
                UPDATE UserPreferences
                SET personality_settings = ${JSON.stringify(style)}
                WHERE userId = ${userId}
            `;

            return {
                style,
                apiVersion: this.API_VERSION,
                source: 'analysis'
            };
        } catch (error) {
            console.error('Error storing personality analysis:', error);
            throw new ValidationError('Failed to store personality analysis');
        }
    }

    async analyzeBulkConversations(conversationBatch) {
        if (!Array.isArray(conversationBatch)) {
            throw new ValidationError('Conversation batch must be an array');
        }

        if (conversationBatch.length > 10) {
            throw new ValidationError('Batch size cannot exceed 10 conversations');
        }

        return Promise.all(conversationBatch.map(async ({ messages, userId }) => {
            try {
                return await this.analyzeConversation(messages, userId);
            } catch (error) {
                return {
                    userId,
                    error: error.message,
                    success: false
                };
            }
        }));
    }

    analyzeEnergy(messages) {
        // Simple analysis based on punctuation and caps
        const energyMarkers = messages.reduce((count, msg) => {
            return count + 
                (msg.content.match(/!|\?|CAPS_WORD/g) || []).length +
                (msg.content.match(/[A-Z]{2,}/g) || []).length;
        }, 0);

        return energyMarkers > 10 ? 'high' :
               energyMarkers > 5 ? 'medium' : 'low';
    }

    analyzeHumor(messages) {
        // Check for humor indicators
        const humorMarkers = messages.reduce((count, msg) => {
            return count +
                (msg.content.match(/😂|🤣|lol|lmao|haha|joke/gi) || []).length +
                (msg.content.match(/\?!/g) || []).length;
        }, 0);

        return humorMarkers > 8 ? 'very_high' :
               humorMarkers > 4 ? 'high' :
               humorMarkers > 2 ? 'medium' : 'low';
    }

    analyzeFormality(messages) {
        // Basic formality analysis
        const informalMarkers = messages.reduce((count, msg) => {
            return count +
                (msg.content.match(/gonna|wanna|dunno|yeah|nah|u|r|ur/gi) || []).length +
                (msg.content.match(/[!?]{2,}|\.{3,}/g) || []).length;
        }, 0);

        return informalMarkers > 10 ? 'low' :
               informalMarkers > 5 ? 'medium' : 'high';
    }
}

module.exports = new PersonalityAdapter(); 