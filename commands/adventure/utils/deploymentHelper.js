/**
 * Deployment Helper Utility
 * Helps to conditionally load modules based on whether we're in deployment mode
 */

// Check if we're in deployment mode (running deploy-commands.js)
const isDeployment = process.argv[1].includes('deploy-commands.js');

// Mock logger for deployment mode
const mockLogger = {
    error: console.error,
    info: console.info,
    debug: console.debug,
    warn: console.warn
};

/**
 * Get the adventure service instance
 * @returns {Object|null} Adventure service or null if in deployment mode
 */
function getAdventureService() {
    if (isDeployment) {
        return null;
    }
    
    const AdventureService = require('../../../services/adventure');
    return new AdventureService();
}

/**
 * Get logger instance
 * @returns {Object} Logger instance or mock logger if in deployment mode
 */
function getLogger() {
    if (isDeployment) {
        return mockLogger;
    }
    
    return require('../../../services/adventure/utils/logger');
}

module.exports = {
    isDeployment,
    getAdventureService,
    getLogger
}; 