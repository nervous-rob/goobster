/**
 * Response Parser
 * Handles parsing and validation of AI responses
 */

const logger = require('./logger');

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
    }

    /**
     * Parse and validate a scene response
     * @param {string} response Raw AI response
     * @returns {Object} Parsed and validated scene
     */
    parseSceneResponse(response) {
        try {
            const parsed = this._parseJSON(response);
            this._validateSchema(parsed, this.schemas.scene);

            // Apply defaults and normalize
            return {
                ...this.schemas.scene.defaults,
                ...parsed,
                choices: (parsed.choices || []).map(choice => this._normalizeChoice(choice)),
                metadata: { ...this.schemas.scene.defaults.metadata, ...parsed.metadata }
            };
        } catch (error) {
            logger.error('Failed to parse scene response', { error, response });
            throw new Error(`Failed to parse scene: ${error.message}`);
        }
    }

    /**
     * Parse and validate a consequence response
     * @param {string} response Raw AI response
     * @returns {Object} Parsed and validated consequences
     */
    parseConsequenceResponse(response) {
        try {
            const parsed = this._parseJSON(response);
            this._validateSchema(parsed, this.schemas.consequence);

            // Apply defaults and normalize
            return {
                ...this.schemas.consequence.defaults,
                ...parsed,
                immediate: this._normalizeArray(parsed.immediate),
                longTerm: this._normalizeArray(parsed.longTerm),
                partyImpact: this._normalizeArray(parsed.partyImpact),
                stateChanges: { ...this.schemas.consequence.defaults.stateChanges, ...parsed.stateChanges }
            };
        } catch (error) {
            logger.error('Failed to parse consequence response', { error, response });
            throw new Error(`Failed to parse consequence: ${error.message}`);
        }
    }

    /**
     * Parse and validate an NPC response
     * @param {string} response Raw AI response
     * @returns {Object} Parsed and validated NPC data
     */
    parseNPCResponse(response) {
        try {
            const parsed = this._parseJSON(response);
            this._validateSchema(parsed, this.schemas.npc);

            // Apply defaults and normalize
            return {
                ...this.schemas.npc.defaults,
                ...parsed,
                name: parsed.name.trim(),
                description: parsed.description.trim(),
                traits: this._normalizeArray(parsed.traits),
                secrets: this._normalizeArray(parsed.secrets),
                motivations: this._normalizeArray(parsed.motivations),
                relationships: this._normalizeArray(parsed.relationships)
            };
        } catch (error) {
            logger.error('Failed to parse NPC response', { error, response });
            throw new Error(`Failed to parse NPC: ${error.message}`);
        }
    }

    /**
     * Parse JSON safely
     * @param {string} text Text to parse
     * @returns {Object} Parsed object
     * @private
     */
    _parseJSON(text) {
        if (!text || typeof text !== 'string') {
            throw new Error('Invalid input: expected string');
        }

        try {
            // Remove markdown code blocks and trim whitespace
            const jsonText = text.replace(/```json\n?|\n?```/g, '').trim();
            const parsed = JSON.parse(jsonText);

            if (!parsed || typeof parsed !== 'object') {
                throw new Error('Invalid JSON: expected object');
            }

            return parsed;
        } catch (error) {
            logger.error('Failed to parse JSON', { text, error });
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
        return {
            id: choice.id || this._generateId(),
            text: (choice.text || '').trim(),
            consequences: this._normalizeArray(choice.consequences),
            requirements: this._normalizeArray(choice.requirements),
            metadata: choice.metadata || {},
            probability: choice.probability || 1.0,
            difficulty: choice.difficulty || 'normal'
        };
    }

    /**
     * Validate object against schema
     * @param {Object} obj Object to validate
     * @param {Object} schema Schema to validate against
     * @private
     */
    _validateSchema(obj, schema) {
        if (!obj || typeof obj !== 'object') {
            throw new Error('Invalid input: expected object');
        }

        const missing = schema.required.filter(field => !obj[field]);
        if (missing.length > 0) {
            throw new Error(`Missing required fields: ${missing.join(', ')}`);
        }

        // Validate field types
        for (const field of [...schema.required, ...schema.optional]) {
            if (obj[field] !== undefined && obj[field] !== null) {
                if (Array.isArray(obj[field])) {
                    obj[field].forEach((item, index) => {
                        if (typeof item !== 'string' && typeof item !== 'object') {
                            throw new Error(`Invalid type for ${field}[${index}]: expected string or object`);
                        }
                    });
                } else if (typeof obj[field] !== 'string' && typeof obj[field] !== 'object') {
                    throw new Error(`Invalid type for ${field}: expected string or object`);
                }
            }
        }
    }

    /**
     * Generate a simple ID
     * @returns {string} Generated ID
     * @private
     */
    _generateId() {
        return Math.random().toString(36).substr(2, 9);
    }
}

module.exports = new ResponseParser(); 