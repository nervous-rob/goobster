/**
 * State Manager
 * Handles adventure state management and persistence
 */

const logger = require('../utils/logger');
const stateRepository = require('../repositories/stateRepository');
const { v4: uuidv4 } = require('uuid');

class StateManager {
    constructor() {
        // Initialize in-memory cache for active states
        this.activeStates = new Map();
        
        // Default settings
        this.defaultSettings = {
            maxHistoryLength: 100,
            stateTimeout: 7 * 24 * 60 * 60 * 1000, // 7 days
            autosaveInterval: 5 * 60 * 1000, // 5 minutes
            maxEventHistory: 50,
            maxDetailedHistory: 20,
            operationTimeout: 120000, // 2 minutes for operations
        };

        // Start autosave interval
        this._startAutosave();
    }

    /**
     * Initialize state for a new adventure
     * @param {Object} options State initialization options
     * @returns {Promise<Object>} Initialized state
     */
    async initializeState({ adventureId, initialState, timeoutMs = 120000, transaction, processId = '' }) { // Added transaction and processId
        const stateId = processId || uuidv4().substring(0, 8);
        try {
            if (!adventureId) {
                throw new Error('adventureId is required for state initialization');
            }
            if (!transaction) {
                logger.error(`[${stateId}] Transaction object is required for initializeState`, { adventureId });
                throw new Error('Internal Error: Transaction object missing during state initialization.');
            }

            logger.info(`[${stateId}] Initializing adventure state within provided transaction`, { adventureId });

            // Create a minimal initial state object with optimized data structure
            const state = {
                adventureId: adventureId,
                currentScene: {
                    ...initialState.currentScene,
                    // Preserve all scene data while ensuring required fields
                    choices: (initialState.currentScene?.choices || []).map(choice => ({
                        ...choice, // Preserve all original choice data
                        id: choice.id,
                        text: choice.text,
                        consequences: choice.consequences || [],
                        requirements: choice.requirements || [],
                        metadata: choice.metadata || {}
                    })),
                },
                status: initialState.status || 'active',
                history: [],
                eventHistory: [],
                metadata: {
                    startedAt: new Date().toISOString(),
                    lastUpdated: new Date().toISOString(),
                    ...initialState.metadata // Preserve any additional metadata
                },
                progress: {
                    plotPointsEncountered: [],
                    objectivesCompleted: [],
                    keyElementsFound: [],
                    resourcesUsed: {},
                    ...initialState.progress // Preserve any additional progress data
                },
                environment: {
                    timeOfDay: initialState.timeOfDay || 'morning',
                    weather: initialState.weather || 'clear',
                    visibility: initialState.visibility || 'good',
                    effects: [],
                    ...initialState.environment // Preserve any additional environment data
                },
                flags: initialState.flags || {},
                variables: initialState.variables || {}
            };

            // Directly use the provided transaction to create the state
            logger.debug(`[${stateId}] Calling stateRepository.create within transaction`);
            const createdState = await stateRepository.create(transaction, state);

            // Add to cache
            this.activeStates.set(adventureId, createdState);
            logger.info(`[${stateId}] State initialized successfully`, {
                adventureId,
                stateId: createdState.id,
                timestamp: new Date().toISOString()
            });

            return createdState;

        } catch (error) {
            // Error is caught here, but rollback should be handled by the caller (AdventureService)
            logger.error(`[${stateId}] Failed to initialize state within transaction`, {
                 error: { message: error.message, code: error.code, stack: error.stack },
                 adventureId,
                 timestamp: new Date().toISOString()
             });
            // Rethrow the error so the caller's executeTransaction handles rollback
            throw error;
        }
    }

