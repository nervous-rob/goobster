/**
 * Gateway errors (the PanelError status+code contract).
 *
 * GatewayUnavailableError is the one callers are expected to handle: it
 * means the Discord gateway (the bot process) could not be reached at all
 * - the bot is restarting, the internal network hiccuped, or the bot is
 * down. Web-reachable services map it onto their own degraded state
 * ("Goobster is offline"), never a crash (reactive port spec §6).
 *
 * GatewayDisabledError is its permanent cousin (shared-instance Increment
 * C): this installation has no Discord adapter at all. It IS an
 * unavailability for every degradation path that already exists, but
 * carries its own code so a surface can say "not connected to Discord,
 * here is the next step" instead of "offline, try again later".
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
    constructor(message = 'Goobster is not connected to Discord right now.', { cause, code = 'GATEWAY_UNAVAILABLE' } = {}) {
        super(503, code, message, { cause });
        this.name = 'GatewayUnavailableError';
    }
}

class GatewayDisabledError extends GatewayUnavailableError {
    constructor(message = 'This installation is not connected to Discord.') {
        super(message, { code: 'DISCORD_DISABLED' });
        this.name = 'GatewayDisabledError';
    }
}

/** True when an error means "Discord could not be reached", not "no". */
function isGatewayUnavailable(error) {
    return error?.code === 'GATEWAY_UNAVAILABLE' || error?.code === 'DISCORD_DISABLED';
}

/** True when the installation has no Discord adapter (permanent, not transient). */
function isGatewayDisabled(error) {
    return error?.code === 'DISCORD_DISABLED';
}

module.exports = {
    GatewayError,
    GatewayUnavailableError,
    GatewayDisabledError,
    isGatewayUnavailable,
    isGatewayDisabled
};
