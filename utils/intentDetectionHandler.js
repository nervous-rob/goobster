/**
 * IntentDetectionHandler.js
 * Provides lightweight NLP methods to determine if the bot should respond to a message
 * based on the context and content without needing explicit mentions
 */

const fs = require('fs');
const path = require('path');

class IntentDetectionHandler {
    constructor() {
        // Initialize rule-based patterns
        this.intentPatterns = {
            // Direct question patterns
            directQuestion: [
                /(?:^|\s)(?:can|could|would|will|should|is|are|was|were|do|does|did|have|has|had)(?:\s+\w+){1,4}\?/i, // Common question forms
                /^(?:what|who|where|when|why|how)(?:\s+\w+){1,10}\??$/i, // WH-questions
                /^.*\?$/i // Any message ending with a question mark
            ],
            
            // Command-like patterns (imperative)
            command: [
                /^(?:please|pls|plz)?\s*(?:help|show|tell|give|find|search|get|list|display|check|explain|describe)/i,
                /^(?:show|tell|give|find|search|get|list|display|check|explain|describe|create|make|set|add)/i
            ],
            
            // Conversational hooks
            conversational: [
                /^(?:hey|hi|hello|greetings|yo|sup)/i,
                /^(?:thanks|thank you|thx|ty)/i
            ],
            
            // Bot name references (beyond exact matches that are already handled)
            botReference: [
                /\b(?:bot|assistant|ai|goob|gooby|goobster|goobs)\b/i
            ]
        };
        
        // Keyword importance weights
        this.keywordWeights = {
            // High relevance keywords
            high: [
                'help', 'question', 'answer', 'explain', 'tell', 'show', 'how', 'why', 'what',
                'who', 'where', 'when', 'assistance', 'guide', 'tutorial', 'information'
            ],
            
            // Medium relevance keywords
            medium: [
                'need', 'want', 'looking', 'searching', 'trying', 'please', 'thanks', 'create',
                'make', 'find', 'get', 'know', 'understand', 'think', 'recommend', 'suggest'
            ]
        };
        
        // Thresholds for response probability
        this.thresholds = {
            default: 0.65,  // Default threshold
            directQuestion: 0.75,
            command: 0.70,
            conversational: 0.80,
            botReference: 0.60,
            keywordTrigger: 0.80
        };
        
        // Context tracking for recent conversations
        this.contextMemory = new Map();
        this.CONTEXT_RETENTION_TIME = 60 * 60 * 1000; // 1 hour
        
        // Set up scheduled cleanup
        setInterval(() => this.cleanupContextMemory(), this.CONTEXT_RETENTION_TIME);
        
        console.log('Intent Detection Handler initialized');
    }
    
    /**
     * Clean up old context memory entries
     */
    cleanupContextMemory() {
        const now = Date.now();
        for (const [channelId, context] of this.contextMemory.entries()) {
            if (now - context.lastUpdated > this.CONTEXT_RETENTION_TIME) {
                this.contextMemory.delete(channelId);
            }
        }
    }
    
    /**
     * Update the context for a channel
     * @param {string} channelId - The channel ID
     * @param {Object} message - The Discord message object
     * @param {boolean} botResponded - Whether the bot responded to this message
     */
    updateContext(channelId, message, botResponded = false) {
        if (!this.contextMemory.has(channelId)) {
            this.contextMemory.set(channelId, {
                messages: [],
                lastUpdated: Date.now(),
                activeConversation: false,
                botMessageCount: 0,
                userMessageCount: 0
            });
        }
        
        const context = this.contextMemory.get(channelId);
        
        // Add message to context
        context.messages.push({
            content: message.content,
            author: message.author.id,
            timestamp: Date.now(),
            botResponded
        });
        
        // Limit context size
        if (context.messages.length > 10) {
            context.messages.shift();
        }
        
        // Update context state
        context.lastUpdated = Date.now();
        if (message.author.bot) {
            context.botMessageCount++;
        } else {
            context.userMessageCount++;
        }
        
        // Set active conversation flag if there's recent bot activity
        const recentMessages = context.messages.filter(
            m => Date.now() - m.timestamp < 5 * 60 * 1000 // Last 5 minutes
        );
        const recentBotMessages = recentMessages.filter(m => m.botResponded);
        context.activeConversation = recentBotMessages.length > 0;
    }
    
    /**
     * Check if a message matches any of the pattern categories
     * @param {string} content - The message content to check
     * @returns {Object} - Object with match results for each category
     */
    checkPatternMatches(content) {
        const matches = {};
        
        for (const [category, patterns] of Object.entries(this.intentPatterns)) {
            matches[category] = patterns.some(pattern => pattern.test(content));
        }
        
        return matches;
    }
    