    /**
     * Update adventure state
     * @param {Object} options State update options
     * @returns {Promise<Object>} Updated state
     */
    async updateState({ adventureId, updates, addToHistory = true }) {
        try {
            // Get current state with retry
            let attempts = 3;
            let state = null;
            let lastError = null;

            while (attempts > 0) {
                try {
                    state = await this.getState(adventureId);
                    break;
                } catch (error) {
                    lastError = error;
                    attempts--;
                    if (attempts > 0) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }

            if (!state) {
                throw lastError || new Error('Failed to get state');
            }

            // Start transaction with optimistic locking
            const transaction = await stateRepository.beginTransaction();
            try {
                // Verify state hasn't changed since we read it
                const currentState = await stateRepository.findByAdventure(transaction, adventureId);
                if (currentState.lastUpdated > state.lastUpdated) {
                    throw new Error('State was updated by another process');
                }

                // Validate state transition
                if (updates.status) {
                    const validTransitions = {
                        'initialized': ['active', 'failed'],
                        'active': ['completed', 'failed', 'paused'],
                        'paused': ['active', 'failed'],
                        'completed': [],
                        'failed': []
                    };

                    if (!validTransitions[state.status]?.includes(updates.status)) {
                        throw new Error(`Invalid state transition from ${state.status} to ${updates.status}`);
                    }
                }

                // Update current scene if provided
                if (updates.currentScene) {
                    if (addToHistory && state.currentScene) {
                        this._addToHistory(state, {
                            type: 'scene',
                            data: state.currentScene,
                            timestamp: new Date()
                        });
                    }
                    state.currentScene = updates.currentScene;
                }

                // Track last decision if provided
                if (updates.lastDecision) {
                    this._addToHistory(state, {
                        type: 'decision',
                        data: updates.lastDecision,
                        timestamp: new Date()
                    });

                    // Add to event history
                    await stateRepository.addEvent(transaction, adventureId, {
                        type: 'decision',
                        description: `${updates.lastDecision.userId} chose: ${updates.lastDecision.decision}`,
                        consequences: updates.lastDecision.consequences,
                        timestamp: new Date()
                    });
                }

                // Update progress tracking
                if (updates.progress) {
                    await stateRepository.updateProgress(transaction, adventureId, updates.progress);
                }

                // Update environment
                if (updates.environment) {
                    await stateRepository.updateEnvironment(transaction, adventureId, updates.environment);
                }

                // Update metadata
                state.metadata.lastUpdated = new Date();
                state.metadata.version = (state.metadata.version || 0) + 1;

                // Update state in database with optimistic locking
                const updateResult = await stateRepository.update(transaction, state.id, state, {
                    version: state.metadata.version - 1
                });

                if (!updateResult) {
                    throw new Error('State was updated by another process');
                }

                await transaction.commit();

                // Update cache
                this.activeStates.set(adventureId, state);
                logger.info('State updated successfully', { 
                    adventureId,
                    status: state.status,
                    version: state.metadata.version,
                    timestamp: new Date().toISOString()
                });

                return state;
            } catch (error) {
                await transaction.rollback();
                
                // If it was a concurrent update, retry the operation
                if (error.message.includes('updated by another process')) {
                    logger.warn('Concurrent state update detected, retrying', {
                        adventureId,
                        timestamp: new Date().toISOString()
                    });
                    return this.updateState({ adventureId, updates, addToHistory });
                }
                
                throw error;
            }
        } catch (error) {
            logger.error('Failed to update state', { 
                error: {
                    message: error.message,
                    code: error.code,
                    stack: error.stack
                },
                adventureId,
                updates: Object.keys(updates),
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    /**
     * Get current state
     * @param {string} adventureId Adventure ID
     * @returns {Promise<Object>} Current state
     */
    async getState(adventureId) {
        try {
            // Try cache first
            let state = this.activeStates.get(adventureId);
            if (!state) {
                // If not in cache, try database
                const transaction = await stateRepository.beginTransaction();
                try {
                    state = await stateRepository.findByAdventure(transaction, adventureId);
                    if (state) {
                        this.activeStates.set(adventureId, state);
                    }
                    await transaction.commit();
                } catch (error) {
                    await transaction.rollback();
                    throw error;
                }
            }
            if (!state) {
                throw new Error('State not found');
            }
            return state;
        } catch (error) {
            logger.error('Failed to get state', { error });
            throw error;
        }
    }

    /**
     * Get detailed state history
     * @param {string} adventureId Adventure ID
     * @param {number} limit Maximum number of entries
     * @returns {Promise<Array>} State history
     */
    async getHistory({ adventureId, limit = 10 }) {
        try {
            const state = this.activeStates.get(adventureId);
            if (!state) {
                throw new Error('State not found');
            }

            return state.history.slice(0, Math.min(limit, this.defaultSettings.maxDetailedHistory));
        } catch (error) {
            logger.error('Failed to get history', { error });
            throw error;
        }
    }

    /**
     * Get event history
     * @param {string} adventureId Adventure ID
     * @param {number} limit Maximum number of entries
     * @returns {Promise<Array>} Event history
     */
    async getEventHistory({ adventureId, limit = 20 }) {
        try {
            const state = this.activeStates.get(adventureId);
            if (!state) {
                throw new Error('State not found');
            }

            return state.eventHistory.slice(0, Math.min(limit, this.defaultSettings.maxEventHistory));
        } catch (error) {
            logger.error('Failed to get event history', { error });
            throw error;
        }
    }

    /**
     * Add entry to state history
     * @param {Object} state Current state
     * @param {Object} entry History entry
     * @private
     */
    _addToHistory(state, entry) {
        state.history.unshift(entry);
        if (state.history.length > this.defaultSettings.maxHistoryLength) {
            state.history.pop();
        }
    }

    /**
     * Add entry to event history
     * @param {Object} state Current state
     * @param {Object} event Event entry
     * @private
     */
    _addToEventHistory(state, event) {
        state.eventHistory.unshift(event);
        if (state.eventHistory.length > this.defaultSettings.maxEventHistory) {
            state.eventHistory.pop();
        }
    }

    /**
     * Update progress tracking
     * @param {Object} state Current state
     * @param {Object} progress Progress updates
     * @private
     */
    _updateProgress(state, progress) {
        if (progress.plotPoints) {
            state.progress.plotPointsEncountered.push(...progress.plotPoints);
        }
        if (progress.objectives) {
            state.progress.objectivesCompleted.push(...progress.objectives);
        }
        if (progress.keyElements) {
            state.progress.keyElementsFound.push(...progress.keyElements);
        }
        if (progress.resources) {
            Object.entries(progress.resources).forEach(([resource, amount]) => {
                state.progress.resourcesUsed[resource] = (state.progress.resourcesUsed[resource] || 0) + amount;
            });
        }
    }

    /**
     * Update environment state
     * @param {Object} state Current state
     * @param {Object} environment Environment updates
     * @private
     */
    _updateEnvironment(state, environment) {
        if (environment.timeOfDay) {
            state.environment.timeOfDay = environment.timeOfDay;
        }
        if (environment.weather) {
            state.environment.weather = environment.weather;
        }
        if (environment.visibility) {
            state.environment.visibility = environment.visibility;
        }
        if (environment.effects) {
            state.environment.effects = environment.effects;
        }
    }

    /**
     * Start autosave interval
     * @private
     */
    _startAutosave() {
        setInterval(async () => {
            for (const [adventureId, state] of this.activeStates.entries()) {
                try {
                    const transaction = await stateRepository.beginTransaction();
                    try {
                        await stateRepository.update(transaction, state.id, state);
                        await transaction.commit();
                        logger.debug('Autosaving state', { adventureId });
                    } catch (error) {
                        await transaction.rollback();
                        logger.error('Failed to autosave state', { error });
                    }
                } catch (error) {
                    logger.error('Failed to begin transaction for autosave', { error });
                }
            }
        }, this.defaultSettings.autosaveInterval);
    }

    /**
     * Clean up inactive states
     */
    async cleanupInactiveStates() {
        try {
            const now = Date.now();
            this.activeStates.forEach((state, adventureId) => {
                const lastUpdated = new Date(state.metadata.lastUpdated).getTime();
                if (now - lastUpdated > this.defaultSettings.stateTimeout) {
                    this.activeStates.delete(adventureId);
                    logger.info('Cleaned up inactive state', { adventureId });
                }
            });
        } catch (error) {
            logger.error('Failed to clean up inactive states', { error });
        }
    }

    /**
     * Set a state flag
     * @param {Object} options Flag options
     * @param {string} options.adventureId Adventure ID
     * @param {string} options.flag Flag name
     * @param {*} options.value Flag value
     * @returns {Promise<Object>} Updated state
     */
    async setFlag({ adventureId, flag, value }) {
        try {
            const state = await this.getState(adventureId);
            if (!state.flags) {
                state.flags = {};
            }
            state.flags[flag] = value;
            return this.updateState({
                adventureId,
                updates: { flags: state.flags },
            });
        } catch (error) {
            logger.error('Failed to set flag', { error });
            throw error;
        }
    }

    /**
     * Get a state flag value
     * @param {Object} options Flag options
     * @param {string} options.adventureId Adventure ID
     * @param {string} options.flag Flag name
     * @returns {Promise<*>} Flag value
     */
    async getFlag({ adventureId, flag }) {
        try {
            const state = await this.getState(adventureId);
            return state.flags?.[flag];
        } catch (error) {
            logger.error('Failed to get flag', { error });
            throw error;
        }
    }

    /**
     * Set a state variable
     * @param {Object} options Variable options
     * @param {string} options.adventureId Adventure ID
     * @param {string} options.variable Variable name
     * @param {*} options.value Variable value
     * @returns {Promise<Object>} Updated state
     */
    async setVariable({ adventureId, variable, value }) {
        try {
            const state = await this.getState(adventureId);
            if (!state.variables) {
                state.variables = {};
            }
            state.variables[variable] = value;
            return this.updateState({
                adventureId,
                updates: { variables: state.variables },
            });
        } catch (error) {
            logger.error('Failed to set variable', { error });
            throw error;
        }
    }

    /**
     * Persist state to storage
     * @param {string} adventureId Adventure ID
     * @param {Object} state State to persist
     * @private
     */
    async _persistState(adventureId, state) {
        try {
            // TODO: Implement persistence to database or file system
            logger.debug('State persisted', { adventureId });
        } catch (error) {
            logger.error('Failed to persist state', { error });
            throw error;
        }
    }
}

module.exports = StateManager; 