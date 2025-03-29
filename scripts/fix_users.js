/**
 * Script to fix users table schema to use BIGINT for id
 * Run this with: node scripts/fix_users.js
 */

const fs = require('fs');
const path = require('path');
const { executeTransaction, getConnection } = require('../azureDb');

async function fixUsersSchema() {
  console.log('Starting users schema fix...');
  
  try {
    // Ensure we have a database connection
    await getConnection();
    console.log('Connected to database');
    
    // Read the SQL script
    const sqlPath = path.join(__dirname, 'migrations', 'fix_users_schema.sql');
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
          WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'id'
        `);
        
        console.log('users table id column:');
        console.log(result.recordset[0]);
        
        // Check if data was preserved
        const countResult = await transaction.request().query(`
          SELECT COUNT(*) as userCount FROM users
        `);
        
        console.log(`\nusers table has ${countResult.recordset[0].userCount} records`);
        
        // Check for foreign key relationships restored
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
            OBJECT_NAME(f.referenced_object_id) = 'users'
        `);
        
        console.log('\nForeign keys to users table:');
        if (fkResult.recordset.length === 0) {
          console.log('No foreign keys found pointing to users table');
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
fixUsersSchema()
  .then(() => {
    console.log('Script execution completed.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Script execution failed:', err.message);
    process.exit(1);
  }); 