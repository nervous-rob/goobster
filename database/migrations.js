const sql = require('mssql');
const fs = require('fs').promises;
const path = require('path');
const { getConnection, closeConnection } = require('../azureDb');

async function runMigration() {
    try {
        // Get database connection
        const pool = await getConnection();
        console.log('Connected to database');
        
        // Read and execute the migration script
        const migrationPath = path.join(__dirname, '../migrations/20240204_add_resource_columns.sql');
        const migrationScript = await fs.readFile(migrationPath, 'utf8');
        console.log('Read migration script');
        
        // Split script into separate commands by GO statements
        const commands = migrationScript.split(/\nGO\b/i).filter(cmd => cmd.trim());
        
        // Execute each command
        for (const command of commands) {
            console.log('Executing command:', command);
            await pool.request().query(command);
        }
        
        console.log('Migration completed successfully');
        await closeConnection();
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        await closeConnection();
        process.exit(1);
    }
}

runMigration(); 