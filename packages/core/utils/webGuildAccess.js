/**
 * Guild access checks shared by the web app services: a browser session may
 * only touch a guild's data when the logged-in user is an actual member,
 * verified live through the Discord gateway (the Activity WebSocket-join
 * rule). The check goes through the DiscordGateway seam, so it works
 * identically in the bot process (LocalGateway wrapping the live client)
 * and in the api service (RemoteGateway over the bot's internal API).
 */

const { toGateway, isGatewayUnavailable } = require('../gateway');

/** Machine-readable web access error (HTTP status + code). */
class WebAccessError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'WebAccessError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Resolve the member snapshot, or throw a WebAccessError the API layer can
 * answer. When the bot cannot be reached at all (split deployment, bot
 * restarting) the answer is the degraded-mode 503, never a crash.
 * @param {Object} params - { gateway, guildId, userId } (gateway also
 *   accepts a live discord.js client during the transition)
 * @returns {Promise<{ id, displayName, username, bot, permissions: string[] }>}
 */
async function requireGuildMember({ gateway, client, guildId, userId }) {
    if (!/^\d{5,20}$/.test(String(guildId || ''))) {
        throw new WebAccessError(400, 'BAD_SCOPE', 'Unknown server.');
    }
    const resolved = toGateway(gateway || client);
    if (!resolved) {
        throw new WebAccessError(503, 'BOT_OFFLINE', 'Goobster is offline right now - server features are unavailable.');
    }
    let result;
    try {
        result = await resolved.getGuildMember(guildId, userId);
    } catch (error) {
        if (isGatewayUnavailable(error)) {
            throw new WebAccessError(503, 'BOT_OFFLINE', 'Goobster is offline right now - server features are unavailable.');
        }
        throw error;
    }
    if (!result.guild) {
        throw new WebAccessError(404, 'UNKNOWN_GUILD', 'Goobster is not in that server.');
    }
    if (!result.member) {
        throw new WebAccessError(403, 'NOT_A_MEMBER', 'You are not a member of that server.');
    }
    return result.member;
}

module.exports = { WebAccessError, requireGuildMember };
