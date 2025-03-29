/**
 * Response Parser
 * Handles parsing and validation of AI responses
 */

const logger = require('./logger');
const { v4: uuidv4 } = require('uuid');

class ResponseParser {
    constructor() {
        this.schemas = {
            scene: {
                required: ['title', 'description', 'choices'],
                optional: ['metadata', 'mood', 'difficulty'],
                defaults: {
                    metadata: {},
                    mood: 'neutral',
                    difficulty: 'normal'
                }
            },
            consequence: {
                required: ['immediate', 'longTerm', 'partyImpact'],
                optional: ['stateChanges', 'probability'],
                defaults: {
                    stateChanges: {},
                    probability: 1.0
                }
            },
            npc: {
                required: ['name', 'description', 'traits'],
                optional: ['secrets', 'motivations', 'relationships'],
                defaults: {
                    secrets: [],
                    motivations: [],
                    relationships: []
                }
            },
        };
        
        logger.debug('ResponseParser initialized with schemas', {
            sceneRequiredFields: this.schemas.scene.required,
            consequenceRequiredFields: this.schemas.consequence.required,
            npcRequiredFields: this.schemas.npc.required
        });
    }

    /**
     * Parse and validate a scene response
     * @param {string} response Raw AI response
     * @returns {Object} Parsed and validated scene
     */
    parseSceneResponse(response) {
        const parseId = uuidv4().substring(0, 8);
        logger.debug(`[${parseId}] Parsing scene response`, {
            responseLength: response?.length || 0,
            responsePreview: response?.substring(0, 100)
        });
        
        try {
            logger.debug(`[${parseId}] Attempting to parse JSON`);
            const parsed = this._parseJSON(response, parseId);
            
            logger.debug(`[${parseId}] Validating against scene schema`, {
                parsedKeys: Object.keys(parsed)
            });
            this._validateSchema(parsed, this.schemas.scene, parseId);

            // Check for choices
            if (!parsed.choices || !Array.isArray(parsed.choices)) {
                logger.warn(`[${parseId}] No choices array found in scene response, using empty array`);
                parsed.choices = [];
            } else {
                logger.debug(`[${parseId}] Found ${parsed.choices.length} choices in scene response`);
            }

            // Apply defaults and normalize
            const normalized = {
                ...this.schemas.scene.defaults,
                ...parsed,
                choices: (parsed.choices || []).map((choice, idx) => {
                    logger.debug(`[${parseId}] Normalizing choice ${idx + 1}/${parsed.choices.length}`);
                    return this._normalizeChoice(choice);
                }),
                metadata: { ...this.schemas.scene.defaults.metadata, ...parsed.metadata }
            };
            
            logger.info(`[${parseId}] Successfully parsed scene response`, {
                title: normalized.title,
                choicesCount: normalized.choices.length
            });
            
            return normalized;
        } catch (error) {
            logger.error(`[${parseId}] Failed to parse scene response`, { 
                error: {
                    message: error.message,
                    stack: error.stack
                }, 
                responsePreview: response?.substring(0, 200)
            });
            throw new Error(`Failed to parse scene: ${error.message}`);
        }
    }

    /**
     * Parse and validate a consequence response
     * @param {string} response Raw AI response
     * @returns {Object} Parsed and validated consequences
     */
    parseConsequenceResponse(response) {
        const parseId = uuidv4().substring(0, 8);
        logger.debug(`[${parseId}] Parsing consequence response`, {
            responseLength: response?.length || 0,
            responsePreview: response?.substring(0, 100)
        });
        
        try {
            logger.debug(`[${parseId}] Attempting to parse JSON`);
            const parsed = this._parseJSON(response, parseId);
            
            logger.debug(`[${parseId}] Validating against consequence schema`, {
                parsedKeys: Object.keys(parsed)
            });
            this._validateSchema(parsed, this.schemas.consequence, parseId);

            // Apply defaults and normalize
            const normalized = {
                ...this.schemas.consequence.defaults,
                ...parsed,
                immediate: this._normalizeArray(parsed.immediate),
                longTerm: this._normalizeArray(parsed.longTerm),
                partyImpact: this._normalizeArray(parsed.partyImpact),
                stateChanges: { ...this.schemas.consequence.defaults.stateChanges, ...parsed.stateChanges }
            };
            
            logger.info(`[${parseId}] Successfully parsed consequence response`, {
                immediateCount: normalized.immediate.length,
                longTermCount: normalized.longTerm.length
            });
            
            return normalized;
        } catch (error) {
            logger.error(`[${parseId}] Failed to parse consequence response`, { 
                error: {
                    message: error.message,
                    stack: error.stack
                }, 
                responsePreview: response?.substring(0, 200)
            });
            throw new Error(`Failed to parse consequence: ${error.message}`);
        }
    }

