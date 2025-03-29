/**
 * Prompt Builder
 * Constructs consistent prompts for AI interactions
 */

const logger = require('./logger');

class PromptBuilder {
    constructor() {
        this.templates = {
            scene: {
                base: `Create a detailed scene in JSON format with the following structure:
{
    "title": "Scene title",
    "description": "Vivid scene description",
    "choices": [
        {
            "text": "Choice description",
            "consequences": ["potential", "consequences"],
            "requirements": [],
            "metadata": {}
        }
    ],
    "metadata": {
        "mood": "scene mood",
        "difficulty": "scene difficulty"
    }
}

Theme: {theme}
Difficulty: {difficulty}
Previous Context: {context}

Requirements:
1. Return ONLY valid JSON
2. Include {minChoices}-{maxChoices} meaningful choices
3. Provide rich environmental details in description
4. Each choice should have clear consequences`,
                combat: `Create an intense combat scene in JSON format:
{
    "title": "Combat scene title",
    "description": "Vivid combat description",
    "choices": [
        {
            "text": "Tactical option description",
            "consequences": ["potential", "outcomes"],
            "requirements": [],
            "metadata": {"type": "combat"}
        }
    ],
    "metadata": {
        "type": "combat",
        "difficulty": "combat difficulty"
    }
}

Context: {context}
Participants: {participants}
Environment: {environment}

Requirements:
1. Return ONLY valid JSON
2. Include tactical options as choices
3. Consider environmental factors
4. Balance risk/reward in choices`,
                puzzle: `Design an engaging puzzle in JSON format:
{
    "title": "Puzzle title",
    "description": "Clear puzzle description",
    "choices": [
        {
            "text": "Solution attempt description",
            "consequences": ["outcome", "if", "chosen"],
            "requirements": [],
            "metadata": {"type": "puzzle"}
        }
    ],
    "metadata": {
        "type": "puzzle",
        "difficulty": "puzzle difficulty"
    }
}

Type: {puzzleType}
Difficulty: {difficulty}
Context: {context}

Requirements:
1. Return ONLY valid JSON
2. Include multiple solution paths as choices
3. Embed hints in the description
4. Define clear success/failure conditions`,
            },
            character: {
                npc: `Create an NPC with:
                    Role: {role}
                    Context: {context}
                    Personality: {personality}
                    
                    Include:
                    1. Distinct traits
                    2. Motivations
                    3. Potential interactions
                    4. Secrets or hidden aspects`,
            },
            consequence: {
                base: `Generate consequences for:
                    Action: {action}
                    Context: {context}
                    Party Size: {partySize}
                    Previous Choices: {history}
                    
                    Include:
                    1. Immediate effects
                    2. Long-term implications
                    3. Party impact
                    4. World state changes`,
            },
            image: {
                scene: `Create a highly detailed fantasy scene:

{description}

Art Style:
- High-quality digital art
- {style} artistic style
- Photorealistic textures and materials
- Rich color palette
- Cinematic quality

Mood and Atmosphere:
- {mood} atmosphere
- {lighting} lighting effects
- Volumetric lighting and shadows
- Environmental particles and effects
- Weather and time of day elements

Composition:
- {composition} composition
- Interesting focal points
- Depth and perspective
- Rule of thirds
- Leading lines and visual flow

Technical Requirements:
- 1024x1024 resolution
- Sharp details and clarity
- Professional quality rendering
- Balanced contrast and saturation
- Cohesive color scheme

Do not include: text, watermarks, signatures, frames, or borders.`,
                location: `Create a highly detailed fantasy location:

{location}

Art Style:
- High-quality digital art
- {style} artistic style
- Photorealistic textures and materials
- Rich color palette
- Cinematic quality

Mood and Atmosphere:
- {mood} atmosphere
- {lighting} lighting effects
- Volumetric lighting and shadows
- Environmental particles and effects
- Weather and time of day elements

Composition:
- {composition} composition
- Wide establishing shot
- Depth and perspective
- Rule of thirds
- Leading lines and visual flow

Technical Requirements:
- 1024x1024 resolution
- Sharp details and clarity
- Professional quality rendering
- Balanced contrast and saturation
- Cohesive color scheme

Do not include: text, watermarks, signatures, frames, or borders.`,
                character: `Create a highly detailed fantasy character portrait:

{character}

Art Style:
- High-quality digital art
- {style} artistic style
- Photorealistic textures and materials
- Rich color palette
- Cinematic quality

Character Details:
- Clear facial features
- Detailed clothing and equipment
- Proper anatomy and proportions
- Expressive pose and gesture
- Character-appropriate lighting

Composition:
- {composition} composition
- Upper body or full body shot
- Interesting pose and angle
- Professional portrait style
- Clean background with depth

Technical Requirements:
- 1024x1024 resolution
- Sharp details and clarity
- Professional quality rendering
- Balanced contrast and saturation
- Cohesive color scheme

Do not include: text, watermarks, signatures, frames, or borders.`
            }
        };
    }

