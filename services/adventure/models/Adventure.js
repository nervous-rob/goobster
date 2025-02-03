/**
 * Adventure Model
 * Represents an instance of an adventure with its state and metadata
 */

const logger = require('../utils/logger');

class Adventure {
    /**
     * Create a new Adventure instance
     * @param {Object} options Adventure creation options
     * @param {number} [options.id] Adventure ID (set by database)
     * @param {string} options.title Adventure title
     * @param {string} options.description Adventure description
     * @param {string} options.createdBy User ID who created the adventure
     * @param {Object} options.settings Additional adventure settings
     */
    constructor({ id, title, description, createdBy, settings = {} }) {
        this.id = id; // Will be set by database auto-increment
        this.title = title;
        this.description = description;
        this.createdBy = createdBy;
        this.settings = settings;
        this.state = {
            status: 'initialized',
            currentScene: {
                title: 'Adventure Beginning',
                description: 'Your adventure is about to begin...',
                choices: [],
                location: {
                    place: 'Starting Point',
                    surroundings: 'A place of new beginnings',
                    weather: 'clear',
                    timeOfDay: 'morning'
                }
            },
            history: [],
            startedAt: new Date(),
            lastUpdated: new Date(),
        };
        this.party = {
            members: [],
            maxSize: settings.maxPartySize || 4,
        };
        
        logger.debug('Created new Adventure instance', { 
            adventureId: this.id,
            title: this.title,
        });
    }

    /**
     * Update the adventure's current scene
     * @param {Object} scene New scene data
     */
    updateScene(scene) {
        this.state.currentScene = scene;
        this.state.history.push({
            type: 'scene',
            data: scene,
            timestamp: new Date(),
        });
        this.state.lastUpdated = new Date();
        
        logger.debug('Updated adventure scene', {
            adventureId: this.id,
            sceneId: scene.id,
        });
    }

    /**
     * Add a member to the adventure party
     * @param {Object} member Party member data
     * @returns {boolean} Success status
     */
    addPartyMember(member) {
        if (this.party.members.length >= this.party.maxSize) {
            logger.warn('Cannot add party member - party is full', {
                adventureId: this.id,
                memberId: member.id,
            });
            return false;
        }

        this.party.members.push(member);
        this.state.history.push({
            type: 'party',
            action: 'join',
            data: member,
            timestamp: new Date(),
        });
        this.state.lastUpdated = new Date();

        logger.debug('Added party member', {
            adventureId: this.id,
            memberId: member.id,
        });
        return true;
    }

    /**
     * Convert the adventure instance to a plain object
     * @returns {Object} Plain object representation
     */
    toJSON() {
        return {
            id: this.id,
            title: this.title,
            description: this.description,
            createdBy: this.createdBy,
            settings: this.settings,
            state: this.state,
            party: this.party,
        };
    }
}

module.exports = Adventure; 