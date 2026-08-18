/**
 * Direct-message conversation scoping.
 *
 * The chat pipeline and memory tables key everything on a guild id (TEXT,
 * NOT NULL). DMs have no guild, so each user's one-on-one conversation gets
 * a synthetic per-user scope id ("dm:<userId>") that satisfies those columns
 * and keeps DM data isolated - both from guilds and from other users.
 */
const DM_SCOPE_PREFIX = 'dm:';

/**
 * Scope id for a user's DM conversation with the bot.
 * @param {string} userId - Discord user snowflake
 * @returns {string}
 */
function dmScopeId(userId) {
    if (!userId) throw new Error('dmScopeId requires a user id');
    return `${DM_SCOPE_PREFIX}${userId}`;
}

/**
 * Whether a scope id denotes a DM conversation rather than a real guild.
 * @param {string} scopeId
 * @returns {boolean}
 */
function isDmScopeId(scopeId) {
    return typeof scopeId === 'string' && scopeId.startsWith(DM_SCOPE_PREFIX);
}

/**
 * Conversation scope for an interaction (or pseudo-interaction): the real
 * guild id in a server, or the user's DM scope in a direct message.
 * @param {Object} interaction - Interaction with guildId and user
 * @returns {string}
 */
function getConversationScopeId(interaction) {
    return interaction.guildId || dmScopeId(interaction.user.id);
}

module.exports = {
    DM_SCOPE_PREFIX,
    dmScopeId,
    isDmScopeId,
    getConversationScopeId
};