    /**
     * Build a scene prompt
     * @param {Object} options Scene options
     * @returns {string} Formatted prompt
     */
    buildScenePrompt(options) {
        const promptId = Math.random().toString(36).substring(2, 10);
        logger.debug(`[${promptId}] Building scene prompt`, { 
            type: options.type || 'base',
            availableOptions: Object.keys(options)
        });
        
        try {
            const template = options.type ? 
                this.templates.scene[options.type] : 
                this.templates.scene.base;
                
            if (!template) {
                logger.error(`[${promptId}] Unknown scene template type: ${options.type}`);
                throw new Error(`Unknown scene template type: ${options.type}`);
            }
            
            logger.debug(`[${promptId}] Selected template`, { 
                type: options.type || 'base', 
                templateLength: template.length,
                templatePreview: template.substring(0, 100) + '...'
            });

            const result = this._fillTemplate(template, options, promptId);
            
            logger.debug(`[${promptId}] Scene prompt built successfully`, {
                resultLength: result.length
            });
            
            return result;
        } catch (error) {
            logger.error(`[${promptId}] Failed to build scene prompt`, { 
                error: {
                    message: error.message,
                    stack: error.stack
                },
                options: {
                    type: options.type,
                    theme: options.theme,
                    difficulty: options.difficulty
                }
            });
            throw error;
        }
    }

    /**
     * Build a consequence prompt
     * @param {Object} options Consequence options
     * @returns {string} Formatted prompt
     */
    buildConsequencePrompt(options) {
        const promptId = Math.random().toString(36).substring(2, 10);
        logger.debug(`[${promptId}] Building consequence prompt`, { 
            availableOptions: Object.keys(options)
        });
        
        try {
            const template = this.templates.consequence.base;
            
            logger.debug(`[${promptId}] Using consequence template`, {
                templateLength: template.length,
                templatePreview: template.substring(0, 100) + '...'
            });
            
            const result = this._fillTemplate(template, options, promptId);
            
            logger.debug(`[${promptId}] Consequence prompt built successfully`, {
                resultLength: result.length
            });
            
            return result;
        } catch (error) {
            logger.error(`[${promptId}] Failed to build consequence prompt`, { 
                error: {
                    message: error.message,
                    stack: error.stack
                },
                options: {
                    action: options.action,
                    context: options.context
                }
            });
            throw error;
        }
    }

    /**
     * Build an NPC prompt
     * @param {Object} options NPC options
     * @returns {string} Formatted prompt
     */
    buildNPCPrompt(options) {
        const promptId = Math.random().toString(36).substring(2, 10);
        logger.debug(`[${promptId}] Building NPC prompt`, { 
            availableOptions: Object.keys(options)
        });
        
        try {
            const template = this.templates.character.npc;
            
            logger.debug(`[${promptId}] Using NPC template`, {
                templateLength: template.length,
                templatePreview: template.substring(0, 100) + '...'
            });
            
            const result = this._fillTemplate(template, options, promptId);
            
            logger.debug(`[${promptId}] NPC prompt built successfully`, {
                resultLength: result.length
            });
            
            return result;
        } catch (error) {
            logger.error(`[${promptId}] Failed to build NPC prompt`, { 
                error: {
                    message: error.message,
                    stack: error.stack
                },
                options: {
                    role: options.role,
                    personality: options.personality
                }
            });
            throw error;
        }
    }

