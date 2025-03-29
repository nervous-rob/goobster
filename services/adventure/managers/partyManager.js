/**
 * Party Manager
 * Handles party management and member operations
 */

// Use a single logger across the file
const logger = require('../utils/logger');
const Party = require('../models/Party');
const { transactionUtils } = require('../utils');
const partyRepository = require('../repositories/partyRepository');
const adventureRepository = require('../repositories/adventureRepository');
const sql = require('mssql'); // Import sql module for SQL type definitions

const { executeWithTimeout, executeTransaction } = transactionUtils;

const PARTY_CACHE_EXPIRATION_MS = 30 * 60 * 1000; // 30 minutes

// Create helper function to ensure SQL params are properly typed
function ensureSqlParams(params) {
    if (!params) return params;
    
    // Create a deep copy to avoid modifying original
    const result = {...params};
    
    // Handle common parameter conversions
    if (result.userId && typeof result.userId !== 'object') {
        result.userId = {
            value: result.userId.toString(),
            type: sql.VarChar(50)
        };
    }
    
    if (result.partyId && typeof result.partyId !== 'object') {
        result.partyId = {
            value: parseInt(result.partyId, 10),
            type: sql.Int
        };
    }
    
    if (result.status && typeof result.status !== 'object') {
        result.status = {
            value: result.status,
            type: sql.VarChar(50)
        };
    }
    
    return result;
}

class PartyManager {
    constructor() {
        // Initialize in-memory cache of active parties
        this.activeParties = new Map();
        
        // Default settings
        this.defaultSettings = {
            maxPartySize: 4,
            defaultMemberType: 'member',
            leaderMemberType: 'leader',
            partyTimeout: 24 * 60 * 60 * 1000, // 24 hours
            maxInactiveTime: 7 * 24 * 60 * 60 * 1000, // 7 days
        };

        // Start cleanup interval
        this._startCleanupInterval();
    }

    /**
     * Create a new party
     * @param {Object} options Party creation options
     * @param {string} options.leaderId User ID of party leader
     * @param {number} options.internalLeaderId Internal User ID of party leader
     * @param {string} options.adventurerName Leader's adventurer name
     * @param {string} [options.backstory] Leader's character backstory
     * @param {Object} [options.settings] Additional party settings
     * @returns {Promise<Party>} Created party instance
     */
    async createParty({ leaderId, internalLeaderId, adventurerName, backstory, settings = {} }) {
        try {
            logger.info('Creating new party', { leaderId, internalLeaderId, adventurerName });

            // Validate internalLeaderId
            if (!internalLeaderId || typeof internalLeaderId !== 'number') {
                logger.error('Invalid internalLeaderId provided to createParty', { internalLeaderId, leaderId });
                throw new Error('Internal validation error: Missing or invalid internal leader ID.');
            }

            // Verify adventurerName is valid
            if (!adventurerName || typeof adventurerName !== 'string') {
                throw new Error('Adventurer name is required and must be a string');
            }

            // Ensure adventurerName is properly trimmed
            const trimmedName = adventurerName.trim();
            if (trimmedName.length === 0) {
                throw new Error('Adventurer name cannot be empty');
            }

            // Create the party instance outside the transaction
            const party = new Party({
                leaderId,
                adventurerName: trimmedName, // Use trimmed name
                leaderBackstory: backstory, // Ensure correct property name
                settings: {
                    maxSize: settings.maxSize || 4,
                    minPartySize: settings.minPartySize || 1,
                    voiceChannel: settings.voiceChannel || null,
                    ...settings
                },
                adventureStatus: 'RECRUITING' // Ensure correct property name
            });

            // Validate party settings
            if (party.settings.maxSize < party.settings.minPartySize) {
                throw new Error('Maximum party size cannot be less than minimum party size');
            }

            if (party.settings.maxSize > 8) {
                throw new Error('Maximum party size cannot exceed 8 members');
            }

            // Use executeTransaction with proper retry logic
            return await partyRepository.executeTransaction(async (transaction) => {
                // Check if user already has an active party
                const existingParty = await partyRepository.findByMember(transaction, leaderId);
                if (existingParty && existingParty.isActive && existingParty.adventureStatus !== 'DISBANDED') {
                    throw new Error('You already have an active party');
                }

                // Create the party
                const createdParty = await partyRepository.create(transaction, party, internalLeaderId);
                
                // Verify we got a valid party back
                if (!createdParty || !createdParty.id) {
                    throw new Error('Failed to retrieve ID for newly created party');
                }
                
                // Add to cache
                this.activeParties.set(createdParty.id, createdParty);
                
                logger.info('Party created successfully', { 
                    partyId: createdParty.id,
                    leaderId,
                    leaderName: trimmedName,
                    memberCount: createdParty.members.length
                });
                
                return createdParty;
            }, 3); // Try up to 3 times with exponential backoff
        } catch (error) {
            logger.error('Failed to create party', { 
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                leaderId,
                internalLeaderId,
                adventurerName
            });
            throw error;
        }
    }

