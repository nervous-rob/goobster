const { SlashCommandBuilder } = require('discord.js');
const { executeTransaction } = require('../../azureDb');
const { logger } = require('../../services/adventure/utils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('updateschema')
        .setDescription('Updates database schema to fix Discord ID handling'),

    async execute(interaction) {
        try {
            await interaction.deferReply();
            
            await interaction.editReply('Beginning database schema update...');

            // Execute the schema update transaction
            await executeTransaction(async (transaction) => {
                // Check if we need to update the partyMembers table
                const checkSchema = await transaction.request().query(`
                    SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH 
                    FROM INFORMATION_SCHEMA.COLUMNS 
                    WHERE TABLE_NAME = 'partyMembers' AND COLUMN_NAME = 'userId'
                `);

                const needsUpdate = !checkSchema.recordset.some(col => 
                    col.DATA_TYPE === 'varchar' || col.DATA_TYPE === 'nvarchar' || col.DATA_TYPE === 'bigint'
                );
                
                if (needsUpdate) {
                    // Create a backup of the partyMembers table
                    await transaction.request().query(`
                        SELECT * INTO partyMembers_backup FROM partyMembers
                    `);
                    
                    // Update users table first to ensure foreign key constraints work
                    await transaction.request().query(`
                        -- Update the users table to use NVARCHAR for discordId if needed
                        IF COL_LENGTH('users', 'discordId') IS NOT NULL
                        BEGIN
                            IF NOT EXISTS (
                                SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                                WHERE TABLE_NAME = 'users' 
                                AND COLUMN_NAME = 'discordId' 
                                AND DATA_TYPE IN ('varchar', 'nvarchar')
                            )
                            BEGIN
                                ALTER TABLE users ALTER COLUMN discordId NVARCHAR(255) NOT NULL
                            END
                        END
                    `);
                    
                    // Now update the partyMembers table
                    await transaction.request().query(`
                        -- Drop existing constraints on partyMembers table
                        DECLARE @constraintName NVARCHAR(255)
                        
                        -- Get foreign key constraint name for userId
                        SELECT @constraintName = CONSTRAINT_NAME
                        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                        WHERE TABLE_NAME = 'partyMembers' AND COLUMN_NAME = 'userId'
                        
                        IF @constraintName IS NOT NULL
                        BEGIN
                            EXEC('ALTER TABLE partyMembers DROP CONSTRAINT ' + @constraintName)
                        END
                        
                        -- Update the userId column to use BIGINT
                        ALTER TABLE partyMembers ALTER COLUMN userId BIGINT NOT NULL
                        
                        -- Add back the foreign key constraint
                        ALTER TABLE partyMembers ADD CONSTRAINT FK_partyMembers_users
                        FOREIGN KEY (userId) REFERENCES users(id)
                    `);
                    
                    // Update the parties table
                    await transaction.request().query(`
                        -- Drop existing constraints on parties table
                        DECLARE @partyConstraintName NVARCHAR(255)
                        
                        -- Get foreign key constraint name for leaderId
                        SELECT @partyConstraintName = CONSTRAINT_NAME
                        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                        WHERE TABLE_NAME = 'parties' AND COLUMN_NAME = 'leaderId'
                        
                        IF @partyConstraintName IS NOT NULL
                        BEGIN
                            EXEC('ALTER TABLE parties DROP CONSTRAINT ' + @partyConstraintName)
                        END
                        
                        -- Update the leaderId column to use BIGINT
                        ALTER TABLE parties ALTER COLUMN leaderId BIGINT NOT NULL
                        
                        -- Add back the foreign key constraint
                        ALTER TABLE parties ADD CONSTRAINT FK_parties_users
                        FOREIGN KEY (leaderId) REFERENCES users(id)
                    `);
                    
                    await interaction.editReply('Schema updated successfully. The tables have been modified to handle Discord IDs properly.');
                } else {
                    await interaction.editReply('Schema is already up to date! No changes needed.');
                }
            });
            
        } catch (error) {
            logger.error('Failed to update schema', { 
                error: error.message,
                stack: error.stack
            });
            
            await interaction.editReply({
                content: `Error updating schema: ${error.message}\n` +
                         `Please run this command with admin privileges and ensure the database is accessible.`,
                ephemeral: true
            });
        }
    },
}; 