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
            },
            consequence: {
                required: ['immediate', 'longTerm', 'partyImpact'],
                optional: ['stateChanges', 'probability'],
            },
            npc: {
                required: ['name', 'description', 'traits'],
                optional: ['secrets', 'motivations', 'relationships'],
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

            // Ensure each choice has required fields
            parsed.choices = parsed.choices.map(choice => ({
                id: choice.id || this._generateId(),
                text: choice.text,
                consequences: choice.consequences || [],
                requirements: choice.requirements || [],
                metadata: choice.metadata || {},
            }));

            return parsed;
        } catch (error) {
            logger.error('Failed to parse scene response', { error });
            throw error;
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

            // Ensure arrays for consequences
            parsed.immediate = Array.isArray(parsed.immediate) ? parsed.immediate : [parsed.immediate];
            parsed.longTerm = Array.isArray(parsed.longTerm) ? parsed.longTerm : [parsed.longTerm];

            return parsed;
        } catch (error) {
            logger.error('Failed to parse consequence response', { error });
            throw error;
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

            // Ensure arrays for traits and relationships
            parsed.traits = Array.isArray(parsed.traits) ? parsed.traits : [parsed.traits];
            if (parsed.relationships) {
                parsed.relationships = Array.isArray(parsed.relationships) ? 
                    parsed.relationships : [parsed.relationships];
            }

            return parsed;
        } catch (error) {
            logger.error('Failed to parse NPC response', { error });
            throw error;
        }
    }

    /**
     * Parse JSON safely
     * @param {string} text Text to parse
     * @returns {Object} Parsed object
     * @private
     */
    _parseJSON(text) {
        try {
            // Handle potential markdown code blocks
            const jsonText = text.replace(/```json\n?|\n?```/g, '');
            return JSON.parse(jsonText);
        } catch (error) {
            logger.error('Failed to parse JSON', { text });
            throw new Error('Invalid JSON format');
        }
    }

    /**
     * Validate object against schema
     * @param {Object} obj Object to validate
     * @param {Object} schema Schema to validate against
     * @private
     */
    _validateSchema(obj, schema) {
        const missing = schema.required.filter(field => !obj[field]);
        if (missing.length > 0) {
            throw new Error(`Missing required fields: ${missing.join(', ')}`);
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