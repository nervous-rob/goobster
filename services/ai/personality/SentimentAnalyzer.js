const { ModelManager } = require('../ModelManager');

class ValidationError extends Error {
    constructor(message, field = null) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
    }
}

/**
 * Enhanced sentiment analysis using AI models with pattern-based fallback
 */
class SentimentAnalyzer {
    constructor() {
        this.modelManager = new ModelManager();
        
        // Analysis thresholds
        this.MIN_CONFIDENCE = 0.6;
        this.MIN_MESSAGES = 1;
        this.MAX_MESSAGES = 50;
        this.MAX_RETRIES = 3;
        
        // Fallback patterns for when AI analysis is not available
        this.patterns = {
            positive: [
                /\b(love|great|awesome|excellent|thank|appreciate|happy|glad|good|nice)\b/i,
                /[😊😃😄😁👍❤️💯]/u,
                /\b(helpful|perfect|amazing|wonderful|fantastic|brilliant)\b/i
            ],
            negative: [
                /\b(hate|bad|terrible|awful|annoying|stupid|useless|wrong)\b/i,
                /[😠😡🤬👎💔]/u,
                /\b(disappointed|frustrated|angry|upset|confused|broken)\b/i
            ],
            neutral: [
                /\b(okay|ok|fine|alright|maybe|perhaps)\b/i,
                /[🤔😐😶]/u,
                /\b(normal|standard|typical|usual|regular)\b/i
            ]
        };

        // Emotion categories for deeper analysis
        this.emotions = {
            joy: ['excited', 'happy', 'delighted', 'pleased', 'content'],
            sadness: ['sad', 'disappointed', 'depressed', 'unhappy', 'down'],
            anger: ['angry', 'frustrated', 'annoyed', 'irritated', 'mad'],
            fear: ['scared', 'worried', 'anxious', 'nervous', 'concerned'],
            surprise: ['amazed', 'shocked', 'astonished', 'unexpected', 'wow'],
            trust: ['confident', 'reliable', 'dependable', 'trustworthy', 'sure'],
            anticipation: ['eager', 'looking forward', 'hopeful', 'excited about', 'cant wait']
        };
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
            throw new ValidationError(`At least ${this.MIN_MESSAGES} message is required for analysis`, 'messages');
        }

        if (messages.length > this.MAX_MESSAGES) {
            throw new ValidationError(`Cannot analyze more than ${this.MAX_MESSAGES} messages at once`, 'messages');
        }

        messages.forEach((msg, index) => {
            if (!msg.content || typeof msg.content !== 'string') {
                throw new ValidationError(`Invalid message content at index ${index}`, 'content');
            }
        });

