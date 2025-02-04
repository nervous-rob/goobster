/**
 * Adventure Validator
 * Validates adventure-related inputs
 */

const logger = require('../utils/logger');

class AdventureValidator {
    constructor() {
        this.validDifficulties = ['easy', 'normal', 'hard', 'expert'];
        this.validStatuses = ['failed', 'completed', 'active', 'initialized'];
    }

    validateInitialization({ createdBy, theme, difficulty, settings = {} }) {
        const errors = [];

        if (!createdBy) {
            errors.push('createdBy is required');
        }

        if (difficulty && !this.validDifficulties.includes(difficulty)) {
            errors.push(`difficulty must be one of: ${this.validDifficulties.join(', ')}`);
        }

        if (settings.maxPartySize && (settings.maxPartySize < 1 || settings.maxPartySize > 10)) {
            errors.push('maxPartySize must be between 1 and 10');
        }

        if (errors.length > 0) {
            logger.warn('Adventure initialization validation failed', { errors });
            throw new Error(`Validation failed: ${errors.join(', ')}`);
        }

        return true;
    }

    validateDecision({ adventureId, userId, decision }) {
        const errors = [];

        if (!adventureId) errors.push('adventureId is required');
        if (!userId) errors.push('userId is required');
        if (!decision) errors.push('decision is required');

        if (errors.length > 0) {
            logger.warn('Decision validation failed', { errors });
            throw new Error(`Validation failed: ${errors.join(', ')}`);
        }

        return true;
    }

    validateSpecialScene({ adventureId, type, context = {} }) {
        const errors = [];
        const validTypes = ['combat', 'puzzle', 'dialogue'];

        if (!adventureId) errors.push('adventureId is required');
        if (!type) errors.push('type is required');
        if (!validTypes.includes(type)) {
            errors.push(`type must be one of: ${validTypes.join(', ')}`);
        }

        if (errors.length > 0) {
            logger.warn('Special scene validation failed', { errors });
            throw new Error(`Validation failed: ${errors.join(', ')}`);
        }

        return true;
    }
}

module.exports = AdventureValidator; 