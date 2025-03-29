/**
 * Party Model
 * Represents a group of adventurers
 */

const logger = require('../utils/logger');

class Party {
    /**
     * Create a new Party instance
     * @param {Object} data Party creation options
     * @param {number} [data.id] Party ID (set by database)
     * @param {string|BigInt} data.leaderId User ID of party leader
     * @param {string} data.adventurerName Leader's adventurer name
     * @param {string} [data.leaderBackstory] Leader's character backstory
     * @param {Object} [data.settings={}] Party settings
     * @param {string} [data.adventureStatus='RECRUITING'] Party status
     * @param {Date} [data.createdAt] Creation timestamp
     * @param {Date} [data.lastUpdated] Last update timestamp
     * @param {boolean} [data.isActive=true] Whether party is active
     * @param {string} [data.adventureId] Adventure ID
     */
    constructor(data = {}) {
        // Validate required fields first
        if (!data.leaderId) {
            throw new Error('Leader ID is required when creating a party');
        }
        if (!data.adventurerName) {
            throw new Error('Adventurer name is required when creating a party');
        }

        // Hydrate with defaults and type conversion
        this.id = data.id || null;
        this.leaderId = data.leaderId.toString();
        this.adventurerName = data.adventurerName.trim();
        this.leaderBackstory = data.leaderBackstory?.trim() || null;
        
        // Hydrate settings with defaults
        this.settings = {
            maxSize: 4,
            minPartySize: 1,
            ...(data.settings || {})
        };

        // Hydrate status with validation
        const validStatuses = ['RECRUITING', 'ACTIVE', 'COMPLETED', 'DISBANDED'];
        this.adventureStatus = validStatuses.includes(data.adventureStatus) 
            ? data.adventureStatus 
            : 'RECRUITING';

        // Set status property as alias for adventureStatus for backward compatibility
        this.status = this.adventureStatus;

        // Hydrate timestamps
        this.createdAt = data.createdAt instanceof Date ? data.createdAt : new Date();
        this.lastUpdated = data.lastUpdated instanceof Date ? data.lastUpdated : new Date();
        
        // Hydrate boolean with default
        this.isActive = data.isActive ?? true;
        
        // Hydrate optional fields
        this.adventureId = data.adventureId || null;
        this.members = [];

        // Initialize members array if we have member data
        if (data.memberId && data.memberName) {
            this.addMember({
                userId: data.memberId,
                adventurerName: data.memberName,
                backstory: data.memberBackstory,
                memberType: data.memberId === this.leaderId ? 'leader' : (data.memberRole || 'member'),
                joinedAt: data.memberJoinedAt || new Date()
            });
        }

        logger.debug('Created new Party instance', { 
            partyId: this.id,
            leaderId: this.leaderId,
            adventurerName: this.adventurerName,
            adventureStatus: this.adventureStatus,
            memberCount: this.members.length
        });
    }

    /**
     * Add a member to the party
     * @param {Object} member Member details
     * @param {string} member.userId User ID
     * @param {string} member.adventurerName Character name
     * @param {string} [member.backstory] Character backstory
     * @param {string} [member.memberType] Member type
     * @returns {boolean} Whether member was added
     */
    addMember({ userId, adventurerName, backstory, memberType = null }) {
        // Check for required fields with detailed error messages
        if (!userId) {
            throw new Error('User ID is required when adding a member');
        }
        
        if (!adventurerName) {
            throw new Error('Adventurer name is required when adding a member');
        }

        // Validate types
        if (typeof adventurerName !== 'string') {
            throw new Error('Adventurer name must be a string');
        }

        if (this.members.length >= this.settings.maxSize) {
            throw new Error('Party is full');
        }

        // Ensure all user IDs are compared as strings
        const userIdStr = userId.toString();
        
        // Check if member already exists
        if (this.members.some(m => m.userId === userIdStr)) {
            return false;
        }

        try {
            // Add the member with consistent data structure
            const member = {
                userId: userIdStr,
                adventurerName: adventurerName.trim(),
                backstory: backstory ? backstory.trim() : null,
                memberType: memberType || (userIdStr === this.leaderId ? 'leader' : 'member'),
                joinedAt: new Date()
            };

            this.members.push(member);
            this.lastUpdated = new Date();

            logger.debug('Added member to party', {
                partyId: this.id,
                userId: userIdStr,
                adventurerName: member.adventurerName,
                memberType: member.memberType,
                memberCount: this.members.length
            });

            return true;
        } catch (error) {
            logger.error('Failed to add member to party', {
                error: error.message,
                partyId: this.id,
                userId: userIdStr,
                adventurerName
            });
            throw error;
        }
    }

    /**
     * Remove a member from the party
     * @param {string} userId User ID to remove
     * @returns {boolean} Whether member was removed
     */
    removeMember(userId) {
        // Ensure all user IDs are compared as strings
        const userIdStr = userId.toString();
        
        if (userIdStr === this.leaderId) {
            throw new Error('Cannot remove party leader');
        }

        const index = this.members.findIndex(m => m.userId === userIdStr);
        if (index === -1) {
            return false;
        }

        this.members.splice(index, 1);
        this.lastUpdated = new Date();
        
        // Update status if no members left except leader
        if (this.members.length === 1 && this.members[0].userId === this.leaderId) {
            this.adventureStatus = 'RECRUITING';
        }

        logger.debug('Removed member from party', {
            partyId: this.id,
            userId: userIdStr,
            newStatus: this.adventureStatus,
            remainingMembers: this.members.length
        });

        return true;
    }

    /**
     * Check if user is a member of the party
     * @param {string} userId User ID to check
     * @returns {boolean} Whether user is a member
     */
    isMember(userId) {
        // Ensure all user IDs are compared as strings
        return this.members.some(m => m.userId === userId.toString());
    }

    /**
     * Get a member from the party
     * @param {string} userId User ID to get
     * @returns {Object} Member details
     */
    getMember(userId) {
        // Ensure all user IDs are compared as strings
        return this.members.find(m => m.userId === userId.toString());
    }

    /**
     * Check if user is the party leader
     * @param {string} userId User ID to check
     * @returns {boolean} Whether user is the leader
     */
    isLeader(userId) {
        // Ensure all user IDs are compared as strings
        return this.leaderId === userId.toString();
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
        return this.isActive && this.adventureStatus === 'RECRUITING' && !this.isFull;
    }

    /**
     * Check if the party can start an adventure
     * @returns {boolean} Whether the party can start an adventure
     */
    canStartAdventure() {
        // Must be active
        if (!this.isActive) return false;

        // Must not be in an adventure already
        if (this.adventureStatus === 'ACTIVE' || this.adventureId) return false;

        // Must have at least one member (the leader)
        if (!this.members.some(m => m.userId === this.leaderId)) {
            return false;
        }

        // Must have enough members (default to 1 if not specified)
        const minSize = this.settings.minPartySize || 1;
        if (this.members.length < minSize) {
            return false;
        }

        // Must not exceed max size
        const maxSize = this.settings.maxSize || 4;
        if (this.members.length > maxSize) {
            return false;
        }

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

        if (this.adventureStatus === 'ACTIVE' || this.adventureId) {
            return 'The party is already in an adventure.';
        }

        if (!this.members.some(m => m.userId === this.leaderId)) {
            return 'The party needs its leader.';
        }

        if (this.members.length < this.settings.minPartySize) {
            return `Need at least ${this.settings.minPartySize} members to start`;
        }

        if (this.members.length > this.settings.maxSize) {
            return `Party is too large (max ${this.settings.maxSize} members)`;
        }

        return 'The party is ready for adventure!';
    }
}

module.exports = Party; 