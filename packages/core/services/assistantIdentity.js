/**
 * The installation-scoped assistant identity (shared-instance Increment C,
 * spec §6).
 *
 * Every chat turn needs "who is the assistant" - the id that marks its
 * side of a transcript, the name a prompt or an inbox item speaks as.
 * Historically that was the Discord bot account, which made a bot token a
 * prerequisite for inference. Discord's bot user is now a *transport*
 * identity: when a live client (or a reachable bot) exists its user is
 * used, so legacy transcripts keep their author id; otherwise this stable
 * per-installation identity stands in. Both shapes are plain TEXT keys in
 * the `users` table, and neither grants anything.
 */

const identityConfig = require('../config/identityConfig');

const ASSISTANT_ID = /^asst_[A-Za-z0-9._-]{1,64}$/;

/** @param {unknown} id */
function isAssistantId(id) {
    return ASSISTANT_ID.test(String(id ?? ''));
}

/** The assistant identity for this installation: `{ id, username }`. */
function assistantUser() {
    const slug = String(identityConfig.installationId || 'local')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .slice(0, 64) || 'local';
    return {
        id: `asst_${slug}`,
        username: identityConfig.assistantName,
        bot: true
    };
}

/**
 * Resolve the assistant identity through whichever seam this process has:
 * a live discord.js client, then the gateway (the api service reaching
 * the bot), then the installation identity. Never throws, never null.
 * @param {{ client?: Object|null, gateway?: Object|null }} [params]
 * @returns {Promise<{ id: string, username: string }>}
 */
async function resolveAssistantUser({ client = null, gateway = null } = {}) {
    if (client?.user?.id) {
        return { id: String(client.user.id), username: client.user.username || identityConfig.assistantName };
    }
    if (gateway && typeof gateway.botUser === 'function') {
        try {
            const user = await gateway.botUser();
            if (user?.id) return { id: String(user.id), username: user.username || identityConfig.assistantName };
        } catch { /* unreachable: fall through to the installation identity */ }
    }
    const local = assistantUser();
    return { id: local.id, username: local.username };
}

module.exports = { assistantUser, resolveAssistantUser, isAssistantId };
