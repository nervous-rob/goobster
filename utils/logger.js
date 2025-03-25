const winston = require('winston');

// Define log levels
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

// Define log colors
const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    debug: 'blue',
};

// Create the logger instance
const logger = winston.createLogger({
    levels,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            ),
        }),
        // Add file transport for production
        ...(process.env.NODE_ENV === 'production' ? [
            new winston.transports.File({
                filename: 'logs/error.log',
                level: 'error',
            }),
            new winston.transports.File({
                filename: 'logs/combined.log',
            }),
        ] : []),
    ],
});

/**
 * Creates a logger instance with a specific context
 * @param {string} context - The context for the logger (e.g., 'SearchCommand', 'ChatHandler')
 * @returns {Object} A logger instance with the specified context
 */
function createLogger(context) {
    return {
        error: (message, ...args) => logger.error(`[${context}] ${message}`, ...args),
        warn: (message, ...args) => logger.warn(`[${context}] ${message}`, ...args),
        info: (message, ...args) => logger.info(`[${context}] ${message}`, ...args),
        debug: (message, ...args) => logger.debug(`[${context}] ${message}`, ...args),
    };
}

module.exports = {
    createLogger,
    logger
}; 