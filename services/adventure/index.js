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
const sql = require('mssql');

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
     * Initialize a new adventure
     * @param {Object} options Initialization options
     * @param {string} options.createdBy User ID who is creating the adventure
     * @param {string} [options.theme] Adventure theme
     * @param {string} [options.difficulty] Difficulty level
     * @param {Object} [options.settings] Additional settings
     * @returns {Promise<Object>} Created adventure instance and formatted response
     */
    async initializeAdventure({ createdBy, theme, difficulty = 'normal', settings = {} }) {
        const processId = Math.random().toString(36).substring(2, 10);
        const startTime = Date.now();
        const timeoutMs = settings.timeoutMs || 120000; // Default 2 minute timeout
        const imageTimeoutMs = settings.imageTimeoutMs || 120000; // 2 minutes for image generation
        
        // Add Overall Timer
        console.time(`[${processId}] initializeAdventure Total`);
        logger.info(`[${processId}] Adventure initialization started`, {
            createdBy,
            theme,
            difficulty,
            settingsKeys: Object.keys(settings),
            timeoutMs,
            imageTimeoutMs
        });
        
        try {
            // Validate initialization parameters
            console.time(`[${processId}] Parameter Validation`);
            logger.debug(`[${processId}] Validating initialization parameters`);
            this.adventureValidator.validateInitialization({
                createdBy,
                theme,
                difficulty,
                settings,
            });
            console.timeEnd(`[${processId}] Parameter Validation`);
            logger.info(`[${processId}] Parameter validation successful`);

            // Get internal user ID, create if necessary
            let internalUserId = null;
            logger.debug(`[${processId}] Looking up internal user ID for Discord ID: ${createdBy}`);
            console.time(`[${processId}] User Lookup/Create`);
            await adventureRepository.executeTransaction(async (transaction) => {
                const userResult = await transaction.request()
                    .input('discordId', sql.VarChar(255), createdBy)
                    .query('SELECT id FROM users WITH (NOLOCK) WHERE discordId = @discordId');
                
                if (userResult?.recordset?.[0]?.id) {
                    internalUserId = userResult.recordset[0].id;
                    logger.debug(`[${processId}] Found existing user`, { discordId: createdBy, internalUserId });
                } else { // Create user if needed (assuming true for now)
                    logger.info(`[${processId}] User not found, creating user record`, { discordId: createdBy });
                    const createUserQuery = `
                        INSERT INTO users (discordId, username, discordUsername)
                        OUTPUT INSERTED.id as internalUserId
                        VALUES (@discordId, @username, @username);
                    `;
                    const createResult = await transaction.request()
                        .input('discordId', sql.VarChar(255), createdBy)
                        .input('username', sql.NVarChar(100), `User_${createdBy.substring(0, 8)}`)
                        .query(createUserQuery);
                    
                    if (createResult?.recordset?.[0]?.internalUserId) {
                        internalUserId = createResult.recordset[0].internalUserId;
                        logger.info(`[${processId}] Created new user`, { discordId: createdBy, internalUserId });
                    } else {
                        logger.error(`[${processId}] Failed to create user during ID lookup`, { discordId: createdBy, createResult: createResult || 'null' });
                        throw new Error('Could not create or find user account');
                    }
                }
            });
            console.timeEnd(`[${processId}] User Lookup/Create`);
            
            if (!internalUserId) {
                logger.error(`[${processId}] Failed to get internal user ID for adventure creator`, { createdBy });
                throw new Error('Failed to identify user account for adventure creation.');
            }
            logger.debug(`[${processId}] Retrieved internal user ID for creator`, { createdBy, internalUserId });

            // Check if user has recently started an adventure using internal ID
            logger.debug(`[${processId}] Checking for recent adventures by user`);
            console.time(`[${processId}] Recent Adventure Check`);
            const lastAdventure = await adventureRepository.findLastAdventureByUser(internalUserId);
            console.timeEnd(`[${processId}] Recent Adventure Check`);
            
            if (lastAdventure) {
                const timeSinceLastAdventure = Date.now() - new Date(lastAdventure.createdAt).getTime();
                logger.debug(`[${processId}] Found recent adventure`, {
                    adventureId: lastAdventure.id,
                    createdAt: lastAdventure.createdAt,
                    timeSinceMs: timeSinceLastAdventure
                });
                
                if (timeSinceLastAdventure < 300000) { // 5 minute cooldown
                    logger.warn(`[${processId}] User attempted to start adventure within cooldown period`, { internalUserId, timeSinceLastMs: timeSinceLastAdventure, cooldownMs: 300000 });
                    throw new Error('Please wait 5 minutes before starting another adventure.');
                }
            } else {
                logger.debug(`[${processId}] No recent adventures found for user`);
            }

            // Get user's party and validate it's ready
            logger.debug(`[${processId}] Finding party for member: ${createdBy}`);
            console.time(`[${processId}] Party Lookup`);
            const party = await this.partyManager.findPartyByMember(createdBy);
            console.timeEnd(`[${processId}] Party Lookup`);
            
            if (!party) {
                logger.warn(`[${processId}] No party found for user`, { createdBy });
                throw { code: 'NO_PARTY', message: 'You need to create or join a party first using /createparty or /joinparty.' };
            }
            
            logger.debug(`[${processId}] Found party for user`, { partyId: party.id, partySize: party.members?.length || 0, partyStatus: party.status });

            // Check if party is ready for adventure
            logger.debug(`[${processId}] Checking if party is ready for adventure`, { partyId: party.id, status: party.status });
            
            if (!party.canStartAdventure()) {
                const readinessMessage = party.getReadinessMessage();
                logger.warn(`[${processId}] Party not ready for adventure`, { partyId: party.id, reason: readinessMessage });
                
                throw {
                    code: 'PARTY_NOT_READY',
                    message: readinessMessage
                };
            }
            
            logger.info(`[${processId}] Party is ready for adventure`, { partyId: party.id });

            // Start transaction with retry logic
            logger.info(`[${processId}] Starting adventure generation transaction`);
            
            return await adventureRepository.executeTransaction(async (transaction) => {
                const transactionStartTime = Date.now();
                console.time(`[${processId}] Adventure Generation Transaction`);
                try {
                    // Generate the adventure
                    logger.info(`[${processId}] Starting adventure content generation process`);
                    console.time(`[${processId}] Adventure Content Generation`);
                    const adventurePromise = this.adventureGenerator.generateAdventure({
                        createdBy: internalUserId,
                        theme,
                        difficulty,
                        settings: { maxPartySize: this.settings.maxPartySize, ...settings, processId },
                    });
                    
                    // Set up a progress reporting interval
                    const progressInterval = setInterval(() => {
                        const elapsedGeneration = Date.now() - transactionStartTime;
                        const percentComplete = Math.min(99, Math.round((elapsedGeneration / timeoutMs) * 100));
                        logger.info(`[${processId}] Adventure generation in progress: ${percentComplete}%`, { elapsedMs: elapsedGeneration, percentComplete });
                    }, 15000);
                    
                    let adventure;
                    try {
                        adventure = await Promise.race([
                            adventurePromise,
                            new Promise((_, reject) => 
                                setTimeout(() => {
                                    logger.error(`[${processId}] Adventure generation timeout hit after ${timeoutMs}ms`);
                                    reject(new Error(`Adventure generation timed out after ${timeoutMs}ms`));
                                }, timeoutMs)
                            )
                        ]);
                        clearInterval(progressInterval);
                    } catch (genError) {
                        clearInterval(progressInterval);
                        logger.error(`[${processId}] Adventure generation failed`, { error: { message: genError.message, stack: genError.stack }});
                        throw genError;
                    }
                    
                    console.timeEnd(`[${processId}] Adventure Content Generation`);
                    logger.info(`[${processId}] Adventure content generation completed`);

                    // **** Get the generated initial scene ****
                    const initialSceneWithId = adventure.state.currentScene;
                    if (!initialSceneWithId || !initialSceneWithId.adventureId) {
                        logger.error(`[${processId}] Initial scene generated by AdventureGenerator is missing adventureId!`, {
                            adventureId: adventure.id, // ID should exist on the adventure object itself though
                            sceneData: initialSceneWithId 
                        });
                        // Attempt recovery if possible, or throw a specific error
                        initialSceneWithId.adventureId = adventure.id; 
                    }
                    
                    // Prepare adventure data for saving (using the internal user ID)
                    const adventureData = { ...adventure.toJSON(), createdBy: internalUserId, partyId: party.id }; // Use internalUserId
                    logger.debug(`[${processId}] Preparing adventure data for database`);

                    // Create the adventure in the database
                    logger.info(`[${processId}] Saving adventure to database`);
                    console.time(`[${processId}] Adventure DB Create`);
                    const createdAdventure = await adventureRepository.create(transaction, adventureData, internalUserId);
                    console.timeEnd(`[${processId}] Adventure DB Create`);
                    logger.info(`[${processId}] Adventure saved to database`, { adventureId: createdAdventure.id, title: createdAdventure.title });

                    // Initialize state and resources
                    logger.info(`[${processId}] Initializing state and resources`);
                    console.time(`[${processId}] State & Resources Init`);
                    let state, resources;
                    try {
                        // Execute sequentially within the same transaction
                        logger.debug(`[${processId}] Initializing state...`);
                        state = await this.stateManager.initializeState({
                            adventureId: createdAdventure.id,
                            // **** Pass the CORRECT initial scene ****
                            initialState: { currentScene: initialSceneWithId, status: 'initialized' }, 
                            timeoutMs: timeoutMs / 2, // Adjust as needed
                            transaction,
                            processId
                        });
                        logger.debug(`[${processId}] State initialized. Initializing resources...`);
                        resources = await this.resourceManager.initializeResources({
                            adventureId: createdAdventure.id,
                            timeoutMs: timeoutMs / 2, // Adjust as needed
                            transaction,
                            processId
                        });
                        logger.debug(`[${processId}] State and resources initialized successfully`);
                    } catch (initError) {
                        logger.error(`[${processId}] Failed to initialize state or resources`, { error: { message: initError.message, stack: initError.stack }, adventureId: createdAdventure.id });
                        throw initError;
                    }
                    console.timeEnd(`[${processId}] State & Resources Init`);

                    // Generate initial images
                    logger.info(`[${processId}] Starting image generation`);
                    console.time(`[${processId}] Image Generation`);
                    const imagePromises = {
                        location: this.sceneGenerator.generateLocationImage(createdAdventure.id, createdAdventure.state.currentScene.location, createdAdventure.setting).catch(err => {
                            logger.error(`[${processId}] Error generating location image`, { error: { message: err.message, stack: err.stack }});
                            return null; // Return null on error, don't throw
                        }),
                        scenes: [
                            this.sceneGenerator.generateSceneImage(createdAdventure.id, createdAdventure.state.currentScene.description, []).catch(err => {
                                logger.error(`[${processId}] Error generating scene image`, { error: { message: err.message, stack: err.stack }});
                                return null; // Return null on error
                            })
                        ],
                        characters: []
                    };
                    let images;
                    const imageStartTime = Date.now();
                    const imageProgressInterval = setInterval(() => {
                        const elapsedImageTime = Date.now() - imageStartTime;
                        const imagePercentComplete = Math.min(99, Math.round((elapsedImageTime / imageTimeoutMs) * 100));
                        logger.info(`[${processId}] Image generation in progress: ${imagePercentComplete}%`, { elapsedMs: elapsedImageTime, percentComplete: imagePercentComplete });
                    }, 10000);
                    try {
                        const imageResults = await Promise.race([
                            Promise.all([imagePromises.location, ...imagePromises.scenes, ...imagePromises.characters]),
                            new Promise((_, reject) =>
                                setTimeout(() => {
                                    logger.error(`[${processId}] Image generation timeout hit after ${imageTimeoutMs}ms`);
                                    reject(new Error(`Image generation timed out after ${imageTimeoutMs}ms`));
                                }, imageTimeoutMs)
                            )
                        ]);
                        clearInterval(imageProgressInterval);
                        // Map results correctly
                        images = {
                            location: imageResults[0],
                            scenes: imageResults.slice(1, 1 + imagePromises.scenes.length),
                            characters: imageResults.slice(1 + imagePromises.scenes.length)
                        };
                        logger.info(`[${processId}] Image generation completed`, { locationImage: !!images.location, sceneImages: images.scenes.filter(Boolean).length });
                    } catch (imgError) {
                        clearInterval(imageProgressInterval);
                        logger.warn(`[${processId}] Image generation failed or timed out`, { error: { message: imgError.message, stack: imgError.stack }});
                        images = { location: null, scenes: [], characters: [] }; // Default empty images
                    }
                    console.timeEnd(`[${processId}] Image Generation`);

                    // Format response
                    logger.debug(`[${processId}] Formatting adventure start response`);
                    console.time(`[${processId}] Response Formatting`);
                    const response = responseFormatter.formatAdventureStart({
                        adventure: createdAdventure,
                        party: null, // Party data not needed here? Fetched separately?
                        images,
                        initialScene: createdAdventure.state.currentScene,
                    });
                    console.timeEnd(`[${processId}] Response Formatting`);
                    logger.debug(`[${processId}] Response formatted successfully`);

                    console.timeEnd(`[${processId}] Adventure Generation Transaction`);
                    logger.info(`[${processId}] Adventure initialization transaction complete`, { adventureId: createdAdventure.id });

                    return {
                        data: {
                            adventure: createdAdventure,
                            party: null, // Or maybe the fetched party?
                            currentScene: createdAdventure.state.currentScene,
                        },
                        response,
                    };
                } catch (error) {
                    // Rollback is handled by executeTransaction
                    console.timeEnd(`[${processId}] Adventure Generation Transaction`); // End timer on error too
                    logger.error(`[${processId}] Transaction error during adventure initialization`, { error: { code: error.code, message: error.message, stack: error.stack }});
                    throw error; // Re-throw for executeTransaction to handle rollback
                }
            }, 3); // 3 retries for the transaction
        } catch (error) {
            // Catch errors from outside the transaction (validation, user lookup, etc.) or after transaction failure
             console.timeEnd(`[${processId}] initializeAdventure Total`); // End overall timer on error
            // ... (existing error categorization and logging as before) ...
             if (error.code === 'NO_PARTY' || error.code === 'PARTY_NOT_READY') {
                logger.warn(`[${processId}] Party validation failed`, { errorCode: error.code, message: error.message, createdBy });
            } else if (error.message?.includes('cooldown') || error.message?.includes('wait')) {
                logger.warn(`[${processId}] Cooldown restriction`, { message: error.message, createdBy });
            } // ... etc ...
            else {
                logger.error(`[${processId}] Failed to initialize adventure`, { error: { message: error.message, code: error.code, stack: error.stack }, createdBy, theme, difficulty });
            }
            throw error;
        } finally {
             // Ensure the overall timer ends even if error handling throws
             // Use try...finally if error handling might throw before reaching this point
             // console.timeEnd(`[${processId}] initializeAdventure Total`); // Already ended in catch, avoid ending twice
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
            if (!currentScene || !currentScene.choices) {
                throw new Error('Invalid scene state');
            }

            const choices = currentScene.choices;
            let chosenAction = null;

            // Try to interpret the decision as a 1-based index first
            const choiceIndex = parseInt(decision, 10);
            if (!isNaN(choiceIndex) && choiceIndex >= 1 && choiceIndex <= choices.length) {
                chosenAction = choices[choiceIndex - 1]; // Use 0-based index
                logger.debug('Interpreted decision as index', { input: decision, index: choiceIndex, choiceId: chosenAction.id, choiceText: chosenAction.text });
            } else {
                // If not a valid index, try matching the exact text (fallback)
                logger.debug('Decision is not a valid index, trying text match', { decisionText: decision });
                chosenAction = choices.find(c => c.text === decision);
                if (chosenAction) {
                    logger.debug('Found matching choice by text', { choiceId: chosenAction.id, choiceText: chosenAction.text });
                }
            }

            // Validate that a choice was found either by index or text
            if (!chosenAction) {
                logger.error('Could not match decision input to any choice (tried index and text)', { userId, adventureId, decisionInput: decision, availableChoiceTexts: choices.map(c => c.text) });
                // Provide a more helpful error message including the available choices
                const availableChoicesText = choices.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
                throw new Error(`Invalid decision. Please enter the number (1-${choices.length}) or the exact text of one of the following choices:\n${availableChoicesText}`);
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

            // Add the userId to the chosenAction before passing it down
            const actionWithUser = { ...chosenAction, userId: userId };

            // Process the decision and get consequences
            const result = await this.decisionGenerator.processDecision({
                adventureId,
                scene: currentScene,
                choice: actionWithUser,
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
                    sceneImage: sceneImage,
                },
                response,
            };
        } catch (error) {
            await transaction.rollback();
            
            // Log the full error details
            logger.error('Failed to process decision', { 
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                adventureId,
                userId,
                decision
            });

            // Format error response
            const errorResponse = responseFormatter.formatError(error, process.env.NODE_ENV === 'development');
            
            // Throw structured error
            throw {
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                response: errorResponse,
                adventureId,
                userId
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
            
            // Initialize state and resources as null
            let state = null;
            let resources = null;
            
            // Only try to get state if party has an adventure
            if (party.adventureId) {
                try {
                    state = await this.stateManager.getState(party.adventureId);
                    resources = await this.resourceManager.getUsage({
                        adventureId: party.adventureId,
                    });
                } catch (stateError) {
                    logger.warn('Could not retrieve adventure state', { 
                        error: stateError.message,
                        partyId,
                        adventureId: party.adventureId
                    });
                    // Continue without state - it's OK for parties not in an adventure
                }
            }

            // Format response
            const response = responseFormatter.formatPartyStatus({
                party,
                state,
                section,
            });

            return {
                data: {
                    party,
                    currentScene: state?.currentScene || null,
                    resources: resources || null,
                    status: state?.status || 'RECRUITING',
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
     * @param {string} options.adventurerName Character name
     * @param {string} [options.backstory] Character backstory
     * @param {Object} [options.settings] Additional party settings
     * @returns {Promise<Object>} Updated party status
     */
    async joinParty({ partyId, userId, adventurerName, backstory, settings = {} }) {
        try {
            // Validate member operation
            this.partyValidator.validateMemberOperation({
                partyId,
                userId,
                role: 'member',
            });

            logger.info('User joining party', { partyId, userId, adventurerName });

            // Validate adventurerName
            if (!adventurerName || typeof adventurerName !== 'string' || adventurerName.trim().length === 0) {
                throw new Error('Adventurer name is required and cannot be empty');
            }

            // Check if user is already in a party
            const existingParty = await this.partyManager.findPartyByMember(userId);
            if (existingParty) {
                throw new Error('User is already in a party');
            }

            // Add member to party
            const success = await this.partyManager.addMember({
                partyId,
                userId,
                adventurerName,
                backstory,
                memberType: 'member',
                settings
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