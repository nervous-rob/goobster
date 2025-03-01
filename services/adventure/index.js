/**
 * Adventure Service
 * Main entry point for the adventure system functionality
 */

const AdventureGenerator = require('./generators/adventureGenerator');
const SceneGenerator = require('./generators/sceneGenerator');
const DecisionGenerator = require('./generators/decisionGenerator');
const PartyManager = require('./managers/partyManager');
const StateManager = require('./managers/stateManager');
const ResourceManager = require('./managers/resourceManager');
const logger = require('./utils/logger');
const AdventureValidator = require('./validators/adventureValidator');
const PartyValidator = require('./validators/partyValidator');
const responseFormatter = require('./utils/responseFormatter');
const voiceIntegrationService = require('./utils/voiceIntegrationService');
const adventureRepository = require('./repositories/adventureRepository');
const OpenAI = require('openai');

class AdventureService {
    constructor() {
        // Initialize managers
        this.partyManager = new PartyManager();
        this.stateManager = new StateManager();
        this.resourceManager = new ResourceManager();

        // Get API key from environment or config
        const apiKey = process.env.OPENAI_API_KEY || require('../../config.json').openaiKey;
        if (!apiKey) {
            throw new Error('OpenAI API key is required. Set OPENAI_API_KEY environment variable or add to config.json');
        }

        // Initialize OpenAI client
        this.openai = new OpenAI({
            apiKey: apiKey
        });

        // Initialize generators
        this.adventureGenerator = new AdventureGenerator(this.openai, null);
        this.sceneGenerator = new SceneGenerator(this.openai, null);
        this.decisionGenerator = new DecisionGenerator(this.openai, null);

        // Initialize validators
        this.adventureValidator = new AdventureValidator();
        this.partyValidator = new PartyValidator();

        // Service settings
        this.settings = {
            maxConcurrentAdventures: 100,
            maxPartySize: 4,
            minPartySize: 1,
            maxAdventuresPerUser: 3,
            defaultDifficulty: 'normal',
            tokenCostPerScene: 1000,
            imageCostPerScene: 1,
        };
    }

    /**
     * Set the user ID for the generators
     * @param {string} userId - The user's ID
     */
    setUserId(userId) {
        this.userId = userId;
        this.adventureGenerator.userId = userId;
        this.sceneGenerator.userId = userId;
        this.decisionGenerator.userId = userId;
        
        return this;
    }

    /**
     * Set the guild ID for the generators (for personality directives)
     * @param {string} guildId - The guild ID
     */
    setGuildId(guildId) {
        this.guildId = guildId;
        this.adventureGenerator.guildId = guildId;
        this.sceneGenerator.guildId = guildId;
        this.decisionGenerator.guildId = guildId;
        
        return this;
    }

