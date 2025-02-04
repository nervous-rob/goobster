/**
 * State Manager
 * Handles adventure state management and persistence
 */

const logger = require('../utils/logger');
const stateRepository = require('../repositories/stateRepository');

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
    async initializeState({ adventureId, initialState, timeoutMs = 120000 }) { // 2 minutes default for state operations
        try {
            if (!adventureId) {
                throw new Error('adventureId is required for state initialization');
            }

            logger.info('Initializing adventure state', { adventureId });

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

            // Start transaction with optimized retry logic
            let retries = 2; // Reduced retries for faster timeout handling
            let lastError = null;
            let backoffMs = 500; // Reduced initial backoff
            
            while (retries >= 0) {
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('State initialization timed out')), 
                        timeoutMs / (retries + 1) // Adjust timeout based on remaining retries
                    );
                });

                try {
                    const transaction = await stateRepository.beginTransaction();
                    
                    // Create state in database with timeout
                    const createPromise = stateRepository.create(transaction, state);
                    const createdState = await Promise.race([createPromise, timeoutPromise]);
                    
                    await transaction.commit();

                    // Add to cache
                    this.activeStates.set(adventureId, createdState);
                    logger.info('State initialized successfully', { 
                        adventureId,
                        stateId: createdState.id,
                        timestamp: new Date().toISOString()
                    });

                    return createdState;
                } catch (error) {
                    lastError = error;
                    await transaction?.rollback().catch(() => {}); // Ignore rollback errors
                    
                    // Only retry on timeout or transient errors
                    if (error.code === 'ETIMEOUT' || error.code === 'ECONNRESET') {
                        retries--;
                        if (retries >= 0) {
                            logger.warn('Retrying state initialization after error', {
                                error,
                                adventureId,
                                retriesLeft: retries,
                                backoffMs,
                                timestamp: new Date().toISOString()
                            });
                            await new Promise(resolve => setTimeout(resolve, backoffMs));
                            backoffMs *= 1.5; // Reduced backoff multiplier
                            continue;
                        }
                    }
                    
                    logger.error('Failed to initialize state in transaction', {
                        error,
                        adventureId,
                        timestamp: new Date().toISOString()
                    });
                    throw error;
                }
            }

            if (lastError) {
                throw lastError;
            }
        } catch (error) {
            logger.error('Failed to initialize state', { error, adventureId });
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
            const state = await this.getState(adventureId);
            if (!state) {
                throw new Error('State not found');
            }

            // Start transaction
            const transaction = await stateRepository.beginTransaction();
            try {
                // Update current scene if provided
                if (updates.currentScene) {
                    if (addToHistory && state.currentScene) {
                        this._addToHistory(state, {
                            type: 'scene',
                            data: state.currentScene,
                            timestamp: new Date(),
                        });
                    }
                    state.currentScene = updates.currentScene;
                }

                // Update status if provided
                if (updates.status) {
                    state.status = updates.status;
                    await stateRepository.addEvent(transaction, adventureId, {
                        type: 'status',
                        description: `Adventure status changed to ${updates.status}`,
                        timestamp: new Date(),
                    });
                }

                // Track last decision if provided
                if (updates.lastDecision) {
                    this._addToHistory(state, {
                        type: 'decision',
                        data: updates.lastDecision,
                        timestamp: new Date(),
                    });
                    await stateRepository.addEvent(transaction, adventureId, {
                        type: 'decision',
                        description: `${updates.lastDecision.userId} chose: ${updates.lastDecision.decision}`,
                        consequences: updates.lastDecision.consequences,
                        timestamp: new Date(),
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

                // Update state in database
                await stateRepository.update(transaction, state.id, state);
                await transaction.commit();

                // Update cache
                this.activeStates.set(adventureId, state);
                logger.info('State updated', { adventureId });

                return state;
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        } catch (error) {
            logger.error('Failed to update state', { error });
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