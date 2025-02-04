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
     * @param {Object} options.setting Adventure setting details
     * @param {Object} options.plotSummary Adventure plot summary
     */
    constructor({ id, title, description, createdBy, settings = {}, setting, plotSummary }) {
        try {
            this.id = id; // Will be set by database auto-increment
            this.title = title;
            this.description = description;
            this.createdBy = createdBy;
            
            // Parse JSON fields safely
            this.settings = this._parseAndMergeSettings(settings);
            this.setting = this._parseSetting(setting, description);
            this.plotSummary = this._parsePlotSummary(plotSummary, title);

            this.plotPoints = {
                majorEvents: [
                    'Adventure begins',
                    'Initial challenges emerge',
                    'Key discoveries made',
                    'Major turning point',
                    'Final confrontation'
                ],
                keyCharacters: [
                    'Party leader',
                    'Key allies',
                    'Important NPCs',
                    'Primary adversary',
                    'Supporting characters'
                ],
                storyArcs: [
                    'Main quest line',
                    'Character growth',
                    'Side quests',
                    'Rising action',
                    'Resolution'
                ]
            };

            this.keyElements = {
                items: [],
                locations: [],
                characters: [],
                objectives: [],
                secrets: []
            };

            this.winCondition = {
                type: 'completion',
                requirements: ['Complete the main objective', 'Survive the challenges'],
                rewards: ['Adventure completion', 'Experience gained'],
                failureConditions: ['Party death', 'Mission failure'],
                timeLimit: null
            };

            this.status = 'initialized';
            this.state = this._initializeState();
            this.party = {
                members: [],
                maxSize: this.settings.maxPartySize || 4,
            };
            
            logger.debug('Created new Adventure instance', { 
                adventureId: this.id,
                title: this.title,
                status: this.status
            });
        } catch (error) {
            logger.error('Failed to create Adventure instance', { error, title });
            throw error;
        }
    }

    /**
     * Parse and merge settings with defaults
     * @param {Object|string} settings Settings to parse
     * @returns {Object} Merged settings
     * @private
     */
    _parseAndMergeSettings(settings) {
        try {
            const settingsObj = typeof settings === 'string' ? JSON.parse(settings) : settings;
            return {
                maxPartySize: settingsObj.maxPartySize || 4,
                difficulty: settingsObj.difficulty || 'normal',
                genre: settingsObj.genre || 'fantasy',
                complexity: settingsObj.complexity || 'medium',
                partyId: settingsObj.partyId,
                ...settingsObj
            };
        } catch (error) {
            logger.warn('Failed to parse settings, using defaults', { error });
            return {
                maxPartySize: 4,
                difficulty: 'normal',
                genre: 'fantasy',
                complexity: 'medium'
            };
        }
    }

    /**
     * Parse setting with defaults
     * @param {Object|string} setting Setting to parse
     * @param {string} description Default environment description
     * @returns {Object} Parsed setting
     * @private
     */
    _parseSetting(setting, description) {
        try {
            const settingObj = typeof setting === 'string' ? JSON.parse(setting) : setting;
            return settingObj || {
                location: 'Unknown Location',
                environment: description,
                atmosphere: 'mysterious'
            };
        } catch (error) {
            logger.warn('Failed to parse setting, using defaults', { error });
            return {
                location: 'Unknown Location',
                environment: description,
                atmosphere: 'mysterious'
            };
        }
    }

    /**
     * Parse plot summary with defaults
     * @param {Object|string} plotSummary Plot summary to parse
     * @param {string} title Adventure title
     * @returns {Object} Parsed plot summary
     * @private
     */
    _parsePlotSummary(plotSummary, title) {
        try {
            const plotObj = typeof plotSummary === 'string' ? JSON.parse(plotSummary) : plotSummary;
            return plotObj || {
                mainObjective: `Complete the adventure: ${title}`,
                challenges: ['Overcome obstacles', 'Face challenges', 'Achieve victory'],
                expectedOutcome: 'Successfully complete the adventure',
                difficulty: this.settings?.difficulty || 'normal'
            };
        } catch (error) {
            logger.warn('Failed to parse plot summary, using defaults', { error });
            return {
                mainObjective: `Complete the adventure: ${title}`,
                challenges: ['Overcome obstacles', 'Face challenges', 'Achieve victory'],
                expectedOutcome: 'Successfully complete the adventure',
                difficulty: 'normal'
            };
        }
    }

    /**
     * Initialize adventure state
     * @returns {Object} Initial state
     * @private
     */
    _initializeState() {
        return {
            currentScene: {
                title: 'Adventure Beginning',
                description: 'Your adventure is about to begin...',
                choices: [],
                location: {
                    place: this.setting?.location || 'Unknown Location',
                    surroundings: this.setting?.environment || 'A mysterious place',
                    weather: 'clear',
                    timeOfDay: 'morning'
                }
            },
            history: [],
            startedAt: new Date(),
            lastUpdated: new Date(),
        };
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
        this.status = 'active'; // Update status when scene changes
        
        logger.debug('Updated adventure scene', {
            adventureId: this.id,
            sceneId: scene.id,
            status: this.status
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
            setting: this.setting,
            plotSummary: this.plotSummary,
            plotPoints: this.plotPoints,
            keyElements: this.keyElements,
            winCondition: this.winCondition,
            currentState: this.state,
            status: this.status || 'initialized',
            theme: this.settings.theme || 'fantasy',
            metadata: {},
            startedAt: this.state.startedAt,
            lastUpdated: this.state.lastUpdated,
            completedAt: null
        };
    }
}

module.exports = Adventure; 