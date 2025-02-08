const { sql, getConnection } = require('../../../azureDb');
const PersonalityPresetManager = require('./PersonalityPresetManager');
const SentimentAnalyzer = require('./SentimentAnalyzer');

class ValidationError extends Error {
    constructor(message, field = null) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
    }
}

/**
 * Analyzes conversations to determine user style and context
 */
class ConversationAnalyzer {
    constructor() {
        // Style indicators
        this.stylePatterns = {
            formal: [
                /\b(would you kindly|please|thank you|appreciate|regards)\b/i,
                /\b(hello|greetings|sincerely|furthermore|moreover)\b/i
            ],
            casual: [
                /\b(hey|hi|yeah|cool|awesome|sup|thanks|ok)\b/i,
                /\b(gonna|wanna|kinda|sorta|dunno)\b/i
            ],
            technical: [
                /\b(implement|function|method|api|database|code|bug|error)\b/i,
                /\b(documentation|interface|module|component|service)\b/i
            ]
        };

        // Energy indicators
        this.energyPatterns = {
            high: [
                /[!?]{2,}/,
                /[A-Z]{3,}/,
                /\b(wow|omg|amazing|incredible|awesome)\b/i
            ],
            low: [
                /\b(meh|whatever|ok|fine|guess)\b/i,
                /\.{3,}/
            ]
        };

        this.sentimentAnalyzer = new SentimentAnalyzer();
        
        // Analysis thresholds
        this.CONFIDENCE_THRESHOLD = 0.6;
        this.MIN_MESSAGES = 3;
        this.MAX_MESSAGES = 100;
        this.MAX_BATCH_SIZE = 10;
    }

    /**
     * Validate messages array
     * @private
     */
    _validateMessages(messages) {
        if (!Array.isArray(messages)) {
            throw new ValidationError('Messages must be an array', 'messages');
        }

        if (messages.length < this.MIN_MESSAGES) {
            throw new ValidationError(`At least ${this.MIN_MESSAGES} messages are required for analysis`, 'messages');
        }

        if (messages.length > this.MAX_MESSAGES) {
            throw new ValidationError(`Cannot analyze more than ${this.MAX_MESSAGES} messages at once`, 'messages');
        }

        messages.forEach((msg, index) => {
            if (!msg.content || typeof msg.content !== 'string') {
                throw new ValidationError(`Invalid message content at index ${index}`, 'content');
            }
            if (!msg.role || !['user', 'assistant'].includes(msg.role)) {
                throw new ValidationError(`Invalid message role at index ${index}`, 'role');
            }
        });

        return true;
    }