    /**
     * Build an image prompt
     * @param {Object} options Image generation options
     * @returns {string} Formatted prompt
     */
    buildImagePrompt(options) {
        const promptId = Math.random().toString(36).substring(2, 10);
        logger.debug(`[${promptId}] Building image prompt`, { 
            type: options.type,
            availableOptions: Object.keys(options)
        });
        
        try {
            const { type, description, location, character, style = 'fantasy', mood = 'mysterious', lighting = 'dramatic', composition = 'dynamic' } = options;
            
            if (!type || !this.templates.image[type]) {
                logger.error(`[${promptId}] Invalid image type: ${type}`, {
                    availableTypes: Object.keys(this.templates.image)
                });
                throw new Error(`Invalid image type: ${type}`);
            }

            const template = this.templates.image[type];
            
            logger.debug(`[${promptId}] Using image template for type: ${type}`, {
                templateLength: template.length,
                templatePreview: template.substring(0, 100) + '...'
            });
            
            const templateValues = {
                description,
                location: typeof location === 'string' ? location : location?.name || '',
                character: typeof character === 'string' ? character : JSON.stringify(character || {}),
                style,
                mood,
                lighting,
                composition
            };
            
            logger.debug(`[${promptId}] Image template values`, {
                values: {
                    descriptionLength: description?.length,
                    location: templateValues.location,
                    style, mood, lighting, composition
                }
            });
            
            const result = this._fillTemplate(template, templateValues, promptId);
            
            logger.debug(`[${promptId}] Image prompt built successfully`, {
                resultLength: result.length,
                type
            });
            
            return result;
        } catch (error) {
            logger.error(`[${promptId}] Failed to build image prompt`, { 
                error: {
                    message: error.message,
                    stack: error.stack
                },
                options: {
                    type: options.type,
                    descriptionLength: options.description?.length
                }
            });
            throw error;
        }
    }

    /**
     * Fill template with values
     * @param {string} template Template string
     * @param {Object} values Values to insert
     * @param {string} [logId] Optional ID for logging
     * @returns {string} Filled template
     * @private
     */
    _fillTemplate(template, values, logId = '') {
        const templateId = logId || Math.random().toString(36).substring(2, 10);
        
        // Log template placeholders found
        const placeholders = [];
        template.replace(/{(\w+)}/g, (match, key) => {
            placeholders.push(key);
            return match;
        });
        
        logger.debug(`[${templateId}] Template placeholders found: ${placeholders.length}`, {
            placeholders,
            availableValues: Object.keys(values)
        });
        
        // Count missing values
        const missingValues = placeholders.filter(key => 
            values[key] === undefined || values[key] === null
        );
        
        if (missingValues.length > 0) {
            logger.warn(`[${templateId}] ${missingValues.length} template keys have no values`, {
                missingKeys: missingValues,
                availableKeys: Object.keys(values)
            });
        }
        
        // Replace placeholders
        const result = template.replace(
            /{(\w+)}/g,
            (match, key) => {
                const value = values[key];
                if (value === undefined || value === null) {
                    logger.warn(`[${templateId}] Template key "${key}" has no value`, { 
                        availableKeys: Object.keys(values),
                        template: template.substring(0, 100) + '...'
                    });
                    // Use default values for common fields
                    const defaults = {
                        theme: 'fantasy',
                        difficulty: 'normal',
                        context: 'new adventure',
                        minChoices: 2,
                        maxChoices: 4,
                        style: 'fantasy',
                        mood: 'mysterious',
                        lighting: 'dramatic',
                        composition: 'balanced'
                    };
                    const defaultValue = defaults[key] || `[${key}]`;
                    logger.debug(`[${templateId}] Using default value for "${key}": ${defaultValue}`);
                    return defaultValue;
                }
                return value;
            }
        );
        
        logger.debug(`[${templateId}] Template filled successfully`, {
            originalLength: template.length,
            resultLength: result.length
        });
        
        return result;
    }
}

module.exports = new PromptBuilder(); 