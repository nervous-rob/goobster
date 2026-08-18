/**
 * The Discord gateway seam (reactive port spec §6).
 *
 * Web-reachable core code never touches discord.js directly: it talks to a
 * small DiscordGateway interface, and each app supplies the implementation:
 *
 *  - LocalGateway  (apps/bot, and the lite single-process deployment):
 *    wraps the live discord.js client.
 *  - RemoteGateway (apps/api): an HTTP client for the bot's internal
 *    gateway API (/internal/gateway/*, shared-secret authenticated).
 *
 * Interface (all methods async, all results plain JSON snapshots):
 *   available() -> boolean
 *   botUser() -> { id, username } | null
 *   getGuildMember(guildId, userId) -> { guild|null, member|null }
 *   memberHasPermission(guildId, userId, permission) -> boolean   (never cached)
 *   listMutualGuilds(userId) -> [{ id, name, icon, memberCount, manageGuild }]
 *   getGuildMembers(guildId, userIds) -> { [userId]: memberSnapshot }
 *   searchGuildMembers(guildId, { query, limit }) -> [memberSnapshot]
 *   getUser(userId) -> { id, username, globalName, bot } | null
 *   sendDm(userId, payload) -> { ok, channelId?, messageId?, error? }   (never throws)
 *   sendToChannel(channelId, payload) -> { ok, messageId?, error? }     (never throws)
 *   resolveDmChannelId(userId) -> string | null
 *   guildMeta(guildId) -> { id, name, icon, memberCount } | null
 *
 * Read methods throw GatewayUnavailableError when the bot cannot be
 * reached; callers map that onto their degraded "Goobster is offline"
 * state (DM-scoped features keep working, guild-scoped panes degrade).
 */

const { LocalGateway } = require('./localGateway');
const { RemoteGateway } = require('./remoteGateway');
const { GatewayError, GatewayUnavailableError, isGatewayUnavailable } = require('./errors');

/** LocalGateway per client, so repeated wrapping is free and identity-stable. */
const wrapped = new WeakMap();

/**
 * Normalize "a client or a gateway or nothing" into a gateway (or null).
 * Lets services accept either during the transition: bot-side callers keep
 * passing the live client; the api app passes a RemoteGateway.
 * @param {Object|null} clientOrGateway
 * @returns {LocalGateway|RemoteGateway|null}
 */
function toGateway(clientOrGateway) {
    if (!clientOrGateway) return null;
    if (clientOrGateway.isGoobsterGateway === true) return clientOrGateway;
    let gateway = wrapped.get(clientOrGateway);
    if (!gateway) {
        gateway = new LocalGateway(clientOrGateway);
        try { wrapped.set(clientOrGateway, gateway); } catch { /* non-object fake */ }
    }
    return gateway;
}

module.exports = {
    LocalGateway,
    RemoteGateway,
    GatewayError,
    GatewayUnavailableError,
    isGatewayUnavailable,
    toGateway
};
