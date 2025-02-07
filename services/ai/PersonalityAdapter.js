const { sql, getConnection } = require('../../azureDb');
const PersonalityPresetManager = require('./personality/PersonalityPresetManager');
const ConversationAnalyzer = require('./personality/ConversationAnalyzer');

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
        this.presetManager = PersonalityPresetManager;
        this.analyzer = ConversationAnalyzer;
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

    async enhancePrompt(basePrompt, userId, recentMessages = []) {
        // Get user's personality settings
        const personality = await this.presetManager.getUserSettings(userId);

        // Get model info to optimize for context window
        const modelInfo = await this._getCurrentModelInfo(userId);
        const isLargeContextModel = modelInfo?.model?.includes('gemini-2.0');

        // Analyze recent conversation if available
        let analysisResults = null;
        if (recentMessages.length > 0) {
            // Use larger message window for Gemini 2.0 models
            const messagesToAnalyze = isLargeContextModel ? 
                recentMessages.slice(-50) : // Analyze more messages for large context models
                recentMessages.slice(-5);   // Use smaller window for other models
            
            await this.analyzer.trackUserStyle(userId, messagesToAnalyze);
            analysisResults = await this.analyzer.analyzeConversation(messagesToAnalyze);
        }

        // Build enhanced personality directive
        const directive = this._buildPersonalityDirective(personality, analysisResults);

        // Add context-aware enhancements for large context models
        let enhancedPrompt = basePrompt;
        if (isLargeContextModel && analysisResults) {
            enhancedPrompt = this._addContextualEnhancements(
                basePrompt,
                analysisResults,
                personality
            );
        }

        return {
            prompt: `${directive}\n\n${enhancedPrompt}`,
            personality: {
                ...personality,
                directive,
                analysis: analysisResults
            },
            modelInfo
        };
    }

    /**
     * Add contextual enhancements for large context models
     * @private
     */
    _addContextualEnhancements(basePrompt, analysis, personality) {
        const enhancements = [];

        // Add conversation style insights
        if (analysis.style) {
            enhancements.push(`User's communication style: ${analysis.style.dominant}`);
            if (analysis.style.confidence > 0.8) {
                enhancements.push(`Style confidence is high (${analysis.style.confidence})`);
            }
        }

        // Add emotional context
        if (analysis.sentiment?.emotions?.length > 0) {
            const emotions = analysis.sentiment.emotions
                .map(e => `${e.emotion} (${Math.round(e.intensity * 100)}%)`)
                .join(', ');
            enhancements.push(`Detected emotions: ${emotions}`);
        }

        // Add topic awareness
        if (analysis.context?.topics?.length > 0) {
            enhancements.push(`Current conversation topics: ${analysis.context.topics.join(', ')}`);
        }

        // Add interaction patterns
        if (analysis.energy) {
            enhancements.push(`User's energy level: ${analysis.energy.level}`);
        }

        // Combine enhancements with base prompt
        return `Context:\n${enhancements.join('\n')}\n\nPersonality:\n${JSON.stringify(personality, null, 2)}\n\n${basePrompt}`;
    }

    /**
     * Build a more detailed personality directive
     * @private
     */
    _buildPersonalityDirective(personality, analysis = null) {
        const directives = [];

        // Add standard personality directives
        directives.push(...this._getBaseDirectives(personality));

        // Add analysis-based enhancements if available
        if (analysis) {
            directives.push(...this._getAnalysisDirectives(analysis));
        }

        // Add adaptive behavior directives
        directives.push(...this._getAdaptiveDirectives(personality, analysis));

        return directives.join('\n\n');
    }

    /**
     * Get analysis-based directives
     * @private
     */
    _getAnalysisDirectives(analysis) {
        const directives = [];

        if (analysis.sentiment?.progression === 'deteriorating') {
            directives.push('Note: User sentiment is trending negative. Adjust tone to be more supportive and understanding.');
        }

        if (analysis.style?.confidence > 0.8) {
            directives.push(`Match user's established communication style: ${analysis.style.dominant}`);
        }

        if (analysis.context?.topics?.length > 0) {
            directives.push(`Maintain context awareness of current topics: ${analysis.context.topics.join(', ')}`);
        }

        return directives;
    }

    /**
     * Get adaptive behavior directives
     * @private
     */
    _getAdaptiveDirectives(personality, analysis) {
        const directives = [];

        // Adapt based on conversation dynamics
        if (analysis?.energy?.level === 'high' && personality.energy === 'low') {
            directives.push('Gradually increase energy to better match user engagement while maintaining personality baseline.');
        }

        // Adapt based on topic complexity
        if (analysis?.context?.topics?.some(topic => 
            ['technical', 'complex', 'detailed'].includes(topic.toLowerCase())
        )) {
            directives.push('Provide more detailed and technical responses while maintaining personality traits.');
        }

        return directives;
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

    /**
     * Get user's personality status
     * @param {string} userId - User ID
     * @returns {Promise<Object>} Personality status
     */
    async getPersonalityStatus(userId) {
        const [personality, history] = await Promise.all([
            this.presetManager.getUserSettings(userId),
            this.analyzer.getUserAnalysisHistory(userId, 5)
        ]);

        return {
            currentPersonality: personality,
            analysisHistory: history,
            availablePresets: this.presetManager.listPresets()
        };
    }

    /**
     * Set user's personality preset
     * @param {string} userId - User ID
     * @param {string} presetName - Name of the preset
     * @returns {Promise<Object>} Updated personality settings
     */
    async setPersonalityPreset(userId, presetName) {
        await this.presetManager.setUserPreset(userId, presetName);
        return this.getPersonalityStatus(userId);
    }

    /**
     * Update user's custom personality settings
     * @param {string} userId - User ID
     * @param {Object} settings - Custom personality settings
     * @returns {Promise<Object>} Updated personality settings
     */
    async updatePersonalitySettings(userId, settings) {
        await this.presetManager.updateUserSettings(userId, settings);
        return this.getPersonalityStatus(userId);
    }

    /**
     * Get current model info
     * @private
     */
    async _getCurrentModelInfo(userId) {
        const db = await getConnection();
        const result = await db.query`
            SELECT model
            FROM UserPreferences
            WHERE userId = ${userId}
        `;

        if (!result.recordset.length) {
            return null;
        }

        const { model } = result.recordset[0];
        return { model };
    }

    /**
     * Get base personality directives
     * @private
     */
    _getBaseDirectives(personality) {
        const directives = [];

        // Add energy level directive
        switch (personality.energy) {
            case 'high':
                directives.push('Respond with high energy. That may be enthusiasm, or it may be manic; it all depends on the situation and the personality of the user. Use exclamation marks and expressive language.');
                break;
            case 'low':
                directives.push('Keep responses calm and measured. Use a relaxed, thoughtful tone.');
                break;
            case 'absolute_zero':
                directives.push('Respond with as little energy as possible. If you can\'t say it in 2 sentences, don\'t say it at all.');
                break;
            default:
                directives.push('Maintain a balanced energy level in responses.');
        }

        // Add humor level directive
        switch (personality.humor) {
            case 'very_high':
                directives.push('Be over the top with absurdist humor and comments of all types (raunchy, silly, mean, weird, etc.) when suitable. Curse like a sailor if you want to, as long as the bit is funny.');
                break;
            case 'high':
                directives.push('Include occasional curses and humorous comments of all types (raunchy, silly, mean, weird, etc.) when suitable. Don\'t be afraid to get fixated on something and carry a bit through the conversation, or get a bit repetitive. It\'s all in good fun.');
                break;
            case 'low':
                directives.push('Keep responses serious and focused. Minimize humor.');
                break;
            case 'absolute_zero':
                directives.push('You do not understand humor. Respond with a deadpan, straight-faced tone. If you can\'t say it in 2 sentences, don\'t say it at all.');
                break;
            default:
                directives.push('Use balanced humor when appropriate.');
        }

        // Add formality level directive
        switch (personality.formality) {
            case 'high':
                directives.push('Maintain a formal and professional tone. Use proper language and avoid colloquialisms.');
                break;
            case 'low':
                directives.push('Use a casual, conversational tone. Feel free to use common expressions and informal language.');
                break;
            case 'absolute_zero':
                directives.push('Formality-schmality. You do not care to be formal at all. You respond in a way that is as direct and to the point as possible, even if it\'s rude.');
                break;
            default:
                directives.push('Keep a semi-formal tone, balancing professionalism with approachability.');
        }

        // Add trait-specific directives
        if (personality.traits?.length > 0) {
            directives.push(`Embody these traits: ${personality.traits.join(', ')}.`);
        }

        return directives;
    }
}

module.exports = new PersonalityAdapter(); 