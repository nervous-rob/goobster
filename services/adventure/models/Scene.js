/**
 * Scene Model
 * Represents a scene in an adventure with its description, choices, and state
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class Scene {
    /**
     * Create a new Scene instance
     * @param {Object} options Scene creation options
     * @param {string} options.adventureId Associated adventure ID
     * @param {string} options.title Scene title
     * @param {string} options.description Scene description
     * @param {Array<Object>} options.choices Available choices in the scene
     * @param {Object} options.state Scene state data
     * @param {Object} options.metadata Additional scene metadata
     */
    constructor({ 
        adventureId, 
        title, 
        description, 
        choices = [], 
        state = {}, 
        metadata = {} 
    }) {
        this.id = uuidv4();
        this.adventureId = adventureId;
        this.title = title;
        this.description = description;
        this.choices = choices.map(choice => ({
            id: uuidv4(),
            text: choice.text,
            consequences: choice.consequences || [],
            requirements: choice.requirements || [],
            metadata: choice.metadata || {},
        }));
        this.state = {
            status: 'initialized',
            selectedChoice: null,
            ...state,
        };
        this.metadata = {
            type: 'standard',
            difficulty: 'normal',
            ...metadata,
        };
        this.createdAt = new Date();
        this.lastUpdated = new Date();

        logger.debug('Created new Scene instance', {
            sceneId: this.id,
            adventureId: this.adventureId,
            title: this.title,
        });
    }

    /**
     * Add a choice to the scene
     * @param {Object} choice Choice data
     * @returns {string} Created choice ID
     */
    addChoice(choice) {
        const choiceId = uuidv4();
        this.choices.push({
            id: choiceId,
            text: choice.text,
            consequences: choice.consequences || [],
            requirements: choice.requirements || [],
            metadata: choice.metadata || {},
        });
        this.lastUpdated = new Date();

        logger.debug('Added choice to scene', {
            sceneId: this.id,
            choiceId,
        });
        return choiceId;
    }

    /**
     * Select a choice in the scene
     * @param {string} choiceId Choice ID to select
     * @returns {boolean} Success status
     */
    selectChoice(choiceId) {
        const choice = this.choices.find(c => c.id === choiceId);
        if (!choice) {
            logger.warn('Choice not found in scene', {
                sceneId: this.id,
                choiceId,
            });
            return false;
        }

        this.state.selectedChoice = choiceId;
        this.state.status = 'resolved';
        this.lastUpdated = new Date();

        logger.debug('Selected choice in scene', {
            sceneId: this.id,
            choiceId,
        });
        return true;
    }

    /**
     * Check if a choice is valid for the current scene state
     * @param {string} choiceId Choice ID to validate
     * @returns {boolean} Whether the choice is valid
     */
    isChoiceValid(choiceId) {
        const choice = this.choices.find(c => c.id === choiceId);
        if (!choice) {
            return false;
        }

        // Check if all requirements are met
        return choice.requirements.every(req => {
            // TODO: Implement requirement checking logic
            return true;
        });
    }

    /**
     * Convert the scene instance to a plain object
     * @returns {Object} Plain object representation
     */
    toJSON() {
        return {
            id: this.id,
            adventureId: this.adventureId,
            title: this.title,
            description: this.description,
            choices: this.choices,
            state: this.state,
            metadata: this.metadata,
            createdAt: this.createdAt,
            lastUpdated: this.lastUpdated,
        };
    }
}

module.exports = Scene; 