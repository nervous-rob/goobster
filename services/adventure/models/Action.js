/**
 * Action Model
 * Represents an action that can be performed in an adventure
 */

const logger = require('../utils/logger');

class Action {
    /**
     * Create a new Action instance
     * @param {Object} options Action creation options
     * @param {number} [options.id] Action ID (set by database)
     * @param {string} options.name Action name
     * @param {string} [options.description=''] Action description
     * @param {string} [options.type='standard'] Action type
     * @param {Object} [options.requirements={}] Requirements to perform this action
     * @param {Object} [options.effects={}] Effects of this action
     * @param {string[]} [options.tags=[]] Action tags
     * @param {boolean} [options.isAvailable=true] Whether the action is available
     * @param {Date} [options.createdAt] Creation timestamp
     * @param {Date} [options.lastUpdated] Last update timestamp
     */
    constructor({ 
        id, 
        name,
        description = '',
        type = 'standard',
        requirements = {},
        effects = {},
        tags = [],
        isAvailable = true,
        createdAt = new Date(),
        lastUpdated = new Date()
    }) {
        if (!name) {
            throw new Error('Action name is required');
        }

        this.id = id;
        this.name = name;
        this.description = description;
        this.type = type;
        this.requirements = requirements;
        this.effects = effects;
        this.tags = tags;
        this.isAvailable = isAvailable;
        this.createdAt = createdAt;
        this.lastUpdated = lastUpdated;

        logger.debug('Created new Action instance', { 
            actionId: this.id,
            name: this.name,
            type: this.type,
            isAvailable: this.isAvailable
        });
    }

    /**
     * Check if this action is available based on context
     * @param {Object} context Context to check against
     * @returns {boolean} Whether the action is available
     */
    checkAvailability(context) {
        if (!this.isAvailable) {
            return false;
        }

        // Check requirements
        if (this.requirements.items) {
            // Check if required items are in inventory
            const hasAllItems = this.requirements.items.every(itemId => {
                return context.inventory && context.inventory[itemId];
            });
            if (!hasAllItems) return false;
        }

        if (this.requirements.status) {
            // Check character status
            if (context.status !== this.requirements.status) return false;
        }

        if (this.requirements.location) {
            // Check location
            if (context.location !== this.requirements.location) return false;
        }

        return true;
    }

    /**
     * Apply the effects of this action to a context
     * @param {Object} context Context to apply effects to
     * @returns {Object} Modified context
     */
    applyEffects(context) {
        const updatedContext = { ...context };

        // Apply health effects
        if (this.effects.health) {
            updatedContext.health = (updatedContext.health || 0) + this.effects.health;
        }

        // Apply status effects
        if (this.effects.status) {
            updatedContext.status = this.effects.status;
        }

        // Apply inventory effects
        if (this.effects.addItems) {
            updatedContext.inventory = updatedContext.inventory || {};
            this.effects.addItems.forEach(item => {
                updatedContext.inventory[item.id] = item;
            });
        }

        if (this.effects.removeItems) {
            updatedContext.inventory = updatedContext.inventory || {};
            this.effects.removeItems.forEach(itemId => {
                delete updatedContext.inventory[itemId];
            });
        }

        // Apply location effects
        if (this.effects.location) {
            updatedContext.location = this.effects.location;
        }

        return updatedContext;
    }

    /**
     * Add tags to the action
     * @param {string|string[]} newTags Tags to add
     * @returns {string[]} Updated tags array
     */
    addTags(newTags) {
        const tagsToAdd = Array.isArray(newTags) ? newTags : [newTags];
        this.tags = [...new Set([...this.tags, ...tagsToAdd])];
        return this.tags;
    }

    /**
     * Remove tags from the action
     * @param {string|string[]} tagsToRemove Tags to remove
     * @returns {string[]} Updated tags array
     */
    removeTags(tagsToRemove) {
        const removeSet = new Set(Array.isArray(tagsToRemove) ? tagsToRemove : [tagsToRemove]);
        this.tags = this.tags.filter(tag => !removeSet.has(tag));
        return this.tags;
    }

    /**
     * Serialize action data to JSON
     * @returns {Object} Serialized action data
     */
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            type: this.type,
            requirements: this.requirements,
            effects: this.effects,
            tags: this.tags,
            isAvailable: this.isAvailable,
            createdAt: this.createdAt,
            lastUpdated: this.lastUpdated
        };
    }
}

module.exports = Action; 