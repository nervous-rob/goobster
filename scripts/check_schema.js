/**
 * Script to check database schema for users, partyMembers, and parties tables
 */

const { executeTransaction, getConnection } = require('../azureDb');

async function checkSchema() {
  try {
    // Ensure we have a database connection
    await getConnection();
    console.log('Connected to database');
    
    await executeTransaction(async (transaction) => {
      console.log('\n--- Users Table ---');
      const usersResult = await transaction.request().query(`
        SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'users'
        ORDER BY ORDINAL_POSITION
      `);
      
      usersResult.recordset.forEach(col => {
        console.log(`${col.COLUMN_NAME}: ${col.DATA_TYPE}${col.CHARACTER_MAXIMUM_LENGTH ? '(' + col.CHARACTER_MAXIMUM_LENGTH + ')' : ''}`);
      });
      
      console.log('\n--- PartyMembers Table ---');
      const partyMembersResult = await transaction.request().query(`
        SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'partyMembers'
        ORDER BY ORDINAL_POSITION
      `);
      
      partyMembersResult.recordset.forEach(col => {
        console.log(`${col.COLUMN_NAME}: ${col.DATA_TYPE}${col.CHARACTER_MAXIMUM_LENGTH ? '(' + col.CHARACTER_MAXIMUM_LENGTH + ')' : ''}`);
      });
      
      console.log('\n--- Parties Table ---');
      const partiesResult = await transaction.request().query(`
        SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'parties'
        ORDER BY ORDINAL_POSITION
      `);
      
      partiesResult.recordset.forEach(col => {
        console.log(`${col.COLUMN_NAME}: ${col.DATA_TYPE}${col.CHARACTER_MAXIMUM_LENGTH ? '(' + col.CHARACTER_MAXIMUM_LENGTH + ')' : ''}`);
      });
      
      // Check for foreign key relationships
      console.log('\n--- Foreign Key Relationships ---');
      const fkResult = await transaction.request().query(`
        SELECT 
          OBJECT_NAME(f.parent_object_id) AS TableName,
          COL_NAME(fc.parent_object_id, fc.parent_column_id) AS ColumnName,
          OBJECT_NAME(f.referenced_object_id) AS ReferenceTableName,
          COL_NAME(fc.referenced_object_id, fc.referenced_column_id) AS ReferenceColumnName
        FROM 
          sys.foreign_keys AS f
          INNER JOIN sys.foreign_key_columns AS fc
            ON f.object_id = fc.constraint_object_id
        WHERE 
          OBJECT_NAME(f.parent_object_id) IN ('users', 'partyMembers', 'parties')
          OR OBJECT_NAME(f.referenced_object_id) IN ('users', 'partyMembers', 'parties')
        ORDER BY 
          TableName, 
          ReferenceTableName
      `);
      
      fkResult.recordset.forEach(fk => {
        console.log(`${fk.TableName}.${fk.ColumnName} -> ${fk.ReferenceTableName}.${fk.ReferenceColumnName}`);
      });
      
      // Check counts for each table individually
      console.log('\n--- Table Counts ---');
      
      // Users count
      const usersCount = await transaction.request().query('SELECT COUNT(*) AS count FROM users');
      console.log(`users: ${usersCount.recordset[0].count} rows`);
      
      // PartyMembers count
      const partyMembersCount = await transaction.request().query('SELECT COUNT(*) AS count FROM partyMembers');
      console.log(`partyMembers: ${partyMembersCount.recordset[0].count} rows`);
      
      // Parties count
      const partiesCount = await transaction.request().query('SELECT COUNT(*) AS count FROM parties');
      console.log(`parties: ${partiesCount.recordset[0].count} rows`);
    });
    
    console.log('\nSchema check completed successfully');
  } catch (error) {
    console.error('Error checking schema:', error.message);
    if (error.precedingErrors) {
      error.precedingErrors.forEach((err, i) => {
        console.error(`Preceding error ${i+1}: ${err.message}`);
      });
    }
  }
}

// Run the script
checkSchema()
  .then(() => {
    console.log('Script execution completed.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Script execution failed:', err.message);
    process.exit(1);
  }); 