/**
 * Adventure Generator
 * Handles the generation of new adventures and their initial content
 */

require('dotenv').config();
const OpenAI = require('openai');
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
        try {
            // Validate inputs
            this.adventureValidator.validateInitialization({ createdBy, theme, difficulty, settings });

            logger.info('Generating new adventure', { createdBy, theme, difficulty });

            // Merge settings with defaults and ensure required fields
            const finalSettings = {
                ...this.defaultSettings,
                ...settings,
                difficulty: difficulty || this.defaultSettings.difficulty,
                theme: theme || 'fantasy', // Ensure theme is never null
            };

            // Generate adventure content using OpenAI
            const content = await this._generateAdventureContent({ theme, difficulty: finalSettings.difficulty });

            // Create new adventure instance with required fields
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

            // Generate and set initial scene
            const initialScene = await this._generateInitialScene(adventure.id, content.initialScenePrompt);
            adventure.updateScene(initialScene);

            logger.info('Successfully generated adventure', { 
                adventureId: adventure.id,
                title: adventure.title,
                status: adventure.status // Log the status
            });

            return adventure;
        } catch (error) {
            logger.error('Failed to generate adventure', { error });
            throw error;
        }
    }

    /**
     * Generate the initial content for an adventure using OpenAI
     * @param {Object} options Content generation options
     * @returns {Promise<Object>} Generated content
     * @private
     */
    async _generateAdventureContent({ theme, difficulty }) {
        const prompt = promptBuilder.buildScenePrompt({
            type: 'base',
            theme: theme || 'Create an interesting theme',
            difficulty,
            minChoices: 2,
            maxChoices: 4,
            context: 'This is the beginning of a new adventure. Include a concise setting description and plot summary.',
        });

        const response = await this.openai.chat.completions.create({
            model: this.defaultSettings.aiModel,
            messages: [{
                role: 'system',
                content: 'You are a creative adventure game designer. Create engaging and imaginative content with rich, detailed settings and compelling plot summaries. Keep descriptions concise but meaningful.',
            }, {
                role: 'user',
                content: prompt,
            }],
            temperature: 0.8,
            max_tokens: 1000, // Limit response size
        });

        try {
            const parsedContent = responseParser.parseSceneResponse(response.choices[0].message.content);
            
            // Ensure all required fields have values but keep them concise
            if (!parsedContent.setting) {
                parsedContent.setting = {
                    location: parsedContent.description.split('.')[0],
                    environment: parsedContent.description.split('.').slice(0, 2).join('.'),
                    atmosphere: theme || 'mysterious'
                };
            }

            if (!parsedContent.plotSummary) {
                parsedContent.plotSummary = {
                    mainObjective: `Complete ${parsedContent.title}`,
                    challenges: ['Face challenges', 'Navigate terrain', 'Uncover secrets'],
                    expectedOutcome: 'Victory or defeat',
                    difficulty: difficulty
                };
            }

            if (!parsedContent.plotPoints) {
                parsedContent.plotPoints = {
                    majorEvents: ['Start', 'Challenge', 'Discovery', 'Climax', 'Resolution'],
                    keyCharacters: ['Leader', 'Ally', 'Enemy', 'Guide', 'Support'],
                    storyArcs: ['Main quest', 'Growth', 'Side quest', 'Tension', 'End']
                };
            }

            if (!parsedContent.keyElements) {
                parsedContent.keyElements = {
                    items: ['Equipment', 'Resources', 'Tools', 'Artifacts', 'Supplies'],
                    locations: ['Start', 'Waypoints', 'Danger zones', 'Safe areas', 'Goal'],
                    characters: ['Allies', 'Contacts', 'Enemies', 'Neutrals', 'Quest givers'],
                    objectives: ['Primary', 'Secondary', 'Optional', 'Hidden', 'Bonus'],
                    secrets: ['Info', 'Paths', 'Dangers', 'Intel', 'Mysteries']
                };
            }

            if (!parsedContent.winCondition) {
                parsedContent.winCondition = {
                    type: 'completion',
                    requirements: ['Complete objective', 'Survive', 'Gather intel', 'Reach goal'],
                    rewards: ['Completion', 'Experience', 'Resources', 'Knowledge'],
                    failureConditions: ['Death', 'Failure', 'Time out', 'Loss'],
                    timeLimit: null
                };
            }

            // Pre-stringify all objects to avoid multiple conversions
            ['plotSummary', 'setting', 'plotPoints', 'keyElements', 'winCondition'].forEach(field => {
                if (typeof parsedContent[field] === 'object') {
                    parsedContent[field] = JSON.stringify(parsedContent[field]);
                }
            });

            return parsedContent;
        } catch (error) {
            logger.error('Failed to parse adventure content response', { error });
            throw new Error('Invalid adventure content format');
        }
    }

    /**
     * Generate the initial scene for an adventure
     * @param {string} adventureId Adventure ID
     * @param {string} scenePrompt Initial scene prompt
     * @returns {Promise<Scene>} Generated scene
     * @private
     */
    async _generateInitialScene(adventureId, scenePrompt) {
        const prompt = promptBuilder.buildScenePrompt({
            type: 'base',
            context: scenePrompt,
            minChoices: 2,
            maxChoices: 4,
        });

        const response = await this.openai.chat.completions.create({
            model: this.defaultSettings.aiModel,
            messages: [{
                role: 'system',
                content: 'You are a creative scene designer specializing in generating structured game content. Always return your responses in valid JSON format following the exact schema provided in the prompt. Never include narrative text or markdown outside the JSON structure.',
            }, {
                role: 'user',
                content: prompt,
            }],
            temperature: 0.8,
        });

        try {
            const content = responseParser.parseSceneResponse(response.choices[0].message.content);
            return new Scene({
                adventureId,
                title: content.title,
                description: content.description,
                choices: content.choices,
                metadata: content.metadata || {},
            });
        } catch (error) {
            logger.error('Failed to parse initial scene response', { error });
            throw new Error('Invalid scene content format');
        }
    }

    async generateAdventure(params) {
        const systemPrompt = await getPromptWithGuildPersonality(this.userId, this.guildId);
        const response = await this.openai.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: this.buildAdventurePrompt(params) }
            ],
            model: "gpt-4o",
            temperature: 0.8,
            max_tokens: 1000
        });
        return response.choices[0].message.content;
    }
}

module.exports = AdventureGenerator; 