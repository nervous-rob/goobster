/**
 * Script to fix database schema to use BIGINT for user IDs
 * Run this with: node scripts/fix_db_schema.js
 */

const fs = require('fs');
const path = require('path');
const { executeTransaction, getConnection } = require('../azureDb');

async function fixDatabaseSchema() {
  console.log('Starting database schema fix...');
  
  try {
    // Ensure we have a database connection
    await getConnection();
    console.log('Connected to database');
    
    // Read the SQL script
    const sqlPath = path.join(__dirname, 'migrations', 'fix_db_schema.sql');
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
        
        // Check users table
        const usersResult = await transaction.request().query(`
          SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'id'
        `);
        
        console.log('users table id column:');
        console.log(usersResult.recordset[0]);
        
        // Check messages table
        const messagesResult = await transaction.request().query(`
          SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'createdBy'
        `);
        
        console.log('\nmessages table createdBy column:');
        console.log(messagesResult.recordset[0]);
        
        // Check if data was preserved
        const countsResult = await transaction.request().query(`
          SELECT 'users' AS TableName, COUNT(*) AS Count FROM users
          UNION ALL
          SELECT 'messages', COUNT(*) FROM messages
        `);
        
        console.log('\nTable row counts:');
        countsResult.recordset.forEach(row => {
          console.log(`${row.TableName}: ${row.Count} rows`);
        });
        
        // Check for foreign key relationships
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
            OBJECT_NAME(f.parent_object_id) IN ('users', 'messages')
            OR OBJECT_NAME(f.referenced_object_id) IN ('users', 'messages')
        `);
        
        console.log('\nForeign keys:');
        if (fkResult.recordset.length === 0) {
          console.log('No foreign keys found');
        } else {
          fkResult.recordset.forEach(fk => {
            console.log(`${fk.TableName}.${fk.ColumnName} -> ${fk.ReferenceTableName}.${fk.ReferenceColumnName}`);
          });
        }
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
      
      // Print full error for debugging
      console.error('\nFull error:', error);
    }
  } catch (error) {
    console.error('Error fixing schema:', error.message);
    process.exit(1);
  }
}

// Run the script
fixDatabaseSchema()
  .then(() => {
    console.log('Script execution completed.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Script execution failed:', err.message);
    process.exit(1);
  }); 