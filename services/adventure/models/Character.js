/**
 * Character Model
 * Represents an adventurer character in the game
 */

const logger = require('../utils/logger');
const config = require('../../../config/adventureConfig');

class Character {
    /**
     * Create a new Character instance
     * @param {Object} options Character creation options
     * @param {number} [options.id] Character ID (set by database)
     * @param {string} options.userId User ID of the player
     * @param {string} options.adventurerName Character's name
     * @param {string} [options.backstory] Character's backstory
     * @param {string} [options.role='member'] Character's role in the party
     * @param {string} [options.status=config.CHARACTER_STATUS.ACTIVE] Character's status
     * @param {number} [options.health=config.HEALTH.DEFAULT] Character's health
     * @param {Object} [options.inventory={}] Character's inventory
     * @param {Object[]} [options.conditions=[]] Character's conditions
     * @param {Date} [options.createdAt] Creation timestamp
     * @param {Date} [options.lastUpdated] Last update timestamp
     */
    constructor({ 
        id,
        userId,
        adventurerName,
        backstory = '',
        role = 'member',
        status = config.CHARACTER_STATUS.ACTIVE,
        health = config.HEALTH.DEFAULT,
        inventory = {},
        conditions = [],
        createdAt = new Date(),
        lastUpdated = new Date()
    }) {
        if (!userId) {
            throw new Error('User ID is required');
        }
        if (!adventurerName) {
            throw new Error('Adventurer name is required');
        }

        this.id = id;
        this.userId = userId;
        this.adventurerName = adventurerName;
        this.backstory = backstory;
        this.role = role;
        this.status = status;
        this.health = health;
        this.inventory = inventory;
        this.conditions = conditions;
        this.createdAt = createdAt;
        this.lastUpdated = lastUpdated;

        logger.debug('Created new Character instance', { 
            characterId: this.id,
            userId: this.userId,
            name: this.adventurerName,
            role: this.role,
            status: this.status
        });
    }

    /**
     * Update character's health
     * @param {number} amount Amount to change health by (positive for healing, negative for damage)
     * @returns {number} New health value
     */
    updateHealth(amount) {
        this.health = Math.max(config.HEALTH.MIN, Math.min(config.HEALTH.MAX, this.health + amount));
        this.updateStatus();
        return this.health;
    }

    /**
     * Update character's status based on current health
     * @param {string} [forceStatus] Force a specific status
     * @returns {string} New status
     */
    updateStatus(forceStatus = null) {
        if (forceStatus) {
            this.status = forceStatus;
            return this.status;
        }

        // Update status based on health if not forced
        if (this.health <= 0) {
            this.status = config.CHARACTER_STATUS.DEAD;
        } else if (this.health <= 20) {
            this.status = config.CHARACTER_STATUS.INCAPACITATED;
        } else if (this.health <= 50) {
            this.status = config.CHARACTER_STATUS.INJURED;
        } else {
            this.status = config.CHARACTER_STATUS.ACTIVE;
        }

        return this.status;
    }

    /**
     * Add an item to the character's inventory
     * @param {string} itemId Item ID
     * @param {Object} itemData Item data
     * @returns {Object} Updated inventory
     */
    addItem(itemId, itemData) {
        this.inventory[itemId] = itemData;
        return this.inventory;
    }

    /**
     * Remove an item from the character's inventory
     * @param {string} itemId Item ID
     * @returns {boolean} Whether the item was removed
     */
    removeItem(itemId) {
        if (this.inventory[itemId]) {
            delete this.inventory[itemId];
            return true;
        }
        return false;
    }

    /**
     * Add a condition to the character
     * @param {Object} condition Condition object
     * @returns {Object[]} Updated conditions array
     */
    addCondition(condition) {
        this.conditions.push(condition);
        return this.conditions;
    }

    /**
     * Remove a condition from the character by ID
     * @param {string} conditionId Condition ID
     * @returns {boolean} Whether the condition was removed
     */
    removeCondition(conditionId) {
        const initialLength = this.conditions.length;
        this.conditions = this.conditions.filter(c => c.id !== conditionId);
        return this.conditions.length < initialLength;
    }

    /**
     * Serialize character data to JSON
     * @returns {Object} Serialized character data
     */
    toJSON() {
        return {
            id: this.id,
            userId: this.userId,
            adventurerName: this.adventurerName,
            backstory: this.backstory,
            role: this.role,
            status: this.status,
            health: this.health,
            inventory: this.inventory,
            conditions: this.conditions,
            createdAt: this.createdAt,
            lastUpdated: this.lastUpdated
        };
    }
}

module.exports = Character; 