/**
 * Guild settings storage (SQLite edition).
 *
 * All tables are created by db/schema.sql when the database opens, so there is
 * no runtime table/column guard logic here anymore. Settings are cached
 * in-memory for five minutes to avoid needless disk reads.
 */

const db = require('../db');

// Cache guild settings in memory for performance
const guildSettingsCache = new Map();

// Clear cache entry after 5 minutes
const CACHE_TIMEOUT = 5 * 60 * 1000;

// Thread preference options
const THREAD_PREFERENCE = {
    ALWAYS_THREAD: 'ALWAYS_THREAD',
    ALWAYS_CHANNEL: 'ALWAYS_CHANNEL'
};

// Search approval options
const SEARCH_APPROVAL = {
    REQUIRED: 'REQUIRED',
    NOT_REQUIRED: 'NOT_REQUIRED'
};

// Dynamic response settings
const DYNAMIC_RESPONSE = {
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED'
};

// Reply detection settings (answering mention-free replies to Goobster's own messages)
const REPLY_DETECTION = {
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED'
};

// Proactive (heartbeat) mode settings
const PROACTIVE_MODE = {
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED'
};

// Internal monologue mode settings
const MONOLOGUE_MODE = {
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED'
};

/**
 * Get (or create) the cache entry for a guild.
 * @param {string} guildId
 * @returns {Object}
 */
function getCacheEntry(guildId) {
    let entry = guildSettingsCache.get(guildId);
    if (!entry || (Date.now() - entry.timestamp) > CACHE_TIMEOUT) {
        entry = { timestamp: Date.now() };
        guildSettingsCache.set(guildId, entry);
        setTimeout(() => {
            if (guildSettingsCache.get(guildId) === entry) {
                guildSettingsCache.delete(guildId);
            }
        }, CACHE_TIMEOUT).unref?.();
    }
    return entry;
}

/**
 * Upsert a single column of guild_settings.
 * @param {string} guildId
 * @param {string} column
 * @param {*} value
 */
async function upsertGuildSetting(guildId, column, value) {
    await db.run(
        `INSERT INTO guild_settings (guildId, ${column}, createdAt, updatedAt)
         VALUES (@guildId, @value, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(guildId) DO UPDATE SET
             ${column} = @value,
             updatedAt = CURRENT_TIMESTAMP`,
        { guildId, value }
    );
}

/**
 * Gets the thread preference for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<string>} - The thread preference (ALWAYS_THREAD or ALWAYS_CHANNEL)
 */
async function getThreadPreference(guildId) {
    const cached = guildSettingsCache.get(guildId);
    if (cached?.threadPreference) {
        return cached.threadPreference;
    }

    try {
        const row = await db.get(
            'SELECT thread_preference FROM guild_settings WHERE guildId = @guildId',
            { guildId }
        );

        const preference = row?.thread_preference ?? THREAD_PREFERENCE.ALWAYS_CHANNEL;
        getCacheEntry(guildId).threadPreference = preference;
        return preference;
    } catch (error) {
        console.error('Error getting thread preference:', error);
        return THREAD_PREFERENCE.ALWAYS_CHANNEL;
    }
}

/**
 * Sets the thread preference for a guild
 * @param {string} guildId - The Discord guild ID
 * @param {string} preference - The thread preference (ALWAYS_THREAD or ALWAYS_CHANNEL)
 * @returns {Promise<string>} - The updated thread preference
 */
async function setThreadPreference(guildId, preference) {
    if (!Object.values(THREAD_PREFERENCE).includes(preference)) {
        throw new Error(`Invalid thread preference: ${preference}. Must be one of: ${Object.values(THREAD_PREFERENCE).join(', ')}`);
    }

    await upsertGuildSetting(guildId, 'thread_preference', preference);
    getCacheEntry(guildId).threadPreference = preference;
    return preference;
}

/**
 * Gets the search approval requirement for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<string>} - The search approval setting (REQUIRED or NOT_REQUIRED)
 */
async function getSearchApproval(guildId) {
    const cached = guildSettingsCache.get(guildId);
    if (cached?.searchApproval) {
        return cached.searchApproval;
    }

    try {
        const row = await db.get(
            'SELECT search_approval FROM guild_settings WHERE guildId = @guildId',
            { guildId }
        );

        const approval = row?.search_approval ?? SEARCH_APPROVAL.REQUIRED;
        getCacheEntry(guildId).searchApproval = approval;
        return approval;
    } catch (error) {
        console.error('Error getting search approval setting:', error);
        return SEARCH_APPROVAL.REQUIRED;
    }
}

