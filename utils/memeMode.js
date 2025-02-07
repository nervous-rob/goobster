const { sql, getConnection } = require('../azureDb');

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

// Initialize the table when the module loads
ensureMemeModeTable().catch(console.error);

module.exports = {
    isMemeModeEnabled,
    setMemeMode
}; 