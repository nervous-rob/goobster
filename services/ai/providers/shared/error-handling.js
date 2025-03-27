/**
 * @typedef {Object} APIError
 * @property {number} status - HTTP status code
 * @property {string} message - Error message
 * @property {Object} [data] - Additional error data
 */

/**
 * Creates a standardized API error object
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 * @param {Object} [data] - Additional error data
 * @returns {APIError}
 */
function createAPIError(status, message, data = {}) {
    return {
        status,
        message,
        data
    };
}

/**
 * Handles common API errors and returns appropriate error messages
 * @param {Error} error - The error object
 * @param {string} provider - Provider name for error context
 * @param {string} operation - Operation being performed
 * @returns {APIError}
 */
function handleAPIError(error, provider, operation) {
    // Handle network errors
    if (error.code === 'ECONNABORTED') {
        return createAPIError(408, `${provider} request timed out during ${operation}`);
    }
    if (error.code === 'ECONNREFUSED') {
        return createAPIError(503, `${provider} service is unavailable`);
    }

    // Handle HTTP errors
    if (error.response) {
        const status = error.response.status;
        const data = error.response.data;

        switch (status) {
            case 400:
                return createAPIError(status, `Invalid request to ${provider}: ${data.error?.message || 'Unknown error'}`, data);
            case 401:
                return createAPIError(status, `Invalid ${provider} API key`);
            case 403:
                return createAPIError(status, `Access denied to ${provider} API`);
            case 404:
                return createAPIError(status, `${provider} resource not found`);
            case 429:
                return createAPIError(status, `${provider} rate limit exceeded`);
            case 500:
                return createAPIError(status, `${provider} server error`);
            default:
                return createAPIError(status, `Unexpected error from ${provider}: ${data.error?.message || 'Unknown error'}`, data);
        }
    }

    // Handle other errors
    return createAPIError(500, `Error during ${operation}: ${error.message}`);
}

/**
 * Validates API key format
 * @param {string} apiKey - API key to validate
 * @param {string} provider - Provider name for error context
 * @throws {APIError} If API key is invalid
 */
function validateAPIKey(apiKey, provider) {
    if (!apiKey) {
        throw createAPIError(401, `${provider} API key is required`);
    }
    if (typeof apiKey !== 'string') {
        throw createAPIError(401, `${provider} API key must be a string`);
    }
    if (apiKey.length < 10) {
        throw createAPIError(401, `${provider} API key appears to be invalid`);
    }
}

module.exports = {
    createAPIError,
    handleAPIError,
    validateAPIKey
}; 