/**
 * Sets the search approval requirement for a guild
 * @param {string} guildId - The Discord guild ID
 * @param {string} approval - The search approval setting (REQUIRED or NOT_REQUIRED)
 * @returns {Promise<string>} - The updated search approval setting
 */
async function setSearchApproval(guildId, approval) {
    if (!Object.values(SEARCH_APPROVAL).includes(approval)) {
        throw new Error(`Invalid search approval setting: ${approval}. Must be one of: ${Object.values(SEARCH_APPROVAL).join(', ')}`);
    }

    await upsertGuildSetting(guildId, 'search_approval', approval);
    getCacheEntry(guildId).searchApproval = approval;
    return approval;
}

/**
 * Gets the proactive (heartbeat) mode for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<string>} - ENABLED or DISABLED
 */
async function getProactiveMode(guildId) {
    const cached = guildSettingsCache.get(guildId);
    if (cached?.proactiveMode) {
        return cached.proactiveMode;
    }

    try {
        const row = await db.get(
            'SELECT proactive_mode FROM guild_settings WHERE guildId = @guildId',
            { guildId }
        );

        const mode = row?.proactive_mode ?? PROACTIVE_MODE.DISABLED;
        getCacheEntry(guildId).proactiveMode = mode;
        return mode;
    } catch (error) {
        console.error('Error getting proactive mode setting:', error);
        return PROACTIVE_MODE.DISABLED;
    }
}

/**
 * Sets the proactive (heartbeat) mode for a guild
 * @param {string} guildId - The Discord guild ID
 * @param {string} mode - ENABLED or DISABLED
 * @returns {Promise<string>} - The updated mode
 */
async function setProactiveMode(guildId, mode) {
    if (!Object.values(PROACTIVE_MODE).includes(mode)) {
        throw new Error(`Invalid proactive mode: ${mode}. Must be one of: ${Object.values(PROACTIVE_MODE).join(', ')}`);
    }

    await upsertGuildSetting(guildId, 'proactive_mode', mode);
    getCacheEntry(guildId).proactiveMode = mode;
    return mode;
}

/**
 * Gets the internal monologue mode for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<string>} - ENABLED or DISABLED
 */
async function getMonologueMode(guildId) {
    const cached = guildSettingsCache.get(guildId);
    if (cached?.monologueMode) {
        return cached.monologueMode;
    }

    try {
        const row = await db.get(
            'SELECT monologue_mode FROM guild_settings WHERE guildId = @guildId',
            { guildId }
        );

        const mode = row?.monologue_mode ?? MONOLOGUE_MODE.DISABLED;
        getCacheEntry(guildId).monologueMode = mode;
        return mode;
    } catch (error) {
        console.error('Error getting monologue mode setting:', error);
        return MONOLOGUE_MODE.DISABLED;
    }
}

/**
 * Sets the internal monologue mode for a guild
 * @param {string} guildId - The Discord guild ID
 * @param {string} mode - ENABLED or DISABLED
 * @returns {Promise<string>} - The updated mode
 */
async function setMonologueMode(guildId, mode) {
    if (!Object.values(MONOLOGUE_MODE).includes(mode)) {
        throw new Error(`Invalid monologue mode: ${mode}. Must be one of: ${Object.values(MONOLOGUE_MODE).join(', ')}`);
    }

    await upsertGuildSetting(guildId, 'monologue_mode', mode);
    getCacheEntry(guildId).monologueMode = mode;
    return mode;
}

/**
 * Gets the per-guild AI overrides (provider/model/reasoning effort).
 * Null fields mean "use the global default".
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<{provider: string|null, model: string|null, reasoningEffort: string|null}>}
 */
async function getGuildAI(guildId) {
    const cached = guildSettingsCache.get(guildId);
    if (cached?.guildAI) {
        return cached.guildAI;
    }

    try {
        const row = await db.get(
            'SELECT ai_provider, ai_model, ai_reasoning_effort FROM guild_settings WHERE guildId = @guildId',
            { guildId }
        );
        const settings = {
            provider: row?.ai_provider || null,
            model: row?.ai_model || null,
            reasoningEffort: row?.ai_reasoning_effort || null
        };
        getCacheEntry(guildId).guildAI = settings;
        return settings;
    } catch (error) {
        console.error('Error getting guild AI settings:', error);
        return { provider: null, model: null, reasoningEffort: null };
    }
}

