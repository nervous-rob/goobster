const sql = require('mssql');
const config = require('./config.json');

// Use the new config structure with better defaults
const sqlConfig = {
    user: config.azure.sql.user,
    password: config.azure.sql.password,
    database: config.azure.sql.database,
    server: config.azure.sql.server,
    options: {
        encrypt: true,
        trustServerCertificate: false,
        enableArithAbort: true,
        connectionTimeout: 0,           // Disabled - no timeout (was 30000)
        requestTimeout: 0,              // Disabled - no timeout (was 30000)
        maxRetriesOnTransientErrors: 3,
        enableRetryOnFailure: true,
        retryInterval: 1000           // 1 second between retry attempts
    },
    pool: {
        max: 10,                      // Reduced from 50 to be more conservative
        min: 0,                       // Start with no connections
        idleTimeoutMillis: 600000,    // 10 minutes idle timeout (was 60000)
        acquireTimeoutMillis: 300000, // 5 minutes acquire timeout (was 30000)
        createTimeoutMillis: 300000,  // 5 minutes create timeout (was 30000)
        destroyTimeoutMillis: 30000,  // 30 seconds destroy timeout (was 5000)
        reapIntervalMillis: 1000,     // 1 second reap interval
        createRetryIntervalMillis: 200 // 200ms retry interval
    }
};

// Add backward compatibility
if (!sqlConfig.user && config.azureSql) {
    sqlConfig.user = config.azureSql.user;
    sqlConfig.password = config.azureSql.password;
    sqlConfig.database = config.azureSql.database;
    sqlConfig.server = config.azureSql.server;
    sqlConfig.options = config.azureSql.options;
    
    // Also update the options if using backward compatibility
    if (sqlConfig.options) {
        sqlConfig.options.connectionTimeout = 0; // Disable timeout
        sqlConfig.options.requestTimeout = 0;    // Disable timeout
    }
}

let pool = null;
let isConnecting = false;
let connectionPromise = null;

async function getConnection() {
    try {
        // If we already have a pool and it's connected, return it
        if (pool?.connected) {
            return pool;
        }

        // If we're already trying to connect, wait for that promise
        if (isConnecting && connectionPromise) {
            return await connectionPromise;
        }

        // Start new connection attempt
        isConnecting = true;
        connectionPromise = (async () => {
            try {
                // Close any existing pool
                if (pool) {
                    try {
                        await pool.close();
                    } catch (closeError) {
                        console.warn('Error closing existing pool:', closeError.message);
                    }
                    pool = null;
                }

                // Create new pool with retry logic
                let retryCount = 0;
                const maxRetries = 3;

                while (retryCount < maxRetries) {
                    try {
                        pool = await sql.connect(sqlConfig);
                        
                        // Set up error handler
                        pool.on('error', err => {
                            console.error('SQL Pool Error:', err);
                            // Close the errored pool and set to null so a new one will be created
                            if (pool) {
                                pool.close().catch(console.error);
                                pool = null;
                            }
                        });

                        return pool;
                    } catch (error) {
                        retryCount++;
                        
                        // Check if we should retry
                        if (retryCount < maxRetries) {
                            console.warn(`Connection attempt ${retryCount} failed, retrying in ${retryCount * 1000}ms:`, error.message);
                            await new Promise(resolve => setTimeout(resolve, retryCount * 1000));
                        } else {
                            throw error;
                        }
                    }
                }
            } finally {
                isConnecting = false;
                connectionPromise = null;
            }
        })();

        return await connectionPromise;
    } catch (err) {
        console.error('SQL Connection Error:', err);
        // Ensure cleanup on error
        if (pool) {
            await pool.close();
            pool = null;
        }
        throw err;
    }
}

// Add a cleanup function
async function closeConnection() {
    try {
        if (pool) {
            await pool.close();
            pool = null;
            console.log('Database connection closed');
        }
    } catch (err) {
        console.error('Error closing database connection:', err);
        throw err;
    }
}

/**
 * Execute a promise with a timeout with detailed metrics
 * @param {Promise} promise Promise to execute
 * @param {number} timeoutMs Timeout in milliseconds
 * @param {string} operationName Optional name of the operation for better logging
 * @returns {Promise<any>} Result of the promise
 */
