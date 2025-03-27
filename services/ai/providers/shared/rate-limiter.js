/**
 * @typedef {Object} RateLimitConfig
 * @property {number} maxRequests - Maximum number of requests allowed
 * @property {number} windowMs - Time window in milliseconds
 */

/**
 * @typedef {Object} RateLimitState
 * @property {number[]} timestamps - Array of request timestamps
 * @property {number} lastReset - Last time the state was reset
 */

class RateLimiter {
    /**
     * @param {RateLimitConfig} config - Rate limiting configuration
     */
    constructor(config) {
        this.config = {
            maxRequests: config.maxRequests || 60,
            windowMs: config.windowMs || 60000 // 1 minute default
        };
        this.state = {
            timestamps: [],
            lastReset: Date.now()
        };
    }

    /**
     * Checks if a request should be allowed based on rate limits
     * @returns {boolean} Whether the request should be allowed
     */
    shouldAllow() {
        const now = Date.now();
        this.cleanup(now);

        if (this.state.timestamps.length >= this.config.maxRequests) {
            return false;
        }

        this.state.timestamps.push(now);
        return true;
    }

    /**
     * Cleans up old timestamps
     * @param {number} now - Current timestamp
     * @private
     */
    cleanup(now) {
        // Remove timestamps older than the window
        this.state.timestamps = this.state.timestamps.filter(
            timestamp => now - timestamp < this.config.windowMs
        );

        // Reset state if window has passed
        if (now - this.state.lastReset >= this.config.windowMs) {
            this.state.timestamps = [];
            this.state.lastReset = now;
        }
    }

    /**
     * Gets the time until the next available request slot
     * @returns {number} Milliseconds until next available slot, or 0 if available now
     */
    getTimeUntilAvailable() {
        const now = Date.now();
        this.cleanup(now);

        if (this.state.timestamps.length < this.config.maxRequests) {
            return 0;
        }

        const oldestTimestamp = this.state.timestamps[0];
        const timeUntilExpiry = this.config.windowMs - (now - oldestTimestamp);
        return Math.max(0, timeUntilExpiry);
    }

    /**
     * Gets the current rate limit status
     * @returns {Object} Current rate limit status
     */
    getStatus() {
        const now = Date.now();
        this.cleanup(now);

        return {
            remaining: this.config.maxRequests - this.state.timestamps.length,
            reset: this.state.lastReset + this.config.windowMs,
            limit: this.config.maxRequests,
            used: this.state.timestamps.length
        };
    }

    /**
     * Resets the rate limiter state
     */
    reset() {
        this.state.timestamps = [];
        this.state.lastReset = Date.now();
    }
}

/**
 * Creates a rate limiter with the specified configuration
 * @param {RateLimitConfig} config - Rate limiting configuration
 * @returns {RateLimiter} Rate limiter instance
 */
function createRateLimiter(config) {
    return new RateLimiter(config);
}

module.exports = {
    RateLimiter,
    createRateLimiter
}; 