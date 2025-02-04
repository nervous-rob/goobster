/**
 * State Repository
 * Handles database operations for adventure states
 */

const BaseRepository = require('./baseRepository');
const logger = require('../utils/logger');
const sql = require('mssql');

class StateRepository extends BaseRepository {
    constructor() {
        super('adventureStates');
        // Define which fields should be stored as JSON
        this.jsonFields = [
            'currentScene',
            'history',
            'eventHistory',
            'metadata',
            'progress',
            'environment',
            'flags',
            'variables'
        ];
    }

    /**
     * Convert database row to state object
     * @param {Object} row Database row
     * @returns {Object} State object
     * @protected
     */
    _toModel(row) {
        try {
            const model = { ...row };
            
            // Parse JSON fields
            for (const field of this.jsonFields) {
                model[field] = this._parseJSONField(field, row[field]);
            }

            return model;
        } catch (error) {
            logger.error('Failed to convert row to state model', { error, row });
            throw error;
        }
    }

    /**
     * Convert state object to database row
     * @param {Object} model State object
     * @returns {Object} Database row
     * @protected
     */
    _fromModel(model) {
        try {
            if (!model.adventureId) {
                throw new Error('adventureId is required');
            }
            if (!model.currentScene) {
                throw new Error('currentScene is required');
            }

            const data = { ...model };
            
            // Stringify JSON fields
            for (const field of this.jsonFields) {
                data[field] = this._stringifyJSONField(field, model[field]);
            }

            // Ensure status is set
            data.status = model.status || 'active';

            return data;
        } catch (error) {
            logger.error('Failed to convert state model to row', { error, modelId: model.id });
            throw error;
        }
    }

    /**
     * Parse a JSON field safely
     * @param {string} fieldName Name of the field
     * @param {string} value Value to parse
     * @returns {Object} Parsed object
     * @private
     */
    _parseJSONField(fieldName, value) {
        try {
            if (!value) return {};
            if (typeof value === 'object') return value;
            return JSON.parse(value);
        } catch (err) {
            logger.warn(`Failed to parse ${fieldName}, using empty object`, { error: err });
            return {};
        }
    }

    /**
     * Stringify a JSON field safely
     * @param {string} fieldName Name of the field
     * @param {*} value Value to stringify
     * @returns {string} JSON string
     * @private
     */
    _stringifyJSONField(fieldName, value) {
        try {
            if (!value) return '{}';
            if (typeof value === 'string') {
                try {
                    JSON.parse(value); // Validate if it's already valid JSON
                    return value;
                } catch {
                    return JSON.stringify(value);
                }
            }
            return JSON.stringify(value);
        } catch (err) {
            logger.error(`Failed to stringify ${fieldName}`, { error: err });
            return '{}';
        }
    }

    /**
     * Find state by adventure ID
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @returns {Promise<Object>} State object
     */
    async findByAdventure(transaction, adventureId) {
        const result = await this.executeQuery(
            transaction,
            `SELECT * FROM ${this.tableName} WHERE adventureId = @adventureId`,
            { adventureId }
        );
        return result.recordset[0] ? this._toModel(result.recordset[0]) : null;
    }

    /**
     * Update state flags
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {Object} flags Flag updates
     * @returns {Promise<Object>} Updated state
     */
    async updateFlags(transaction, adventureId, flags) {
        const state = await this.findByAdventure(transaction, adventureId);
        if (!state) {
            throw new Error('State not found');
        }

        state.flags = {
            ...state.flags,
            ...flags,
        };

        return this.update(transaction, state.id, state);
    }

    /**
     * Update state variables
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {Object} variables Variable updates
     * @returns {Promise<Object>} Updated state
     */
    async updateVariables(transaction, adventureId, variables) {
        const state = await this.findByAdventure(transaction, adventureId);
        if (!state) {
            throw new Error('State not found');
        }

        state.variables = {
            ...state.variables,
            ...variables,
        };

        return this.update(transaction, state.id, state);
    }

