const sql = require('mssql');
const config = require('./config.json');

// Use the new config structure
const sqlConfig = {
    user: config.azure.sql.user,
    password: config.azure.sql.password,
    database: config.azure.sql.database,
    server: config.azure.sql.server,
    options: config.azure.sql.options || {
        encrypt: true,
        trustServerCertificate: false,
        enableArithAbort: true,
        connectionTimeout: 60000,     // 1 minute connection timeout
        requestTimeout: 120000,       // 2 minutes request timeout
        maxRetriesOnTransientErrors: 3,
        enableRetryOnFailure: true
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 60000,     // 1 minute idle timeout
        acquireTimeoutMillis: 60000,  // 1 minute acquire timeout
        createTimeoutMillis: 60000,   // 1 minute create timeout
        destroyTimeoutMillis: 5000,   // 5 seconds destroy timeout
        reapIntervalMillis: 1000,     // 1 second reap interval
        createRetryIntervalMillis: 200 // 200ms retry interval
    },
    retry: {
        max: 3,
        min: 0,
        maxWait: 5000
    }
};

// Add backward compatibility
if (!sqlConfig.user && config.azureSql) {
    sqlConfig.user = config.azureSql.user;
    sqlConfig.password = config.azureSql.password;
    sqlConfig.database = config.azureSql.database;
    sqlConfig.server = config.azureSql.server;
    sqlConfig.options = config.azureSql.options;
}

let pool = null;

async function getConnection() {
    try {
        if (pool) {
            return pool;
        }
        
        pool = await sql.connect(sqlConfig);
        
        // Set up error handling for the pool
        pool.on('error', err => {
            console.error('SQL Pool Error:', err);
            // Close the errored pool and set to null so a new one will be created
            if (pool) {
                pool.close();
                pool = null;
            }
        });
        
        return pool;
    } catch (err) {
        console.error('SQL Connection Error:', err);
        // Ensure pool is cleaned up on error
        if (pool) {
            await pool.close();
            pool = null;
        }
        throw err;
    }
}

// Add a cleanup function
async function closeConnection() {
    try {
        if (pool) {
            await pool.close();
            pool = null;
            console.log('Database connection closed');
        }
    } catch (err) {
        console.error('Error closing database connection:', err);
        throw err;
    }
}

module.exports = {
    getConnection,
    closeConnection,
    sql
};