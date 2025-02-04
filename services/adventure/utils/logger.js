/**
 * Adventure Service Logger
 * Centralized logging utility for the adventure service
 */

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
                filename: 'logs/adventure-error.log',
                level: 'error',
            }),
            new winston.transports.File({
                filename: 'logs/adventure-combined.log',
            }),
        ] : []),
    ],
});

// Add colors to Winston
winston.addColors(colors);

module.exports = logger; 