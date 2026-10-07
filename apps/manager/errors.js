/**
 * The one error type the manager's HTTP layer turns into a response body.
 * `message` is written for the operator and must never contain a secret,
 * a credential, a path or a file's contents.
 */

class ManagerError extends Error {
    /**
     * @param {number} status HTTP status
     * @param {string} code   stable machine code
     * @param {string} message
     * @param {Object} [details] small structured, non-secret detail
     */
    constructor(status, code, message, details = null) {
        super(message);
        this.name = 'ManagerError';
        this.status = status;
        this.code = code;
        this.details = details;
    }

    toJSON() {
        return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
    }
}

module.exports = { ManagerError };
