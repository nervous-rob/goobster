/**
 * Database plumbing for the chat pipeline: user/conversation row management,
 * message tracking, system-event logging, and health diagnostics.
 */
const db = require('../../db');

const DB_HEALTH_CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes

/**
 * Logs a system event to the database
 * @param {string} level - The log level (ERROR, WARN, INFO, DEBUG)
 * @param {string} message - The log message
 * @param {Object} metadata - Additional metadata to store
 * @returns {Promise<void>}
 */
async function logSystemEvent(level, message, metadata = {}) {
    try {
        db.run(
            `INSERT INTO system_logs (log_level, message, metadata, source, error_code, error_state)
             VALUES (@level, @message, @metadata, @source, @errorCode, @errorState)`,
            {
                level,
                message,
                metadata: JSON.stringify(metadata),
                source: metadata.source || null,
                errorCode: metadata.error_code || null,
                errorState: metadata.error_state || null
            }
        );
    } catch (error) {
        console.error('Error logging system event:', error);
    }
}

/**
 * Looks up a user by Discord ID, creating the record if needed.
 * @param {string} discordId - The Discord user ID (snowflake)
 * @param {string} username - Username to store when creating the record
 * @returns {number} Internal user id
 */
function getOrCreateUser(discordId, username) {
    const existing = db.get('SELECT id FROM users WHERE discordId = @discordId', { discordId });
    if (existing) return existing.id;

    const result = db.run(
        'INSERT INTO users (discordUsername, discordId, username) VALUES (@username, @discordId, @username)',
        { discordId, username }
    );
    return Number(result.lastInsertRowid);
}

/**
 * Looks up a conversation for a user within a guild conversation, creating it if needed.
 * @param {number} userId - Internal user id
 * @param {number} guildConvId - guild_conversations id
 * @returns {number} Conversation id
 */
function getOrCreateConversation(userId, guildConvId) {
    const existing = db.get(
        'SELECT id FROM conversations WHERE userId = @userId AND guildConversationId = @guildConvId',
        { userId, guildConvId }
    );
    if (existing) return existing.id;

    const result = db.run(
        'INSERT INTO conversations (userId, guildConversationId) VALUES (@userId, @guildConvId)',
        { userId, guildConvId }
    );
    return Number(result.lastInsertRowid);
}

/**
 * Checks database health by performing basic query operations
 * @returns {Promise<boolean>} True if database is healthy
 */
async function checkDatabaseHealth() {
    console.log('Performing database health check...');

    try {
        const userCount = db.get('SELECT COUNT(*) as count FROM users').count;
        const messageCount = db.get('SELECT COUNT(*) as count FROM messages').count;

        // Verify write access with a test insert that is rolled back with the transaction helper.
        db.transaction(() => {
            const result = db.run(
                `INSERT INTO system_logs (log_level, message, source)
                 VALUES ('DEBUG', 'DB health check - write test', 'checkDatabaseHealth')`
            );
            db.run('DELETE FROM system_logs WHERE id = @id', { id: Number(result.lastInsertRowid) });
        });

        console.log('Database health check successful', {
            userCount,
            messageCount,
            time: new Date().toISOString()
        });

        return true;
    } catch (error) {
        console.error('Database health check failed:', {
            error: error.message,
            code: error.code,
            timestamp: new Date().toISOString()
        });
        return false;
    }
}

// Schedule periodic database health checks (unref: never keeps process alive)
setInterval(checkDatabaseHealth, DB_HEALTH_CHECK_INTERVAL).unref?.();

/**
 * Diagnoses database connection issues with detailed reporting
 * @param {Object} interaction - The Discord interaction object
 * @returns {Promise<string>} Diagnostic message
 */
