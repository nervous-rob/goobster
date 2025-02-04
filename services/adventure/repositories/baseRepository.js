/**
 * Base Repository
 * Provides common database operations for all repositories
 */

const { sql, getConnection } = require('../../../azureDb');
const logger = require('../utils/logger');

class BaseRepository {
    constructor(tableName) {
        this.tableName = tableName;
        this.pool = null;
    }

    /**
     * Get database connection
     * @returns {Promise<Object>} Database connection
     * @private
     */
    async _getConnection() {
        if (!this.pool) {
            this.pool = await getConnection();
        }
        return this.pool;
    }

    /**
     * Begin a transaction
     * @returns {Promise<Object>} Transaction object
     */
    async beginTransaction() {
        try {
            const transaction = new sql.Transaction(await this._getConnection());
            await transaction.begin();
            return transaction;
        } catch (error) {
            logger.error('Failed to begin transaction', { error });
            throw error;
        }
    }

    /**
     * Create a request with a transaction
     * @param {Object} transaction Transaction object
     * @returns {Object} Request object
     */
    createRequest(transaction) {
        return transaction.request();
    }

    /**
     * Execute a query with parameters
     * @param {Object} transaction Transaction object
     * @param {string} query SQL query
     * @param {Object} params Query parameters
     * @returns {Promise<Object>} Query result
     */
    async executeQuery(transaction, query, params = {}) {
        try {
            const request = this.createRequest(transaction);
            
            // Add parameters to request
            Object.entries(params).forEach(([key, param]) => {
                if (param && typeof param === 'object' && 'type' in param && 'value' in param) {
                    // Parameter with explicit type definition
                    request.input(key, param.type, param.value);
                } else {
                    // Auto-detect type for simple values
                    request.input(key, this._getSqlType(param), param);
                }
            });

            const result = await request.query(query);
            return result;
        } catch (error) {
            logger.error('Failed to execute query', { 
                error,
                params,
                query,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    /**
     * Get SQL type for a value
     * @param {*} value Value to get type for
     * @returns {Object} SQL type
     * @private
     */
    _getSqlType(value) {
        switch (typeof value) {
            case 'string':
                return sql.NVarChar;
            case 'number':
                return Number.isInteger(value) ? sql.Int : sql.Float;
            case 'boolean':
                return sql.Bit;
            case 'object':
                if (value instanceof Date) return sql.DateTime;
                if (Array.isArray(value) || value === null) return sql.NVarChar;
                return sql.NVarChar;
            default:
                return sql.NVarChar;
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
        const sets = Object.keys(data).map(k => `${k} = @${k}`).join(', ');
        
        const query = `
            UPDATE ${this.tableName}
            SET ${sets}
            WHERE id = @id;
        `;

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
}

module.exports = BaseRepository; 