/**
 * Sets per-guild AI overrides. Pass null values to clear back to defaults.
 * @param {string} guildId - The Discord guild ID
 * @param {Object} settings - { provider, model, reasoningEffort } (all optional)
 */
async function setGuildAI(guildId, { provider, model, reasoningEffort } = {}) {
    if (provider !== undefined) await upsertGuildSetting(guildId, 'ai_provider', provider);
    if (model !== undefined) await upsertGuildSetting(guildId, 'ai_model', model);
    if (reasoningEffort !== undefined) await upsertGuildSetting(guildId, 'ai_reasoning_effort', reasoningEffort);
    delete getCacheEntry(guildId).guildAI;
    return await getGuildAI(guildId);
}

/**
 * Gets the long-term memory retention window for a guild.
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<number|null>} - Days to keep memories, or null (keep forever)
 */
async function getMemoryRetentionDays(guildId) {
    const cached = guildSettingsCache.get(guildId);
    if (cached && cached.memoryRetentionDays !== undefined) {
        return cached.memoryRetentionDays;
    }

    try {
        const row = await db.get(
            'SELECT memory_retention_days FROM guild_settings WHERE guildId = @guildId',
            { guildId }
        );
        const days = row?.memory_retention_days ?? null;
        getCacheEntry(guildId).memoryRetentionDays = days;
        return days;
    } catch (error) {
        console.error('Error getting memory retention setting:', error);
        return null;
    }
}

/**
 * Sets the long-term memory retention window for a guild.
 * @param {string} guildId - The Discord guild ID
 * @param {number|null} days - Days to keep memories (null/0 = keep forever)
 * @returns {Promise<number|null>} - The stored value
 */
async function setMemoryRetentionDays(guildId, days) {
    const value = days && days > 0 ? Math.floor(days) : null;
    await upsertGuildSetting(guildId, 'memory_retention_days', value);
    getCacheEntry(guildId).memoryRetentionDays = value;
    return value;
}

/**
 * Gets the personality directive for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<string|null>} - The personality directive or null if not set
 */
async function getPersonalityDirective(guildId) {
    const cached = guildSettingsCache.get(guildId);
    if (cached && cached.personalityDirective !== undefined) {
        return cached.personalityDirective;
    }

    try {
        const row = await db.get(
            'SELECT personality_directive FROM guild_settings WHERE guildId = @guildId',
            { guildId }
        );

        const directive = row?.personality_directive ?? null;
        getCacheEntry(guildId).personalityDirective = directive;
        return directive;
    } catch (error) {
        console.error('Error getting personality directive:', error);
        return null;
    }
}

/**
 * Sets the personality directive for a guild
 * @param {string} guildId - The Discord guild ID
 * @param {string|null} directive - The personality directive or null to clear it
 * @returns {Promise<string|null>} - The updated personality directive
 */
async function setPersonalityDirective(guildId, directive) {
    await upsertGuildSetting(guildId, 'personality_directive', directive);
    getCacheEntry(guildId).personalityDirective = directive;
    return directive;
}

/**
 * Gets the dynamic response setting for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<string>} - The dynamic response setting (ENABLED or DISABLED)
 */
async function getDynamicResponse(guildId) {
    const cached = guildSettingsCache.get(guildId);
    if (cached?.dynamicResponse) {
        return cached.dynamicResponse;
    }

    try {
        const row = await db.get(
            'SELECT dynamic_response FROM guild_settings WHERE guildId = @guildId',
            { guildId }
        );

        const dynamicResponse = row?.dynamic_response ?? DYNAMIC_RESPONSE.DISABLED;
        getCacheEntry(guildId).dynamicResponse = dynamicResponse;
        return dynamicResponse;
    } catch (error) {
        console.error('Error getting dynamic response setting:', error);
        return DYNAMIC_RESPONSE.DISABLED;
    }
}

/**
 * Sets the dynamic response setting for a guild
 * @param {string} guildId - The Discord guild ID
 * @param {string} setting - The dynamic response setting (ENABLED or DISABLED)
 * @returns {Promise<string>} - The updated dynamic response setting
 */
async function setDynamicResponse(guildId, setting) {
    if (!Object.values(DYNAMIC_RESPONSE).includes(setting)) {
        throw new Error(`Invalid dynamic response setting: ${setting}. Must be one of: ${Object.values(DYNAMIC_RESPONSE).join(', ')}`);
    }

    await upsertGuildSetting(guildId, 'dynamic_response', setting);
    getCacheEntry(guildId).dynamicResponse = setting;
    return setting;
}

