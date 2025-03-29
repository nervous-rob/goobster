/**
 * Script to update database schema to handle Discord IDs properly
 * Run this with: node scripts/update_discord_id_schema.js
 */

const fs = require('fs');
const path = require('path');
const { executeTransaction, getConnection } = require('../azureDb');
const sql = require('mssql');

async function updateSchema() {
  console.log('Starting schema update to fix Discord ID handling...');
  
  try {
    // Ensure we have a database connection
    await getConnection();
    console.log('Connected to database');
    
    // Read the SQL script
    const sqlPath = path.join(__dirname, 'migrations', 'update_discord_id_schema.sql');
    const sqlScript = fs.readFileSync(sqlPath, 'utf8');
    
    // Split the script into sections for better error handling
    const sections = [
      { name: 'Creating backup tables', pattern: /-- First create a backup of affected tables/, endPattern: /-- Update users table/ },
      { name: 'Updating users table', pattern: /-- Update users table/, endPattern: /-- Now update the partyMembers table/ },
      { name: 'Updating partyMembers table indexes', pattern: /-- Now update the partyMembers table/, endPattern: /-- Check if we need to update partyMembers\.userId column type/ },
      { name: 'Updating partyMembers column', pattern: /-- Check if we need to update partyMembers\.userId column type/, endPattern: /-- Update the parties table/ },
      { name: 'Updating parties table indexes', pattern: /-- Update the parties table/, endPattern: /-- Check if we need to update parties\.leaderId column type/ },
      { name: 'Updating parties column', pattern: /-- Check if we need to update parties\.leaderId column type/, endPattern: /-- Add back the foreign key constraints/ },
      { name: 'Adding foreign key constraints', pattern: /-- Add back the foreign key constraints/, endPattern: /-- Recreate the index/ },
      { name: 'Recreating indexes', pattern: /-- Recreate the index/, endPattern: /PRINT \'Schema update/ }
    ];
    
    // Extract each section's SQL
    const sectionScripts = sections.map((section, index) => {
      const startMatch = sqlScript.match(section.pattern);
      if (!startMatch) {
        console.warn(`Could not find start pattern for section: ${section.name}`);
        return null;
      }
      
      const startIndex = startMatch.index;
      let endIndex;
      
      if (index === sections.length - 1) {
        endIndex = sqlScript.length;
      } else {
        const endMatch = sqlScript.match(section.endPattern);
        if (!endMatch) {
          console.warn(`Could not find end pattern for section: ${section.name}`);
          return null;
        }
        endIndex = endMatch.index;
      }
      
      return {
        name: section.name,
        sql: sqlScript.substring(startIndex, endIndex).trim()
      };
    }).filter(section => section !== null);
    
    // Execute each section in separate transactions
    for (const section of sectionScripts) {
      console.log(`\nExecuting section: ${section.name}`);
      
      try {
        await executeTransaction(async (transaction) => {
          console.log(`Running SQL: ${section.sql.substring(0, 50)}...`);
          await transaction.request().query(section.sql);
        }, 2); // 2 retries
        
        console.log(`Successfully completed section: ${section.name}`);
      } catch (error) {
        console.error(`Error in section ${section.name}:`, error.message);
        
        // Log the error but continue with the next section
        console.log('Continuing with next section...');
      }
    }
    
    // Verify the changes
    console.log('\nVerifying schema changes:');
    
    // Check users table
    try {
      await executeTransaction(async (transaction) => {
        const usersResult = await transaction.request().query(`
          SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'discordId'
        `);
        
        console.log('Users table discordId column:');
        console.log(usersResult.recordset[0]);
      });
    } catch (error) {
      console.error('Error checking users table:', error.message);
    }
    
    // Check partyMembers table
    try {
      await executeTransaction(async (transaction) => {
        const partyMembersResult = await transaction.request().query(`
          SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = 'partyMembers' AND COLUMN_NAME = 'userId'
        `);
        
        console.log('\nPartyMembers table userId column:');
        console.log(partyMembersResult.recordset[0]);
      });
    } catch (error) {
      console.error('Error checking partyMembers table:', error.message);
    }
    
    // Check parties table
    try {
      await executeTransaction(async (transaction) => {
        const partiesResult = await transaction.request().query(`
          SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = 'parties' AND COLUMN_NAME = 'leaderId'
        `);
        
        console.log('\nParties table leaderId column:');
        console.log(partiesResult.recordset[0]);
      });
    } catch (error) {
      console.error('Error checking parties table:', error.message);
    }
    
    console.log('\nSchema update verification complete!');
    console.log('The database should now properly handle Discord IDs.');
    
  } catch (error) {
    console.error('Error updating schema:', error.message);
    process.exit(1);
  }
}

// Run the script
updateSchema()
  .then(() => {
    console.log('Script execution completed.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Script execution failed:', err.message);
    process.exit(1);
  }); 