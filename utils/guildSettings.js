const { sql, getConnection } = require('../azureDb');

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

/**
 * Ensures the guild_settings table exists
 */
async function ensureGuildSettingsTable() {
    const pool = await getConnection();
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'guild_settings')
        CREATE TABLE guild_settings (
            guildId VARCHAR(255) PRIMARY KEY,
            thread_preference VARCHAR(20) DEFAULT 'ALWAYS_CHANNEL' NOT NULL,
            search_approval VARCHAR(20) DEFAULT 'REQUIRED' NOT NULL,
            createdAt DATETIME2 DEFAULT GETDATE() NOT NULL,
            updatedAt DATETIME2 DEFAULT GETDATE() NOT NULL,
            CONSTRAINT CHK_thread_preference CHECK (thread_preference IN ('ALWAYS_THREAD', 'ALWAYS_CHANNEL')),
            CONSTRAINT CHK_search_approval CHECK (search_approval IN ('REQUIRED', 'NOT_REQUIRED'))
        )
    `);
    
    // Add search_approval column if it doesn't exist
    await pool.request().query(`
        IF NOT EXISTS (
            SELECT * FROM sys.columns 
            WHERE name = 'search_approval' AND object_id = OBJECT_ID('guild_settings')
        )
        ALTER TABLE guild_settings
        ADD search_approval VARCHAR(20) DEFAULT 'REQUIRED' NOT NULL,
        CONSTRAINT CHK_search_approval CHECK (search_approval IN ('REQUIRED', 'NOT_REQUIRED'))
    `);
}

/**
 * Gets the thread preference for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<string>} - The thread preference (ALWAYS_THREAD or ALWAYS_CHANNEL)
 */
async function getThreadPreference(guildId) {
    // Check cache first
    if (guildSettingsCache.has(guildId)) {
        return guildSettingsCache.get(guildId).threadPreference;
    }

    try {
        await ensureGuildSettingsTable();
        
        const pool = await getConnection();
        const result = await pool.request()
            .input('guildId', sql.VarChar, guildId)
            .query(`
                SELECT thread_preference 
                FROM guild_settings 
                WHERE guildId = @guildId
            `);

        if (result.recordset.length > 0) {
            const preference = result.recordset[0].thread_preference;
            
            // Cache the result
            guildSettingsCache.set(guildId, {
                threadPreference: preference,
                timestamp: Date.now()
            });
            
            // Set timeout to clear cache
            setTimeout(() => {
                guildSettingsCache.delete(guildId);
            }, CACHE_TIMEOUT);
            
            return preference;
        }

        // If no setting exists, create default and return it
        return await setThreadPreference(guildId, THREAD_PREFERENCE.ALWAYS_CHANNEL);
    } catch (error) {
        console.error('Error getting thread preference:', error);
        // Return default in case of error
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

    try {
        await ensureGuildSettingsTable();
        
        const pool = await getConnection();
        await pool.request()
            .input('guildId', sql.VarChar, guildId)
            .input('preference', sql.VarChar, preference)
            .input('now', sql.DateTime2, new Date())
            .query(`
                MERGE guild_settings AS target
                USING (SELECT @guildId as guildId) AS source
                ON target.guildId = source.guildId
                WHEN MATCHED THEN
                    UPDATE SET 
                        thread_preference = @preference,
                        updatedAt = @now
                WHEN NOT MATCHED THEN
                    INSERT (guildId, thread_preference, createdAt, updatedAt)
                    VALUES (@guildId, @preference, @now, @now);
            `);

        // Update cache
        guildSettingsCache.set(guildId, {
            threadPreference: preference,
            timestamp: Date.now()
        });
        
        // Set timeout to clear cache
        setTimeout(() => {
            guildSettingsCache.delete(guildId);
        }, CACHE_TIMEOUT);

        return preference;
    } catch (error) {
        console.error('Error setting thread preference:', error);
        throw error;
    }
}

/**
 * Gets the search approval requirement for a guild
 * @param {string} guildId - The Discord guild ID
 * @returns {Promise<string>} - The search approval setting (REQUIRED or NOT_REQUIRED)
 */
async function getSearchApproval(guildId) {
    // Check cache first
    if (guildSettingsCache.has(guildId) && guildSettingsCache.get(guildId).searchApproval) {
        return guildSettingsCache.get(guildId).searchApproval;
    }

    try {
        await ensureGuildSettingsTable();
        
        const pool = await getConnection();
        const result = await pool.request()
            .input('guildId', sql.VarChar, guildId)
            .query(`
                SELECT search_approval 
                FROM guild_settings 
                WHERE guildId = @guildId
            `);

        if (result.recordset.length > 0) {
            const approval = result.recordset[0].search_approval;
            
            // Update cache with the search approval setting
            if (guildSettingsCache.has(guildId)) {
                guildSettingsCache.get(guildId).searchApproval = approval;
            } else {
                guildSettingsCache.set(guildId, {
                    searchApproval: approval,
                    timestamp: Date.now()
                });
                
                // Set timeout to clear cache
                setTimeout(() => {
                    guildSettingsCache.delete(guildId);
                }, CACHE_TIMEOUT);
            }
            
            return approval;
        }

        // If no setting exists, create default and return it
        return await setSearchApproval(guildId, SEARCH_APPROVAL.REQUIRED);
    } catch (error) {
        console.error('Error getting search approval setting:', error);
        // Return default in case of error
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

    try {
        await ensureGuildSettingsTable();
        
        const pool = await getConnection();
        await pool.request()
            .input('guildId', sql.VarChar, guildId)
            .input('approval', sql.VarChar, approval)
            .input('now', sql.DateTime2, new Date())
            .query(`
                MERGE guild_settings AS target
                USING (SELECT @guildId as guildId) AS source
                ON target.guildId = source.guildId
                WHEN MATCHED THEN
                    UPDATE SET 
                        search_approval = @approval,
                        updatedAt = @now
                WHEN NOT MATCHED THEN
                    INSERT (guildId, thread_preference, search_approval, createdAt, updatedAt)
                    VALUES (@guildId, 'ALWAYS_CHANNEL', @approval, @now, @now);
            `);

        // Update cache
        if (guildSettingsCache.has(guildId)) {
            guildSettingsCache.get(guildId).searchApproval = approval;
        } else {
            guildSettingsCache.set(guildId, {
                searchApproval: approval,
                timestamp: Date.now()
            });
            
            // Set timeout to clear cache
            setTimeout(() => {
                guildSettingsCache.delete(guildId);
            }, CACHE_TIMEOUT);
        }

        return approval;
    } catch (error) {
        console.error('Error setting search approval setting:', error);
        throw error;
    }
}

module.exports = {
    THREAD_PREFERENCE,
    SEARCH_APPROVAL,
    getThreadPreference,
    setThreadPreference,
    getSearchApproval,
    setSearchApproval
}; 