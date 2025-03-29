/**
 * Test Database Timeout Settings
 * This script tests that database timeouts are properly disabled
 */

const { getConnection, executeTransaction, sql } = require('../azureDb');
const logger = require('../services/adventure/utils/logger');

// Helper function to log results
function logResult(message, data = null, error = null) {
    console.log('\n-----------------------------------------');
    console.log(`[${new Date().toISOString()}] ${message}`);
    
    if (data) {
        console.log('\nData:');
        console.log(JSON.stringify(data, null, 2));
    }
    
    if (error) {
        console.log('\nError:');
        console.log(error.message);
        console.log(error.stack);
    }
    
    console.log('-----------------------------------------\n');
}

// Test a query with a deliberate delay to verify timeout settings
async function testLongRunningQuery() {
    logResult('Testing long-running query...');
    
    try {
        // Get a connection with timeout check
        const pool = await getConnection();
        
        // Get the timeout configuration
        const config = pool.config;
        logResult('Database connection settings', {
            requestTimeout: config.options.requestTimeout,
            connectionTimeout: config.options.connectionTimeout,
            idleTimeoutMillis: config.pool.idleTimeoutMillis,
            acquireTimeoutMillis: config.pool.acquireTimeoutMillis,
            createTimeoutMillis: config.pool.createTimeoutMillis
        });
        
        // Run a query that takes more than 30 seconds using WAITFOR DELAY
        logResult('Running query with 40-second delay...');
        const startTime = Date.now();
        
        // Execute the long-running query
        const result = await pool.request()
            .query("WAITFOR DELAY '00:00:40'; SELECT 'Query completed successfully' AS result;");
            
        const duration = Date.now() - startTime;
        
        logResult('Long-running query completed', {
            duration: `${duration}ms`,
            result: result.recordset[0].result
        });
        
        return { success: true, duration };
    } catch (error) {
        logResult('Query failed', null, error);
        return { success: false, error: error.message };
    }
}

// Test with a transaction
async function testLongRunningTransaction() {
    logResult('Testing long-running transaction...');
    
    try {
        // Execute a transaction with a long-running query
        const startTime = Date.now();
        
        await executeTransaction(async (transaction) => {
            // Verify the transaction request timeout
            const request = transaction.request();
            logResult('Transaction request settings', {
                timeout: request.timeout
            });
            
            // Run a query that takes more than 30 seconds
            logResult('Running transaction query with 35-second delay...');
            
            await request.query("WAITFOR DELAY '00:00:35'; SELECT 'Transaction completed successfully' AS result;");
            
            logResult('Transaction query completed');
        });
        
        const duration = Date.now() - startTime;
        
        logResult('Long-running transaction completed', {
            duration: `${duration}ms`
        });
        
        return { success: true, duration };
    } catch (error) {
        logResult('Transaction failed', null, error);
        return { success: false, error: error.message };
    }
}

// Run the tests
async function runTests() {
    console.log('===================================================');
    console.log('DATABASE TIMEOUT TEST');
    console.log(`Started at: ${new Date().toISOString()}`);
    console.log('===================================================\n');
    
    try {
        // Run the query test
        const queryResult = await testLongRunningQuery();
        
        // Run the transaction test
        const transactionResult = await testLongRunningTransaction();
        
        // Output summary
        console.log('\n===================================================');
        console.log('TEST SUMMARY');
        console.log('===================================================');
        console.log(`Query test success: ${queryResult.success}`);
        console.log(`Query test duration: ${queryResult.duration}ms`);
        console.log(`Transaction test success: ${transactionResult.success}`);
        console.log(`Transaction test duration: ${transactionResult.duration}ms`);
        console.log('===================================================\n');
        
        // Final result
        if (queryResult.success && transactionResult.success) {
            console.log('SUCCESS: Timeout settings are properly disabled!');
        } else {
            console.log('FAILED: Some tests did not complete successfully.');
        }
    } catch (error) {
        console.error('FATAL ERROR:', error);
    } finally {
        // Make sure to exit the process
        setTimeout(() => process.exit(0), 1000);
    }
}

// Run the tests
runTests(); 