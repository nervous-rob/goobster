/**
 * Item Model
 * Represents an item in an adventure
 */

const logger = require('../utils/logger');

class Item {
    /**
     * Create a new Item instance
     * @param {Object} options Item creation options
     * @param {number} [options.id] Item ID (set by database)
     * @param {string} options.name Item name
     * @param {string} [options.description=''] Item description
     * @param {string} [options.type='misc'] Item type
     * @param {Object} [options.properties={}] Additional item properties
     * @param {string[]} [options.tags=[]] Item tags
     * @param {boolean} [options.isConsumable=false] Whether the item is consumable
     * @param {boolean} [options.isEquippable=false] Whether the item is equippable
     * @param {boolean} [options.isQuestItem=false] Whether the item is a quest item
     * @param {Date} [options.createdAt] Creation timestamp
     * @param {Date} [options.lastUpdated] Last update timestamp
     */
    constructor({ 
        id, 
        name,
        description = '',
        type = 'misc',
        properties = {},
        tags = [],
        isConsumable = false,
        isEquippable = false,
        isQuestItem = false,
        createdAt = new Date(),
        lastUpdated = new Date()
    }) {
        if (!name) {
            throw new Error('Item name is required');
        }

        this.id = id;
        this.name = name;
        this.description = description;
        this.type = type;
        this.properties = properties;
        this.tags = tags;
        this.isConsumable = isConsumable;
        this.isEquippable = isEquippable;
        this.isQuestItem = isQuestItem;
        this.createdAt = createdAt;
        this.lastUpdated = lastUpdated;

        logger.debug('Created new Item instance', { 
            itemId: this.id,
            name: this.name,
            type: this.type,
            isQuestItem: this.isQuestItem
        });
    }

    /**
     * Add a property to the item
     * @param {string} key Property key
     * @param {any} value Property value
     * @returns {Object} Updated properties
     */
    addProperty(key, value) {
        this.properties[key] = value;
        return this.properties;
    }

    /**
     * Remove a property from the item
     * @param {string} key Property key
     * @returns {boolean} Whether the property was removed
     */
    removeProperty(key) {
        if (this.properties[key] !== undefined) {
            delete this.properties[key];
            return true;
        }
        return false;
    }

    /**
     * Add tags to the item
     * @param {string|string[]} newTags Tags to add
     * @returns {string[]} Updated tags array
     */
    addTags(newTags) {
        const tagsToAdd = Array.isArray(newTags) ? newTags : [newTags];
        this.tags = [...new Set([...this.tags, ...tagsToAdd])];
        return this.tags;
    }

    /**
     * Remove tags from the item
     * @param {string|string[]} tagsToRemove Tags to remove
     * @returns {string[]} Updated tags array
     */
    removeTags(tagsToRemove) {
        const removeSet = new Set(Array.isArray(tagsToRemove) ? tagsToRemove : [tagsToRemove]);
        this.tags = this.tags.filter(tag => !removeSet.has(tag));
        return this.tags;
    }

    /**
     * Use the item (for consumables)
     * @returns {boolean} Whether the item was successfully used
     */
    use() {
        if (!this.isConsumable) {
            return false;
        }
        
        // Logic for using the item would go here
        // This is a placeholder
        
        return true;
    }

    /**
     * Serialize item data to JSON
     * @returns {Object} Serialized item data
     */
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            type: this.type,
            properties: this.properties,
            tags: this.tags,
            isConsumable: this.isConsumable,
            isEquippable: this.isEquippable,
            isQuestItem: this.isQuestItem,
            createdAt: this.createdAt,
            lastUpdated: this.lastUpdated
        };
    }
}

module.exports = Item; 