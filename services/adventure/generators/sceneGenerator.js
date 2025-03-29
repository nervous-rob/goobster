/**
 * Scene Generator
 * Handles the generation of scenes and their content
 */

require('dotenv').config();
const OpenAI = require('openai');
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

class SceneGenerator {
    constructor(openai, userId) {
        this.openai = openai;
        this.userId = userId;
        this.guildId = null;

        // Default settings for scene generation
        this.defaultSettings = {
            minChoices: 2,
            maxChoices: 4,
            maxChoiceLength: 100,
            maxSceneDescription: 1500,
            aiModel: 'gpt-4o'
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
            'data/images/references',
            'data/images/fallbacks'
        ];

        for (const dir of dirs) {
            try {
                await fs.mkdir(path.join(process.cwd(), dir), { recursive: true });
            } catch (error) {
                logger.error('Failed to create image directory', { dir, error });
            }
        }

        // Initialize fallback images if they don't exist
        await this._initializeFallbackImages();
    }

    /**
     * Initialize fallback images
     * @private
     */
    async _initializeFallbackImages() {
        const fallbacks = {
            'scene_default.png': {
                prompt: 'A mysterious fantasy scene with a path leading into darkness, atmospheric fog, and magical lighting',
                style: 'vivid'
            },
            'location_default.png': {
                prompt: 'A distant fantasy castle on a hill at sunset with dramatic lighting and mysterious atmosphere',
                style: 'vivid'
            },
            'character_default.png': {
                prompt: 'A silhouetted fantasy adventurer standing in dramatic lighting with a mysterious atmosphere',
                style: 'vivid'
            }
        };

        const fallbackDir = path.join(process.cwd(), 'data/images/fallbacks');

        for (const [filename, config] of Object.entries(fallbacks)) {
            const filepath = path.join(fallbackDir, filename);
            
            // Only generate if fallback doesn't exist
            if (!await fs.access(filepath).then(() => true).catch(() => false)) {
                try {
                    logger.info('Generating fallback image', { filename });
                    
                    const response = await this.openai.images.generate({
                        model: "dall-e-3",
                        prompt: config.prompt,
                        size: "1024x1024",
                        quality: "standard",
                        style: config.style,
                        n: 1,
                        response_format: "url"
                    });

                    if (response.data?.[0]?.url) {
                        await this.downloadAndSaveImage(response.data[0].url, filepath);
                        logger.info('Fallback image generated', { filename });
                    }
                } catch (error) {
                    logger.error('Failed to generate fallback image', { 
                        error,
                        filename
                    });
                }
            }
        }
    }