    /**
     * Add event to history
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {Object} event Event to add
     * @returns {Promise<Object>} Updated state
     */
    async addEvent(transaction, adventureId, event) {
        const state = await this.findByAdventure(transaction, adventureId);
        if (!state) {
            throw new Error('State not found');
        }

        state.eventHistory.unshift({
            ...event,
            timestamp: new Date(),
        });

        // Trim history if needed
        if (state.eventHistory.length > 50) {
            state.eventHistory = state.eventHistory.slice(0, 50);
        }

        return this.update(transaction, state.id, state);
    }

    /**
     * Update environment state
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {Object} environment Environment updates
     * @returns {Promise<Object>} Updated state
     */
    async updateEnvironment(transaction, adventureId, environment) {
        const state = await this.findByAdventure(transaction, adventureId);
        if (!state) {
            throw new Error('State not found');
        }

        state.environment = {
            ...state.environment,
            ...environment,
        };

        return this.update(transaction, state.id, state);
    }

    /**
     * Update progress tracking
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {Object} progress Progress updates
     * @returns {Promise<Object>} Updated state
     */
    async updateProgress(transaction, adventureId, progress) {
        const state = await this.findByAdventure(transaction, adventureId);
        if (!state) {
            throw new Error('State not found');
        }

        // Update specific progress fields
        if (progress.plotPoints) {
            state.progress.plotPointsEncountered.push(...progress.plotPoints);
        }
        if (progress.objectives) {
            state.progress.objectivesCompleted.push(...progress.objectives);
        }
        if (progress.keyElements) {
            state.progress.keyElementsFound.push(...progress.keyElements);
        }
        if (progress.resources) {
            Object.entries(progress.resources).forEach(([resource, amount]) => {
                state.progress.resourcesUsed[resource] = 
                    (state.progress.resourcesUsed[resource] || 0) + amount;
            });
        }

        return this.update(transaction, state.id, state);
    }

    /**
     * Create a new state record
     * @param {Object} transaction Transaction object
     * @param {Object} state State object
     * @returns {Promise<Object>} Created state
     */
    async create(transaction, state) {
        try {
            const data = this._fromModel(state);
            
            // Configure query options
            const queryOptions = {
                timeout: 120000 // 2 minutes timeout
            };

            const insertQuery = `
                SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
                
                INSERT INTO ${this.tableName} (
                    adventureId, currentScene, status, history,
                    eventHistory, metadata, progress, environment,
                    flags, variables
                )
                OUTPUT INSERTED.id
                VALUES (
                    @adventureId,
                    CAST(@currentScene AS NVARCHAR(MAX)),
                    @status,
                    CAST(@history AS NVARCHAR(MAX)),
                    CAST(@eventHistory AS NVARCHAR(MAX)),
                    CAST(@metadata AS NVARCHAR(MAX)),
                    CAST(@progress AS NVARCHAR(MAX)),
                    CAST(@environment AS NVARCHAR(MAX)),
                    CAST(@flags AS NVARCHAR(MAX)),
                    CAST(@variables AS NVARCHAR(MAX))
                );
            `;

            const result = await this.executeQuery(transaction, insertQuery, {
                adventureId: { type: sql.Int, value: parseInt(data.adventureId, 10) },
                currentScene: { type: sql.NVarChar(sql.MAX), value: data.currentScene },
                status: { type: sql.VarChar(50), value: data.status },
                history: { type: sql.NVarChar(sql.MAX), value: data.history },
                eventHistory: { type: sql.NVarChar(sql.MAX), value: data.eventHistory },
                metadata: { type: sql.NVarChar(sql.MAX), value: data.metadata },
                progress: { type: sql.NVarChar(sql.MAX), value: data.progress },
                environment: { type: sql.NVarChar(sql.MAX), value: data.environment },
                flags: { type: sql.NVarChar(sql.MAX), value: data.flags },
                variables: { type: sql.NVarChar(sql.MAX), value: data.variables }
            }, queryOptions);

            if (!result.recordset?.[0]?.id) {
                throw new Error('Failed to create adventure state record');
            }

            // Set the ID from the database
            state.id = result.recordset[0].id;
            return state;
        } catch (error) {
            logger.error('Failed to create adventure state', { 
                error,
                adventureId: state.adventureId
            });
            throw error;
        }
    }
}

module.exports = new StateRepository(); 