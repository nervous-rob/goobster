/**
 * Scene Generator
 * Handles the generation of scenes and their content
 */

require('dotenv').config();
const Scene = require('../models/Scene');
const logger = require('../utils/logger');
const promptBuilder = require('../utils/promptBuilder');
const responseParser = require('../utils/responseParser');
const adventureValidator = require('../validators/adventureValidator');
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { createCanvas, loadImage } = require('../utils/canvasMock');
const sharp = require('../utils/sharpMock');
const { writeFile } = require('fs/promises');
const { s3Upload } = require('../../../utils/aws');
const { getPrompt, getPromptWithGuildPersonality } = require('../../../utils/memeMode');
const { createLogger } = require('../../../utils/logger');
const aiService = require('../../../services/ai/instance');

const logger = createLogger('SceneGenerator');

class SceneGenerator {
    constructor(userId) {
        this.userId = userId;
        this.guildId = null;

        // Default settings for scene generation
        this.defaultSettings = {
            minChoices: 2,
            maxChoices: 4,
            maxChoiceLength: 100,
            maxSceneDescription: 1500,
            aiModel: 'o1',
            temperature: 0.7,
            imageModel: 'dall-e-3',
            imageSize: '1024x1024',
            imageStyle: 'natural',
        };

        // Ensure image directories exist
        this.initializeImageDirectories();
    }

    /**
     * Initialize necessary directories for image storage
     * @private
     */
    async initializeImageDirectories() {
        const dirs = [
            'data/images/scenes',
            'data/images/characters',
            'data/images/locations',
            'data/images/references'
        ];

        for (const dir of dirs) {
            try {
                await fs.mkdir(path.join(process.cwd(), dir), { recursive: true });
            } catch (error) {
                logger.error('Failed to create image directory', { dir, error });
            }
        }
    }

    /**
     * Generate a new scene
     * @param {Object} options Scene generation options
     * @param {string} options.adventureId Adventure ID
     * @param {string} options.previousScene Previous scene data
     * @param {string} options.chosenAction Chosen action from previous scene
     * @param {Object} options.adventureContext Additional context
     * @returns {Promise<Scene>} Generated scene instance
     */
    async generateNextScene({ adventureId, previousScene, chosenAction, adventureContext }) {
        try {
            logger.info('Generating next scene', { adventureId });

            const prompt = promptBuilder.buildScenePrompt({
                type: 'next',
                previousScene,
                chosenAction,
                context: adventureContext,
                minChoices: this.defaultSettings.minChoices,
                maxChoices: this.defaultSettings.maxChoices,
            });

            const response = await aiService.generateResponse({
                model: this.defaultSettings.aiModel,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a creative scene designer. Create engaging and meaningful scenes with interesting choices.',
                    },
                    {
                        role: 'user',
                        content: prompt,
                    }
                ],
                temperature: this.defaultSettings.temperature,
                maxTokens: 1000
            });

