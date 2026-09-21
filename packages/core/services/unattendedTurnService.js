/**
 * Unattended agent turns whose result goes to the in-app inbox
 * (shared-instance Increment C, spec §6).
 *
 * Scheduled tasks, watches, and follow-ups used to be bound to a Discord
 * channel: the turn ran with a channel-shaped pseudo-interaction and the
 * reply was whatever the channel received. This is the same turn - one
 * chat pipeline, one tool registry, the same automation guardrails - with
 * an inbox-shaped destination instead: the reply is collected, written to
 * `inbox_items` first, and echoed to Discord only afterwards and only
 * when the person can receive it there. It needs no Discord client, so it
 * runs identically in the bot, the api service, and a Discord-less
 * installation.
 */

const db = require('../db');
const { toGateway } = require('../gateway');
const { resolveAssistantUser } = require('./assistantIdentity');
const inboxService = require('./inboxService');
const { inboxChannelId } = inboxService;
const identityConfig = require('../config/identityConfig');

/** Display name for a principal, from whatever table knows one. */
async function displayNameFor(userId) {
    const principal = await db.get(
        'SELECT displayName FROM principals WHERE id = @id', { id: String(userId) }
    ).catch(() => null);
    if (principal?.displayName) return principal.displayName;
    const user = await db.get(
        'SELECT username FROM users WHERE discordId = @id', { id: String(userId) }
    ).catch(() => null);
    return user?.username || `user_${userId}`;
}

class UnattendedTurnService {
    /**
     * Run one unattended turn for `userId` and deliver the reply to their
     * inbox (and Discord, when `discord` is set and they can receive it).
     *
     * @param {Object} params
     * @param {string} params.userId - principal id
     * @param {string} params.prompt - the instruction the turn carries out
     * @param {string} params.kind - inbox kind ('task' | 'watch' | 'reminder' | …)
     * @param {string} params.title - inbox item title (the task/watch label)
     * @param {string} params.sourceDescription - what the model is told about why it woke up
     * @param {{ type: string, id: string|number }} [params.source]
     * @param {string} [params.link] - portal path the item points at
     * @param {string} [params.dedupeKey]
     * @param {Object|null} [params.gateway] - Discord seam for tools and the echo
     * @param {Object|null} [params.client] - live discord.js client, when this process has one
     * @param {boolean} [params.discord=true] - echo the result to Discord when possible
     * @returns {Promise<{ item: Object|null, content: string, attachments: Array }>}
     */
    async run({
        userId, prompt, kind, title, sourceDescription, source = null, link = null,
        dedupeKey = null, gateway = null, client = null, discord = true
    }) {
        const { handleChatInteraction } = require('../utils/chatHandler');
        const webChatService = require('./webChatService');
        const resolvedGateway = toGateway(gateway || client);
        const assistant = await resolveAssistantUser({ client, gateway: resolvedGateway });
        const userName = await displayNameFor(userId);
        const channelId = inboxChannelId(userId);

        const parts = [];
        const attachments = [];
        const collect = async (payload) => {
            if (typeof payload === 'string') {
                if (payload && payload !== '✅') parts.push(payload);
                return { id: `inbox-msg-${Date.now()}` };
            }
            if (!payload || typeof payload !== 'object') return { id: `inbox-msg-${Date.now()}` };
            if (typeof payload.content === 'string' && payload.content.trim()) parts.push(payload.content);
            for (const embed of Array.isArray(payload.embeds) ? payload.embeds : []) {
                const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed;
                const lines = [data?.title, data?.description].filter(Boolean);
                if (lines.length > 0) parts.push(lines.join('\n'));
            }
            for (const file of Array.isArray(payload.files) ? payload.files : []) {
                const filePath = typeof file === 'string' ? file : file?.attachment;
                if (typeof filePath !== 'string') continue;
                try {
                    const registered = await webChatService.registerFile(filePath, userId);
                    if (registered) attachments.push({ url: registered.url, name: (typeof file === 'object' && file.name) || registered.name });
                } catch { /* an unregisterable file is dropped, not fatal */ }
            }
            return { id: `inbox-msg-${Date.now()}` };
        };

        const channel = {
            id: channelId,
            isThread: () => false,
            isTextBased: () => true,
            sendTyping: async () => {},
            // Unattended turns start from the prompt alone; the pipeline
            // reads recent history through the channel, and the inbox has none.
            messages: { fetch: async () => [] },
            send: collect
        };

        const pseudoInteraction = {
            id: `inbox-${userId}-${Date.now()}`,
            user: { id: String(userId), username: userName },
            member: null,
            guild: null,
            guildId: null,
            channel,
            channelId,
            client: client || { user: { id: assistant.id, username: assistant.username } },
            gateway: resolvedGateway,
            content: prompt,
            isAutomation: true,
            sourceDescription,
            deferReply: async () => {},
            editReply: collect,
            reply: collect,
            followUp: collect,
            sendFullResponse: async (text) => { await collect(text); },
            options: { getString: () => prompt }
        };

        await handleChatInteraction(pseudoInteraction);

        const content = parts.join('\n\n').trim();
        if (!content && attachments.length === 0) {
            return { item: null, content: '', attachments: [] };
        }
        const { item } = await inboxService.deliver({
            userId,
            kind,
            title,
            body: content || null,
            source,
            link,
            attachments,
            dedupeKey,
            discord: discord && resolvedGateway ? { gateway: resolvedGateway } : false
        });
        return { item, content, attachments };
    }

    /** The assistant's display name, for banners and prompts. */
    get assistantName() {
        return identityConfig.assistantName;
    }
}

module.exports = new UnattendedTurnService();
module.exports.UnattendedTurnService = UnattendedTurnService;
module.exports.displayNameFor = displayNameFor;