    /**
     * Add member to party
     * @param {Object} options Member addition options
     * @param {string} options.partyId Party ID
     * @param {string} options.userId User ID joining
     * @param {string} options.adventurerName Character name
     * @param {string} [options.backstory] Character backstory
     * @param {string} [options.memberType] Role for the member
     * @returns {Promise<boolean>} Success status
     */
    async addMember({ partyId, userId, adventurerName, backstory, memberType = null }) {
        try {
            logger.info('Adding member to party', { partyId, userId, adventurerName });

            // Validate inputs
            if (!partyId || !userId || !adventurerName) {
                throw new Error('Party ID, User ID, and Adventurer Name are required.');
            }

            return await partyRepository.executeTransaction(async (transaction) => {
                // Get party using the refined getWithMembers which returns the model with Discord IDs
                const party = await partyRepository.getWithMembers(transaction, partyId);
                if (!party) {
                    throw new Error('Party not found');
                }

                // Validate party can accept members
                if (!party.canAcceptMembers) {
                    throw new Error(`Party cannot accept new members. Status: ${party.adventureStatus}, Size: ${party.size}/${party.settings.maxSize}`);
                }

                // Check if user is already in *any* active party using the manager's find method
                const existingParty = await this.findPartyByMember(userId);
                if (existingParty && existingParty.id !== partyId) {
                    throw new Error('You are already in another active party.');
                } 
                // Also check if they are already in *this* party (Model check)
                if (party.isMember(userId)) {
                     throw new Error('You are already a member of this party.');
                }

                // Call the repository's addMember method, which now handles the ID lookup and insertion
                const memberData = {
                    userId, // Pass Discord ID
                    adventurerName,
                    backstory,
                    memberType: memberType || party.settings.defaultMemberType
                };
                await partyRepository.addMember(transaction, partyId, memberData);
                
                // Refetch party state after adding member to get the updated list
                const updatedParty = await partyRepository.getWithMembers(transaction, partyId);
                if (!updatedParty) {
                    // This shouldn't happen, but handle defensively
                    throw new Error('Failed to fetch updated party state after adding member.');
                }

                // Check if party is now full and update status if needed
                if (updatedParty.size >= updatedParty.settings.maxSize) {
                    updatedParty.status = 'ACTIVE'; // Update model status
                    // Use the repository's update method to persist the status change
                    await partyRepository.update(transaction, partyId, updatedParty);
                    logger.info('Party is now full, status updated to ACTIVE', { partyId });
                } else {
                     // Ensure status remains RECRUITING if not full
                     if (updatedParty.status !== 'RECRUITING') {
                          updatedParty.status = 'RECRUITING';
                          await partyRepository.update(transaction, partyId, updatedParty);
                          logger.info('Party status ensured as RECRUITING', { partyId });
                     }
                }

                // Update cache with the latest state
                this.activeParties.set(partyId, updatedParty);

                logger.info('Member added successfully', { 
                    partyId, 
                    userId,
                    adventurerName,
                    memberType: memberData.memberType,
                    newPartySize: updatedParty.size
                });

                return true; // Indicate success
            }, 3); // Retry transaction up to 3 times

        } catch (error) {
            logger.error('Failed to add member', { 
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                partyId,
                userId,
                adventurerName
            });
            // Re-throw the error for the command handler
            throw error; 
        }
    }

