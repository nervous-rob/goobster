/**
 * Meme mode preferences (SQLite edition).
 * The UserPreferences table is created by db/schema.sql.
 */

const db = require('../db');
const { getPersonalityDirective } = require('./guildSettings');

// Cache meme mode settings in memory for performance
const memeModeCache = new Map();

// Clear cache entry after 5 minutes
const CACHE_TIMEOUT = 5 * 60 * 1000;

const MEME_MODE_PROMPT_SUFFIX = `

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

/**
 * Resolve the base system prompt from config, with a safe fallback.
 * @returns {string}
 */
function getBasePrompt() {
    try {
        return require('../config.json').DEFAULT_PROMPT
            || 'You are Goobster, a helpful and friendly Discord bot.';
    } catch {
        return 'You are Goobster, a helpful and friendly Discord bot.';
    }
}

async function isMemeModeEnabled(userId) {
    // Check cache first
    const cachedValue = memeModeCache.get(userId);
    if (cachedValue && (Date.now() - cachedValue.timestamp) < CACHE_TIMEOUT) {
        return cachedValue.enabled;
    }

    const row = db.get(
        'SELECT memeMode FROM UserPreferences WHERE userId = @userId',
        { userId }
    );
    const enabled = row ? Boolean(row.memeMode) : false;

    memeModeCache.set(userId, {
        enabled,
        timestamp: Date.now()
    });

    return enabled;
}

async function setMemeMode(userId, enabled) {
    db.run(
        `INSERT INTO UserPreferences (userId, memeMode, updatedAt)
         VALUES (@userId, @enabled, CURRENT_TIMESTAMP)
         ON CONFLICT(userId) DO UPDATE SET
             memeMode = @enabled,
             updatedAt = CURRENT_TIMESTAMP`,
        { userId, enabled }
    );

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
    let prompt = getBasePrompt();

    if (await isMemeModeEnabled(userId)) {
        prompt = `${prompt}${MEME_MODE_PROMPT_SUFFIX}`;
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
    const basePrompt = getBasePrompt();

    if (!memeModeCache.get(userId)?.enabled) {
        return basePrompt;
    }

    return `${basePrompt}${MEME_MODE_PROMPT_SUFFIX}`;
}

module.exports = {
    isMemeModeEnabled,
    setMemeMode,
    getPrompt,
    getPromptWithGuildPersonality
};
