/**
 * Migration script to add personality_directive column to guild_settings table
 * 
 * This script checks if the column exists before adding it,
 * and uses a transaction to ensure database consistency.
 */

const { sql, getConnection } = require('../../azureDb');

async function migrateDatabase() {
    console.log('Starting migration: Adding personality_directive column to guild_settings table');
    let pool = null;
    let transaction = null;

    try {
        // Get connection to the database
        pool = await getConnection();
        if (!pool) {
            throw new Error('Failed to establish database connection');
        }

        // First, check if the table exists
        const tableExists = await pool.request().query(`
            SELECT 1 
            FROM sys.tables 
            WHERE name = 'guild_settings'
        `);

        if (tableExists.recordset.length === 0) {
            console.log('Table guild_settings does not exist. Creating it first...');
            
            // Create the guild_settings table if it doesn't exist
            await pool.request().query(`
                CREATE TABLE [dbo].[guild_settings] (
                    [guildId]           VARCHAR (255)  NOT NULL,
                    [thread_preference] VARCHAR (20)   DEFAULT ('ALWAYS_CHANNEL') NOT NULL,
                    [search_approval]   VARCHAR (20)   DEFAULT ('REQUIRED') NOT NULL,
                    [personality_directive] NVARCHAR (MAX) NULL,
                    [createdAt]         DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
                    [updatedAt]         DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
                    PRIMARY KEY CLUSTERED ([guildId] ASC)
                );

                -- Add constraint to ensure thread_preference is one of the allowed values
                ALTER TABLE [dbo].[guild_settings]
                    ADD CONSTRAINT [CHK_thread_preference] CHECK ([thread_preference]='ALWAYS_THREAD' OR [thread_preference]='ALWAYS_CHANNEL');

                -- Add constraint to ensure search_approval is one of the allowed values
                ALTER TABLE [dbo].[guild_settings]
                    ADD CONSTRAINT [CHK_search_approval] CHECK ([search_approval]='REQUIRED' OR [search_approval]='NOT_REQUIRED');

                -- Create index for faster lookups
                CREATE NONCLUSTERED INDEX [idx_guild_settings_guild]
                    ON [dbo].[guild_settings]([guildId] ASC);
            `);
            
            console.log('Table guild_settings created successfully with personality_directive column');
            return;
        }

        // Check if the personality_directive column already exists
        const columnExists = await pool.request().query(`
            SELECT 1
            FROM sys.columns 
            WHERE name = 'personality_directive' AND object_id = OBJECT_ID('guild_settings')
        `);

        if (columnExists.recordset.length > 0) {
            console.log('Column personality_directive already exists in guild_settings table. No changes needed.');
            return;
        }

        // Start a transaction for adding the column
        transaction = await pool.transaction();
        await transaction.begin();

        // Add the personality_directive column
        await transaction.request().query(`
            ALTER TABLE guild_settings
            ADD personality_directive NVARCHAR(MAX) NULL
        `);

        // Commit the transaction
        await transaction.commit();
        console.log('Migration successful: Added personality_directive column to guild_settings table');

    } catch (error) {
        // Rollback transaction if it exists and an error occurred
        if (transaction) {
            try {
                await transaction.rollback();
                console.error('Transaction rolled back due to error');
            } catch (rollbackError) {
                console.error('Error rolling back transaction:', rollbackError);
            }
        }
        
        console.error('Migration failed:', error);
        throw error;
    }
}

// Execute the migration if this script is run directly
if (require.main === module) {
    migrateDatabase()
        .then(() => {
            console.log('Migration completed');
            process.exit(0);
        })
        .catch(error => {
            console.error('Migration failed:', error);
            process.exit(1);
        });
} else {
    // Export for use in a migration framework
    module.exports = migrateDatabase;
} 