    /**
     * Get a fallback image path
     * @param {string} type Image type
     * @returns {Promise<string>} Fallback image path
     * @private
     */
    async _getFallbackImage(type) {
        const fallbackMap = {
            'scene': 'scene_default.png',
            'location': 'location_default.png',
            'character': 'character_default.png'
        };

        const filename = fallbackMap[type] || 'scene_default.png';
        const filepath = path.join(process.cwd(), 'data/images/fallbacks', filename);

        // Check if fallback exists
        if (await fs.access(filepath).then(() => true).catch(() => false)) {
            return filepath;
        }

        // If fallback doesn't exist, try to generate it
        await this._initializeFallbackImages();

        // Check again after generation attempt
        if (await fs.access(filepath).then(() => true).catch(() => false)) {
            return filepath;
        }

        throw new Error(`No fallback image available for type: ${type}`);
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
                type: 'base',
                previousScene,
                chosenAction,
                context: adventureContext,
                minChoices: this.defaultSettings.minChoices,
                maxChoices: this.defaultSettings.maxChoices,
            });

            const response = await this.openai.chat.completions.create({
                model: this.defaultSettings.aiModel,
                messages: [{
                    role: 'system',
                    content: 'You are a creative scene designer. Create engaging and meaningful scenes with interesting choices.',
                }, {
                    role: 'user',
                    content: prompt,
                }],
                temperature: 0.7,
            });

            const content = responseParser.parseSceneResponse(response.choices[0].message.content);
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
     * Download and save an image from a URL
     * @param {string} url Image URL
     * @param {string} filepath Destination file path
     * @private
     */
    async downloadAndSaveImage(url, filepath) {
        try {
            logger.debug('Downloading image', { url, filepath });
            
            // Add retries for image download
            let attempts = 3;
            let lastError = null;
            
            while (attempts > 0) {
                try {
                    const response = await fetch(url, {
                        timeout: 30000, // 30 second timeout
                        headers: {
                            'User-Agent': 'Adventure-Service/1.0'
                        }
                    });
                    
                    if (!response.ok) {
                        throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
                    }
                    
                    const buffer = await response.arrayBuffer();
                    
                    // Ensure the directory exists
                    await fs.mkdir(path.dirname(filepath), { recursive: true });
                    
                    // Write file with proper error handling
                    await fs.writeFile(filepath, Buffer.from(buffer));
                    
                    // Verify the file was written correctly
                    const stats = await fs.stat(filepath);
                    if (stats.size === 0) {
                        throw new Error('Downloaded file is empty');
                    }
                    
                    // Upload to S3 if configured
                    if (process.env.USE_S3_STORAGE === 'true') {
                        const s3Key = `adventures/${path.basename(filepath)}`;
                        await s3Upload(filepath, s3Key);
                        logger.info('Image uploaded to S3', { filepath, s3Key });
                    }
                    
                    logger.info('Image saved successfully', { 
                        filepath,
                        size: stats.size,
                        timestamp: new Date().toISOString()
                    });
                    
                    return;
                } catch (error) {
                    lastError = error;
                    attempts--;
                    if (attempts > 0) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        logger.warn('Retrying image download', {
                            url,
                            attemptsLeft: attempts,
                            error: error.message
                        });
                    }
                }
            }
            
            throw lastError;
        } catch (error) {
            logger.error('Failed to download and save image', { 
                error: {
                    message: error.message,
                    code: error.code,
                    type: error.type,
                    stack: error.stack
                },
                url,
                filepath,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    /**
     * Generate an image for a scene with retries and fallbacks
     * @param {string} adventureId Adventure ID
     * @param {string} description Scene description
     * @param {Object} [options] Image generation options
     * @returns {Promise<string>} Generated image URL
     */
    async generateSceneImage(adventureId, description, options = {}) {
        try {
            logger.info('Generating scene image', { 
                adventureId,
                description: description.substring(0, 100) + '...'
            });

            // Add retries for image generation
            let attempts = 3;
            let lastError = null;
            
            while (attempts > 0) {
                try {
                    const prompt = promptBuilder.buildImagePrompt({
                        type: 'scene',
                        description,
                        style: options.style || 'vivid',
                        mood: options.mood || 'mysterious',
                        lighting: options.lighting || 'dramatic',
                        composition: options.composition || 'dynamic'
                    });

                    logger.debug('Generated image prompt', { prompt });

                    const response = await this.openai.images.generate({
                        model: "dall-e-3",
                        prompt: prompt,
                        size: "1024x1024",
                        quality: "standard",
                        style: options.style || "vivid",
                        n: 1,
                        response_format: "url"
                    });

                    if (!response.data?.[0]?.url) {
                        throw new Error('No image URL in response');
                    }

                    // Generate unique filename with timestamp and hash
                    const timestamp = Date.now();
                    const hash = crypto.createHash('md5').update(description).digest('hex').substring(0, 8);
                    const filename = `${adventureId}_${timestamp}_${hash}.png`;
                    const imagePath = path.join(process.cwd(), 'data/images/scenes', filename);

                    // Download and save the image
                    await this.downloadAndSaveImage(response.data[0].url, imagePath);

                    logger.info('Scene image generated successfully', { 
                        adventureId,
                        imagePath,
                        timestamp: new Date().toISOString()
                    });

                    return imagePath;
                } catch (error) {
                    lastError = error;
                    attempts--;
                    
                    if (attempts > 0) {
                        // Wait before retrying
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        logger.warn('Retrying scene image generation', {
                            adventureId,
                            attemptsLeft: attempts,
                            error: error.message
                        });
                        continue;
                    }
                    
                    // If all attempts failed, try to use a fallback image
                    logger.error('All image generation attempts failed, using fallback', {
                        error: lastError,
                        adventureId
                    });
                    
                    const fallbackPath = await this._getFallbackImage('scene');
                    return fallbackPath;
                }
            }
            
            throw lastError;
        } catch (error) {
            logger.error('Failed to generate scene image', { 
                error: {
                    message: error.message,
                    code: error.code,
                    type: error.type,
                    stack: error.stack
                },
                adventureId,
                description: description.substring(0, 100) + '...',
                timestamp: new Date().toISOString()
            });
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
                style: 'vivid',
            });

            const response = await this.openai.images.generate({
                model: "dall-e-3",
                prompt: prompt,
                size: "1024x1024",
                quality: "standard",
                style: "vivid",
                n: 1,
            });

            // Download and save the image
            const imageUrl = response.data[0].url;
            const imagePath = path.join(process.cwd(), 'data/images/characters', `${adventureId}_${Date.now()}.png`);
            await this.downloadAndSaveImage(imageUrl, imagePath);

            logger.info('Character portrait generated successfully', { 
                adventureId,
                imagePath
            });

            return imagePath;
        } catch (error) {
            logger.error('Failed to generate character portrait', { 
                error: {
                    message: error.message,
                    code: error.code,
                    type: error.type,
                    stack: error.stack
                },
                adventureId,
                character
            });
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
            logger.info('Generating location image', { 
                adventureId,
                location: typeof location === 'string' ? location : location.name,
                setting
            });

            const prompt = promptBuilder.buildImagePrompt({
                type: 'location',
                location: typeof location === 'string' ? location : location.name,
                setting,
                style: 'vivid',
                mood: 'mysterious',
                lighting: 'dramatic',
                composition: 'wide'
            });

            const response = await this.openai.images.generate({
                model: "dall-e-3",
                prompt: prompt,
                size: "1024x1024",
                quality: "standard",
                style: "vivid",
                n: 1,
            });

            if (!response.data?.[0]?.url) {
                throw new Error('No image URL in response');
            }

            // Download and save the image
            const imageUrl = response.data[0].url;
            const imagePath = path.join(process.cwd(), 'data/images/locations', `${adventureId}_${Date.now()}.png`);
            await this.downloadAndSaveImage(imageUrl, imagePath);

            logger.info('Location image generated successfully', { 
                adventureId,
                imagePath
            });

            return imagePath;
        } catch (error) {
            logger.error('Failed to generate location image', { 
                error: {
                    message: error.message,
                    code: error.code,
                    type: error.type,
                    stack: error.stack
                },
                adventureId,
                location: typeof location === 'string' ? location : location.name,
                setting
            });
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

            const response = await this.openai.chat.completions.create({
                model: this.defaultSettings.aiModel,
                messages: [{
                    role: 'system',
                    content: `You are a creative scene designer specializing in ${type} scenes.`,
                }, {
                    role: 'user',
                    content: prompt,
                }],
                temperature: 0.7,
            });

            const content = responseParser.parseSceneResponse(response.choices[0].message.content);
            return new Scene({
                adventureId,
                title: content.title,
                description: content.description,
                choices: content.choices,
                metadata: {
                    type,
                    ...content.metadata,
                },
            });
        } catch (error) {
            logger.error('Failed to generate special scene', { error });
            throw error;
        }
    }

    async generateScene(params) {
        const systemPrompt = await getPromptWithGuildPersonality(this.userId, this.guildId);
        const response = await this.openai.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: this.buildScenePrompt(params) }
            ],
            model: "gpt-4o",
            temperature: 0.8,
            max_tokens: 1000
        });
        return response.choices[0].message.content;
    }
}

module.exports = SceneGenerator; 