    /**
     * Calculate keyword relevance score for a message
     * @param {string} content - The message content to analyze
     * @returns {number} - The keyword relevance score (0-1)
     */
    calculateKeywordRelevance(content) {
        const words = content.toLowerCase().split(/\s+/);
        let score = 0;
        
        // Check for high relevance keywords
        const highRelevanceCount = this.keywordWeights.high.filter(keyword => 
            words.includes(keyword) || content.toLowerCase().includes(keyword)
        ).length;
        
        // Check for medium relevance keywords
        const mediumRelevanceCount = this.keywordWeights.medium.filter(keyword => 
            words.includes(keyword) || content.toLowerCase().includes(keyword)
        ).length;
        
        // Calculate weighted score
        score = (highRelevanceCount * 0.15) + (mediumRelevanceCount * 0.05);
        
        // Normalize score to 0-1 range
        return Math.min(score, 1);
    }
    
    /**
     * Calculate conversational context score based on recent interactions
     * @param {string} channelId - The channel ID
     * @returns {number} - Conversational context score (0-1)
     */
    calculateContextScore(channelId) {
        if (!this.contextMemory.has(channelId)) {
            return 0;
        }
        
        const context = this.contextMemory.get(channelId);
        
        // If there's an active conversation, increase probability
        if (context.activeConversation) {
            return 0.3;
        }
        
        // Calculate recency score - more recent interactions get higher scores
        const mostRecentBotMessage = context.messages
            .filter(m => m.botResponded)
            .sort((a, b) => b.timestamp - a.timestamp)[0];
            
        if (mostRecentBotMessage) {
            const timeSinceLastBot = Date.now() - mostRecentBotMessage.timestamp;
            const recencyScore = Math.max(0, 1 - (timeSinceLastBot / (10 * 60 * 1000))); // Decays over 10 minutes
            return recencyScore * 0.2;
        }
        
        return 0;
    }
    
    /**
     * Determine if the bot should respond to a message
     * @param {Object} message - The Discord message object
     * @param {string} guildId - The Discord guild ID
     * @returns {Object} - Result with shouldRespond flag and confidence score
     */
    shouldRespond(message, guildId) {
        // Skip processing bot messages
        if (message.author.bot) return { shouldRespond: false, confidence: 0 };
        
        // Get message content
        const content = message.content.trim();
        
        // Skip very short messages unless they're questions
        if (content.length < 2 && !content.endsWith('?')) {
            return { shouldRespond: false, confidence: 0 };
        }
        
        // Check pattern matches
        const patternMatches = this.checkPatternMatches(content);
        
        // Calculate keyword relevance
        const keywordScore = this.calculateKeywordRelevance(content);
        
        // Calculate context score
        const contextScore = this.calculateContextScore(message.channelId);
        
        // Calculate total probability
        let totalScore = contextScore;
        let confidenceBoosts = [];
        
        // Add pattern match scores
        if (patternMatches.directQuestion) {
            totalScore += 0.4;
            confidenceBoosts.push('directQuestion');
        }
        
        if (patternMatches.command) {
            totalScore += 0.3;
            confidenceBoosts.push('command');
        }
        
        if (patternMatches.conversational) {
            totalScore += 0.2;
            confidenceBoosts.push('conversational');
        }
        
        if (patternMatches.botReference) {
            totalScore += 0.35;
            confidenceBoosts.push('botReference');
        }
        
        // Add keyword score
        totalScore += keywordScore;
        if (keywordScore > 0.3) {
            confidenceBoosts.push('keywordTrigger');
        }
        
        // Normalize total score to 0-1 range
        totalScore = Math.min(Math.max(totalScore, 0), 1);
        
        // Determine if we should respond based on the highest applicable threshold
        let thresholdCategory = 'default';
        if (confidenceBoosts.length > 0) {
            // Use the threshold of the highest confidence category
            confidenceBoosts.sort((a, b) => this.thresholds[b] - this.thresholds[a]);
            thresholdCategory = confidenceBoosts[0];
        }
        
        const threshold = this.thresholds[thresholdCategory];
        const shouldRespond = totalScore >= threshold;
        
        return { 
            shouldRespond, 
            confidence: totalScore,
            threshold,
            thresholdCategory,
            patternMatches,
            keywordScore,
            contextScore
        };
    }
}

module.exports = new IntentDetectionHandler(); 