    /**
     * Analyze a conversation for style and context
     * @param {Array} messages - Array of conversation messages
     * @returns {Promise<Object>} Analysis results
     */
    async analyzeConversation(messages) {
        try {
            this._validateMessages(messages);

            const [sentiment, style, energy, context] = await Promise.all([
                this.sentimentAnalyzer.analyzeSentiment(messages),
                this._analyzeStyle(messages),
                this._analyzeEnergy(messages),
                this._analyzeContext(messages)
            ]);

            const confidence = (sentiment.confidence + style.confidence + energy.confidence) / 3;

            if (confidence < this.CONFIDENCE_THRESHOLD) {
                console.warn('Low confidence in conversation analysis:', {
                    confidence,
                    messageCount: messages.length
                });
            }

            return {
                sentiment,
                style,
                energy,
                context,
                confidence,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            console.error('Error analyzing conversation:', error);
            throw new Error('Failed to analyze conversation');
        }
    }

    /**
     * Track user's conversation style over time
     * @param {string} userId - User ID
     * @param {Array<Object>} messages - Recent conversation messages
     * @param {string} messages[].content - Message content
     * @param {string} messages[].role - Message role (user/assistant)
     * @param {string} [messages[].timestamp] - Optional message timestamp
     * @returns {Promise<void>}
     * @throws {ValidationError} If input validation fails
     * @throws {Error} If tracking fails
     */
    async trackUserStyle(userId, messages) {
        if (!userId) {
            throw new ValidationError('User ID is required', 'userId');
        }

        try {
            const analysis = await this.analyzeConversation(messages);
            
            // Get current model info
            const modelInfo = await this._getCurrentModelInfo(userId);
            
            const db = await getConnection();
            await db.query`
                INSERT INTO conversation_analysis (
                    userId,
                    sentiment,
                    style,
                    energy,
                    context,
                    model_id,
                    provider,
                    confidence_scores,
                    analysis_metadata
                )
                VALUES (
                    ${userId},
                    ${JSON.stringify({
                        dominant: analysis.sentiment.dominant,
                        emotions: analysis.sentiment.emotions,
                        intensity: analysis.sentiment.intensity,
                        progression: analysis.sentiment.progression
                    })},
                    ${JSON.stringify({
                        dominant: analysis.style.dominant,
                        scores: analysis.style.scores,
                        confidence: analysis.style.confidence
                    })},
                    ${JSON.stringify({
                        level: analysis.energy.level,
                        scores: analysis.energy.scores,
                        confidence: analysis.energy.confidence
                    })},
                    ${JSON.stringify(analysis.context)},
                    ${modelInfo?.modelId || null},
                    ${modelInfo?.provider || null},
                    ${JSON.stringify({
                        sentiment: analysis.sentiment.confidence,
                        style: analysis.style.confidence,
                        energy: analysis.energy.confidence,
                        overall: analysis.confidence
                    })},
                    ${JSON.stringify({
                        version: 'v1',
                        timestamp: new Date().toISOString(),
                        messageCount: messages.length,
                        analysisType: 'full'
                    })}
                )
            `;

            // Only update personality if confidence is high enough
            if (analysis.confidence >= this.CONFIDENCE_THRESHOLD) {
                await this._updateUserPersonality(userId, analysis);
            }
        } catch (error) {
            console.error('Error tracking user style:', error);
            throw new Error('Failed to track user conversation style');
        }
    }

    /**
     * Get user's conversation history analysis
     * @param {string} userId - User ID
     * @param {number} [limit=10] - Number of recent analyses to retrieve
     * @returns {Promise<Array<Object>>} Recent conversation analyses
     * @throws {ValidationError} If input validation fails
     * @throws {Error} If retrieval fails
     */
    async getUserAnalysisHistory(userId, limit = 10) {
        if (!userId) {
            throw new ValidationError('User ID is required', 'userId');
        }

        if (limit > this.MAX_BATCH_SIZE) {
            throw new ValidationError(`Cannot retrieve more than ${this.MAX_BATCH_SIZE} analyses at once`, 'limit');
        }

        try {
            const db = await getConnection();
            const result = await db.query`
                SELECT TOP ${limit}
                    id,
                    sentiment,
                    style,
                    energy,
                    context,
                    model_id,
                    provider,
                    confidence_scores,
                    analysis_metadata,
                    timestamp,
                    dominant_sentiment,
                    dominant_style,
                    energy_level
                FROM conversation_analysis
                WHERE userId = ${userId}
                ORDER BY timestamp DESC
            `;

            return result.recordset.map(record => ({
                id: record.id,
                sentiment: JSON.parse(record.sentiment),
                style: JSON.parse(record.style),
                energy: JSON.parse(record.energy),
                context: JSON.parse(record.context),
                modelInfo: {
                    modelId: record.model_id,
                    provider: record.provider
                },
                confidence: JSON.parse(record.confidence_scores),
                metadata: JSON.parse(record.analysis_metadata),
                timestamp: record.timestamp,
                dominant: {
                    sentiment: record.dominant_sentiment,
                    style: record.dominant_style,
                    energy: record.energy_level
                }
            }));
        } catch (error) {
            console.error('Error retrieving user analysis history:', error);
            throw new Error('Failed to retrieve conversation analysis history');
        }
    }

    /**
     * Get current model information for user
     * @private
     * @param {string} userId - User ID
     * @returns {Promise<Object|null>} Model information or null if not found
     */
    async _getCurrentModelInfo(userId) {
        try {
            const db = await getConnection();
            const result = await db.query`
                SELECT mc.id as modelId, mc.provider
                FROM UserPreferences up
                LEFT JOIN model_configs mc ON up.preferred_model_id = mc.id
                WHERE up.userId = ${userId}
            `;

            return result.recordset[0] || null;
        } catch (error) {
            console.error('Error getting model info:', error);
            return null;
        }
    }

    /**
     * Analyze conversation style
     * @private
     */
    _analyzeStyle(messages) {
        const counts = { formal: 0, casual: 0, technical: 0 };
        
        messages.forEach(msg => {
            for (const [style, patterns] of Object.entries(this.stylePatterns)) {
                if (patterns.some(pattern => pattern.test(msg.content))) {
                    counts[style]++;
                }
            }
        });

        // Calculate dominant style
        const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
        return {
            dominant: Object.entries(counts).reduce((max, [style, count]) => 
                count > max.count ? { style, count } : max,
                { style: 'neutral', count: 0 }
            ).style,
            scores: counts,
            confidence: Math.max(...Object.values(counts)) / (total || 1)
        };
    }

    /**
     * Analyze message energy levels
     * @private
     */
    _analyzeEnergy(messages) {
        const counts = { high: 0, medium: 0, low: 0 };
        
        messages.forEach(msg => {
            let matched = false;
            
            if (this.energyPatterns.high.some(pattern => pattern.test(msg.content))) {
                counts.high++;
                matched = true;
            }
            
            if (this.energyPatterns.low.some(pattern => pattern.test(msg.content))) {
                counts.low++;
                matched = true;
            }
            
            if (!matched) counts.medium++;
        });

        const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
        return {
            level: Object.entries(counts).reduce((max, [level, count]) => 
                count > max.count ? { level, count } : max,
                { level: 'medium', count: 0 }
            ).level,
            scores: counts,
            confidence: Math.max(...Object.values(counts)) / total
        };
    }

    /**
     * Analyze conversation context
     * @private
     */
    _analyzeContext(messages) {
        return {
            topics: this._extractTopics(messages),
            messageCount: messages.length,
            averageLength: messages.reduce((sum, msg) => 
                sum + msg.content.length, 0) / messages.length,
            timeSpan: messages.length > 1 ? 
                new Date(messages[messages.length - 1].timestamp) - new Date(messages[0].timestamp) : 0
        };
    }

    /**
     * Extract conversation topics
     * @private
     */
    _extractTopics(messages) {
        // Simple keyword extraction
        const keywords = messages.reduce((acc, msg) => {
            const words = msg.content.toLowerCase()
                .replace(/[^\w\s]/g, '')
                .split(/\s+/)
                .filter(word => word.length > 3);
            
            words.forEach(word => {
                acc[word] = (acc[word] || 0) + 1;
            });
            
            return acc;
        }, {});

        // Return top 5 keywords
        return Object.entries(keywords)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([word]) => word);
    }

