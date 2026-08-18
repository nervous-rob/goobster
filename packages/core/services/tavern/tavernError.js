/**
 * Errors the Tavern can show to players directly: `message` is already
 * presentable copy; `code` is machine-readable for tests and callers.
 */
class TavernError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'TavernError';
        this.code = code;
    }
}

module.exports = { TavernError };
