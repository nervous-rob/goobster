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
    }
};

async function getConnection() {
    try {
        // make sure that any items are correctly URL encoded in the connection string
        await sql.connect(config);
        console.log('Connected to Azure SQL Database');
        return sql; // return the sql object
    } catch (err) {
        console.error('Failed to connect to Azure SQL Database:', err);
    }
}

module.exports = {
    getConnection,
    sql // Exporting sql to use it for queries elsewhere
};