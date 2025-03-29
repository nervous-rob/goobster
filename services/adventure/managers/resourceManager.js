/**
 * Resource Manager
 * Handles resource allocation and tracking
 */

const logger = require('../utils/logger');
const resourceRepository = require('../repositories/resourceRepository');
const adventureRepository = require('../repositories/adventureRepository');
const { executeTransaction } = require('../../../azureDb');
const { v4: uuidv4 } = require('uuid');

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
                        maxPerInterval: Infinity,
                        maxTotal: Infinity,
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
                specialScenes: {
                    limits: {
                        maxPerInterval: Infinity,
                        maxTotal: Infinity,
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
    async initializeResources({ adventureId, limits = {}, transaction, processId = '' }) {
        const resourceId = processId || uuidv4().substring(0, 8);
        try {
            logger.info(`[${resourceId}] Initializing resources within provided transaction`, { adventureId });

            if (!transaction) {
                logger.error(`[${resourceId}] Transaction object is required for initializeResources`, { adventureId });
                throw new Error('Internal Error: Transaction object missing during resource initialization.');
            }

            // Directly use the provided transaction to initialize resources
            logger.debug(`[${resourceId}] Calling resourceRepository.initializeResources within transaction`);
            const allocations = await resourceRepository.initializeResources(
                transaction,
                adventureId,
                {
                    ...this.defaultSettings.resourceTypes,
                    ...limits,
                }
            );

            // Add to cache (Cache update can happen outside transaction)
            this.resourceAllocations.set(adventureId, allocations);

            logger.info(`[${resourceId}] Resources initialized successfully`, { adventureId });
            return allocations;

        } catch (error) {
            // Error is caught here, but rollback should be handled by the caller (AdventureService)
            logger.error(`[${resourceId}] Failed to initialize resources within transaction`, {
                error: { message: error.message, code: error.code, stack: error.stack },
                adventureId,
                timestamp: new Date().toISOString()
             });
            // Rethrow the error so the caller's executeTransaction handles rollback
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

            // Use transaction with retry
            return await executeTransaction(async (transaction) => {
                // Get current allocation with lock
                const allocation = await resourceRepository.findByType(
                    transaction, 
                    adventureId, 
                    resourceType,
                    { withLock: true }
                );

                if (!allocation) {
                    throw new Error('Resource allocation not found');
                }

                // Check if allocation is possible
                const now = new Date();
                if (now - allocation.lastReset > allocation.resetInterval) {
                    allocation.used = 0;
                    allocation.lastReset = now;
                }

                // Validate against limits - skip check if limit is null (Infinity)
                if (allocation.limits.maxPerInterval !== null && 
                    (allocation.used + amount > allocation.limits.maxPerInterval)) {
                    logger.warn('Resource allocation exceeded interval limit', {
                        adventureId,
                        resourceType,
                        used: allocation.used,
                        requested: amount,
                        limit: allocation.limits.maxPerInterval,
                        timestamp: new Date().toISOString()
                    });
                    return false;
                }

                if (allocation.limits.maxTotal !== null && 
                    (allocation.used + amount > allocation.limits.maxTotal)) {
                    logger.warn('Resource allocation exceeded total limit', {
                        adventureId,
                        resourceType,
                        used: allocation.used,
                        requested: amount,
                        limit: allocation.limits.maxTotal,
                        timestamp: new Date().toISOString()
                    });
                    return false;
                }

                // Update allocation
                allocation.used += amount;
                allocation.lastUpdated = now;
                await resourceRepository.update(transaction, allocation.id, allocation);

                // Update cache
                this.resourceAllocations.set(
                    this._getCacheKey(adventureId, resourceType),
                    allocation
                );

                logger.info('Resource allocated successfully', {
                    adventureId,
                    resourceType,
                    amount,
                    totalUsed: allocation.used,
                    timestamp: new Date().toISOString()
                });

                return true;
            }, 3); // 3 retries

        } catch (error) {
            logger.error('Failed to request allocation', { 
                error: {
                    message: error.message,
                    code: error.code,
                    stack: error.stack
                },
                adventureId,
                resourceType,
                amount,
                timestamp: new Date().toISOString()
            });
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
                // If allocation doesn't exist for this type (maybe added later), try to create it based on defaults
                logger.warn('Resource allocation not found during check/reset, attempting to initialize.', { adventureId, resourceType });
                const defaultLimits = this.defaultSettings.resourceTypes[resourceType];
                if (defaultLimits) {
                    await resourceRepository.initializeResources(transaction, adventureId, { [resourceType]: defaultLimits });
                    logger.info('Initialized missing resource allocation.', { adventureId, resourceType });
                    await transaction.commit(); // Commit the initialization
                    // No need to proceed further in this check, next request will find it
                    return; 
                } else {
                    throw new Error(`Resource allocation not found and no default settings exist for type: ${resourceType}`);
                }
            }

            let needsUpdate = false;
            const now = new Date();
            const defaultResourceConfig = this.defaultSettings.resourceTypes[resourceType];

            // 1. Check if usage needs resetting due to interval
            if (allocation.resetInterval && (now - allocation.lastReset > allocation.resetInterval)) {
                logger.info('Resetting resource usage due to interval.', { 
                    adventureId, 
                    resourceType, 
                    lastReset: allocation.lastReset, 
                    interval: allocation.resetInterval 
                });
                allocation.used = 0;
                allocation.lastReset = now;
                needsUpdate = true;
            }

            // 2. Check if stored limits need updating based on default settings
            if (defaultResourceConfig) {
                const defaultLimits = defaultResourceConfig.limits;
                const currentLimits = allocation.limits;
                
                // Compare interval and total limits. Use simple JSON string comparison for nested objects.
                if (JSON.stringify(defaultLimits) !== JSON.stringify(currentLimits)) {
                     logger.info('Updating resource limits to match defaults.', { 
                        adventureId, 
                        resourceType, 
                        oldLimits: currentLimits, 
                        newLimits: defaultLimits 
                    });
                    allocation.limits = defaultLimits; // Update the limits object
                    needsUpdate = true;
                }
                
                 // Also check and update resetInterval if necessary
                if (defaultResourceConfig.resetInterval !== allocation.resetInterval) {
                    logger.info('Updating resource reset interval to match defaults.', { 
                        adventureId, 
                        resourceType, 
                        oldInterval: allocation.resetInterval, 
                        newInterval: defaultResourceConfig.resetInterval
                    });
                    allocation.resetInterval = defaultResourceConfig.resetInterval;
                    needsUpdate = true;
                }
                
            } else {
                logger.warn('No default configuration found for resource type, cannot sync limits.', { adventureId, resourceType });
            }


            // 3. If any changes were made (resetting usage or updating limits), update the DB record
            if (needsUpdate) {
                await resourceRepository.update(transaction, allocation.id, allocation);
                logger.info('Updated resource allocation record.', { adventureId, resourceType, needsUpdate });
                
                // Also update the cache immediately after DB update
                 this.resourceAllocations.set(
                    this._getCacheKey(adventureId, resourceType),
                    allocation
                );
            }

            await transaction.commit();
        } catch (error) {
            await transaction.rollback();
            // Log the error but don't necessarily rethrow unless it's critical
            logger.error('Failed during _checkAndResetUsage', { 
                error: { message: error.message, stack: error.stack },
                adventureId, 
                resourceType 
            });
             // Rethrow specific errors like "not found" if initialization also failed
            if (error.message.includes('Resource allocation not found')) {
                 throw error; // Propagate if initialization couldn't fix it
            }
            // For other errors, we might allow proceeding, but log it was problematic.
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
                const now = new Date();
                const staleThreshold = now - (24 * 60 * 60 * 1000); // 24 hours

                // Get all allocations
                const allocations = await resourceRepository.findAll(transaction);
                
                for (const allocation of allocations) {
                    // Check if allocation is stale
                    if (allocation.lastUpdated < staleThreshold) {
                        // Check if adventure is still active
                        const adventure = await adventureRepository.findById(
                            transaction,
                            allocation.adventureId
                        );

                        if (!adventure || ['completed', 'failed'].includes(adventure.status)) {
                            // Clean up the allocation
                            await resourceRepository.delete(transaction, allocation.id);
                            
                            // Remove from cache
                            this.resourceAllocations.delete(
                                this._getCacheKey(allocation.adventureId, allocation.resourceType)
                            );

                            logger.info('Cleaned up stale resource allocation', {
                                adventureId: allocation.adventureId,
                                resourceType: allocation.resourceType,
                                lastUsed: allocation.lastUpdated,
                                timestamp: new Date().toISOString()
                            });
                        }
                    }
                }

                await transaction.commit();
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        } catch (error) {
            logger.error('Failed to clean up resources', { 
                error: {
                    message: error.message,
                    code: error.code,
                    stack: error.stack
                },
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    /**
     * Get cache key for resource allocation
     * @param {string} adventureId Adventure ID
     * @param {string} resourceType Resource type
     * @returns {string} Cache key
     * @private
     */
    _getCacheKey(adventureId, resourceType) {
        return `${adventureId}:${resourceType}`;
    }
}

module.exports = ResourceManager; 