async function diagnoseDatabaseIssues(interaction) {
    try {
        console.log('Running database diagnostics...');

        let hasReadPermission = true;
        let hasWritePermission = true;
        const detailedErrors = [];

        try {
            db.get('SELECT * FROM users LIMIT 1');
        } catch (error) {
            hasReadPermission = false;
            detailedErrors.push(`Read Error: ${error.message}`);
        }

        try {
            db.transaction(() => {
                const result = db.run(
                    `INSERT INTO system_logs (log_level, message, source)
                     VALUES ('DEBUG', 'DB diagnostics - write test', 'diagnoseDatabaseIssues')`
                );
                db.run('DELETE FROM system_logs WHERE id = @id', { id: Number(result.lastInsertRowid) });
            });
        } catch (error) {
            hasWritePermission = false;
            detailedErrors.push(`Write Error: ${error.message}`);
        }

        let diagnosticMessage = "**Database Diagnostic Results**\n";

        if (hasReadPermission && hasWritePermission) {
            diagnosticMessage += "✅ Database connection and permissions appear to be working correctly.\n";

            const recentMessageCount = db.get(
                "SELECT COUNT(*) as count FROM messages WHERE createdAt > datetime('now', '-1 day')"
            );
            const totalMessageCount = db.get('SELECT COUNT(*) as count FROM messages');
            const mostRecentMessage = db.get(
                'SELECT id, createdAt as timestamp, isBot FROM messages ORDER BY createdAt DESC LIMIT 1'
            );

            diagnosticMessage += `✅ Found ${recentMessageCount.count} messages stored in the last 24 hours.\n`;
            diagnosticMessage += `✅ Total message count in database: ${totalMessageCount.count}\n`;

            if (mostRecentMessage) {
                diagnosticMessage += `✅ Most recent message (ID: ${mostRecentMessage.id}) was stored at ${mostRecentMessage.timestamp} (${mostRecentMessage.isBot ? 'bot' : 'user'} message)\n`;
            } else {
                diagnosticMessage += `⚠️ No messages found in the database.\n`;
            }

            // Check for recent errors in system logs
            const recentErrors = db.all(
                `SELECT id, createdAt as timestamp, message
                 FROM system_logs
                 WHERE log_level = 'ERROR' AND createdAt > datetime('now', '-1 day')
                 ORDER BY createdAt DESC LIMIT 10`
            );

            if (recentErrors.length > 0) {
                diagnosticMessage += `\n**Recent Errors (Last 24h):**\n`;
                recentErrors.forEach(error => {
                    diagnosticMessage += `- ${error.timestamp}: ${error.message.substring(0, 100)}...\n`;
                });
            } else {
                diagnosticMessage += "\n**Recent Errors:** No errors logged in the last 24 hours.\n";
            }

            // Database file statistics
            const pageCount = db.getDb().pragma('page_count', { simple: true });
            const pageSize = db.getDb().pragma('page_size', { simple: true });
            const dbSizeMb = ((pageCount * pageSize) / (1024 * 1024)).toFixed(2);
            diagnosticMessage += `\n**Database Info:**\n- Engine: SQLite (better-sqlite3)\n- Size: ${dbSizeMb} MB\n- Journal mode: ${db.getDb().pragma('journal_mode', { simple: true })}\n`;
        } else {
            if (!hasReadPermission) {
                diagnosticMessage += "❌ Cannot read from database tables. This may be a permissions issue.\n";
            }

            if (!hasWritePermission) {
                diagnosticMessage += "❌ Cannot write to database tables. This may be a permissions issue.\n";
            }

            diagnosticMessage += "\nDetailed Errors:\n";
            detailedErrors.forEach(error => {
                diagnosticMessage += `- ${error}\n`;
            });
        }

        return diagnosticMessage;

    } catch (error) {
        console.error('Error in database diagnosis:', error);
        return `Failed to complete database diagnosis: ${error.message}`;
    }
}

/**
 * Creates a placeholder thread ID for channel-only conversations
 * @param {string} channelId - The Discord channel ID
 * @returns {string} - A placeholder thread ID
 */
function createPlaceholderThreadId(channelId) {
    return `channel-${channelId}`;
}

/**
 * Tracks a message in the conversation history
 * @param {string} guildConvId - The guild conversation ID
 * @param {string} discordUserId - The Discord user ID
 * @param {string} message - The message content
 * @param {string} role - The role ('user' or 'assistant')
 */
async function trackMessage(guildConvId, discordUserId, message, role) {
    try {
        const userId = getOrCreateUser(discordUserId, `user_${discordUserId}`);
        const conversationId = getOrCreateConversation(userId, guildConvId);

        db.run(
            `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot)
             VALUES (@conversationId, @guildConvId, @createdBy, @message, @isBot)`,
            {
                conversationId,
                guildConvId,
                createdBy: userId,
                message,
                isBot: role === 'assistant'
            }
        );
    } catch (error) {
        console.error('Error tracking message in database:', {
            error: error.message,
            stack: error.stack,
            guildConvId,
            discordUserId,
            messagePreview: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
            role
        });
        // Don't throw the error, just log it - we don't want to interrupt the flow
    }
}

module.exports = {
    logSystemEvent,
    getOrCreateUser,
    getOrCreateConversation,
    checkDatabaseHealth,
    diagnoseDatabaseIssues,
    createPlaceholderThreadId,
    trackMessage
};
