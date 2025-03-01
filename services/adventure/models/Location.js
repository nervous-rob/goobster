/**
 * Location Model
 * Represents a location in an adventure
 */

const logger = require('../utils/logger');

class Location {
    /**
     * Create a new Location instance
     * @param {Object} options Location creation options
     * @param {number} [options.id] Location ID (set by database)
     * @param {string} options.name Location name
     * @param {string} [options.description=''] Location description
     * @param {string} [options.type='point_of_interest'] Location type
     * @param {Object} [options.properties={}] Additional location properties
     * @param {string[]} [options.tags=[]] Location tags
     * @param {Date} [options.createdAt] Creation timestamp
     * @param {Date} [options.lastUpdated] Last update timestamp
     */
    constructor({ 
        id, 
        name,
        description = '',
        type = 'point_of_interest',
        properties = {},
        tags = [],
        createdAt = new Date(),
        lastUpdated = new Date()
    }) {
        if (!name) {
            throw new Error('Location name is required');
        }

        this.id = id;
        this.name = name;
        this.description = description;
        this.type = type;
        this.properties = properties;
        this.tags = tags;
        this.createdAt = createdAt;
        this.lastUpdated = lastUpdated;

        logger.debug('Created new Location instance', { 
            locationId: this.id,
            name: this.name,
            type: this.type
        });
    }

    /**
     * Add a property to the location
     * @param {string} key Property key
     * @param {any} value Property value
     * @returns {Object} Updated properties
     */
    addProperty(key, value) {
        this.properties[key] = value;
        return this.properties;
    }

    /**
     * Remove a property from the location
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
     * Add tags to the location
     * @param {string|string[]} newTags Tags to add
     * @returns {string[]} Updated tags array
     */
    addTags(newTags) {
        const tagsToAdd = Array.isArray(newTags) ? newTags : [newTags];
        this.tags = [...new Set([...this.tags, ...tagsToAdd])];
        return this.tags;
    }

    /**
     * Remove tags from the location
     * @param {string|string[]} tagsToRemove Tags to remove
     * @returns {string[]} Updated tags array
     */
    removeTags(tagsToRemove) {
        const removeSet = new Set(Array.isArray(tagsToRemove) ? tagsToRemove : [tagsToRemove]);
        this.tags = this.tags.filter(tag => !removeSet.has(tag));
        return this.tags;
    }

    /**
     * Serialize location data to JSON
     * @returns {Object} Serialized location data
     */
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            type: this.type,
            properties: this.properties,
            tags: this.tags,
            createdAt: this.createdAt,
            lastUpdated: this.lastUpdated
        };
    }
}

module.exports = Location; 