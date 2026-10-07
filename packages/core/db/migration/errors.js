/**
 * The migration modules' one error type. `code` is a short stable
 * identifier (no row content, no connection detail); `details` carries only
 * names, counts and booleans.
 */

class MigrationError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'MigrationError';
        this.code = code;
        this.details = details;
    }
}

module.exports = { MigrationError };
