/**
 * State Repository
 * Handles database operations for adventure states
 */

const BaseRepository = require('./baseRepository');
const logger = require('../utils/logger');

class StateRepository extends BaseRepository {
    constructor() {
        super('adventureStates');
    }

    /**
     * Convert database row to state object
     * @param {Object} row Database row
     * @returns {Object} State object
     * @protected
     */
    _toModel(row) {
        return {
            id: row.id,
            adventureId: row.adventureId,
            currentScene: JSON.parse(row.currentScene),
            status: row.status,
            history: JSON.parse(row.history),
            eventHistory: JSON.parse(row.eventHistory),
            metadata: JSON.parse(row.metadata),
            progress: JSON.parse(row.progress),
            environment: JSON.parse(row.environment),
            flags: JSON.parse(row.flags || '{}'),
            variables: JSON.parse(row.variables || '{}'),
        };
    }

    /**
     * Convert state object to database row
     * @param {Object} model State object
     * @returns {Object} Database row
     * @protected
     */
    _fromModel(model) {
        return {
            adventureId: model.adventureId,
            currentScene: JSON.stringify(model.currentScene),
            status: model.status,
            history: JSON.stringify(model.history),
            eventHistory: JSON.stringify(model.eventHistory),
            metadata: JSON.stringify(model.metadata),
            progress: JSON.stringify(model.progress),
            environment: JSON.stringify(model.environment),
            flags: JSON.stringify(model.flags || {}),
            variables: JSON.stringify(model.variables || {}),
        };
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
}

module.exports = new StateRepository(); 