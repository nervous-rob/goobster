/**
 * Resource Repository
 * Handles database operations for resource allocations
 */

const BaseRepository = require('./baseRepository');
const logger = require('../utils/logger');

class ResourceRepository extends BaseRepository {
    constructor() {
        super('resourceAllocations');
    }

    /**
     * Convert database row to resource allocation object
     * @param {Object} row Database row
     * @returns {Object} Resource allocation object
     * @protected
     */
    _toModel(row) {
        return {
            id: row.id,
            adventureId: row.adventureId,
            resourceType: row.resourceType,
            allocated: row.allocated,
            used: row.used,
            limits: JSON.parse(row.limits),
            resetInterval: row.resetInterval,
            lastReset: new Date(row.lastReset),
            metadata: JSON.parse(row.metadata || '{}'),
        };
    }

    /**
     * Convert resource allocation object to database row
     * @param {Object} model Resource allocation object
     * @returns {Object} Database row
     * @protected
     */
    _fromModel(model) {
        return {
            adventureId: model.adventureId,
            resourceType: model.resourceType,
            allocated: model.allocated,
            used: model.used,
            limits: JSON.stringify(model.limits),
            resetInterval: model.resetInterval,
            lastReset: model.lastReset,
            metadata: JSON.stringify(model.metadata || {}),
        };
    }

    /**
     * Find resource allocations by adventure
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @returns {Promise<Array<Object>>} Resource allocations
     */
    async findByAdventure(transaction, adventureId) {
        return this.findAll(transaction, 'adventureId = @adventureId', { adventureId });
    }

    /**
     * Find resource allocation by type
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {string} resourceType Resource type
     * @returns {Promise<Object>} Resource allocation
     */
    async findByType(transaction, adventureId, resourceType) {
        const result = await this.executeQuery(
            transaction,
            `SELECT * FROM ${this.tableName} 
             WHERE adventureId = @adventureId 
             AND resourceType = @resourceType`,
            { adventureId, resourceType }
        );
        return result.recordset[0] ? this._toModel(result.recordset[0]) : null;
    }

    /**
     * Request resource allocation
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {string} resourceType Resource type
     * @param {number} amount Amount to allocate
     * @returns {Promise<boolean>} Success status
     */
    async requestAllocation(transaction, adventureId, resourceType, amount) {
        const allocation = await this.findByType(transaction, adventureId, resourceType);
        if (!allocation) {
            throw new Error('Resource allocation not found');
        }

        // Check if reset is needed
        const now = new Date();
        if (now - allocation.lastReset > allocation.resetInterval) {
            allocation.used = 0;
            allocation.lastReset = now;
        }

        // Check if allocation is possible
        if (allocation.used + amount > allocation.limits.maxPerInterval) {
            return false;
        }

        // Update allocation
        allocation.used += amount;
        await this.update(transaction, allocation.id, allocation);
        return true;
    }

    /**
     * Release resource allocation
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {string} resourceType Resource type
     * @param {number} amount Amount to release
     * @returns {Promise<Object>} Updated allocation
     */
    async releaseAllocation(transaction, adventureId, resourceType, amount) {
        const allocation = await this.findByType(transaction, adventureId, resourceType);
        if (!allocation) {
            throw new Error('Resource allocation not found');
        }

        allocation.used = Math.max(0, allocation.used - amount);
        return this.update(transaction, allocation.id, allocation);
    }

    /**
     * Initialize resource allocations
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {Object} settings Resource settings
     * @returns {Promise<Array<Object>>} Created allocations
     */
    async initializeResources(transaction, adventureId, settings) {
        const allocations = [];
        for (const [resourceType, config] of Object.entries(settings)) {
            const allocation = {
                adventureId,
                resourceType,
                allocated: 0,
                used: 0,
                limits: config.limits,
                resetInterval: config.resetInterval,
                lastReset: new Date(),
                metadata: {},
            };
            allocations.push(await this.create(transaction, allocation));
        }
        return allocations;
    }

    /**
     * Clean up unused allocations
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @returns {Promise<void>}
     */
    async cleanupResources(transaction, adventureId) {
        await this.executeQuery(
            transaction,
            `DELETE FROM ${this.tableName} WHERE adventureId = @adventureId`,
            { adventureId }
        );
    }
}

module.exports = new ResourceRepository(); 