    /**
     * Initialize a new adventure with formatted response
     * @param {Object} options Adventure initialization options
     * @param {string} options.createdBy User ID who created the adventure
     * @param {string} [options.theme] Adventure theme
     * @param {string} [options.difficulty] Difficulty level
     * @param {Object} [options.settings] Additional settings
     * @returns {Promise<Object>} Created adventure instance and formatted response
     */
    async initializeAdventure({ createdBy, theme, difficulty = 'normal', settings = {} }) {
        const transaction = await adventureRepository.beginTransaction();
        const timeoutMs = settings.timeoutMs || 120000; // Default 2 minute timeout
        const imageTimeoutMs = settings.imageTimeoutMs || 120000; // 2 minutes for image generation
        
        try {
            // Validate initialization parameters
            this.adventureValidator.validateInitialization({
                createdBy,
                theme,
                difficulty,
                settings,
            });

            logger.info('Initializing new adventure', { createdBy, theme, difficulty });

            // Generate the adventure with timeout
            const adventurePromise = this.adventureGenerator.generateAdventure({
                createdBy,
                theme,
                difficulty,
                settings: {
                    maxPartySize: this.settings.maxPartySize,
                    ...settings,
                },
            });

            const adventure = await Promise.race([
                adventurePromise,
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Adventure generation timed out')), timeoutMs)
                )
            ]);

            // Create the adventure in the database first and wait for it to complete
            const createdAdventure = await adventureRepository.create(transaction, adventure);
            await transaction.commit(); // Commit the adventure creation first
            
            // Start a new transaction for state and resources
            const stateTransaction = await adventureRepository.beginTransaction();
            try {
                // Initialize state and resources concurrently
                const [state, resources] = await Promise.all([
                    this.stateManager.initializeState({
                        adventureId: createdAdventure.id,
                        initialState: {
                            currentScene: createdAdventure.state.currentScene,
                            status: 'active',
                        },
                        timeoutMs: timeoutMs / 2,
                        transaction: stateTransaction
                    }),
                    this.resourceManager.initializeResources({
                        adventureId: createdAdventure.id,
                        timeoutMs: timeoutMs / 2,
                        transaction: stateTransaction
                    })
                ]);

                // Generate initial images in parallel if possible
                const imagePromises = {
                    location: this.sceneGenerator.generateLocationImage(
                        createdAdventure.id,
                        createdAdventure.state.currentScene.location,
                        createdAdventure.setting
                    ).catch(err => {
                        logger.warn('Failed to generate location image', { err });
                        return null;
                    }),
                    scenes: [],
                    characters: []
                };

                // Add scene image generation
                imagePromises.scenes.push(
                    this.sceneGenerator.generateSceneImage(
                        createdAdventure.id,
                        createdAdventure.state.currentScene.description,
                        []
                    ).catch(err => {
                        logger.warn('Failed to generate scene image', { err });
                        return null;
                    })
                );

                // Wait for all image generation with separate timeout
                const images = await Promise.race([
                    Promise.all([
                        imagePromises.location,
                        ...imagePromises.scenes,
                        ...imagePromises.characters
                    ]),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Image generation timed out')), imageTimeoutMs)
                    )
                ]).catch(err => {
                    logger.warn('Image generation failed or timed out', { 
                        error: err,
                        timeoutMs: imageTimeoutMs,
                        timestamp: new Date().toISOString()
                    });
                    return {
                        location: null,
                        scenes: [],
                        characters: []
                    };
                });

                await stateTransaction.commit();

                logger.info('Successfully initialized adventure', {
                    adventureId: createdAdventure.id,
                    state: state.id,
                    resources: resources.id
                });

                // Format response
                const response = responseFormatter.formatAdventureStart({
                    adventure: createdAdventure,
                    party: null, // Party will be created separately
                    images,
                    initialScene: createdAdventure.state.currentScene,
                });

                return {
                    data: {
                        adventure: createdAdventure,
                        party: null,
                        currentScene: createdAdventure.state.currentScene,
                    },
                    response,
                };
            } catch (stateError) {
                await stateTransaction.rollback();
                throw stateError;
            }
        } catch (error) {
            await transaction.rollback();
            logger.error('Failed to initialize adventure', { error });
            throw error;
        }
    }

    /**
     * Process a decision with formatted response
     * @param {Object} options Decision options
     * @param {string} options.adventureId The adventure ID
     * @param {string} options.userId User making the decision
     * @param {string} options.decision The decision made
     * @param {string} [options.voiceChannel] Voice channel for narration
     * @returns {Promise<Object>} Updated state and formatted response
     */
    async processDecision({ adventureId, userId, decision, voiceChannel = null }) {
        const transaction = await adventureRepository.beginTransaction();
        try {
            // Validate decision parameters
            this.adventureValidator.validateDecision({
                adventureId,
                userId,
                decision,
            });

            logger.info('Processing decision', { adventureId, userId, decision });

            // Get current state
            const state = await this.stateManager.getState(adventureId);
            if (!['active', 'initialized'].includes(state.status)) {
                throw new Error('Adventure is not active');
            }

            // If state is initialized, transition to active
            if (state.status === 'initialized') {
                await this.stateManager.updateState({
                    adventureId,
                    updates: { status: 'active' }
                });
            }

            // Get party and validate user is a member
            const party = await this.partyManager.findPartyByMember(userId);
            if (!party || party.adventureId !== adventureId) {
                throw new Error('User is not in this adventure\'s party');
            }

            // Validate and process the decision
            const currentScene = state.currentScene;
            const chosenAction = currentScene.choices.find(c => c.id === decision);
            if (!chosenAction) {
                throw new Error('Invalid decision');
            }

            // Check resource availability
            const hasResources = await this.resourceManager.requestAllocation({
                adventureId,
                resourceType: 'tokens',
                amount: this.settings.tokenCostPerScene,
            });
            if (!hasResources) {
                throw new Error('Insufficient resources');
            }

            // Process the decision and get consequences
            const result = await this.decisionGenerator.processDecision({
                scene: currentScene,
                choice: chosenAction,
                party,
                history: state.history,
            });

            // Generate next scene
            const nextScene = await this.sceneGenerator.generateNextScene({
                adventureId,
                previousScene: currentScene,
                chosenAction,
                adventureContext: {
                    consequences: result.consequences,
                    partySize: party.members.length,
                    difficulty: state.difficulty,
                },
            });

            // Update state
            const updatedState = await this.stateManager.updateState({
                adventureId,
                updates: {
                    currentScene: nextScene,
                    lastDecision: {
                        userId,
                        decision,
                        timestamp: new Date(),
                        consequences: result.consequences,
                    },
                },
            });

            // Generate scene image
            let sceneImage = null;
            try {
                sceneImage = await this.sceneGenerator.generateSceneImage(
                    adventureId,
                    nextScene.description,
                    party.members
                );
            } catch (imageError) {
                logger.error('Failed to generate scene image', { imageError });
            }

            // Handle voice narration if channel provided
            if (voiceChannel) {
                try {
                    const { connection, musicPlayer, narrationPlayer } = 
                        await voiceIntegrationService.initializeVoiceConnection(voiceChannel);

                    // Play background music based on scene mood
                    await voiceIntegrationService.playBackgroundMusic(
                        voiceChannel.id,
                        result.consequences.atmosphere || 'neutral'
                    );

                    // Play narration
                    await voiceIntegrationService.playNarration(
                        voiceChannel.id,
                        result.consequences.narration
                    );
                } catch (voiceError) {
                    logger.error('Failed to handle voice integration', { voiceError });
                }
            }

            await transaction.commit();

            logger.info('Successfully processed decision', {
                adventureId,
                userId,
                nextSceneId: nextScene.id,
            });

            // Format response
            const response = responseFormatter.formatDecisionResponse({
                decision: chosenAction,
                consequences: result.consequences,
                nextScene,
                adventurerName: party.members.find(m => m.id === userId)?.adventurerName || 'Unknown',
                sceneImage,
            });

            return {
                data: {
                    state: updatedState,
                    scene: nextScene,
                    consequences: result.consequences,
                    impact: result.impact,
                },
                response,
            };
        } catch (error) {
            await transaction.rollback();
            logger.error('Failed to process decision', { error });
            const errorResponse = responseFormatter.formatError(error, process.env.NODE_ENV === 'development');
            throw {
                error,
                response: errorResponse,
            };
        }
    }

    /**
     * Get party status with formatted response
     * @param {string} partyId The party ID
     * @param {string} section Status section to display
     * @returns {Promise<Object>} Party status and formatted response
     */
    async getPartyStatus(partyId, section = 'overview') {
        try {
            logger.info('Getting party status', { partyId });

            const party = await this.partyManager.getParty(partyId);
            const state = await this.stateManager.getState(party.adventureId);
            const resources = await this.resourceManager.getUsage({
                adventureId: party.adventureId,
            });

            // Format response
            const response = responseFormatter.formatPartyStatus({
                party,
                state,
                section,
            });

            return {
                data: {
                    party,
                    currentScene: state.currentScene,
                    resources,
                    status: state.status,
                },
                response,
            };
        } catch (error) {
            logger.error('Failed to get party status', { error });
            throw error;
        }
    }

    /**
     * Join an existing adventure party
     * @param {Object} options Join options
     * @param {string} options.partyId Target party ID
     * @param {string} options.userId User ID joining
     * @returns {Promise<Object>} Updated party status
     */
    async joinParty({ partyId, userId }) {
        try {
            // Validate member operation
            this.partyValidator.validateMemberOperation({
                partyId,
                userId,
                role: 'member',
            });

            logger.info('User joining party', { partyId, userId });

            // Check if user is already in a party
            const existingParty = await this.partyManager.findPartyByMember(userId);
            if (existingParty) {
                throw new Error('User is already in a party');
            }

            // Add member to party
            const success = await this.partyManager.addMember({
                partyId,
                userId,
            });

            if (!success) {
                throw new Error('Failed to join party');
            }

            // Get updated status
            return this.getPartyStatus(partyId);
        } catch (error) {
            logger.error('Failed to join party', { error });
            throw error;
        }
    }

    /**
     * Leave an adventure party
     * @param {Object} options Leave options
     * @param {string} options.partyId Target party ID
     * @param {string} options.userId User ID leaving
     * @returns {Promise<boolean>} Success status
     */
    async leaveParty({ partyId, userId }) {
        try {
            // Validate member operation
            this.partyValidator.validateMemberOperation({
                partyId,
                userId,
            });

            logger.info('User leaving party', { partyId, userId });

            const success = await this.partyManager.removeMember({
                partyId,
                userId,
            });

            if (success) {
                logger.info('Successfully left party', { partyId, userId });
            }

            return success;
        } catch (error) {
            logger.error('Failed to leave party', { error });
            throw error;
        }
    }

    /**
     * Generate a special scene (combat, puzzle, etc.)
     * @param {Object} options Scene generation options
     * @param {string} options.adventureId Adventure ID
     * @param {string} options.type Scene type
     * @param {Object} options.context Scene context
     * @returns {Promise<Object>} Generated scene
     */
    async generateSpecialScene({ adventureId, type, context }) {
        try {
            // Validate special scene request
            this.adventureValidator.validateSpecialScene({
                adventureId,
                type,
                context,
            });

            logger.info('Generating special scene', { adventureId, type });

            // Check resource availability
            const hasResources = await this.resourceManager.requestAllocation({
                adventureId,
                resourceType: 'specialScenes',
                amount: 1,
            });
            if (!hasResources) {
                throw new Error('Insufficient special scene resources');
            }

            const scene = await this.sceneGenerator.generateSpecialScene({
                adventureId,
                type,
                context,
            });

            // Update state with new scene
            await this.stateManager.updateState({
                adventureId,
                updates: {
                    currentScene: scene,
                },
            });

            return scene;
        } catch (error) {
            logger.error('Failed to generate special scene', { error });
            throw error;
        }
    }

    /**
     * End an adventure
     * @param {string} adventureId Adventure ID
     * @returns {Promise<Object>} Final adventure state
     */
    async endAdventure(adventureId) {
        try {
            logger.info('Ending adventure', { adventureId });

            // Update state
            const finalState = await this.stateManager.updateState({
                adventureId,
                updates: {
                    status: 'completed',
                    endedAt: new Date(),
                },
            });

            // Clean up resources
            await this.resourceManager.cleanupResources();

            // Get all parties for this adventure
            const parties = await this.partyManager.getPartiesForAdventure(adventureId);

            // Clean up parties
            await Promise.all(parties.map(party => 
                this.partyManager.cleanupInactiveParties()
            ));

            return {
                state: finalState,
                summary: {
                    duration: new Date() - new Date(finalState.metadata.startedAt),
                    totalScenes: finalState.history.length,
                    endStatus: 'completed',
                },
            };
        } catch (error) {
            logger.error('Failed to end adventure', { error });
            throw error;
        }
    }
}

module.exports = AdventureService; 