/**
 * Party Model
 * Represents a group of adventurers
 */

const logger = require('../utils/logger');

class Party {
    /**
     * Create a new Party instance
     * @param {Object} options Party creation options
     * @param {number} [options.id] Party ID (set by database)
     * @param {string} options.leaderId User ID of party leader
     * @param {string} options.leaderName Leader's adventurer name
     * @param {string} [options.leaderBackstory] Leader's character backstory
     * @param {Object} [options.settings={}] Party settings
     * @param {string} [options.status='RECRUITING'] Party status
     * @param {Date} [options.createdAt] Creation timestamp
     * @param {Date} [options.lastUpdated] Last update timestamp
     * @param {boolean} [options.isActive=true] Whether party is active
     */
    constructor({ 
        id, 
        leaderId,
        leaderName,
        leaderBackstory,
        settings = {}, 
        status = 'RECRUITING',
        createdAt = new Date(),
        lastUpdated = new Date(),
        isActive = true
    }) {
        if (!leaderId) {
            throw new Error('Leader ID is required');
        }

        this.id = id;
        this.leaderId = leaderId;
        this.leaderName = leaderName;
        this.leaderBackstory = leaderBackstory;
        this.settings = {
            maxSize: settings.maxSize || 4,
            defaultRole: settings.defaultRole || 'member',
            leaderRole: settings.leaderRole || 'leader',
            ...settings
        };
        this.status = status;
        this.createdAt = createdAt;
        this.lastUpdated = lastUpdated;
        this.isActive = isActive;
        this.members = [];

        // Note: We don't add the leader here anymore since they'll be added through the repository
        // This prevents duplicate member entries
        
        logger.debug('Created new Party instance', { 
            partyId: this.id,
            leaderId: this.leaderId,
            status: this.status,
            memberCount: this.members.length
        });
    }

    /**
     * Add a member to the party
     * @param {Object} member Member details
     * @param {string} member.userId User ID
     * @param {string} member.adventurerName Character name
     * @param {string} [member.backstory] Character backstory
     * @param {string} [member.role] Member role
     * @throws {Error} If party is full or user is already a member
     */
    addMember({ userId, adventurerName, backstory, role = null }) {
        if (!userId || !adventurerName) {
            throw new Error('User ID and adventurer name are required');
        }

        if (this.members.length >= this.settings.maxSize) {
            throw new Error('Party is full');
        }

        if (this.members.some(m => m.userId === userId)) {
            throw new Error('User is already a member of this party');
        }

        // Determine role - if it's the leader, use leader role, otherwise use provided role or default
        const memberRole = userId === this.leaderId ? 
            this.settings.leaderRole : 
            (role || this.settings.defaultRole);

        this.members.push({
            userId,
            adventurerName,
            backstory,
            role: memberRole,
            joinedAt: new Date()
        });

        this.lastUpdated = new Date();

        logger.debug('Added member to party', {
            partyId: this.id,
            userId,
            adventurerName,
            role: memberRole,
            memberCount: this.members.length
        });
    }

    /**
     * Remove a member from the party
     * @param {string} userId User ID to remove
     * @returns {boolean} Whether member was removed
     */
    removeMember(userId) {
        if (userId === this.leaderId) {
            throw new Error('Cannot remove party leader');
        }

        const initialLength = this.members.length;
        this.members = this.members.filter(member => member.userId !== userId);
        
        const removed = initialLength > this.members.length;
        if (removed) {
            this.lastUpdated = new Date();
            
            // Update status if no members left except leader
            if (this.members.length === 1 && this.members[0].userId === this.leaderId) {
                this.status = 'RECRUITING';
            }

            logger.debug('Removed member from party', {
                partyId: this.id,
                userId,
                newStatus: this.status,
                remainingMembers: this.members.length
            });
        }
        return removed;
    }

    /**
     * Check if user is a member of the party
     * @param {string} userId User ID to check
     * @returns {boolean} Whether user is a member
     */
    isMember(userId) {
        return this.members.some(member => member.userId === userId);
    }

    /**
     * Check if user is the party leader
     * @param {string} userId User ID to check
     * @returns {boolean} Whether user is the leader
     */
    isLeader(userId) {
        return this.leaderId === userId;
    }

    /**
     * Get party size
     * @returns {number} Current party size
     */
    get size() {
        return this.members.length;
    }

    /**
     * Check if party is full
     * @returns {boolean} Whether party is at max size
     */
    get isFull() {
        return this.members.length >= this.settings.maxSize;
    }

    /**
     * Check if party can accept new members
     * @returns {boolean} Whether party can accept new members
     */
    get canAcceptMembers() {
        return this.isActive && this.status === 'RECRUITING' && !this.isFull;
    }

    /**
     * Check if the party can start an adventure
     * @returns {boolean} Whether the party can start an adventure
     */
    canStartAdventure() {
        // Must be active
        if (!this.isActive) return false;

        // Must not be in an adventure already
        if (this.status === 'IN_ADVENTURE') return false;

        // Must have at least one member (the leader)
        if (!this.members.some(m => m.userId === this.leaderId)) {
            return false;
        }

        // Must not exceed max size
        if (this.members.length > this.settings.maxSize) return false;

        return true;
    }

    /**
     * Get a message explaining why the party can't start an adventure
     * @returns {string} Readiness message
     */
    getReadinessMessage() {
        if (!this.isActive) {
            return 'The party is not active.';
        }

        if (this.status === 'IN_ADVENTURE') {
            return 'The party is already in an adventure.';
        }

        if (!this.members.some(m => m.userId === this.leaderId)) {
            return 'The party needs its leader.';
        }

        if (this.members.length > this.settings.maxSize) {
            return `The party has too many members (max: ${this.settings.maxSize}).`;
        }

        return 'The party is ready for adventure!';
    }
}

module.exports = Party; 