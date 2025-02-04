/**
 * Party Manager
 * Handles party management and member operations
 */

const Party = require('../models/Party');
const logger = require('../utils/logger');
const partyRepository = require('../repositories/partyRepository');
const adventureRepository = require('../repositories/adventureRepository');

class PartyManager {
    constructor() {
        // Initialize in-memory cache of active parties
        this.activeParties = new Map();
        
        // Default settings
        this.defaultSettings = {
            maxPartySize: 4,
            defaultRole: 'member',
            leaderRole: 'leader',
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
     * @param {string} options.adventurerName Leader's adventurer name
     * @param {string} [options.backstory] Leader's character backstory
     * @param {Object} [options.settings] Additional party settings
     * @returns {Promise<Party>} Created party instance
     */
    async createParty({ leaderId, adventurerName, backstory, settings = {} }) {
        try {
            logger.info('Creating new party', { leaderId, adventurerName });

            // Create party instance with default settings
            const party = new Party({
                leaderId,
                leaderName: adventurerName,
                leaderBackstory: backstory,
                settings: {
                    ...this.defaultSettings,
                    ...settings,
                },
                status: 'RECRUITING'
            });

            // Start transaction
            const transaction = await partyRepository.beginTransaction();
            try {
                // Create party in database
                const createdParty = await partyRepository.create(transaction, party);
                await transaction.commit();

                // Add to cache
                this.activeParties.set(createdParty.id, createdParty);
                logger.info('Party created successfully', { 
                    partyId: createdParty.id,
                    leaderId,
                    leaderName: adventurerName,
                    memberCount: createdParty.members.length
                });

                return createdParty;
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        } catch (error) {
            logger.error('Failed to create party', { 
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                leaderId,
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
     * @param {string} [options.role] Role for the member
     * @returns {Promise<boolean>} Success status
     */
    async addMember({ partyId, userId, adventurerName, backstory, role = null }) {
        try {
            logger.info('Adding member to party', { partyId, userId, adventurerName });

            const transaction = await partyRepository.beginTransaction();
            try {
                // Get party with current members
                const party = await partyRepository.getWithMembers(transaction, partyId);
                if (!party) {
                    throw new Error('Party not found');
                }

                // Validate party can accept members
                if (!party.canAcceptMembers) {
                    throw new Error('Party cannot accept new members');
                }

                // Check if user is already in another party
                const existingParty = await this.findPartyByMember(userId);
                if (existingParty) {
                    throw new Error('User is already in another party');
                }

                // Check if party would be full after adding this member
                if (party.members.length + 1 >= party.settings.maxSize) {
                    party.status = 'ACTIVE';
                }

                // Add member
                party.addMember({
                    userId,
                    adventurerName,
                    backstory,
                    role
                });

                // Update party in database
                await partyRepository.update(transaction, partyId, party);

                // Update cache
                this.activeParties.set(partyId, party);

                await transaction.commit();
                logger.info('Member added successfully', { 
                    partyId, 
                    userId,
                    adventurerName,
                    role: role || party.settings.defaultRole
                });

                return true;
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
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
            // Try cache first
            for (const party of this.activeParties.values()) {
                if (party.isMember(userId)) {
                    return party;
                }
            }

            // If not in cache, try database
            const transaction = await partyRepository.beginTransaction();
            try {
                const party = await partyRepository.findByMember(transaction, userId);
                if (party) {
                    this.activeParties.set(party.id, party);
                }
                await transaction.commit();
                return party;
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        } catch (error) {
            logger.error('Failed to find party by member', { 
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                userId
            });
            throw error;
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
            const transaction = await partyRepository.beginTransaction();
            try {
                // Get party with current members
                const party = await partyRepository.getWithMembers(transaction, partyId);
                if (!party) {
                    throw new Error('Party not found');
                }

                // Update party status to disbanded
                party.status = 'DISBANDED';
                party.isActive = false;
                party.lastUpdated = new Date();

                // Update party in database
                await partyRepository.update(transaction, partyId, party);

                // If party is in an adventure, mark it as failed
                if (party.adventureId) {
                    await adventureRepository.updateStatus(transaction, party.adventureId, 'failed');
                }

                await transaction.commit();

                // Remove from cache
                this.activeParties.delete(partyId);

                logger.info('Party disbanded successfully', { 
                    partyId,
                    adventureId: party.adventureId
                });

            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        } catch (error) {
            logger.error('Failed to disband party', { error });
            throw error;
        }
    }
}

module.exports = PartyManager; 