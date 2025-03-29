/**
 * Script to fix partyMembers table schema to use BIGINT for userId
 * Run this with: node scripts/fix_party_members.js
 */

const fs = require('fs');
const path = require('path');
const { executeTransaction, getConnection } = require('../azureDb');

async function fixPartyMembersSchema() {
  console.log('Starting partyMembers schema fix...');
  
  try {
    // Ensure we have a database connection
    await getConnection();
    console.log('Connected to database');
    
    // Read the SQL script
    const sqlPath = path.join(__dirname, 'migrations', 'fix_party_members_schema.sql');
    const sqlScript = fs.readFileSync(sqlPath, 'utf8');
    
    // Execute the script
    try {
      await executeTransaction(async (transaction) => {
        console.log('Executing SQL migration...');
        await transaction.request().query(sqlScript);
        console.log('SQL migration completed successfully');
      });
      
      // Verify the changes
      await executeTransaction(async (transaction) => {
        console.log('\nVerifying schema changes:');
        
        const result = await transaction.request().query(`
          SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = 'partyMembers' AND COLUMN_NAME = 'userId'
        `);
        
        console.log('partyMembers table userId column:');
        console.log(result.recordset[0]);
        
        // Check if data was preserved
        const countResult = await transaction.request().query(`
          SELECT COUNT(*) as memberCount FROM partyMembers
        `);
        
        console.log(`\npartyMembers table has ${countResult.recordset[0].memberCount} records`);
      });
      
      console.log('\nSchema fix completed successfully');
    } catch (error) {
      console.error('Error executing migration:', error.message);
      if (error.precedingErrors) {
        console.error('Preceding errors:');
        error.precedingErrors.forEach((err, i) => {
          console.error(`${i+1}: ${err.message}`);
        });
      }
    }
  } catch (error) {
    console.error('Error fixing schema:', error.message);
    process.exit(1);
  }
}

// Run the script
fixPartyMembersSchema()
  .then(() => {
    console.log('Script execution completed.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Script execution failed:', err.message);
    process.exit(1);
  }); 