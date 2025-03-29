/**
 * Base Repository
 * Provides common database operations for all repositories
 */

const sql = require('mssql');
const logger = require('../utils/logger');
const config = require('../../../config.json');
const { executeWithTimeout, executeTransaction } = require('../../../azureDb');

class BaseRepository {
    constructor(tableName) {
        this.tableName = tableName;
        this.pool = null;
        this.defaultTimeout = 0; // No timeout (was 300000 - 5 minutes)
        this.retryAttempts = 3;
        this.retryDelay = 1000;
        
        // Ensure we have proper SQL config
        this.sqlConfig = {
            user: config.azure.sql.user,
            password: config.azure.sql.password,
            database: config.azure.sql.database,
            server: config.azure.sql.server,
            pool: {
                max: 10,
                min: 0,
                idleTimeoutMillis: 600000 // 10 minutes (was 30000)
            },
            options: {
                encrypt: true,
                trustServerCertificate: false,
                enableArithAbort: true,
                requestTimeout: 0, // No timeout
                connectionTimeout: 0 // No timeout
            }
        };
    }

    /**
     * Get a database connection
     * @returns {Promise<Object>} Database connection
     * @private
     */
    async _getConnection() {
        try {
            // If we already have a pool and it's connected, reuse it
            if (this.pool && this.pool.connected) {
                return this.pool;
            }

            // Close any existing pool that might be in a bad state
            if (this.pool) {
                try {
                    await this.pool.close();
                } catch (closeError) {
                    logger.warn('Error closing existing pool', { error: closeError.message });
                }
            }

            // Create new connection pool
            this.pool = await new sql.ConnectionPool(this.sqlConfig).connect();

            // Set up error handler
            this.pool.on('error', err => {
                logger.error('SQL Pool Error', {
                    error: err.message,
                    code: err.code,
                    state: err.state
                });
            });

            return this.pool;
        } catch (error) {
            logger.error('Failed to get database connection', {
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                config: {
                    server: this.sqlConfig.server,
                    database: this.sqlConfig.database,
                    user: this.sqlConfig.user
                }
            });
            throw error;
        }
    }