    /**
     * Parse and validate an NPC response
     * @param {string} response Raw AI response
     * @returns {Object} Parsed and validated NPC data
     */
    parseNPCResponse(response) {
        const parseId = uuidv4().substring(0, 8);
        logger.debug(`[${parseId}] Parsing NPC response`, {
            responseLength: response?.length || 0,
            responsePreview: response?.substring(0, 100)
        });
        
        try {
            logger.debug(`[${parseId}] Attempting to parse JSON`);
            const parsed = this._parseJSON(response, parseId);
            
            logger.debug(`[${parseId}] Validating against NPC schema`, {
                parsedKeys: Object.keys(parsed)
            });
            this._validateSchema(parsed, this.schemas.npc, parseId);

            // Apply defaults and normalize
            const normalized = {
                ...this.schemas.npc.defaults,
                ...parsed,
                name: parsed.name.trim(),
                description: parsed.description.trim(),
                traits: this._normalizeArray(parsed.traits),
                secrets: this._normalizeArray(parsed.secrets),
                motivations: this._normalizeArray(parsed.motivations),
                relationships: this._normalizeArray(parsed.relationships)
            };
            
            logger.info(`[${parseId}] Successfully parsed NPC response`, {
                name: normalized.name,
                traitsCount: normalized.traits.length
            });
            
            return normalized;
        } catch (error) {
            logger.error(`[${parseId}] Failed to parse NPC response`, { 
                error: {
                    message: error.message,
                    stack: error.stack
                }, 
                responsePreview: response?.substring(0, 200)
            });
            throw new Error(`Failed to parse NPC: ${error.message}`);
        }
    }

    /**
     * Parse JSON safely
     * @param {string} text Text to parse
     * @param {string} [parseId] Parse operation ID for logging
     * @returns {Object} Parsed object
     * @private
     */
    _parseJSON(text, parseId = '') {
        const id = parseId || uuidv4().substring(0, 8);
        
        if (!text || typeof text !== 'string') {
            logger.error(`[${id}] Invalid input for JSON parsing`, {
                type: typeof text,
                value: text
            });
            throw new Error('Invalid input: expected string');
        }

        try {
            // Remove markdown code blocks and trim whitespace
            logger.debug(`[${id}] Cleaning JSON text of markdown and whitespace`);
            const jsonText = text.replace(/```json\n?|\n?```/g, '').trim();
            
            logger.debug(`[${id}] Attempting to parse JSON of length ${jsonText.length}`);
            // Try to catch syntax errors before parsing
            if (!jsonText.startsWith('{') && !jsonText.startsWith('[')) {
                logger.warn(`[${id}] JSON doesn't start with { or [, may not be valid JSON`, {
                    preview: jsonText.substring(0, 50)
                });
            }
            
            const parsed = JSON.parse(jsonText);

            if (!parsed || typeof parsed !== 'object') {
                logger.error(`[${id}] Parsed result is not an object`, {
                    type: typeof parsed
                });
                throw new Error('Invalid JSON: expected object');
            }

            logger.debug(`[${id}] Successfully parsed JSON`, {
                keys: Object.keys(parsed),
                topLevelProps: Object.keys(parsed).length
            });
            
            return parsed;
        } catch (error) {
            // Enhanced error information for JSON parsing failures
            const errorInfo = {
                message: error.message,
                stack: error.stack,
                textPreview: text?.substring(0, 300) + '...' // Show more context for parsing errors
            };
            
            // Try to identify the problematic part of the JSON
            if (error instanceof SyntaxError && error.message.includes('position')) {
                const position = parseInt(error.message.match(/position (\d+)/)?.[1]);
                if (!isNaN(position)) {
                    const start = Math.max(0, position - 20);
                    const end = Math.min(text.length, position + 20);
                    errorInfo.problematicSection = text.substring(start, end);
                    errorInfo.position = position;
                    logger.error(`[${id}] JSON syntax error near position ${position}`, {
                        beforeError: text.substring(start, position),
                        afterError: text.substring(position, end)
                    });
                }
            }
            
            logger.error(`[${id}] Failed to parse JSON`, errorInfo);
            throw new Error(`Invalid JSON format: ${error.message}`);
        }
    }

