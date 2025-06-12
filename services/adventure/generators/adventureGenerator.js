/**
 * Adventure Generator
 * Handles the generation of new adventures and their initial content
 */

require('dotenv').config();
const Adventure = require('../models/Adventure');
const Scene = require('../models/Scene');
const logger = require('../utils/logger');
const promptBuilder = require('../utils/promptBuilder');
const responseParser = require('../utils/responseParser');
const AdventureValidator = require('../validators/adventureValidator');
const { getPrompt, getPromptWithGuildPersonality } = require('../../../utils/memeMode');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { formatJSON } = require('../utils/responseFormatter');
const Party = require('../models/Party');
const Character = require('../models/Character');
const Location = require('../models/Location');
const Item = require('../models/Item');
const Action = require('../models/Action');
const adventureRepository = require('../repositories/adventureRepository');
const aiService = require('../../aiService');

class AdventureGenerator {
    constructor(openai, userId) {
        this.openai = openai;
        this.userId = userId;
        this.guildId = null;
        
        // Initialize validator
        this.adventureValidator = new AdventureValidator();
        
        // Default settings for adventure generation
        this.defaultSettings = {
            maxPartySize: 4,
            difficulty: 'normal',
            genre: 'fantasy',
            complexity: 'medium',
            aiModel: 'gpt-4o',
        };
        
        logger.debug('AdventureGenerator initialized', { 
            userId, 
            defaultSettings: this.defaultSettings 
        });
    }

    /**
     * Generate a new adventure
     * @param {Object} options Adventure generation options
     * @param {string} options.createdBy User ID who requested the adventure
     * @param {string} [options.theme] Specific theme for the adventure
     * @param {string} [options.difficulty] Difficulty level
     * @param {Object} [options.settings] Additional settings
     * @returns {Promise<Adventure>} Generated adventure instance
     */
    async generateAdventure({ createdBy, theme, difficulty, settings = {} }) {
        const startTime = Date.now();
        const processId = uuidv4().substring(0, 8);
        
        logger.info(`[${processId}] Adventure generation started`, { 
            createdBy, 
            theme, 
            difficulty, 
            settingsKeys: Object.keys(settings)
        });
        
        try {
            // Validate inputs
            logger.debug(`[${processId}] Validating inputs`, { createdBy, theme, difficulty });
            this.adventureValidator.validateInitialization({ createdBy, theme, difficulty, settings });

            // Ensure we have defaults for all required fields
            const validatedTheme = theme || 'fantasy';
            const validatedDifficulty = difficulty || this.defaultSettings.difficulty;
            
            logger.info(`[${processId}] Generating new adventure`, { 
                createdBy, 
                theme: validatedTheme, 
                difficulty: validatedDifficulty 
            });

            // Merge settings with defaults and ensure required fields
            const finalSettings = {
                ...this.defaultSettings,
                ...settings,
                difficulty: validatedDifficulty,
                theme: validatedTheme, // Ensure theme is never null
            };
            
            logger.debug(`[${processId}] Final settings`, { finalSettings });

            // Generate adventure content using OpenAI
            logger.info(`[${processId}] Generating adventure content`);
            console.time(`${processId}-content-generation`);
            const content = await this._generateAdventureContent({ 
                theme: validatedTheme, 
                difficulty: finalSettings.difficulty,
                context: settings.context || 'This is the beginning of a new adventure.',
                processId
            });
            console.timeEnd(`${processId}-content-generation`);
            logger.debug(`[${processId}] Adventure content generated`, { 
                title: content.title,
                contentFields: Object.keys(content) 
            });

            // Create new adventure instance with required fields
            logger.debug(`[${processId}] Creating adventure instance`);
            const adventure = new Adventure({
                title: content.title,
                description: content.description,
                setting: content.setting,
                plotSummary: content.plotSummary,
                plotPoints: content.plotPoints,
                keyElements: content.keyElements,
                winCondition: content.winCondition,
                createdBy,
                settings: finalSettings,
                theme: finalSettings.theme, // Explicitly pass theme
            });
            
            logger.debug(`[${processId}] Adventure instance created`, { 
                adventureId: adventure.id,
                title: adventure.title 
            });

            // Generate and set initial scene
            logger.info(`[${processId}] Generating initial scene`);
            console.time(`${processId}-initial-scene-generation`);
            const initialScene = await this._generateInitialScene(adventure.id, content.initialScenePrompt, processId);
            console.timeEnd(`${processId}-initial-scene-generation`);
            adventure.updateScene(initialScene);
            
            logger.debug(`[${processId}] Initial scene added to adventure`, { 
                sceneId: initialScene.id,
                sceneTitle: initialScene.title
            });

            const elapsedTime = Date.now() - startTime;
            logger.info(`[${processId}] Successfully generated adventure in ${elapsedTime}ms`, { 
                adventureId: adventure.id,
                title: adventure.title,
                status: adventure.status,
                timeMs: elapsedTime
            });

            return adventure;
        } catch (error) {
            const elapsedTime = Date.now() - startTime;
            logger.error(`[${processId}] Failed to generate adventure after ${elapsedTime}ms`, { 
                error: {
                    message: error.message,
                    stack: error.stack
                },
                createdBy,
                theme,
                difficulty,
                timeMs: elapsedTime
            });
            throw error;
        }
    }