    /**
     * Update user's personality based on analysis
     * @private
     * @param {string} userId - User ID
     * @param {Object} analysis - Analysis results
     * @param {Object} analysis.style - Style analysis
     * @param {Object} analysis.sentiment - Sentiment analysis
     * @param {Object} analysis.energy - Energy analysis
     * @returns {Promise<void>}
     */
    async _updateUserPersonality(userId, analysis) {
        // Get current personality settings
        const currentSettings = await PersonalityPresetManager.getUserSettings(userId);
        
        // Create context-based personality adjustments
        const contextStyle = {
            energy: analysis.energy.level,
            formality: analysis.style.dominant === 'formal' ? 'high' : 
                      analysis.style.dominant === 'casual' ? 'low' : 'medium',
            humor: analysis.sentiment.dominant === 'positive' ? 'high' :
                  analysis.sentiment.dominant === 'negative' ? 'low' : 'medium'
        };

        // Mix current settings with context-based adjustments
        const mixedStyle = PersonalityPresetManager.mixStyles(currentSettings, contextStyle);

        // Update user settings if confidence is high enough
        if (analysis.style.confidence > 0.6 && analysis.sentiment.confidence > 0.6) {
            await PersonalityPresetManager.updateUserSettings(userId, mixedStyle);
        }
    }
}

module.exports = ConversationAnalyzer; 