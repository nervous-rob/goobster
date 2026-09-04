/**
 * Shared resolvers for chat tools. toolsRegistry.js stays the facade;
 * tool implementations call these so account identity stays consistent.
 */

/**
 * Discord command modules wrapped as tools (playTrack, setNickname,
 * speakMessage). Core never imports app code, so the host app registers the
 * command modules it wants these tools to drive at startup:
 *
 *   toolsRegistry.registerCommandAdapters({ playTrack, nickname, speak });
 *
 * Each adapter is a command module exposing `execute(interaction)`. A tool
 * whose adapter is missing returns a friendly error instead of throwing.
 */
const commandAdapters = {
    playTrack: null,
    nickname: null,
    speak: null
};

function registerCommandAdapters(adapters = {}) {
    for (const [name, mod] of Object.entries(adapters)) {
        if (name in commandAdapters && mod && typeof mod.execute === 'function') {
            commandAdapters[name] = mod;
        }
    }
}

function getCommandAdapter(name) {
    return commandAdapters[name] || null;
}

/**
 * Resolve which wallet an economy/stock tool acts on. The model picks the
 * account explicitly via the tool's `owner` parameter:
 *   - 'user' (default): the human who triggered this turn.
 *   - 'bot': Goobster's own Discord account (interactionContext.client.user)
 *     - the SAME real account id that `/points admin grant` can fund, so the
 *     assistant's "my points" always means the shared economyService wallet
 *     keyed on (guildId, botUserId). Never a synthetic id.
 * @param {Object} interactionContext - Discord interaction (or pseudo-interaction)
 * @param {'user'|'bot'} [owner]
 * @returns {{guildId: string, userId: string, whose: string}|{error: string}}
 */
function resolveEconomyAccount(interactionContext, owner = 'user') {
    const guildId = interactionContext?.guildId;
    if (!guildId) return { error: '❌ The point economy only exists inside servers.' };
    if (owner === 'bot') {
        const botId = interactionContext?.client?.user?.id;
        if (!botId) return { error: '❌ I could not resolve my own bot account in this context.' };
        return { guildId, userId: botId, whose: "Goobster's own" };
    }
    const userId = interactionContext?.user?.id;
    if (!userId) return { error: '❌ I could not tell whose wallet to use.' };
    return { guildId, userId, whose: "the requesting user's" };
}

/**
 * Resolve which member of the guild an audit/inspection tool is asking about.
 * Accepts a mention (`<@123>`), a raw snowflake, a username, a display name,
 * or nothing at all (meaning the person Goobster is talking to).
 *
 * Read-only by design: this is how Goobster answers "how is The Data Daddy's
 * account doing" without needing the asker to paste an id. It only ever
 * resolves members of the guild the conversation is happening in.
 * @returns {Promise<{guildId, userId, label}|{error: string}>}
 */
async function resolveGuildMember(interactionContext, who = null) {
    const guildId = interactionContext?.guildId;
    if (!guildId) return { error: '❌ The exchange only exists inside servers.' };

    const selfId = interactionContext?.user?.id;
    const query = String(who || '').trim();
    if (!query) {
        if (!selfId) return { error: '❌ I could not tell whose account to look at.' };
        return { guildId, userId: selfId, label: interactionContext.user.username || 'you', isSelf: true };
    }

    const botId = interactionContext?.client?.user?.id;
    if (/^(me|myself|my account|i)$/i.test(query) && selfId) {
        return { guildId, userId: selfId, label: interactionContext.user.username || 'you', isSelf: true };
    }
    if (/^(you|yourself|goobster|your account)$/i.test(query) && botId) {
        return { guildId, userId: botId, label: 'Goobster', isBot: true };
    }

    const mentioned = query.match(/^<@!?(\d{5,25})>$/);
    const id = mentioned ? mentioned[1] : (/^\d{5,25}$/.test(query) ? query : null);
    const guild = interactionContext?.guild;

    try {
        if (id) {
            const member = guild?.members?.cache?.get(id) || await guild?.members?.fetch(id);
            return { guildId, userId: id, label: member?.displayName || member?.user?.username || `user ${id}` };
        }
        if (guild?.members?.fetch) {
            const matches = await guild.members.fetch({ query, limit: 5 });
            const member = matches?.first?.();
            if (member) return { guildId, userId: member.id, label: member.displayName || member.user.username };
        }
    } catch {
        // Fall through to the not-found message below
    }
    return { error: `❌ I couldn't find "${query}" in this server. Try mentioning them.` };
}

/**
 * Resolve Notion access for a tool call. Notion is a personal integration:
 * it only works on private surfaces (DMs and the web portal), never in a
 * server channel, so personal workspace content can't leak into a guild.
 * @returns {{ token?: string, error?: string }}
 */
async function resolveNotionAccess(interactionContext) {
    const guildId = interactionContext?.guildId || interactionContext?.guild?.id;
    if (guildId) {
        return { error: '❌ Notion is a personal integration - use it in a DM or the web portal, not in a server channel.' };
    }
    const userId = interactionContext?.user?.id;
    if (!userId) return { error: '❌ Notion tools need a known user in this context.' };
    const userIntegrationService = require('../../services/userIntegrationService');
    const token = await userIntegrationService.getToken(userId, 'notion');
    if (!token) {
        return { error: '❌ No Notion workspace connected. Connect one in the web portal (Integrations) to use Notion tools.' };
    }
    return { token };
}

module.exports = {
    commandAdapters,
    registerCommandAdapters,
    getCommandAdapter,
    resolveEconomyAccount,
    resolveGuildMember,
    resolveNotionAccess
};
