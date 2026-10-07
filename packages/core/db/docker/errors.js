/**
 * The Docker modules' one error type. `code` is a short stable identifier;
 * `details` carries names, counts and booleans only - never a password, a URL
 * or an environment value (documentation/docker_postgres.md).
 */

class DockerError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DockerError';
        this.code = code;
        this.details = details;
    }
}

module.exports = { DockerError };