    /**
     * Normalize an array or single value into an array
     * @param {*} value Value to normalize
     * @returns {Array} Normalized array
     * @private
     */
    _normalizeArray(value) {
        if (!value) return [];
        const arr = Array.isArray(value) ? value : [value];
        return arr.map(item => typeof item === 'string' ? item.trim() : item);
    }

    /**
     * Normalize a choice object
     * @param {Object} choice Choice to normalize
     * @returns {Object} Normalized choice
     * @private
     */
    _normalizeChoice(choice = {}) {
        if (!choice || typeof choice !== 'object') {
            logger.warn('Received invalid choice for normalization', { 
                type: typeof choice, 
                value: choice 
            });
            choice = {};
        }
        
        const normalized = {
            id: choice.id || this._generateId(),
            text: (choice.text || '').trim(),
            consequences: this._normalizeArray(choice.consequences),
            requirements: this._normalizeArray(choice.requirements),
            metadata: choice.metadata || {},
            probability: choice.probability || 1.0,
            difficulty: choice.difficulty || 'normal'
        };
        
        // Log warnings for missing critical fields
        if (!normalized.text) {
            logger.warn('Choice missing text field', { choiceId: normalized.id });
        }
        
        return normalized;
    }

    /**
     * Validate object against schema
     * @param {Object} obj Object to validate
     * @param {Object} schema Schema to validate against
     * @param {string} [parseId] Parse operation ID for logging
     * @private
     */
    _validateSchema(obj, schema, parseId = '') {
        const id = parseId || uuidv4().substring(0, 8);
        
        if (!obj || typeof obj !== 'object') {
            logger.error(`[${id}] Schema validation failed: not an object`, {
                type: typeof obj,
                value: obj
            });
            throw new Error('Invalid input: expected object');
        }

        // Check all required fields
        const missing = schema.required.filter(field => !obj[field]);
        if (missing.length > 0) {
            logger.error(`[${id}] Schema validation failed: missing required fields`, {
                missingFields: missing,
                availableFields: Object.keys(obj),
                required: schema.required
            });
            throw new Error(`Missing required fields: ${missing.join(', ')}`);
        }
        
        logger.debug(`[${id}] All required fields present in object`, {
            fields: schema.required
        });

        // Validate field types
        for (const field of [...schema.required, ...schema.optional]) {
            if (obj[field] !== undefined && obj[field] !== null) {
                if (Array.isArray(obj[field])) {
                    logger.debug(`[${id}] Validating array field: ${field}`, {
                        length: obj[field].length
                    });
                    
                    obj[field].forEach((item, index) => {
                        if (typeof item !== 'string' && typeof item !== 'object') {
                            logger.error(`[${id}] Invalid type in array`, {
                                field,
                                index,
                                expectedType: 'string or object',
                                actualType: typeof item
                            });
                            throw new Error(`Invalid type for ${field}[${index}]: expected string or object`);
                        }
                    });
                } else if (typeof obj[field] !== 'string' && typeof obj[field] !== 'object') {
                    logger.error(`[${id}] Invalid field type`, {
                        field,
                        expectedType: 'string or object',
                        actualType: typeof obj[field]
                    });
                    throw new Error(`Invalid type for ${field}: expected string or object`);
                }
            }
        }
        
        logger.debug(`[${id}] Schema validation successful`, {
            schemaType: Object.keys(schema.required).length > 0 ? schema.required[0] : 'unknown'
        });
    }

    /**
     * Generate a unique ID
     * @returns {string} Generated ID
     * @private
     */
    _generateId() {
        return uuidv4();
    }
}

module.exports = new ResponseParser(); 