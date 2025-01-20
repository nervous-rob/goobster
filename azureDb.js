const sql = require('mssql');

const config = require('./config.json').azureSql;

const sqlConfig = {
    user: config.user,
    password: config.password,
    database: config.database,
    server: config.server,
    options: {
        encrypt: config.options.encrypt,
        trustServerCertificate: config.options.trustServerCertificate
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    },
    requestTimeout: 30000,
    connectionTimeout: 30000,
    stream: false,
    parseJSON: true
};

let pool = null;

async function getConnection() {
    try {
        if (pool) {
            return pool;
        }

        console.log('Connecting to Azure SQL Database...');
        pool = await sql.connect(sqlConfig);
        console.log('Connected to Azure SQL Database');
        
        pool.on('error', err => {
            console.error('Database pool error:', err);
            pool = null;
        });
        
        return pool;
    } catch (err) {
        console.error('Failed to connect to Azure SQL Database:', err);
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