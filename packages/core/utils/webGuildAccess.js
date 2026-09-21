/**
 * Guild access checks shared by the web app services: a browser session may
 * only touch a guild's data when the logged-in user is an actual member,
 * verified live through the Discord gateway (the Activity WebSocket-join
 * rule). The check goes through the DiscordGateway seam, so it works
 * identically in the bot process (LocalGateway wrapping the live client)
 * and in the api service (RemoteGateway over the bot's internal API).
 *
 * Two distinct refusals when Discord cannot answer (spec §6): BOT_OFFLINE
 * is transient (a configured adapter that cannot be reached right now);
 * DISCORD_DISABLED is permanent (this installation has no Discord adapter,
 * or the caller has no Discord identity to check) and names the next step.
 */

const { toGateway, isGatewayUnavailable, isGatewayDisabled } = require('../gateway');
const discordConfig = require('../config/discordConfig');

/** Machine-readable web access error (HTTP status + code). */
class WebAccessError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'WebAccessError';
        this.status = status;
        this.code = code;
    }
}

const OFFLINE = () => new WebAccessError(503, 'BOT_OFFLINE',
    'Goobster is offline right now - server features are unavailable.');
const DISABLED = () => new WebAccessError(503, 'DISCORD_DISABLED',
    'This installation is not connected to Discord, so server features are unavailable here.');
const NO_DISCORD_IDENTITY = () => new WebAccessError(403, 'NO_DISCORD_IDENTITY',
    'Server features need a linked Discord account - connect Discord in Settings first.');

/**
 * Resolve the member snapshot, or throw a WebAccessError the API layer can
 * answer. When the bot cannot be reached at all (split deployment, bot
 * restarting) the answer is the degraded-mode 503, never a crash.
 * @param {Object} params - { gateway, guildId, userId } (gateway also
 *   accepts a live discord.js client during the transition). `userId` is
 *   the Discord subject; pass null for a principal without one.
 * @returns {Promise<{ id, displayName, username, bot, permissions: string[] }>}
 */
async function requireGuildMember({ gateway, client, guildId, userId }) {
    if (!/^\d{5,20}$/.test(String(guildId || ''))) {
        throw new WebAccessError(400, 'BAD_SCOPE', 'Unknown server.');
    }
    const resolved = toGateway(gateway || client);
    if (!resolved) {
        throw discordConfig.enabled ? OFFLINE() : DISABLED();
    }
    if (!/^\d{5,20}$/.test(String(userId || ''))) {
        throw NO_DISCORD_IDENTITY();
    }
    let result;
    try {
        result = await resolved.getGuildMember(guildId, userId);
    } catch (error) {
        if (isGatewayDisabled(error)) throw DISABLED();
        if (isGatewayUnavailable(error)) throw OFFLINE();
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
