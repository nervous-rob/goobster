/**
 * The native Postgres modules' one error type. `code` is a short stable
 * identifier; `details` carries names, counts and booleans only - never a
 * password, a URL or an environment value (documentation/native_postgres.md).
 */

class NativeError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'NativeError';
        this.code = code;
        this.details = details;
    }
}

module.exports = { NativeError };
