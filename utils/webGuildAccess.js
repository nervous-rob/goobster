/**
 * Guild access checks shared by the web app services: a browser session may
 * only touch a guild's data when the logged-in user is an actual member,
 * verified live through the bot client (the Activity WebSocket-join rule).
 */

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
 * Resolve the member, or throw a WebAccessError the API layer can answer.
 * @param {Object} params - { client, guildId, userId }
 * @returns {Promise<import('discord.js').GuildMember>}
 */
async function requireGuildMember({ client, guildId, userId }) {
    if (!/^\d{5,20}$/.test(String(guildId || ''))) {
        throw new WebAccessError(400, 'BAD_SCOPE', 'Unknown server.');
    }
    const guild = client?.guilds?.cache?.get(guildId);
    if (!guild) {
        throw new WebAccessError(404, 'UNKNOWN_GUILD', 'Goobster is not in that server.');
    }
    try {
        return await guild.members.fetch(userId);
    } catch {
        throw new WebAccessError(403, 'NOT_A_MEMBER', 'You are not a member of that server.');
    }
}

module.exports = { WebAccessError, requireGuildMember };
