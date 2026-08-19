/**
 * Gateway errors (the PanelError status+code contract).
 *
 * GatewayUnavailableError is the one callers are expected to handle: it
 * means the Discord gateway (the bot process) could not be reached at all
 * - the bot is restarting, the internal network hiccuped, or the bot is
 * down. Web-reachable services map it onto their own degraded state
 * ("Goobster is offline"), never a crash (reactive port spec §6).
 */

class GatewayError extends Error {
    constructor(status, code, message, { cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'GatewayError';
        this.status = status;
        this.code = code;
    }
}

class GatewayUnavailableError extends GatewayError {
    constructor(message = 'Goobster is not connected to Discord right now.', { cause } = {}) {
        super(503, 'GATEWAY_UNAVAILABLE', message, { cause });
        this.name = 'GatewayUnavailableError';
    }
}

/** True when an error means "the bot could not be reached", not "no". */
function isGatewayUnavailable(error) {
    return error?.code === 'GATEWAY_UNAVAILABLE';
}

module.exports = { GatewayError, GatewayUnavailableError, isGatewayUnavailable };