    /**
     * Begin a new transaction
     * @returns {Promise<Object>} Transaction wrapper object
     */
    async beginTransaction() {
        try {
            const pool = await this._getConnection();
            const transaction = new sql.Transaction(pool);
            await transaction.begin();
            
            // Return a transaction wrapper with a request method
            return {
                transaction: transaction,
                commit: async () => {
                    await transaction.commit();
                },
                rollback: async () => {
                    await transaction.rollback();
                },
                request: function() {
                    const request = new sql.Request(transaction);
                    request.timeout = 0; // Disable timeout
                    return request;
                }
            };
        } catch (error) {
            logger.error('Failed to begin transaction', {
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    /**
     * Execute a query with parameters
     * @param {Object} transaction Transaction object
     * @param {string} query Query to execute
     * @param {Object} params Query parameters
     * @returns {Promise<any>} Query result
     */
    async executeQuery(transaction, query, params = {}) {
        const queryId = Math.random().toString(36).substring(2, 15);
        console.time(`db_query_${queryId}`);
        console.log(`[DB-METRICS] ${new Date().toISOString()} - Starting query execution ${queryId} for ${this.tableName}`);
        
        try {
            // Ensure we have a valid transaction
            if (!transaction) {
                logger.error('Transaction object is null or undefined');
                throw new Error('Invalid transaction object');
            }
            
            let request;
            
            // Handle both legacy transaction objects and new wrapper format
            if (typeof transaction.request === 'function') {
                request = transaction.request();
            } else if (transaction.request) {
                request = transaction.request;
            } else {
                request = new sql.Request(transaction);
            }
            
            // Ensure timeout is disabled
            request.timeout = 0;
            
            // Log query size for performance analysis
            const querySize = query.length;
            console.log(`[DB-METRICS] ${new Date().toISOString()} - Query size: ${querySize} chars, TableName: ${this.tableName}, QueryID: ${queryId}`);
            
            // Log number of parameters for performance analysis
            const paramCount = Object.keys(params).length;
            console.log(`[DB-METRICS] ${new Date().toISOString()} - Parameter count: ${paramCount}, QueryID: ${queryId}`);
            
            console.time(`db_query_params_${queryId}`);
            // Standardized parameter handling
            if (params) {
                for (const [key, param] of Object.entries(params)) {
                    try {
                        if (param === null || param === undefined) {
                            request.input(key, sql.VarChar, null);
                            continue;
                        }

                        // If param has explicit type definition
                        if (param && typeof param === 'object' && 'type' in param && 'value' in param) {
                            request.input(key, param.type, param.value);
                            continue;
                        }

                        // Handle different types
                        switch (typeof param) {
                            case 'string':
                                request.input(key, sql.NVarChar, param);
                                break;
                            case 'number':
                                if (Number.isInteger(param)) {
                                    request.input(key, sql.Int, param);
                                } else {
                                    request.input(key, sql.Float, param);
                                }
                                break;
                            case 'boolean':
                                request.input(key, sql.Bit, param);
                                break;
                            case 'object':
                                if (param instanceof Date) {
                                    request.input(key, sql.DateTime, param);
                                } else {
                                    request.input(key, sql.NVarChar, JSON.stringify(param));
                                }
                                break;
                            default:
                                request.input(key, sql.NVarChar, String(param));
                        }
                    } catch (paramError) {
                        logger.error('Failed to add parameter to request', {
                            key,
                            paramType: typeof param,
                            error: paramError.message
                        });
                        throw paramError;
                    }
                }
            }
            console.timeEnd(`db_query_params_${queryId}`);
            
            // Execute query and measure time
            console.log(`[DB-METRICS] ${new Date().toISOString()} - Executing SQL query, QueryID: ${queryId}`);
            console.time(`db_query_execution_${queryId}`);
            const result = await request.query(query);
            console.timeEnd(`db_query_execution_${queryId}`);
            
            // Get stats after query execution
            const recordCount = result.recordset ? result.recordset.length : 0;
            const rowsAffected = result.rowsAffected ? result.rowsAffected.reduce((a, b) => a + b, 0) : 0;
            
            console.log(`[DB-METRICS] ${new Date().toISOString()} - Query completed - Records: ${recordCount}, Rows affected: ${rowsAffected}, QueryID: ${queryId}`);
            console.timeEnd(`db_query_${queryId}`);
            
            return result;
        } catch (error) {
            console.log(`[DB-METRICS] ${new Date().toISOString()} - Query failed, QueryID: ${queryId}, Error: ${error.message}`);
            console.timeEnd(`db_query_${queryId}`);
            
            logger.error('Failed to execute query', {
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    lineNumber: error.lineNumber,
                    number: error.number,
                    class: error.class,
                    procName: error.procName
                },
                query: query.substring(0, 300) + (query.length > 300 ? '...' : ''),
                params: JSON.stringify(params).substring(0, 200)
            });
            throw error;
        }
    }

    /**
     * Get SQL type for a value
     * @param {any} value Value to get type for
     * @returns {Object} SQL type
     * @private
     */
    _getSqlType(value) {
        if (value === null || value === undefined) {
            return sql.VarChar(50);
        }

        switch (typeof value) {
            case 'string':
                return sql.VarChar(50);
            case 'number':
                if (Number.isInteger(value)) {
                    return sql.Int;
                }
                return sql.Float;
            case 'boolean':
                return sql.Bit;
            case 'object':
                if (value instanceof Date) {
                    return sql.DateTime;
                }
                if (Array.isArray(value)) {
                    return sql.VarChar(2000); // For JSON arrays
                }
                return sql.VarChar(2000); // For JSON objects
            default:
                return sql.VarChar(50);
        }
    }

    /**
     * Convert database row to model
     * @param {Object} row Database row
     * @returns {Object} Model instance
     * @protected
     */
    _toModel(row) {
        throw new Error('_toModel must be implemented by child class');
    }

    /**
     * Convert model to database row
     * @param {Object} model Model instance
     * @returns {Object} Database row
     * @protected
     */
    _fromModel(model) {
        throw new Error('_fromModel must be implemented by child class');
    }

    /**
     * Find by ID
     * @param {Object} transaction Transaction object
     * @param {string|number} id ID to find
     * @returns {Promise<Object>} Found model
     */
    async findById(transaction, id) {
        const result = await this.executeQuery(
            transaction,
            `SELECT * FROM ${this.tableName} WHERE id = @id`,
            { id }
        );
        return result.recordset[0] ? this._toModel(result.recordset[0]) : null;
    }

    /**
     * Find all matching a condition
     * @param {Object} transaction Transaction object
     * @param {string} condition WHERE clause
     * @param {Object} params Query parameters
     * @returns {Promise<Array>} Found models
     */
    async findAll(transaction, condition = '', params = {}) {
        const query = `SELECT * FROM ${this.tableName} ${condition ? 'WHERE ' + condition : ''}`;
        const result = await this.executeQuery(transaction, query, params);
        return result.recordset.map(row => this._toModel(row));
    }

    /**
     * Create new record
     * @param {Object} transaction Transaction object
     * @param {Object} model Model to create
     * @returns {Promise<Object>} Created model
     */
    async create(transaction, model) {
        const data = this._fromModel(model);
        const columns = Object.keys(data).join(', ');
        const values = Object.keys(data).map(k => '@' + k).join(', ');
        
        const query = `
            INSERT INTO ${this.tableName} (${columns})
            VALUES (${values});
            SELECT SCOPE_IDENTITY() AS id;
        `;

        const result = await this.executeQuery(transaction, query, data);
        const id = result.recordset[0].id;
        return this.findById(transaction, id);
    }

    /**
     * Update existing record
     * @param {Object} transaction Transaction object
     * @param {string|number} id ID to update
     * @param {Object} model Model with updates
     * @returns {Promise<Object>} Updated model
     */
    async update(transaction, id, model) {
        const data = this._fromModel(model);
        // Exclude the primary key ('id') from the SET clause
        const sets = Object.keys(data)
            .filter(k => k !== 'id') // Filter out the 'id' key
            .map(k => `${k} = @${k}`)
            .join(', ');
        
        const query = `
            UPDATE ${this.tableName}
            SET ${sets}
            WHERE id = @id;
        `;

        // Pass the original data (including id for the WHERE clause) to executeQuery
        await this.executeQuery(transaction, query, { ...data, id });
        return this.findById(transaction, id);
    }

    /**
     * Delete record
     * @param {Object} transaction Transaction object
     * @param {string|number} id ID to delete
     * @returns {Promise<boolean>} Success status
     */
    async delete(transaction, id) {
        const result = await this.executeQuery(
            transaction,
            `DELETE FROM ${this.tableName} WHERE id = @id`,
            { id }
        );
        return result.rowsAffected[0] > 0;
    }

    /**
     * Execute a database transaction with retries
     * @param {Function} operation Async function that takes a transaction object and performs database operations
     * @param {number} maxRetries Maximum number of retry attempts
     * @returns {Promise<any>} Result of the operation
     */
    async executeTransaction(operation, maxRetries = 3) {
        return executeTransaction(operation, maxRetries);
    }

    /**
     * Execute a promise with a timeout
     * @param {Promise} promise Promise to execute
     * @param {number} timeoutMs Timeout in milliseconds (0 or less means no timeout)
     * @returns {Promise<any>} Result of the promise
     */
    async executeWithTimeout(promise, timeoutMs = 0) { // Default to no timeout
        // Use the updated executeWithTimeout from azureDb module
        return executeWithTimeout(promise, timeoutMs); 
    }

    /**
     * Utility to make SQL Server-compatible queries
     * SQL Server doesn't support LIMIT, uses TOP instead
     * @param {string} query - Original query that might contain LIMIT
     * @returns {string} - SQL Server compatible query
     * @private
     */
    _makeSqlServerCompatible(query) {
        // Replace LIMIT with TOP in SQL Server
        const limitRegex = /ORDER BY\s+(.+?)\s+LIMIT\s+(\d+);/i;
        if (limitRegex.test(query)) {
            const match = query.match(limitRegex);
            const orderByClause = match[1];
            const limitValue = match[2];
            
            // Remove the LIMIT clause and add TOP
            let modifiedQuery = query.replace(limitRegex, `ORDER BY ${orderByClause};`);
            
            // Add TOP clause after SELECT
            modifiedQuery = modifiedQuery.replace(/SELECT\s+/i, `SELECT TOP(${limitValue}) `);
            
            logger.debug('Modified SQL query for SQL Server compatibility', {
                original: query,
                modified: modifiedQuery
            });
            
            return modifiedQuery;
        }
        
        return query;
    }

    /**
     * Handle Azure SQL specific error
     * @param {Error} error The error that occurred
     * @param {string} operation Description of what operation was being performed
     * @param {Function} retryCallback Function to call to retry the operation
     * @param {number} [maxRetries=3] Maximum number of retries
     * @returns {Promise<any>} Result of the operation or throws error
     */
    async handleAzureSqlError(error, operation, retryCallback, maxRetries = 3) {
        // Azure SQL transient error codes that can be retried
        const transientErrorCodes = [
            'ETIMEOUT',       // Connection timeout
            'ECONNRESET',     // Connection reset 
            40197,            // The service has encountered an error processing your request
            40501,            // The service is currently busy
            40613,            // Database is currently unavailable
            40143,            // The service has encountered an error processing your request
            49918,            // Not enough resources to process request
            49919,            // Cannot process request - too many operations in progress
            49920,            // Too many operations in progress
            10928,            // Resource ID: %d. The %s limit for the database is %d and has been reached
            10929,            // Resource ID: %d. The %s minimum guarantee is %d, maximum limit is %d
            1205,             // Transaction deadlock
            40550,            // The session has been terminated because of excessive lock
            40551,            // The session has been terminated because of excessive tempdb usage
            40552,            // The session has been terminated because of excessive transaction log space usage
            40553              // The session has been terminated because of excessive memory usage
        ];
        
        const errorCode = error.code || error.number;
        
        // Check if this is a transient error that can be retried
        if (transientErrorCodes.includes(errorCode)) {
            logger.warn(`Azure SQL transient error (${errorCode}) during ${operation}, retrying...`, {
                errorMessage: error.message,
                errorCode: errorCode,
                operation
            });
            
            let lastError = error;
            let attempt = 1;
            
            while (attempt <= maxRetries) {
                try {
                    // Exponential backoff - wait longer between each retry
                    const delay = Math.min(100 * Math.pow(2, attempt), 10000); // Max 10 seconds
                    await new Promise(resolve => setTimeout(resolve, delay));
                    
                    logger.debug(`Retry attempt ${attempt} for ${operation}`, { delay });
                    
                    // Call the retry callback
                    return await retryCallback();
                } catch (retryError) {
                    lastError = retryError;
                    
                    // Only retry for transient errors
                    const retryErrorCode = retryError.code || retryError.number;
                    if (!transientErrorCodes.includes(retryErrorCode)) {
                        logger.warn(`Non-transient error during retry for ${operation}`, {
                            errorMessage: retryError.message,
                            errorCode: retryErrorCode
                        });
                        throw retryError;
                    }
                    
                    attempt++;
                }
            }
            
            // If we've exhausted all retries, throw the last error
            logger.error(`Failed to ${operation} after ${maxRetries} retry attempts`, {
                errorMessage: lastError.message,
                errorCode: lastError.code || lastError.number
            });
            throw lastError;
        }
        
        // If not a transient error, just throw it
        throw error;
    }
}

module.exports = BaseRepository; 