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

// Helper – mirrors playtrack's internal check
function isUserInBotVoiceChannel(interaction) {
    const botVoiceChannel = interaction.guild?.members?.me?.voice?.channel;
    if (!botVoiceChannel) return false;
    const userVoiceChannel = interaction.member?.voice?.channel;
    if (!userVoiceChannel) return false;
    return botVoiceChannel.id === userVoiceChannel.id;
}

function getCommandResponse(sub, track, playlistName) {
    switch (sub) {
        case 'play':
            return `Attempting to play **${track}**`;
        case 'pause':
            return '⏸️ Pausing playback';
        case 'resume':
            return '▶️ Resuming playback';
        case 'skip':
            return '⏭️ Skipping track';
        case 'stop':
            return '⏹️ Stopping playback';
        case 'volume':
            return '🔊 Adjusting volume';
        case 'list':
            return '📋 Listing available tracks';
        case 'queue':
            return '📋 Showing queue';
        case 'play_all':
            return '🎵 Playing all tracks';
        case 'shuffle_all':
            return '🔀 Shuffling all tracks';
        case 'playlist_create':
            return `✅ Creating playlist **${playlistName}**`;
        case 'playlist_add':
            return `➕ Adding to playlist **${playlistName}**`;
        case 'playlist_play':
            return `▶️ Playing playlist **${playlistName}**`;
        case 'playlist_list':
            return '📋 Listing playlists';
        case 'playlist_delete':
            return `🗑️ Deleting playlist **${playlistName}**`;
        case 'playlist_create_from_search':
            return `🔍 Creating playlist **${playlistName}** from search`;
        default:
            return '🎵 Executing music command';
    }
}

/**
 * Resolve GitHub access for a tool call. In a server, the global token is
 * used and the repo must be on the guild's watch allowlist. In DMs and the
 * web portal there is no guild authority, so the caller's own connected
 * GitHub token (user_integrations) is the credential - their token, their
 * repos, no allowlist.
 * @returns {{ service?: Object, parsed?: string, error?: string }}
 */
async function resolveGithubAccess(interactionContext, githubService, repo) {
    const guildId = interactionContext?.guildId || interactionContext?.guild?.id;
    let parsed;
    try {
        parsed = githubService.parseRepo(repo);
    } catch (error) {
        return { error: `❌ ${error.message}` };
    }

    if (guildId) {
        const repoWatchService = require('../../services/repoWatchService');
        if (!await repoWatchService.isRepoAllowed(guildId, parsed)) {
            return { error: `❌ ${parsed} isn't allowlisted in this server. An admin must run /github watch first.` };
        }
        return { service: githubService, parsed };
    }

    const userId = interactionContext?.user?.id;
    if (!userId) return { error: '❌ GitHub tools need a known user in this context.' };
    const userIntegrationService = require('../../services/userIntegrationService');
    const token = await userIntegrationService.getToken(userId, 'github');
    if (!token) {
        return { error: '❌ No GitHub account connected. Connect one in the web portal (Integrations) to use GitHub tools here.' };
    }
    return { service: githubService.withToken(token), parsed };
}

module.exports = {
    commandAdapters,
    registerCommandAdapters,
    getCommandAdapter,
    resolveEconomyAccount,
    resolveGuildMember,
    resolveNotionAccess,
    isUserInBotVoiceChannel,
    getCommandResponse,
    resolveGithubAccess
};
