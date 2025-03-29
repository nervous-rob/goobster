const sql = require('mssql');
const { logger } = require('./logger');

/**
 * Execute a promise with a timeout
 * @param {Promise} promise - The promise to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise} The promise result or timeout error
 */
async function executeWithTimeout(promise, timeout = 300000) { // 5 minutes default timeout
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Query timeout after ${timeout}ms`));
        }, timeout);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } catch (error) {
        if (error.message.includes('Query timeout')) {
            logger.error('Database Query Timeout:', {
                timeout: `${timeout}ms`,
                error: error.message,
                stack: error.stack,
                time: new Date().toISOString()
            });
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Execute a transaction with retry logic
 * @param {Function} transactionFn - The transaction function to execute
 * @param {number} maxRetries - Maximum number of retries
 * @returns {Promise} The transaction result
 */
async function executeTransaction(transactionFn, maxRetries = 3) {
    let lastError;
    let transaction = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Get a connection from the pool
            const pool = await sql.connect();
            transaction = new sql.Transaction(pool);
            
            // Begin the transaction
            await transaction.begin();
            
            try {
                const result = await transactionFn(transaction);
                await transaction.commit();
                return result;
            } catch (error) {
                // Only try to rollback if the transaction was actually started
                if (transaction && transaction._started) {
                    await transaction.rollback();
                }
                lastError = error;
                
                // If it's not a timeout error, don't retry
                if (!error.message.includes('timeout') && !error.code === 'ETIMEOUT') {
                    throw error;
                }
                
                // Wait before retrying
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                }
            }
        } catch (error) {
            lastError = error;
            // Only try to rollback if the transaction was actually started
            if (transaction && transaction._started) {
                try {
                    await transaction.rollback();
                } catch (rollbackError) {
                    logger.error('Error rolling back transaction:', rollbackError);
                }
            }
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }
    
    throw lastError;
}

module.exports = {
    executeWithTimeout,
    executeTransaction
}; 