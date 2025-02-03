/**
 * Party Validator
 * Validates party-related inputs
 */

const logger = require('../utils/logger');

class PartyValidator {
    constructor() {
        this.validRoles = ['leader', 'member', 'guest'];
        this.validStatuses = ['active', 'disbanded', 'full'];
    }

    validatePartyCreation({ adventureId, leaderId, settings = {} }) {
        const errors = [];

        if (!adventureId) errors.push('adventureId is required');
        if (!leaderId) errors.push('leaderId is required');

        if (settings.maxSize && (settings.maxSize < 1 || settings.maxSize > 10)) {
            errors.push('maxSize must be between 1 and 10');
        }

        if (errors.length > 0) {
            logger.warn('Party creation validation failed', { errors });
            throw new Error(`Validation failed: ${errors.join(', ')}`);
        }

        return true;
    }

    validateMemberOperation({ partyId, userId, role }) {
        const errors = [];

        if (!partyId) errors.push('partyId is required');
        if (!userId) errors.push('userId is required');
        if (role && !this.validRoles.includes(role)) {
            errors.push(`role must be one of: ${this.validRoles.join(', ')}`);
        }

        if (errors.length > 0) {
            logger.warn('Member operation validation failed', { errors });
            throw new Error(`Validation failed: ${errors.join(', ')}`);
        }

        return true;
    }

    validatePartySettings({ partyId, settings = {} }) {
        const errors = [];

        if (!partyId) errors.push('partyId is required');
        if (settings.maxSize && (settings.maxSize < 1 || settings.maxSize > 10)) {
            errors.push('maxSize must be between 1 and 10');
        }

        if (errors.length > 0) {
            logger.warn('Party settings validation failed', { errors });
            throw new Error(`Validation failed: ${errors.join(', ')}`);
        }

        return true;
    }
}

module.exports = PartyValidator; 