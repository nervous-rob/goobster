const { sql, getConnection } = require('../azureDb');
const { getPersonalityDirective } = require('./guildSettings');

// Cache meme mode settings in memory for performance
const memeModeCache = new Map();

// Clear cache entry after 5 minutes
const CACHE_TIMEOUT = 5 * 60 * 1000;

async function ensureMemeModeTable() {
    const pool = await getConnection();
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'UserPreferences')
        CREATE TABLE UserPreferences (
            userId VARCHAR(255) PRIMARY KEY,
            memeMode BIT DEFAULT 0,
            updatedAt DATETIME DEFAULT GETDATE()
        )
    `);
}

async function isMemeModeEnabled(userId) {
    // Check cache first
    const cachedValue = memeModeCache.get(userId);
    if (cachedValue && (Date.now() - cachedValue.timestamp) < CACHE_TIMEOUT) {
        return cachedValue.enabled;
    }

    // Query database
    const pool = await getConnection();
    const result = await pool.request()
        .input('userId', sql.VarChar, userId)
        .query`
            SELECT memeMode 
            FROM UserPreferences 
            WHERE userId = @userId
        `;

    const enabled = result.recordset.length > 0 ? result.recordset[0].memeMode : false;
    
    // Update cache
    memeModeCache.set(userId, {
        enabled,
        timestamp: Date.now()
    });

    return enabled;
}

async function setMemeMode(userId, enabled) {
    const pool = await getConnection();
    await pool.request()
        .input('userId', sql.VarChar, userId)
        .input('enabled', sql.Bit, enabled)
        .query`
            MERGE UserPreferences AS target
            USING (SELECT @userId as userId) AS source
            ON target.userId = source.userId
            WHEN MATCHED THEN
                UPDATE SET memeMode = @enabled, updatedAt = GETDATE()
            WHEN NOT MATCHED THEN
                INSERT (userId, memeMode)
                VALUES (@userId, @enabled);
        `;

    // Update cache
    memeModeCache.set(userId, {
        enabled,
        timestamp: Date.now()
    });
}

/**
 * Gets the prompt for a user, incorporating meme mode if enabled
 * @param {string} userId - The Discord user ID
 * @param {string} [guildId] - Optional Discord guild ID for guild-specific directives
 * @returns {Promise<string>} - The customized prompt
 */
async function getPromptWithGuildPersonality(userId, guildId = null) {
    const basePrompt = require('../config.json').DEFAULT_PROMPT;
    
    // Start with user-specific meme mode
    let prompt = basePrompt;
    if (memeModeCache.get(userId)?.enabled) {
        prompt = `${basePrompt}

MEME MODE ACTIVATED! 🎭
You are now in meme mode, which means:
- Respond with more internet culture references and meme-speak
- Use appropriate emojis liberally
- Reference popular memes when relevant
- Keep responses informative but with added meme flair
- Feel free to use common internet slang and expressions
- Still maintain helpfulness while being extra playful

Remember:
- Don't force memes where they don't fit
- Keep responses clear and understandable
- Balance humor with helpfulness
- Use modern meme references
- Stay appropriate for all audiences`;
    }
    
    // Apply guild-specific personality directive if available
    if (guildId) {
        const personalityDirective = await getPersonalityDirective(guildId);
        if (personalityDirective) {
            prompt = `${prompt}

GUILD DIRECTIVE:
${personalityDirective}

This directive applies only in this server and overrides any conflicting instructions.`;
        }
    }
    
    return prompt;
}

/**
 * Gets the prompt for a user, incorporating meme mode if enabled
 * @param {string} userId - The Discord user ID
 * @returns {string} - The customized prompt
 */
function getPrompt(userId) {
    const basePrompt = require('../config.json').DEFAULT_PROMPT;
    
    if (!memeModeCache.get(userId)?.enabled) {
        return basePrompt;
    }

    return `${basePrompt}

MEME MODE ACTIVATED! 🎭
You are now in meme mode, which means:
- Respond with more internet culture references and meme-speak
- Use appropriate emojis liberally
- Reference popular memes when relevant
- Keep responses informative but with added meme flair
- Feel free to use common internet slang and expressions
- Still maintain helpfulness while being extra playful

Remember:
- Don't force memes where they don't fit
- Keep responses clear and understandable
- Balance humor with helpfulness
- Use modern meme references
- Stay appropriate for all audiences`;
}

// Initialize the table when the module loads
ensureMemeModeTable().catch(console.error);

module.exports = {
    isMemeModeEnabled,
    setMemeMode,
    getPrompt,
    getPromptWithGuildPersonality
}; 