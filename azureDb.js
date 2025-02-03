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
        trustServerCertificate: false
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
        return pool;
    } catch (err) {
        console.error('SQL Connection Error:', err);
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