    /**
     * Remove member from party
     * @param {Object} options Member removal options
     * @returns {Promise<boolean>} Success status
     */
    async removeMember({ partyId, userId }) {
        try {
            logger.info('Removing member from party', { partyId, userId });

            const transaction = await partyRepository.beginTransaction();
            try {
                const updatedParty = await partyRepository.removeMember(transaction, partyId, userId);
                await transaction.commit();

                // Update cache
                if (updatedParty.status === 'disbanded') {
                    this.activeParties.delete(partyId);
                } else {
                    this.activeParties.set(partyId, updatedParty);
                }

                logger.info('Member removed from party', { partyId, userId });
                return true;
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        } catch (error) {
            logger.error('Failed to remove member', { error });
            throw error;
        }
    }

    /**
     * Get party information
     * @param {string} partyId Party ID
     * @returns {Promise<Party>} Party instance
     */
    async getParty(partyId) {
        try {
            // Try cache first
            let party = this.activeParties.get(partyId);
            if (!party) {
                // If not in cache, try database
                const transaction = await partyRepository.beginTransaction();
                try {
                    party = await partyRepository.getWithMembers(transaction, partyId);
                    if (party) {
                        this.activeParties.set(partyId, party);
                    }
                    await transaction.commit();
                } catch (error) {
                    await transaction.rollback();
                    throw error;
                }
            }

            if (!party) {
                throw new Error('Party not found');
            }

            return party;
        } catch (error) {
            logger.error('Failed to get party', { 
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                partyId
            });
            throw error;
        }
    }

    /**
     * Find party by member
     * @param {string} userId User ID to check
     * @returns {Promise<Party|null>} Party instance if found, null otherwise
     */
    async findPartyByMember(userId) {
        try {
            // Handle null or undefined userId
            if (!userId) {
                logger.debug('findPartyByMember called with empty userId', { 
                    userId,
                    stack: new Error().stack.split('\n')[2] // Log caller
                });
                return null;
            }
            
            // Ensure userId is a string
            const userIdStr = userId.toString();
            
            // Check cache first
            for (const party of this.activeParties.values()) {
                const partyLeaderId = party.leaderId ? party.leaderId.toString() : null;
                
                if (partyLeaderId === userIdStr) {
                    logger.debug('Found party by leader in cache', { 
                        partyId: party.id,
                        leaderId: partyLeaderId
                    });
                    return party;
                }
                
                // Check party members
                if (party.members && party.members.some(m => {
                    const memberId = m.userId ? m.userId.toString() : null;
                    return memberId === userIdStr;
                })) {
                    logger.debug('Found party by member in cache', { 
                        partyId: party.id,
                        userId: userIdStr
                    });
                    return party;
                }
            }

            // Not in cache, fetch from database with retry
            let retryCount = 0;
            const maxRetries = 2;
            
            while (retryCount <= maxRetries) {
                try {
                    logger.debug('Fetching party from database', { 
                        userId: userIdStr,
                        attempt: retryCount + 1
                    });
                    
                    // Create a transaction for the repository call
                    let party = null;
                    
                    await executeTransaction(async (transaction) => {
                        party = await partyRepository.findByMember(transaction, userIdStr);
                    });
                    
                    if (party) {
                        logger.debug('Found party in database', { 
                            partyId: party.id,
                            userId: userIdStr
                        });
                        this.activeParties.set(party.id, party);
                    } else {
                        logger.debug('No party found in database', { userId: userIdStr });
                    }
                    
                    return party;
                } catch (dbError) {
                    retryCount++;
                    if (retryCount > maxRetries) throw dbError;
                    
                    // Exponential backoff
                    const delay = Math.pow(2, retryCount) * 100;
                    logger.warn('Retrying database query', { 
                        error: dbError.message,
                        attempt: retryCount,
                        delay
                    });
                    
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
            
            return null;
        } catch (error) {
            logger.error('Error finding party by member', { 
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                userId: userId ? userId.toString() : 'undefined'
            });
            return null;
        }
    }

    /**
     * Get all parties for an adventure
     * @param {string} adventureId Adventure ID
     * @returns {Promise<Array<Party>>} Array of party instances
     */
    async getPartiesForAdventure(adventureId) {
        try {
            const transaction = await partyRepository.beginTransaction();
            try {
                const parties = await partyRepository.findByAdventure(transaction, adventureId);
                await transaction.commit();

                // Update cache
                parties.forEach(party => {
                    this.activeParties.set(party.id, party);
                });

                return parties;
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        } catch (error) {
            logger.error('Failed to get parties for adventure', { error });
            throw error;
        }
    }

    /**
     * Link a party to an adventure
     * @param {string} partyId Party ID
     * @param {string} adventureId Adventure ID
     * @returns {Promise<void>}
     */
    async linkPartyToAdventure(partyId, adventureId) {
        // Added processId for better log correlation
        const processId = Math.random().toString(36).substring(2, 10);
        logger.info(`[${processId}] linkPartyToAdventure started`, { partyId, adventureId });
        console.time(`[${processId}] linkPartyToAdventure Total`);

        try {
            // Execute the linking logic within a transaction with retry
            await partyRepository.executeTransaction(async (transaction) => {
                const transactionStartTime = Date.now();
                logger.info(`[${processId}] Starting transaction block for party link validation`, { attempt: transaction.attempt || 1 }); // Assuming attempt number is available
                console.time(`[${processId}] Party Link Validation Transaction`);

                try {
                    // 1. Fetch the party to ensure it exists and potentially get leader info
                    logger.debug(`[${processId}] Fetching party for validation`, { partyId });
                    console.time(`[${processId}] Fetch Party for Validation`);
                    const party = await partyRepository.getWithMembers(transaction, partyId);
                    console.timeEnd(`[${processId}] Fetch Party for Validation`);
                    
                    if (!party) {
                        logger.error(`[${processId}] Party not found during link validation`, { partyId });
                        throw new Error(`Party with ID ${partyId} not found.`);
                    }
                    logger.debug(`[${processId}] Party found for validation`, { partyId: party.id, memberCount: party.members?.length || 0 });

                    // 2. Link party and adventure in the join table (partyAdventures)
                    // This is handled by adventureRepository.create, so we don't repeat it here.
                    // logger.info(`[${processId}] Linking party and adventure in join table`, { partyId, adventureId });
                    // console.time(`[${processId}] Insert partyAdventures`);
                    // await adventureRepository.linkPartyToAdventure(transaction, adventureId, partyId); // Assuming adventure repo handles this table
                    // console.timeEnd(`[${processId}] Insert partyAdventures`);
                    // logger.debug(`[${processId}] partyAdventures link created`);
                    
                    // 3. Update the party's status to 'ACTIVE'
                    // This is also handled by adventureRepository.linkPartyToAdventure called within adventureRepository.create.
                    // No need to call partyRepository.update here.
                    // logger.info(`[${processId}] Updating party status to ACTIVE`, { partyId });
                    // console.time(`[${processId}] Update Party Status`);
                    // const updates = { adventureStatus: 'ACTIVE', lastUpdated: new Date() };
                    // const typedUpdates = {
                    //     adventureStatus: { type: sql.VarChar, value: 'ACTIVE' },
                    //     lastUpdated: { type: sql.DateTime, value: new Date() }
                    // };
                    // await this.partyRepository.update(transaction, partyId, typedUpdates);
                    // console.timeEnd(`[${processId}] Update Party Status`);
                    // logger.debug(`[${processId}] Party status updated successfully`);

                    // Potentially update member statuses if needed (Example - depends on schema)
                    // ... (keep existing member update logic if needed, otherwise remove) ...
                    
                    const transactionEndTime = Date.now();
                    console.timeEnd(`[${processId}] Party Link Validation Transaction`);
                    logger.info(`[${processId}] Transaction block for validation completed successfully`, { durationMs: transactionEndTime - transactionStartTime });

                } catch (error) {
                    console.timeEnd(`[${processId}] Party Link Validation Transaction`); // Ensure timer ends on error
                    logger.error(`[${processId}] Error within party link validation transaction`, { 
                        error: { message: error.message, stack: error.stack, code: error.code }, 
                        partyId, 
                        adventureId 
                    });
                    // Rethrow the error to trigger rollback by executeTransaction
                    throw error;
                }
            }, 3); // Retry logic embedded in executeTransaction

            console.timeEnd(`[${processId}] linkPartyToAdventure Total`);
            logger.info(`[${processId}] linkPartyToAdventure completed successfully`, { partyId, adventureId });

        } catch (error) {
            console.timeEnd(`[${processId}] linkPartyToAdventure Total`); // End timer on error
            logger.error(`[${processId}] Failed to link party to adventure`, {
                error: { message: error.message, code: error.code, stack: error.stack },
                partyId,
                adventureId
            });
            throw error;
        }
    }

    /**
     * Update party settings
     * @param {Object} options Update options
     * @returns {Promise<Party>} Updated party instance
     */
    async updatePartySettings({ partyId, settings }) {
        try {
            const transaction = await partyRepository.beginTransaction();
            try {
                const party = await partyRepository.findById(transaction, partyId);
                if (!party) {
                    throw new Error('Party not found');
                }

                party.settings = {
                    ...party.settings,
                    ...settings,
                };

                const updatedParty = await partyRepository.update(transaction, partyId, party);
                await transaction.commit();

                // Update cache
                this.activeParties.set(partyId, updatedParty);

                return updatedParty;
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        } catch (error) {
            logger.error('Failed to update party settings', { error });
            throw error;
        }
    }

    /**
     * Start the cleanup interval for inactive parties
     * @private
     */
    _startCleanupInterval() {
        setInterval(async () => {
            try {
                const now = new Date();
                for (const [partyId, party] of this.activeParties) {
                    // Remove from cache if inactive for too long
                    const inactiveTime = now - new Date(party.lastUpdated);
                    if (inactiveTime > this.defaultSettings.maxInactiveTime) {
                        this.activeParties.delete(partyId);
                    }
                }
            } catch (error) {
                logger.error('Error in party cleanup interval', { error });
            }
        }, this.defaultSettings.partyTimeout);
    }

    /**
     * Disband a party and clean up associated resources
     * @param {string} partyId Party ID to disband
     * @returns {Promise<void>}
     */
    async disbandParty(partyId) {
        try {
            logger.info('Disbanding party', { partyId });
            
            // Use executeTransaction to handle transaction lifecycle automatically
            return await partyRepository.executeTransaction(async (transaction) => {
                try {
                    // Get party with current members
                    const party = await partyRepository.getWithMembers(transaction, partyId);
                    if (!party) {
                        logger.warn('Party not found for disbanding', { partyId });
                        return;
                    }

                    // If party is already disbanded, just return
                    if (party.status === 'DISBANDED') {
                        logger.info('Party is already disbanded', { partyId });
                        return;
                    }

                    logger.debug('Found party to disband', { 
                        partyId,
                        status: party.status,
                        memberCount: party.members?.length || 0
                    });

                    // Find any active adventures for this party
                    const adventures = await adventureRepository.findByParty(transaction, partyId);
                    
                    // If party is in an adventure, mark it as failed and unlink it
                    for (const adventure of adventures) {
                        await adventureRepository.updateStatus(transaction, adventure.id, 'failed');
                        await adventureRepository.unlinkPartyFromAdventure(transaction, adventure.id, partyId);
                    }

                    // Remove all party members
                    await partyRepository.removeAllMembers(transaction, partyId);

                    // Update party status to disbanded
                    party.status = 'DISBANDED';
                    party.isActive = false;
                    party.lastUpdated = new Date();

                    // Update party in database
                    await partyRepository.update(transaction, partyId, party);

                    // For additional safety, directly update the database field as well
                    const updateQuery = `
                        UPDATE parties
                        SET isActive = 0, 
                            adventureStatus = 'DISBANDED',
                            lastUpdated = GETDATE()
                        WHERE id = @partyId
                    `;
                    
                    await partyRepository.executeQuery(transaction, updateQuery, {
                        partyId: {
                            value: partyId,
                            type: sql.Int
                        }
                    });

                    // Remove from cache
                    this.activeParties.delete(partyId);

                    logger.info('Party disbanded successfully', { 
                        partyId,
                        adventureCount: adventures.length
                    });
                } catch (error) {
                    logger.error('Error during party disbanding', {
                        error: {
                            message: error.message,
                            code: error.code || error.number,
                            stack: error.stack
                        },
                        partyId
                    });
                    throw error;
                }
            }, 3); // Try up to 3 times
        } catch (error) {
            logger.error('Failed to disband party', { 
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                partyId
            });
            throw error;
        }
    }

    /**
     * Force cleanup any stale or inconsistent party records for a user
     * @param {string} userId User ID to clean up records for
     * @returns {Promise<void>}
     */
    async forceCleanupUserPartyRecords(userId) {
        try {
            // Validate userId
            if (!userId) {
                logger.warn('Null or undefined userId passed to forceCleanupUserPartyRecords', { userId });
                return; // Nothing to do if no userId
            }
            
            // Normalize userId to string
            const userIdStr = userId.toString();
            
            logger.info('Force cleaning up party records for user', { userId: userIdStr });
            
            // First, use a direct query to check for existing parties - this is more reliable
            let foundPartyIds = [];
            
            try {
                await executeTransaction(async (transaction) => {
                    // Set a longer timeout for cleanup operations
                    transaction.request().timeout = 120000; // 2 minutes
                    
                    // Get the internal user ID first
                    const userResult = await transaction.request()
                        .input('discordId', sql.VarChar(255), userIdStr)
                        .query('SELECT id FROM users WITH (NOLOCK) WHERE discordId = @discordId');
                    
                    if (!userResult.recordset || userResult.recordset.length === 0) {
                        logger.warn('User not found during cleanup', { discordId: userIdStr });
                        return;
                    }
                    
                    const internalUserId = userResult.recordset[0].id;
                    
                    // First step: Directly check what party IDs we need to clean up
                    // This separate step helps avoid timeouts in one large transaction
                    const partyCheckQuery = `
                        -- Find parties where user is leader
                        SELECT p.id 
                        FROM parties p WITH (NOLOCK)
                        WHERE p.leaderId = @userId
                        
                        UNION
                        
                        -- Find parties where user is a member
                        SELECT p.id
                        FROM parties p WITH (NOLOCK)
                        JOIN partyMembers pm WITH (NOLOCK) ON p.id = pm.partyId
                        WHERE pm.userId = @userId
                    `;
                    
                    const partyCheckResult = await transaction.request()
                        .input('userId', sql.Int, internalUserId)
                        .query(partyCheckQuery);
                    
                    if (partyCheckResult.recordset && partyCheckResult.recordset.length > 0) {
                        foundPartyIds = partyCheckResult.recordset.map(p => p.id);
                        logger.info('Found parties to clean up', { 
                            userId: userIdStr,
                            internalUserId, 
                            partyCount: foundPartyIds.length,
                            partyIds: foundPartyIds
                        });
                    }
                }, 2);
            } catch (checkError) {
                logger.error('Error during party check phase', {
                    error: checkError,
                    userId: userIdStr
                });
                // Continue even if check phase fails
            }
            
            // Second phase: Clean up member records in a separate transaction
            if (foundPartyIds.length > 0) {
                try {
                    await executeTransaction(async (transaction) => {
                        // Set a longer timeout for cleanup operations
                        transaction.request().timeout = 120000; // 2 minutes
                        
                        // Get the internal user ID first (again, for this transaction)
                        const userResult = await transaction.request()
                            .input('discordId', sql.VarChar(255), userIdStr)
                            .query('SELECT id FROM users WITH (NOLOCK) WHERE discordId = @discordId');
                        
                        if (!userResult.recordset || userResult.recordset.length === 0) {
                            logger.warn('User not found during cleanup phase 2', { discordId: userIdStr });
                            return;
                        }
                        
                        const internalUserId = userResult.recordset[0].id;
                        
                        // Delete party members first using direct SQL
                        if (foundPartyIds.length > 0) {
                            // Safety check - avoid SQL injection by ensuring all IDs are numbers
                            const validPartyIds = foundPartyIds
                                .filter(id => !isNaN(parseInt(id, 10)))
                                .map(id => parseInt(id, 10));
                            
                            if (validPartyIds.length > 0) {
                                // First try to remove all members from these parties
                                const deletePartyMembersQuery = `
                                    DELETE FROM partyMembers 
                                    WHERE partyId IN (${validPartyIds.join(',')})
                                `;
                                
                                await transaction.request().query(deletePartyMembersQuery);
                                logger.debug('Deleted all members from parties', { partyIds: validPartyIds });
                                
                                // Also remove this user from any other parties they might be in
                                await transaction.request()
                                    .input('userId', sql.Int, internalUserId)
                                    .query('DELETE FROM partyMembers WHERE userId = @userId');
                                
                                logger.debug('Removed user from all parties', { internalUserId });
                            }
                        }
                    }, 2);
                } catch (memberError) {
                    logger.error('Error during party member cleanup phase', {
                        error: memberError,
                        userId: userIdStr
                    });
                    // Continue even if member cleanup fails
                }
            }
            
            // Third phase: Delete party records
            if (foundPartyIds.length > 0) {
                try {
                    await executeTransaction(async (transaction) => {
                        // Set a longer timeout for cleanup operations
                        transaction.request().timeout = 120000; // 2 minutes
                        
                        // Get the internal user ID first (again, for this transaction)
                        const userResult = await transaction.request()
                            .input('discordId', sql.VarChar(255), userIdStr)
                            .query('SELECT id FROM users WITH (NOLOCK) WHERE discordId = @discordId');
                        
                        if (!userResult.recordset || userResult.recordset.length === 0) {
                            logger.warn('User not found during cleanup phase 3', { discordId: userIdStr });
                            return;
                        }
                        
                        const internalUserId = userResult.recordset[0].id;
                        
                        // Safety check - avoid SQL injection by ensuring all IDs are numbers
                        const validPartyIds = foundPartyIds
                            .filter(id => !isNaN(parseInt(id, 10)))
                            .map(id => parseInt(id, 10));
                        
                        if (validPartyIds.length > 0) {
                            // Delete parties led by this user
                            const deletePartiesQuery = `
                                DELETE FROM parties
                                WHERE id IN (${validPartyIds.join(',')})
                            `;
                            
                            await transaction.request().query(deletePartiesQuery);
                            logger.debug('Deleted parties', { partyIds: validPartyIds });
                            
                            // Additionally, delete any parties led by this user (in case our first query missed some)
                            await transaction.request()
                                .input('leaderId', sql.Int, internalUserId)
                                .query('DELETE FROM parties WHERE leaderId = @leaderId');
                                
                            logger.debug('Deleted all parties led by user', { internalUserId });
                        }
                    }, 2);
                } catch (partyError) {
                    logger.error('Error during party deletion phase', {
                        error: partyError,
                        userId: userIdStr
                    });
                }
            }
            
            // Finally, clean the cache
            // Look through the active parties cache and remove any for this user
            const userIdString = userId.toString();
            for (const [partyId, party] of this.activeParties.entries()) {
                if (party.leaderId === userIdString || party.members.some(m => m.userId === userIdString)) {
                    this.activeParties.delete(partyId);
                    logger.debug('Removed party from cache during cleanup', { partyId, userId: userIdString });
                }
            }
            
            logger.info('Force cleanup completed for user', { userId: userIdStr });
            return true;
        } catch (error) {
            logger.error('Failed to force cleanup party records', { 
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                userId: userId ? userId.toString() : 'undefined'
            });
            // Don't swallow the error - let the caller handle it
            throw error;
        }
    }

    /**
     * Update party status
     * @param {string} partyId Party ID to update
     * @param {string} status New status for the party
     * @returns {Promise<void>}
     */
    async updatePartyStatus(partyId, status) {
        try {
            logger.info('Updating party status', { partyId, status });
            
            // Use executeTransaction to handle transaction lifecycle automatically
            return await partyRepository.executeTransaction(async (transaction) => {
                try {
                    // Get party with current members
                    const party = await partyRepository.getWithMembers(transaction, partyId);
                    if (!party) {
                        logger.warn('Party not found for status update', { partyId });
                        return;
                    }

                    // Update party status
                    party.status = status;
                    party.lastUpdated = new Date();

                    // Update party in database
                    await partyRepository.update(transaction, partyId, party);
                    
                    // Direct update as backup in case model conversion doesn't work
                    const updateQuery = `
                        UPDATE parties
                        SET adventureStatus = @status,
                            lastUpdated = GETDATE()
                        WHERE id = @partyId
                    `;
                    
                    await partyRepository.executeQuery(transaction, updateQuery, {
                        partyId: {
                            value: partyId,
                            type: sql.Int
                        },
                        status: {
                            value: status,
                            type: sql.VarChar(50)
                        }
                    });

                    // Update cache
                    if (this.activeParties.has(partyId)) {
                        const cachedParty = this.activeParties.get(partyId);
                        cachedParty.status = status;
                        this.activeParties.set(partyId, cachedParty);
                    }

                    logger.info('Party status updated successfully', { 
                        partyId,
                        status
                    });
                } catch (error) {
                    logger.error('Error during party status update', {
                        error: {
                            message: error.message,
                            code: error.code || error.number,
                            stack: error.stack
                        },
                        partyId,
                        status
                    });
                    throw error;
                }
            }, 3); // Try up to 3 times
        } catch (error) {
            logger.error('Failed to update party status', { 
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                partyId,
                status
            });
            throw error;
        }
    }
}

module.exports = PartyManager; 