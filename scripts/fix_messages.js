/**
 * Script to fix messages table schema to use BIGINT for createdBy
 * Run this with: node scripts/fix_messages.js
 */

const fs = require('fs');
const path = require('path');
const { executeTransaction, getConnection } = require('../azureDb');

async function fixMessagesSchema() {
  console.log('Starting messages schema fix...');
  
  try {
    // Ensure we have a database connection
    await getConnection();
    console.log('Connected to database');
    
    // Read the SQL script
    const sqlPath = path.join(__dirname, 'migrations', 'fix_messages_schema.sql');
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
          WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'createdBy'
        `);
        
        console.log('messages table createdBy column:');
        console.log(result.recordset[0]);
        
        // Check if data was preserved
        const countResult = await transaction.request().query(`
          SELECT COUNT(*) as msgCount FROM messages
        `);
        
        console.log(`\nmessages table has ${countResult.recordset[0].msgCount} records`);
        
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
            OBJECT_NAME(f.parent_object_id) = 'messages'
        `);
        
        console.log('\nForeign keys from messages table:');
        if (fkResult.recordset.length === 0) {
          console.log('No foreign keys found from messages table');
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
    }
  } catch (error) {
    console.error('Error fixing schema:', error.message);
    process.exit(1);
  }
}

// Run the script
fixMessagesSchema()
  .then(() => {
    console.log('Script execution completed.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Script execution failed:', err.message);
    process.exit(1);
  }); 