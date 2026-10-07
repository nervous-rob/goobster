/**
 * The connection modules' one error type (documentation/database_connection.md).
 * `code` is a short stable identifier; `details` carries names, counts and
 * booleans only - never a password, a URL or a row.
 */

class ConnectionError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ConnectionError';
        this.code = code;
        this.details = details;
    }
}

module.exports = { ConnectionError };
