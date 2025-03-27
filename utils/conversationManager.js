const { sql, getConnection } = require('../azureDb');
const { getPreferredUserName, getBotPreferredName } = require('./guildContext');
const { getPersonalityDirective } = require('./guildSettings');

class ConversationManager {
    constructor() {
        // Cache for user preferences and patterns
        this.userCache = new Map();
        // Cache for conversation context
        this.contextCache = new Map();
        // Cache for response patterns
        this.responseCache = new Map();
        // Cache for retry attempts
        this.retryCache = new Map();
        
        // Cleanup interval (every hour)
        setInterval(() => this.cleanup(), 3600000);
    }
    
    async getUserContext(userId, guildId, retryCount = 0) {
        const cacheKey = `${userId}-${guildId}`;
        if (this.userCache.has(cacheKey)) {
            return this.userCache.get(cacheKey);
        }
        
        try {
            const db = await getConnection();
            if (!db) {
                throw new Error('Failed to connect to database');
            }
            
            // Get or create user preferences with retry logic
            const result = await this.executeWithRetry(async () => {
                // First try to get existing preferences
                const existingResult = await db.query`
                    SELECT * FROM user_preferences 
                    WHERE userId = ${userId} AND guildId = ${guildId}
                `;

                if (existingResult.recordset.length > 0) {
                    // Update existing preferences
                    await db.query`
                        UPDATE user_preferences
                        SET updatedAt = GETUTCDATE()
                        WHERE userId = ${userId} AND guildId = ${guildId}
                    `;
                    return existingResult;
                } else {
                    // Insert new preferences
                    const insertResult = await db.query`
                        INSERT INTO user_preferences (
                            userId, guildId, preferredName, interactionCount, lastInteraction
                        )
                        VALUES (
                            ${userId}, 
                            ${guildId}, 
                            ${await getPreferredUserName(userId, guildId)}, 
                            0, 
                            GETUTCDATE()
                        );
                        
                        SELECT * FROM user_preferences 
                        WHERE userId = ${userId} AND guildId = ${guildId}
                    `;
                    return insertResult;
                }
            }, retryCount);
            
            const preferences = result.recordset[0];
            
            const context = {
                preferredName: preferences.preferredName,
                personalityDirective: await getPersonalityDirective(guildId, userId),
                interactionCount: preferences.interactionCount,
                lastInteraction: preferences.lastInteraction,
                topics: new Set(preferences.topics ? JSON.parse(preferences.topics) : []),
                sentimentScore: preferences.sentimentScore
            };
            
            this.userCache.set(cacheKey, context);
            return context;
        } catch (error) {
            console.error('Error getting user context:', {
                error: error.message,
                userId,
                guildId,
                retryCount
            });
            
            // If we haven't exceeded retry limit, try again
            if (retryCount < 3) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
                return this.getUserContext(userId, guildId, retryCount + 1);
            }
            
            // Return basic context if all retries fail
            return {
                preferredName: await getPreferredUserName(userId, guildId),
                personalityDirective: await getPersonalityDirective(guildId, userId),
                interactionCount: 0,
                lastInteraction: Date.now(),
                topics: new Set(),
                sentimentScore: 0
            };
        }
    }
    
    async updateUserContext(userId, guildId, updates, retryCount = 0) {
        try {
            const db = await getConnection();
            if (!db) {
                throw new Error('Failed to connect to database');
            }
            
            const context = await this.getUserContext(userId, guildId);
            const updatedContext = { ...context, ...updates };
            
            await this.executeWithRetry(async () => {
                await db.query`
                    UPDATE user_preferences
                    SET 
                        interactionCount = ${updatedContext.interactionCount},
                        lastInteraction = GETUTCDATE(),
                        topics = ${JSON.stringify(Array.from(updatedContext.topics))},
                        sentimentScore = ${updatedContext.sentimentScore}
                    WHERE userId = ${userId} AND guildId = ${guildId}
                `;
            }, retryCount);
            
            this.userCache.set(`${userId}-${guildId}`, updatedContext);
            return updatedContext;
        } catch (error) {
            console.error('Error updating user context:', {
                error: error.message,
                userId,
                guildId,
                retryCount
            });
            
            // If we haven't exceeded retry limit, try again
            if (retryCount < 3) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
                return this.updateUserContext(userId, guildId, updates, retryCount + 1);
            }
            
            return context;
        }
    }
    
    async getConversationContext(guildConversationId, retryCount = 0) {
        const cacheKey = `conv-${guildConversationId}`;
        if (this.contextCache.has(cacheKey)) {
            return this.contextCache.get(cacheKey);
        }
        
        try {
            const db = await getConnection();
            if (!db) {
                throw new Error('Failed to connect to database');
            }
            
            const result = await this.executeWithRetry(async () => {
                return await db.query`
                    SELECT contextSummary, lastUpdated
                    FROM conversation_context
                    WHERE guildConversationId = ${guildConversationId}
                `;
            }, retryCount);
            
            const context = result.recordset[0] || {
                contextSummary: '',
                lastUpdated: new Date()
            };
            
            this.contextCache.set(cacheKey, context);
            return context;
        } catch (error) {
            console.error('Error getting conversation context:', {
                error: error.message,
                guildConversationId,
                retryCount
            });
            
            // If we haven't exceeded retry limit, try again
            if (retryCount < 3) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
                return this.getConversationContext(guildConversationId, retryCount + 1);
            }
            
            return { contextSummary: '', lastUpdated: new Date() };
        }
    }
    
    async executeWithRetry(operation, retryCount = 0) {
        try {
            return await operation();
        } catch (error) {
            if (retryCount < 3 && this.isRetryableError(error)) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
                return this.executeWithRetry(operation, retryCount + 1);
            }
            throw error;
        }
    }
    
    isRetryableError(error) {
        // List of error codes that are safe to retry
        const retryableCodes = [
            1205, // Deadlock
            1222, // Lock timeout
            233,  // Connection timeout
            10054, // Connection reset
            10060, // Connection timeout
            10061  // Connection refused
        ];
        
        return retryableCodes.includes(error.number) || 
               error.message.includes('timeout') ||
               error.message.includes('deadlock');
    }
    
    cleanup() {
        const now = Date.now();
        // Remove stale entries (older than 24 hours)
        for (const [key, value] of this.userCache.entries()) {
            if (now - value.lastInteraction > 86400000) {
                this.userCache.delete(key);
            }
        }
        
        // Clean up context cache (older than 1 hour)
        for (const [key, value] of this.contextCache.entries()) {
            if (now - value.lastUpdated > 3600000) {
                this.contextCache.delete(key);
            }
        }
        
        // Clean up retry cache (older than 5 minutes)
        for (const [key, timestamp] of this.retryCache.entries()) {
            if (now - timestamp > 300000) {
                this.retryCache.delete(key);
            }
        }
    }
}

module.exports = new ConversationManager(); 