const { getConnection } = require('../azureDb');

/**
 * Gets a database connection with error handling
 * @returns {Promise<Object|null>} The database connection or null if connection fails
 */
async function getDatabaseConnection() {
    try {
        const db = await getConnection();
        if (!db) {
            console.error('Failed to establish database connection');
            return null;
        }
        return db;
    } catch (error) {
        console.error('Error getting database connection:', {
            error: error.message,
            code: error.code,
            number: error.number,
            state: error.state,
            stack: error.stack
        });
        return null;
    }
}

/**
 * Executes a database query with error handling
 * @param {string} query - The SQL query to execute
 * @param {Array} params - Query parameters
 * @returns {Promise<Object|null>} Query result or null if query fails
 */
async function executeQuery(query, params = []) {
    try {
        const db = await getDatabaseConnection();
        if (!db) {
            throw new Error('Failed to establish database connection');
        }

        const result = await db.query(query, params);
        return result;
    } catch (error) {
        console.error('Error executing database query:', {
            error: error.message,
            code: error.code,
            number: error.number,
            state: error.state,
            stack: error.stack,
            query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
            params: params
        });
        return null;
    }
}

/**
 * Executes a database transaction with error handling
 * @param {Function} callback - Transaction callback function
 * @returns {Promise<Object|null>} Transaction result or null if transaction fails
 */
async function executeTransaction(callback) {
    try {
        const db = await getDatabaseConnection();
        if (!db) {
            throw new Error('Failed to establish database connection');
        }

        const transaction = await db.transaction();
        await transaction.begin();

        try {
            const result = await callback(transaction);
            await transaction.commit();
            return result;
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        console.error('Error executing database transaction:', {
            error: error.message,
            code: error.code,
            number: error.number,
            state: error.state,
            stack: error.stack
        });
        return null;
    }
}

module.exports = {
    getDatabaseConnection,
    executeQuery,
    executeTransaction
}; 