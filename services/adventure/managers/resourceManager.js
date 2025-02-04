/**
 * Resource Manager
 * Handles resource allocation and tracking
 */

const logger = require('../utils/logger');
const resourceRepository = require('../repositories/resourceRepository');

class ResourceManager {
    constructor() {
        // Initialize in-memory cache for resource allocations
        this.resourceAllocations = new Map();
        
        // Default settings for resource management
        this.defaultSettings = {
            maxTokensPerAdventure: 100000,
            maxImagesPerAdventure: 50,
            maxActiveAdventures: 100,
            cleanupInterval: 60 * 60 * 1000, // 1 hour
            resourceTypes: {
                tokens: {
                    limits: {
                        maxPerInterval: 10000,
                        maxTotal: 100000,
                    },
                    resetInterval: 24 * 60 * 60 * 1000, // 24 hours
                },
                images: {
                    limits: {
                        maxPerInterval: 10,
                        maxTotal: 50,
                    },
                    resetInterval: 24 * 60 * 60 * 1000, // 24 hours
                },
                api_calls: {
                    limits: {
                        maxPerInterval: 100,
                        maxTotal: 1000,
                    },
                    resetInterval: 24 * 60 * 60 * 1000, // 24 hours
                },
            },
        };

        // Start cleanup interval
        this._startCleanup();
    }

    /**
     * Initialize resources for a new adventure
     * @param {Object} options Resource initialization options
     * @returns {Promise<Object>} Initialized resources
     */
    async initializeResources({ adventureId, limits = {} }) {
        try {
            logger.info('Initializing resources', { adventureId });

            const transaction = await resourceRepository.beginTransaction();
            try {
                // Initialize resources with settings
                const allocations = await resourceRepository.initializeResources(
                    transaction,
                    adventureId,
                    {
                        ...this.defaultSettings.resourceTypes,
                        ...limits,
                    }
                );

                await transaction.commit();

                // Add to cache
                this.resourceAllocations.set(adventureId, allocations);

                logger.info('Resources initialized', { adventureId });
                return allocations;
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        } catch (error) {
            logger.error('Failed to initialize resources', { error });
            throw error;
        }
    }

    /**
     * Request resource allocation
     * @param {Object} options Allocation request options
     * @returns {Promise<boolean>} Success status
     */
    async requestAllocation({ adventureId, resourceType, amount }) {
        try {
            logger.info('Requesting resource allocation', { adventureId, resourceType, amount });

            // Check if we need to reset usage first
            await this._checkAndResetUsage(adventureId, resourceType);

            const transaction = await resourceRepository.beginTransaction();
            try {
                const success = await resourceRepository.requestAllocation(
                    transaction,
                    adventureId,
                    resourceType,
                    amount
                );

                if (success) {
                    // Update cache
                    const allocations = await resourceRepository.findByAdventure(transaction, adventureId);
                    this.resourceAllocations.set(adventureId, allocations);

                    logger.info('Resource allocated', {
                        adventureId,
                        resourceType,
                        amount,
                    });
                } else {
                    logger.warn('Resource allocation exceeded limit', {
                        adventureId,
                        resourceType,
                        requested: amount,
                    });
                }

                await transaction.commit();
                return success;
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        } catch (error) {
            logger.error('Failed to request allocation', { error });
            throw error;
        }
    }

    /**
     * Release resource allocation
     * @param {Object} options Release options
     * @returns {Promise<boolean>} Success status
     */
    async releaseAllocation({ adventureId, resourceType, amount }) {
        try {
            logger.info('Releasing resource allocation', { adventureId, resourceType, amount });

            const transaction = await resourceRepository.beginTransaction();
            try {
                await resourceRepository.releaseAllocation(
                    transaction,
                    adventureId,
                    resourceType,
                    amount
                );

                // Update cache
                const allocations = await resourceRepository.findByAdventure(transaction, adventureId);
                this.resourceAllocations.set(adventureId, allocations);

                logger.info('Resource released', {
                    adventureId,
                    resourceType,
                    amount,
                });

                await transaction.commit();
                return true;
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        } catch (error) {
            logger.error('Failed to release allocation', { error });
            throw error;
        }
    }

    /**
     * Get resource usage
     * @param {Object} options Usage query options
     * @returns {Promise<Object>} Resource usage
     */
    async getUsage({ adventureId, resourceType }) {
        try {
            // Try cache first
            let allocations = this.resourceAllocations.get(adventureId);
            if (!allocations) {
                // If not in cache, try database
                const transaction = await resourceRepository.beginTransaction();
                try {
                    allocations = await resourceRepository.findByAdventure(transaction, adventureId);
                    if (allocations) {
                        this.resourceAllocations.set(adventureId, allocations);
                    }
                    await transaction.commit();
                } catch (error) {
                    await transaction.rollback();
                    throw error;
                }
            }

            if (!allocations) {
                throw new Error('Resource allocations not found');
            }

            if (resourceType) {
                const allocation = allocations.find(a => a.resourceType === resourceType);
                if (!allocation) {
                    throw new Error(`Resource type ${resourceType} not found`);
                }
                return allocation;
            }

            return allocations;
        } catch (error) {
            logger.error('Failed to get resource usage', { error });
            throw error;
        }
    }

    /**
     * Check and reset usage if needed
     * @param {string} adventureId Adventure ID
     * @param {string} resourceType Resource type
     * @private
     */
    async _checkAndResetUsage(adventureId, resourceType) {
        const transaction = await resourceRepository.beginTransaction();
        try {
            const allocation = await resourceRepository.findByType(transaction, adventureId, resourceType);
            if (!allocation) {
                throw new Error('Resource allocation not found');
            }

            const now = new Date();
            if (now - allocation.lastReset > allocation.resetInterval) {
                allocation.used = 0;
                allocation.lastReset = now;
                await resourceRepository.update(transaction, allocation.id, allocation);
                logger.info('Reset resource usage', { adventureId, resourceType });
            }

            await transaction.commit();
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    }

    /**
     * Start cleanup interval
     * @private
     */
    _startCleanup() {
        setInterval(async () => {
            try {
                await this.cleanupResources();
                logger.debug('Resource cleanup completed');
            } catch (error) {
                logger.error('Resource cleanup failed', { error });
            }
        }, this.defaultSettings.cleanupInterval);
    }

    /**
     * Clean up resources
     * @returns {Promise<void>}
     */
    async cleanupResources() {
        try {
            const transaction = await resourceRepository.beginTransaction();
            try {
                // Clean up each adventure's resources
                for (const [adventureId, allocations] of this.resourceAllocations.entries()) {
                    // Check if all resources are unused
                    const isInactive = allocations.every(allocation => allocation.used === 0);
                    if (isInactive) {
                        await resourceRepository.cleanupResources(transaction, adventureId);
                        this.resourceAllocations.delete(adventureId);
                        logger.info('Cleaned up unused resources', { adventureId });
                    }
                }
                await transaction.commit();
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        } catch (error) {
            logger.error('Failed to clean up resources', { error });
            throw error;
        }
    }
}

module.exports = ResourceManager; 