const executeWithTimeout = async (promise, timeoutMs = 300000, operationName = 'Unknown Operation') => {
    const startTime = Date.now();
    const operationId = Math.random().toString(36).substring(2, 15);
    
    console.log(`[TIMEOUT-METRICS] ${new Date().toISOString()} - Operation started: ${operationName} (ID: ${operationId}), Timeout: ${timeoutMs}ms`);
    
    if (!timeoutMs) {
        console.log(`[TIMEOUT-METRICS] ${new Date().toISOString()} - No timeout set for: ${operationName} (ID: ${operationId})`);
        return promise; // No timeout specified, just return the promise
    }

    let timeoutId;
    let hasTimedOut = false;
    
    // Create periodic progress reporting
    const progressIntervalMs = Math.min(30000, timeoutMs / 10); // Report progress every 30s or 1/10 of timeout
    const progressInterval = setInterval(() => {
        const elapsedTime = Date.now() - startTime;
        const percentComplete = (elapsedTime / timeoutMs * 100).toFixed(1);
        console.log(`[TIMEOUT-METRICS] ${new Date().toISOString()} - Operation progress: ${operationName} (ID: ${operationId}), Elapsed: ${elapsedTime}ms (${percentComplete}% of timeout)`);
    }, progressIntervalMs);
    
    // Monitor memory usage
    const memoryInterval = setInterval(() => {
        const memoryUsage = process.memoryUsage();
        const formattedMemory = {
            rss: `${Math.round(memoryUsage.rss / (1024 * 1024))} MB`,
            heapTotal: `${Math.round(memoryUsage.heapTotal / (1024 * 1024))} MB`,
            heapUsed: `${Math.round(memoryUsage.heapUsed / (1024 * 1024))} MB`,
            external: `${Math.round(memoryUsage.external / (1024 * 1024))} MB`
        };
        console.log('Memory usage:', formattedMemory);
    }, 60000); // Monitor memory every minute

    // Create a promise that rejects after the specified timeout
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            hasTimedOut = true;
            const elapsedTime = Date.now() - startTime;
            const error = new Error(`Query timeout after ${timeoutMs}ms`);
            error.code = 'ETIMEOUT';
            error.operationName = operationName;
            error.operationId = operationId;
            error.elapsedTime = elapsedTime;
            
            console.error('Database Query Timeout:', {
                operationName,
                operationId,
                timeout: `${timeoutMs}ms`,
                elapsed: `${elapsedTime}ms`,
                error: error.message,
                stack: error.stack,
                time: new Date().toISOString()
            });
            reject(error);
        }, timeoutMs);
    });

    // Race the original promise against the timeout
    try {
        const result = await Promise.race([promise, timeoutPromise]);
        const elapsedTime = Date.now() - startTime;
        console.log(`[TIMEOUT-METRICS] ${new Date().toISOString()} - Operation completed: ${operationName} (ID: ${operationId}), Time: ${elapsedTime}ms`);
        return result;
    } catch (error) {
        const elapsedTime = Date.now() - startTime;
        if (!hasTimedOut) {
            console.error(`[TIMEOUT-METRICS] ${new Date().toISOString()} - Operation failed: ${operationName} (ID: ${operationId}), Time: ${elapsedTime}ms, Error: ${error.message}`);
        }
        throw error; 
    } finally {
        clearTimeout(timeoutId);
        clearInterval(progressInterval);
        clearInterval(memoryInterval);
    }
};

// Add a utility function for executing transactions with retry
async function executeTransaction(transactionFn, maxRetries = 3) {
    let lastError;
    let transaction = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Get a connection from the pool
            const pool = await getConnection();
            transaction = new sql.Transaction(pool);
            
            // Begin the transaction
            await transaction.begin();
            
            // Set request timeout to 0 (infinite) for all requests in this transaction
            const originalRequest = transaction.request;
            transaction.request = function() {
                const req = originalRequest.apply(this, arguments);
                req.timeout = 0; // Disable timeout
                return req;
            };
            
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
                    console.error('Error rolling back transaction:', rollbackError);
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
    getConnection,
    closeConnection,
    sql,
    executeWithTimeout,
    executeTransaction
}; 