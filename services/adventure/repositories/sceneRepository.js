/**
 * Scene Repository
 * Handles database operations for scenes
 */

const BaseRepository = require('./baseRepository');
const Scene = require('../models/Scene');
const logger = require('../utils/logger');

class SceneRepository extends BaseRepository {
    constructor() {
        super('scenes');
    }

    /**
     * Convert database row to Scene model
     * @param {Object} row Database row
     * @returns {Scene} Scene instance
     * @protected
     */
    _toModel(row) {
        return new Scene({
            id: row.id,
            adventureId: row.adventureId,
            title: row.title,
            description: row.description,
            choices: JSON.parse(row.choices),
            state: JSON.parse(row.state),
            metadata: JSON.parse(row.metadata),
        });
    }

    /**
     * Convert Scene model to database row
     * @param {Scene} model Scene instance
     * @returns {Object} Database row
     * @protected
     */
    _fromModel(model) {
        return {
            adventureId: model.adventureId,
            title: model.title,
            description: model.description,
            choices: JSON.stringify(model.choices),
            state: JSON.stringify(model.state),
            metadata: JSON.stringify(model.metadata),
            createdAt: model.createdAt,
            lastUpdated: model.lastUpdated,
        };
    }

    /**
     * Find scenes by adventure
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @returns {Promise<Array<Scene>>} Scene instances
     */
    async findByAdventure(transaction, adventureId) {
        return this.findAll(transaction, 'adventureId = @adventureId', { adventureId });
    }

    /**
     * Find active scene for adventure
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @returns {Promise<Scene>} Active scene
     */
    async findActiveScene(transaction, adventureId) {
        const result = await this.executeQuery(
            transaction,
            `SELECT s.*
             FROM ${this.tableName} s
             WHERE s.adventureId = @adventureId
             AND s.state->>'status' = 'active'
             ORDER BY s.createdAt DESC
             LIMIT 1`,
            { adventureId }
        );
        return result.recordset[0] ? this._toModel(result.recordset[0]) : null;
    }

    /**
     * Get scene history
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {number} limit History limit
     * @returns {Promise<Array<Scene>>} Scene history
     */
    async getHistory(transaction, adventureId, limit = 10) {
        const result = await this.executeQuery(
            transaction,
            `SELECT s.*
             FROM ${this.tableName} s
             WHERE s.adventureId = @adventureId
             ORDER BY s.createdAt DESC
             LIMIT @limit`,
            { adventureId, limit }
        );
        return result.recordset.map(row => this._toModel(row));
    }

    /**
     * Complete current scene
     * @param {Object} transaction Transaction object
     * @param {string} sceneId Scene ID
     * @param {Object} outcome Scene outcome
     * @returns {Promise<Scene>} Updated scene
     */
    async completeScene(transaction, sceneId, outcome) {
        const scene = await this.findById(transaction, sceneId);
        if (!scene) {
            throw new Error('Scene not found');
        }

        scene.state.status = 'completed';
        scene.state.outcome = outcome;
        scene.lastUpdated = new Date();

        return this.update(transaction, sceneId, scene);
    }
}

module.exports = new SceneRepository(); 