            const content = responseParser.parseSceneResponse(response.content);
            return new Scene({
                adventureId,
                title: content.title,
                description: content.description,
                choices: content.choices,
                metadata: content.metadata || {},
            });
        } catch (error) {
            logger.error('Failed to generate next scene', { error });
            throw error;
        }
    }

    /**
     * Generate an image for a scene
     * @param {string} adventureId Adventure ID
     * @param {string} description Scene description
     * @param {Object} [options] Image generation options
     * @returns {Promise<string>} Generated image URL
     */
    async generateSceneImage(adventureId, description, options = {}) {
        try {
            logger.info('Generating scene image', { adventureId });

            const prompt = promptBuilder.buildImagePrompt({
                type: 'scene',
                description,
                style: options.style || this.defaultSettings.imageStyle,
            });

            const response = await aiService.generateImage({
                model: this.defaultSettings.imageModel,
                prompt: prompt,
                size: options.size || this.defaultSettings.imageSize,
                quality: options.quality || 'standard',
                style: options.style || this.defaultSettings.imageStyle,
                n: 1,
            });

            return response.url;
        } catch (error) {
            logger.error('Failed to generate scene image', { error });
            throw error;
        }
    }

    /**
     * Generate a character portrait
     * @param {string} adventureId Adventure ID
     * @param {Object} character Character details
     * @returns {Promise<string>} Generated image URL
     */
    async generateCharacterPortrait(adventureId, character) {
        try {
            logger.info('Generating character portrait', { adventureId });

            const prompt = promptBuilder.buildImagePrompt({
                type: 'character',
                character,
                style: this.defaultSettings.imageStyle,
            });

            const response = await aiService.generateImage({
                model: this.defaultSettings.imageModel,
                prompt: prompt,
                size: this.defaultSettings.imageSize,
                quality: 'standard',
                style: this.defaultSettings.imageStyle,
                n: 1,
            });

            return response.url;
        } catch (error) {
            logger.error('Failed to generate character portrait', { error });
            throw error;
        }
    }

    /**
     * Generate a location image
     * @param {string} adventureId Adventure ID
     * @param {Object} location Location details
     * @param {string} setting Adventure setting
     * @returns {Promise<string>} Generated image URL
     */
    async generateLocationImage(adventureId, location, setting) {
        try {
            logger.info('Generating location image', { adventureId });

            const prompt = promptBuilder.buildImagePrompt({
                type: 'location',
                location,
                setting,
                style: this.defaultSettings.imageStyle,
            });

            const response = await aiService.generateImage({
                model: this.defaultSettings.imageModel,
                prompt: prompt,
                size: this.defaultSettings.imageSize,
                quality: 'standard',
                style: this.defaultSettings.imageStyle,
                n: 1,
            });

            return response.url;
        } catch (error) {
            logger.error('Failed to generate location image', { error });
            throw error;
        }
    }

    /**
     * Generate a special scene (e.g., combat, puzzle, dialogue)
     * @param {Object} options Special scene options
     * @returns {Promise<Scene>} Generated special scene
     */
    async generateSpecialScene({ adventureId, type, context }) {
        try {
            // Validate special scene request
            adventureValidator.validateSpecialScene({ adventureId, type, context });
            
            logger.info('Generating special scene', { adventureId, type });

            const prompt = promptBuilder.buildScenePrompt({
                type,
                context: JSON.stringify(context),
                minChoices: this.defaultSettings.minChoices,
                maxChoices: this.defaultSettings.maxChoices,
            });

            const response = await aiService.generateResponse({
                model: this.defaultSettings.aiModel,
                messages: [
                    {
                        role: 'system',
                        content: `You are a creative scene designer specializing in ${type} scenes.`,
                    },
                    {
                        role: 'user',
                        content: prompt,
                    }
                ],
                temperature: this.defaultSettings.temperature,
                maxTokens: 1000
            });

            const content = responseParser.parseSceneResponse(response.content);
            return new Scene({
                adventureId,
                title: content.title,
                description: content.description,
                choices: content.choices,
                metadata: content.metadata || {},
            });
        } catch (error) {
            logger.error('Failed to generate special scene', { error });
            throw error;
        }
    }

    /**
     * Download and save an image from a URL
     * @param {string} url Image URL
     * @param {string} filepath Destination file path
     * @private
     */
    async downloadAndSaveImage(url, filepath) {
        try {
            const response = await fetch(url);
            const buffer = await response.arrayBuffer();
            await fs.writeFile(filepath, Buffer.from(buffer));
        } catch (error) {
            logger.error('Failed to download and save image', { error });
            throw error;
        }
    }

    async generateScene(context, previousScenes = []) {
        try {
            const prompt = this.buildScenePrompt(context, previousScenes);
            
            const response = await aiService.generateResponse({
                messages: [
                    { role: 'system', content: 'You are an expert adventure game master creating engaging and dynamic scenes.' },
                    { role: 'user', content: prompt }
                ],
                model: 'o1', // Use O1 for creative content generation
                temperature: 0.8,
                maxTokens: 2000
            });

            return this.parseSceneResponse(response.content);
        } catch (error) {
            logger.error('Error generating scene:', error);
            throw error;
        }
    }
}

module.exports = SceneGenerator; 