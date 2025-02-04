const sql = require('mssql');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../services/adventure/utils/logger');

async function clearDatabase() {
    try {
        // Azure SQL configuration
        const config = {
            user: 'nervousadmin',
            password: 'B00mer1412!',
            server: 'sqlsvr-nervousdb-dev.database.windows.net',
            database: 'Goobster',
            options: {
                encrypt: true,
                trustServerCertificate: false
            }
        };

        // Read the SQL script
        const scriptPath = path.join(__dirname, 'clearAdventureData.sql');
        const sqlScript = await fs.readFile(scriptPath, 'utf8');

        // Connect to database
        console.log('Connecting to database...');
        const pool = await sql.connect(config);

        // Execute the script
        console.log('Executing clear script...');
        await pool.request().batch(sqlScript);

        console.log('Database cleared successfully!');
        
        // Close the connection
        await sql.close();
        
        process.exit(0);
    } catch (error) {
        logger.error('Failed to clear database', { error });
        console.error('Error:', error.message);
        process.exit(1);
    }
}

// Run the script
clearDatabase(); 