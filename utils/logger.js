/**
 * Shared application logger.
 *
 * Winston-based with console output and rotating log files under logs/.
 * File logging matters on a Raspberry Pi where stdout is lost across
 * restarts; rotation caps disk usage (3 x 5MB per file).
 *
 * Debug output is enabled with --debug or LOG_LEVEL=debug.
 */

const path = require('node:path');
const winston = require('winston');

const DEBUG_MODE = process.argv.includes('--debug') || process.env.LOG_LEVEL === 'debug';
const LOG_DIR = process.env.GOOBSTER_LOG_DIR || path.join(__dirname, '..', 'logs');

const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const rest = Object.keys(meta).filter(k => k !== 'stack').length
            ? ` ${JSON.stringify(Object.fromEntries(Object.entries(meta).filter(([k]) => k !== 'stack')))}`
            : '';
        const stack = meta.stack ? `\n${meta.stack}` : '';
        return `${timestamp} [${level}] ${message}${rest}${stack}`;
    })
);

const logger = winston.createLogger({
    level: DEBUG_MODE ? 'debug' : 'info',
    transports: [
        new winston.transports.Console({ format: consoleFormat }),
        new winston.transports.File({
            dirname: LOG_DIR,
            filename: 'goobster.log',
            format: fileFormat,
            maxsize: 5 * 1024 * 1024,
            maxFiles: 3,
            tailable: true
        }),
        new winston.transports.File({
            dirname: LOG_DIR,
            filename: 'goobster-error.log',
            level: 'error',
            format: fileFormat,
            maxsize: 5 * 1024 * 1024,
            maxFiles: 3,
            tailable: true
        })
    ]
});

// Compatibility helper matching the previous ad-hoc logger's `log` method.
logger.log = ((original) => function (...args) {
    if (typeof args[0] === 'string' && args.length >= 1 && !['error', 'warn', 'info', 'debug'].includes(args[0])) {
        return logger.info(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    }
    return original.apply(logger, args);
})(logger.log);

module.exports = logger;