/**
 * Gets the reply detection setting for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<string>} - ENABLED or DISABLED (defaults to ENABLED)
 */
async function getReplyDetection(guildId) {
    const cached = guildSettingsCache.get(guildId);
    if (cached?.replyDetection) {
        return cached.replyDetection;
    }

    try {
        const row = await db.get(
            'SELECT reply_detection FROM guild_settings WHERE guildId = @guildId',
            { guildId }
        );

        const setting = row?.reply_detection ?? REPLY_DETECTION.ENABLED;
        getCacheEntry(guildId).replyDetection = setting;
        return setting;
    } catch (error) {
        console.error('Error getting reply detection setting:', error);
        return REPLY_DETECTION.ENABLED;
    }
}

/**
 * Sets the reply detection setting for a guild
 * @param {string} guildId - The Discord guild ID
 * @param {string} setting - ENABLED or DISABLED
 * @returns {Promise<string>} - The updated setting
 */
async function setReplyDetection(guildId, setting) {
    if (!Object.values(REPLY_DETECTION).includes(setting)) {
        throw new Error(`Invalid reply detection setting: ${setting}. Must be one of: ${Object.values(REPLY_DETECTION).join(', ')}`);
    }

    await upsertGuildSetting(guildId, 'reply_detection', setting);
    getCacheEntry(guildId).replyDetection = setting;
    return setting;
}

/**
 * Gets the bot's nickname for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<string|null>} - The bot's nickname or null if not set
 */
async function getBotNickname(guildId) {
    try {
        const row = await db.get(
            'SELECT bot_nickname FROM guild_settings WHERE guildId = @guildId',
            { guildId }
        );
        return row?.bot_nickname ?? null;
    } catch (error) {
        console.error('Error getting bot nickname:', error);
        return null;
    }
}

/**
 * Sets the bot's nickname for a guild
 * @param {string} guildId - The Discord guild ID
 * @param {string|null} nickname - The new nickname or null to clear it
 * @returns {Promise<string|null>} - The updated nickname
 */
async function setBotNickname(guildId, nickname) {
    await upsertGuildSetting(guildId, 'bot_nickname', nickname);
    return nickname;
}

/**
 * Gets a user's nickname for a guild
 * @param {string} userId - The Discord user ID
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<string|null>} - The user's nickname or null if not set
 */
async function getUserNickname(userId, guildId) {
    try {
        const row = await db.get(
            'SELECT nickname FROM user_nicknames WHERE userId = @userId AND guildId = @guildId',
            { userId, guildId }
        );
        return row?.nickname ?? null;
    } catch (error) {
        console.error('Error getting user nickname:', error);
        return null;
    }
}

/**
 * Sets a user's nickname for a guild
 * @param {string} userId - The Discord user ID
 * @param {string} guildId - The Discord guild ID
 * @param {string|null} nickname - The new nickname or null to clear it
 * @returns {Promise<string|null>} - The updated nickname
 */
async function setUserNickname(userId, guildId, nickname) {
    try {
        if (nickname === null) {
            await db.run(
                'DELETE FROM user_nicknames WHERE userId = @userId AND guildId = @guildId',
                { userId, guildId }
            );
            return null;
        }

        await db.run(
            `INSERT INTO user_nicknames (userId, guildId, nickname, createdAt, updatedAt)
             VALUES (@userId, @guildId, @nickname, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(userId, guildId) DO UPDATE SET
                 nickname = @nickname,
                 updatedAt = CURRENT_TIMESTAMP`,
            { userId, guildId, nickname }
        );

        return nickname;
    } catch (error) {
        console.error('Error setting user nickname:', error);
        throw error;
    }
}

module.exports = {
    THREAD_PREFERENCE,
    SEARCH_APPROVAL,
    DYNAMIC_RESPONSE,
    REPLY_DETECTION,
    PROACTIVE_MODE,
    MONOLOGUE_MODE,
    getThreadPreference,
    setThreadPreference,
    getSearchApproval,
    setSearchApproval,
    getProactiveMode,
    setProactiveMode,
    getMonologueMode,
    setMonologueMode,
    getGuildAI,
    setGuildAI,
    getMemoryRetentionDays,
    setMemoryRetentionDays,
    getPersonalityDirective,
    setPersonalityDirective,
    getDynamicResponse,
    setDynamicResponse,
    getReplyDetection,
    setReplyDetection,
    getBotNickname,
    setBotNickname,
    getUserNickname,
    setUserNickname
};