    /**
     * Generate the initial content for an adventure using OpenAI
     * @param {Object} options Content generation options
     * @returns {Promise<Object>} Generated content
     * @private
     */
    async _generateAdventureContent({ theme, difficulty, context, processId = '' }) {
        const contentId = processId || uuidv4().substring(0, 8);
        logger.debug(`[${contentId}] Building prompt for adventure content`);
        
        const prompt = promptBuilder.buildScenePrompt({
            type: 'base',
            theme: theme || 'Create an interesting theme',
            difficulty: difficulty || 'normal',
            minChoices: 2,
            maxChoices: 4,
            context: context || 'This is the beginning of a new adventure. Include a concise setting description and plot summary.',
        });
        
        logger.debug(`[${contentId}] Prompt built, length: ${prompt.length} chars`);

        logger.info(`[${contentId}] Making OpenAI request for adventure content`);
        const startTime = Date.now();
        try {
            const responseText = await aiService.chat([
                {
                    role: 'system',
                    content: 'You are a creative adventure game designer. Create engaging and imaginative content with rich, detailed settings and compelling plot summaries. Keep descriptions concise but meaningful.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ], {
                preset: 'creative',
                max_tokens: 1000
            });

            logger.debug(`[${contentId}] Parsing adventure content response`);
            try {
                const parsedContent = responseParser.parseSceneResponse(responseText);
                logger.debug(`[${contentId}] Response parsed successfully`, {
                    contentFields: Object.keys(parsedContent)
                });
                
                // Check for missing fields and apply defaults
                logger.debug(`[${contentId}] Checking for missing fields`);
                
                // Ensure all required fields have values but keep them concise
                if (!parsedContent.setting) {
                    logger.debug(`[${contentId}] Setting missing, creating default`);
                    parsedContent.setting = {
                        location: parsedContent.description.split('.')[0],
                        environment: parsedContent.description.split('.').slice(0, 2).join('.'),
                        atmosphere: theme || 'mysterious'
                    };
                }

                if (!parsedContent.plotSummary) {
                    logger.debug(`[${contentId}] Plot summary missing, creating default`);
                    parsedContent.plotSummary = {
                        mainObjective: `Complete ${parsedContent.title}`,
                        challenges: ['Face challenges', 'Navigate terrain', 'Uncover secrets'],
                        expectedOutcome: 'Victory or defeat',
                        difficulty: difficulty
                    };
                }

                if (!parsedContent.plotPoints) {
                    logger.debug(`[${contentId}] Plot points missing, creating default`);
                    parsedContent.plotPoints = {
                        majorEvents: ['Start', 'Challenge', 'Discovery', 'Climax', 'Resolution'],
                        keyCharacters: ['Leader', 'Ally', 'Enemy', 'Guide', 'Support'],
                        storyArcs: ['Main quest', 'Growth', 'Side quest', 'Tension', 'End']
                    };
                }

                if (!parsedContent.keyElements) {
                    logger.debug(`[${contentId}] Key elements missing, creating default`);
                    parsedContent.keyElements = {
                        items: ['Equipment', 'Resources', 'Tools', 'Artifacts', 'Supplies'],
                        locations: ['Start', 'Waypoints', 'Danger zones', 'Safe areas', 'Goal'],
                        characters: ['Allies', 'Contacts', 'Enemies', 'Neutrals', 'Quest givers'],
                        objectives: ['Primary', 'Secondary', 'Optional', 'Hidden', 'Bonus'],
                        secrets: ['Info', 'Paths', 'Dangers', 'Intel', 'Mysteries']
                    };
                }

                if (!parsedContent.winCondition) {
                    logger.debug(`[${contentId}] Win condition missing, creating default`);
                    parsedContent.winCondition = {
                        type: 'completion',
                        requirements: ['Complete objective', 'Survive', 'Gather intel', 'Reach goal'],
                        rewards: ['Completion', 'Experience', 'Resources', 'Knowledge'],
                        failureConditions: ['Death', 'Failure', 'Time out', 'Loss'],
                        timeLimit: null
                    };
                }

                // Pre-stringify all objects to avoid multiple conversions
                logger.debug(`[${contentId}] Stringifying complex objects`);
                ['plotSummary', 'setting', 'plotPoints', 'keyElements', 'winCondition'].forEach(field => {
                    if (typeof parsedContent[field] === 'object') {
                        parsedContent[field] = JSON.stringify(parsedContent[field]);
                    }
                });

                logger.info(`[${contentId}] Adventure content preparation completed`);
                return parsedContent;
            } catch (parseError) {
                logger.error(`[${contentId}] Failed to parse adventure content response`, { 
                    error: {
                        message: parseError.message,
                        stack: parseError.stack
                    },
                    responseContent: responseText.substring(0, 200) + '...'
                });
                throw new Error('Invalid adventure content format');
            }
        } catch (apiError) {
            const responseTime = Date.now() - startTime;
            logger.error(`[${contentId}] OpenAI API error after ${responseTime}ms`, { 
                error: {
                    message: apiError.message,
                    type: apiError.type,
                    code: apiError.code,
                    stack: apiError.stack
                },
                theme,
                difficulty
            });
            throw apiError;
        }
    }

    /**
     * Generate the initial scene for an adventure
     * @param {string} adventureId Adventure ID
     * @param {string} scenePrompt Initial scene prompt
     * @returns {Promise<Scene>} Generated scene
     * @private
     */
    async _generateInitialScene(adventureId, scenePrompt, processId = '') {
        const sceneId = processId || uuidv4().substring(0, 8);
        logger.debug(`[${sceneId}] Building prompt for initial scene`, { adventureId });
        
        const prompt = promptBuilder.buildScenePrompt({
            type: 'base',
            context: scenePrompt,
            minChoices: 2,
            maxChoices: 4,
        });
        
        logger.debug(`[${sceneId}] Scene prompt built, length: ${prompt.length} chars`);

        logger.info(`[${sceneId}] Making OpenAI request for initial scene`);
        const startTime = Date.now();
        try {
            const responseText = await aiService.chat([
                {
                    role: 'system',
                    content: 'You are a creative scene designer specializing in generating structured game content. Always return your responses in valid JSON format following the exact schema provided in the prompt. Never include narrative text or markdown outside the JSON structure.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ], {
                preset: 'creative',
                max_tokens: 1000
            });

            logger.debug(`[${sceneId}] Parsing scene response`);
            try {
                const content = responseParser.parseSceneResponse(responseText);
                logger.debug(`[${sceneId}] Scene response parsed successfully`, {
                    title: content.title,
                    choicesCount: content.choices?.length || 0
                });
                
                const scene = new Scene({
                    adventureId,
                    title: content.title,
                    description: content.description,
                    choices: content.choices,
                    metadata: content.metadata || {},
                });
                
                logger.info(`[${sceneId}] Initial scene created`, {
                    sceneId: scene.id,
                    title: scene.title,
                    choicesCount: scene.choices.length
                });
                
                return scene;
            } catch (parseError) {
                logger.error(`[${sceneId}] Failed to parse initial scene response`, { 
                    error: {
                        message: parseError.message,
                        stack: parseError.stack
                    },
                    responseContent: responseText.substring(0, 200) + '...'
                });
                throw new Error('Invalid scene content format');
            }
        } catch (apiError) {
            const responseTime = Date.now() - startTime;
            logger.error(`[${sceneId}] OpenAI API error after ${responseTime}ms`, { 
                error: {
                    message: apiError.message,
                    type: apiError.type,
                    code: apiError.code,
                    stack: apiError.stack
                },
                adventureId
            });
            throw apiError;
        }
    }

    /**
     * Build the prompt for adventure generation
     * @param {Object} params Adventure generation parameters
     * @returns {string} Formatted prompt
     * @private
     */
    buildAdventurePrompt(params) {
        const { theme, difficulty, settings = {} } = params;
        
        logger.debug('Building adventure prompt', { theme, difficulty, settings });
        
        return `Create a new adventure with the following parameters:
Theme: ${theme || 'fantasy'}
Difficulty: ${difficulty || 'normal'}
Party Size: ${settings.maxPartySize || 4}

Please provide a detailed adventure structure including:
1. Title
2. Description
3. Setting
4. Plot Summary
5. Key Plot Points
6. Important Elements
7. Win Conditions

Format the response as a JSON object with these fields.`;
    }
}

module.exports = AdventureGenerator; 