        return true;
    }

    /**
     * Analyze sentiment using AI with pattern-based fallback
     * @param {Array} messages - Messages to analyze
     * @returns {Promise<Object>} Detailed sentiment analysis
     */
    async analyzeSentiment(messages) {
        try {
            this._validateMessages(messages);

            let retries = 0;
            while (retries < this.MAX_RETRIES) {
                try {
                    // Try AI-based analysis first
                    const aiAnalysis = await this._getAIAnalysis(messages);
                    
                    // Validate confidence
                    if (aiAnalysis.confidence < this.MIN_CONFIDENCE) {
                        console.warn('Low confidence in AI analysis, falling back to pattern-based analysis');
                        throw new Error('Low confidence in AI analysis');
                    }
                    
                    return {
                        ...aiAnalysis,
                        source: 'ai'
                    };
                } catch (error) {
                    retries++;
                    if (retries === this.MAX_RETRIES) {
                        console.warn('AI sentiment analysis failed, using pattern-based fallback:', error);
                        // Fallback to pattern-based analysis
                        return {
                            ...this._getPatternAnalysis(messages),
                            source: 'pattern'
                        };
                    }
                    // Wait before retrying
                    await new Promise(resolve => setTimeout(resolve, 1000 * retries));
                }
            }
        } catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            console.error('Error in sentiment analysis:', error);
            throw new Error('Failed to analyze sentiment');
        }
    }

    /**
     * Get AI-based sentiment analysis
     * @private
     */
    async _getAIAnalysis(messages) {
        const prompt = this._buildAnalysisPrompt(messages);
        
        try {
            const response = await this.modelManager.generateResponse({
                prompt,
                capability: 'analysis',
                options: {
                    temperature: 0.3, // Lower temperature for more consistent analysis
                    model: 'gpt-4o'  // Use most capable model for analysis
                }
            });

            // Parse and validate the structured analysis
            let analysis;
            try {
                analysis = JSON.parse(response.content);
            } catch (error) {
                throw new Error('Failed to parse AI analysis response');
            }

            // Validate required fields
            const requiredFields = ['dominant_sentiment', 'emotions', 'intensity', 'confidence'];
            for (const field of requiredFields) {
                if (!analysis[field]) {
                    throw new Error(`Missing required field in AI analysis: ${field}`);
                }
            }
            
            return {
                dominant: analysis.dominant_sentiment,
                emotions: analysis.emotions,
                intensity: analysis.intensity,
                confidence: analysis.confidence,
                context: {
                    subjectivity: analysis.subjectivity,
                    irony: analysis.irony,
                    sarcasm: analysis.sarcasm_probability
                },
                progression: analysis.sentiment_progression,
                topics: analysis.sentiment_by_topic,
                metadata: {
                    model: response.metadata.model,
                    provider: response.metadata.provider
                }
            };
        } catch (error) {
            throw new Error(`AI analysis failed: ${error.message}`);
        }
    }

    /**
     * Build prompt for AI sentiment analysis
     * @private
     */
    _buildAnalysisPrompt(messages) {
        return `Analyze the sentiment, emotions, and tone of the following conversation messages. 
Provide a detailed analysis including:
- Dominant sentiment (positive, negative, or neutral)
- Detected emotions and their intensities
- Overall sentiment intensity (0-1)
- Analysis confidence score
- Subjectivity assessment
- Detection of irony or sarcasm
- Sentiment progression throughout the conversation
- Sentiment analysis by topic/theme

Format your response as a JSON object with these fields. Messages to analyze:

${messages.map(msg => `[${msg.role}]: ${msg.content}`).join('\n')}

Respond only with the JSON analysis object.`;
    }

    /**
     * Get pattern-based sentiment analysis
     * @private
     */
    _getPatternAnalysis(messages) {
        const results = {
            patterns: {
                positive: 0,
                negative: 0,
                neutral: 0
            },
            emotions: {},
            total: 0
        };

        // Initialize emotion counters
        for (const emotion in this.emotions) {
            results.emotions[emotion] = 0;
        }

        // Analyze each message
        messages.forEach(message => {
            const content = message.content.toLowerCase();
            
            // Check sentiment patterns
            for (const pattern of this.patterns.positive) {
                const matches = content.match(pattern) || [];
                results.patterns.positive += matches.length;
                results.total += matches.length;
            }
            
            for (const pattern of this.patterns.negative) {
                const matches = content.match(pattern) || [];
                results.patterns.negative += matches.length;
                results.total += matches.length;
            }
            
            for (const pattern of this.patterns.neutral) {
                const matches = content.match(pattern) || [];
                results.patterns.neutral += matches.length;
                results.total += matches.length;
            }

            // Check emotion patterns
            for (const [emotion, keywords] of Object.entries(this.emotions)) {
                keywords.forEach(keyword => {
                    if (content.includes(keyword)) {
                        results.emotions[emotion]++;
                        results.total++;
                    }
                });
            }
        });

        // Calculate dominant sentiment
        const { positive, negative, neutral } = results.patterns;
        let dominant = 'neutral';
        if (positive > negative && positive > neutral) {
            dominant = 'positive';
        } else if (negative > positive && negative > neutral) {
            dominant = 'negative';
        }

        // Calculate dominant emotions (top 2)
        const dominantEmotions = Object.entries(results.emotions)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 2)
            .map(([emotion, count]) => ({
                emotion,
                intensity: count / messages.length
            }))
            .filter(({ intensity }) => intensity > 0);

        // Calculate confidence score
        const confidence = this._calculatePatternConfidence(results, messages.length);

        return {
            dominant_sentiment: dominant,
            emotions: dominantEmotions,
            intensity: Math.max(
                results.patterns.positive,
                results.patterns.negative,
                results.patterns.neutral
            ) / messages.length,
            confidence,
            subjectivity: this._calculateSubjectivity(results),
            irony: this._detectIrony(messages),
            sarcasm_probability: this._detectSarcasm(messages),
            sentiment_progression: this._analyzeSentimentProgression(messages),
            sentiment_by_topic: this._analyzeTopicSentiments(messages)
        };
    }

    /**
     * Calculate confidence score for pattern-based analysis
     * @private
     */
    _calculatePatternConfidence(results, messageCount) {
        // Base confidence factors
        const patternDiversity = (results.total > 0) ? 
            Math.min(results.total / messageCount, 1) : 0;
        
        const emotionDiversity = Object.values(results.emotions)
            .filter(count => count > 0).length / Object.keys(results.emotions).length;
        
        const patternStrength = Math.max(
            results.patterns.positive,
            results.patterns.negative,
            results.patterns.neutral
        ) / results.total || 0;
        
        // Calculate weighted confidence score
        const confidence = (
            patternDiversity * 0.4 +
            emotionDiversity * 0.3 +
            patternStrength * 0.3
        );

        return Math.min(Math.max(confidence, 0.1), 0.8); // Cap between 0.1 and 0.8
    }

    /**
     * Calculate subjectivity score
     * @private
     */
    _calculateSubjectivity(results) {
        const objectivePatterns = results.patterns.neutral;
        const subjectivePatterns = results.patterns.positive + results.patterns.negative;
        const total = objectivePatterns + subjectivePatterns;
        
        return total > 0 ? subjectivePatterns / total : 0.5;
    }

    /**
     * Detect potential irony in messages
     * @private
     */
    _detectIrony(messages) {
        let ironyScore = 0;
        const ironyPatterns = [
            /\b(yeah right|sure thing|of course|obviously)\b.*[!?]/i,
            /[!?]{2,}/,
            /\b(how surprising|what a shock|imagine that)\b/i
        ];

        messages.forEach(message => {
            ironyPatterns.forEach(pattern => {
                if (pattern.test(message.content)) {
                    ironyScore++;
                }
            });
        });

        return Math.min(ironyScore / messages.length, 1);
    }

    /**
     * Detect potential sarcasm in messages
     * @private
     */
    _detectSarcasm(messages) {
        let sarcasmScore = 0;
        const sarcasmPatterns = [
            /\b(great|fantastic|awesome|wonderful)\b.*\b(not|never)\b/i,
            /\b(thanks|thank you)\b.*\b(not|never)\b/i,
            /[!?]{3,}/,
            /\b(wow|omg|oh)\b.*\b(really|seriously)\b/i
        ];

        messages.forEach(message => {
            sarcasmPatterns.forEach(pattern => {
                if (pattern.test(message.content)) {
                    sarcasmScore++;
                }
            });
        });

        return Math.min(sarcasmScore / messages.length, 1);
    }

    /**
     * Analyze sentiment progression over messages
     * @private
     */
    _analyzeSentimentProgression(messages) {
        if (messages.length < 2) return null;

        const progression = messages.map(message => {
            const analysis = this._getPatternAnalysis([message]);
            return {
                sentiment: analysis.dominant_sentiment,
                intensity: analysis.intensity
            };
        });

        return {
            trend: this._calculateTrend(progression),
            changes: progression
        };
    }

    /**
     * Calculate sentiment trend
     * @private
     */
    _calculateTrend(progression) {
        const sentimentValues = {
            negative: -1,
            neutral: 0,
            positive: 1
        };

        const values = progression.map(p => 
            sentimentValues[p.sentiment] * p.intensity
        );

        if (values.length < 2) return 'stable';

        const start = values.slice(0, Math.ceil(values.length / 2));
        const end = values.slice(-Math.ceil(values.length / 2));

        const startAvg = start.reduce((a, b) => a + b, 0) / start.length;
        const endAvg = end.reduce((a, b) => a + b, 0) / end.length;

        const diff = endAvg - startAvg;
        if (Math.abs(diff) < 0.2) return 'stable';
        return diff > 0 ? 'improving' : 'deteriorating';
    }

    /**
     * Analyze sentiments by topic
     * @private
     */
    _analyzeTopicSentiments(messages) {
        const topics = new Map();

        messages.forEach(message => {
            const content = message.content.toLowerCase();
            const words = content.split(/\W+/);
            
            // Simple topic extraction (can be enhanced with NLP)
            const potentialTopics = words.filter(word => 
                word.length > 3 && 
                !['this', 'that', 'these', 'those', 'have', 'been'].includes(word)
            );

            potentialTopics.forEach(topic => {
                if (!topics.has(topic)) {
                    topics.set(topic, {
                        positive: 0,
                        negative: 0,
                        neutral: 0,
                        mentions: 0
                    });
                }

                const topicData = topics.get(topic);
                topicData.mentions++;

                // Analyze sentiment in the context of this topic
                const nearbyWords = this._getNearbyWords(content, topic, 5);
                const sentiment = this._analyzeTopicContext(nearbyWords);
                topicData[sentiment]++;
            });
        });

        // Filter and format results
        return Array.from(topics.entries())
            .filter(([, data]) => data.mentions >= 2)
            .map(([topic, data]) => ({
                topic,
                sentiment: this._getTopicSentiment(data),
                confidence: data.mentions / messages.length
            }))
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 5);
    }

    /**
     * Get words near a topic
     * @private
     */
    _getNearbyWords(content, topic, windowSize) {
        const words = content.split(/\W+/);
        const topicIndex = words.indexOf(topic);
        if (topicIndex === -1) return [];

        const start = Math.max(0, topicIndex - windowSize);
        const end = Math.min(words.length, topicIndex + windowSize + 1);
        return words.slice(start, end);
    }

    /**
     * Analyze sentiment in topic context
     * @private
     */
    _analyzeTopicContext(words) {
        let score = 0;
        words.forEach(word => {
            if (this.patterns.positive.some(pattern => pattern.test(word))) score++;
            if (this.patterns.negative.some(pattern => pattern.test(word))) score--;
        });

        if (Math.abs(score) < 0.2) return 'neutral';
        return score > 0 ? 'positive' : 'negative';
    }

    /**
     * Get overall topic sentiment
     * @private
     */
    _getTopicSentiment(data) {
        const total = data.positive + data.negative + data.neutral;
        const positiveRatio = data.positive / total;
        const negativeRatio = data.negative / total;
        const neutralRatio = data.neutral / total;

        if (Math.max(positiveRatio, negativeRatio, neutralRatio) < 0.4) {
            return 'mixed';
        }

        if (positiveRatio > negativeRatio && positiveRatio > neutralRatio) {
            return 'positive';
        }
        if (negativeRatio > positiveRatio && negativeRatio > neutralRatio) {
            return 'negative';
        }
        return 'neutral';
    }
}

module.exports = new SentimentAnalyzer(); 