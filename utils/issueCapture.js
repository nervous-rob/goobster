/**
 * 📋 reaction → GitHub issue proposal. Reacting with 📋 on a message (e.g. a
 * bug report mid-conversation) has Goobster draft an issue from the message
 * plus nearby context and post the standard Confirm/Cancel proposal. Nothing
 * is written to GitHub until a Manage Server member confirms.
 */
const db = require('../db');
const aiService = require('../services/aiService');
const githubService = require('../services/githubService');
const repoWatchService = require('../services/repoWatchService');
const integrationActionService = require('../services/integrationActionService');
const integrationAudit = require('../services/integrationAudit');

/**
 * Pick the repo a captured issue belongs to: the repo watched into this
 * channel when unambiguous, otherwise the guild's only watch.
 * @returns {string|null} owner/name, or null when ambiguous/none
 */
function resolveTargetRepo(guildId, channelId) {
    const watches = repoWatchService.listWatches(guildId);
    if (!watches.length) return null;
    const channelWatches = watches.filter(watch => watch.channelId === channelId);
    if (channelWatches.length === 1) return channelWatches[0].repo;
    if (watches.length === 1) return watches[0].repo;
    return null;
}

/** A PENDING github-issue proposal already exists for this source message. */
function hasPendingCapture(messageId) {
    return Boolean(db.get(
        `SELECT 1 AS ok FROM pending_integration_actions
         WHERE type = 'github-issue' AND status = 'PENDING'
         AND payload LIKE @marker`,
        { marker: `%"sourceMessageId":"${messageId}"%` }
    ));
}

/**
 * Draft {title, body} from the message and a little surrounding context.
 * AI-drafted when a provider is available; deterministic fallback otherwise.
 */
async function draftIssue(message) {
    const link = `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;
    const attribution = `\n\n---\nReported by **${message.author.username}** on Discord ([source](${link})).`;

    let context = '';
    try {
        const before = await message.channel.messages.fetch({ limit: 6, before: message.id });
        context = [...before.values()].reverse()
            .filter(m => m.content)
            .map(m => `${m.author.username}${m.author.bot ? ' (bot)' : ''}: ${m.content.slice(0, 300)}`)
            .join('\n');
    } catch {
        // context is optional
    }

    try {
        const response = await aiService.generateText(
            `Turn this Discord message into a well-formed GitHub issue. Respond with ONLY JSON: {"title": "<concise, specific title>", "body": "<markdown body: what happened / expected behavior / reproduction details, from the message and context. Do not invent details.>"}

MESSAGE (by ${message.author.username}):
${message.content.slice(0, 1500)}

${context ? `NEARBY CONVERSATION (oldest first):\n${context}` : ''}`,
            { temperature: 0.3, max_tokens: 600, usageContext: { guildId: message.guild.id, userId: message.author.id } }
        );
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        const draft = JSON.parse(jsonMatch[0]);
        if (draft.title) {
            return { title: String(draft.title).slice(0, 250), body: String(draft.body || '').slice(0, 5000) + attribution };
        }
    } catch {
        // fall through to the deterministic draft
    }
    return {
        title: message.content.split('\n')[0].slice(0, 100) || 'Issue reported on Discord',
        body: `> ${message.content.slice(0, 2000).replace(/\n/g, '\n> ')}${attribution}`
    };
}

/**
 * Handle a 📋 reaction. Returns true when the reaction was consumed
 * (including polite refusals), false when it wasn't an issue-capture case.
 * @param {import('discord.js').MessageReaction} reaction
 * @param {import('discord.js').User} user
 */
async function handleIssueCaptureReaction(reaction, user) {
    const message = reaction.message;
    if (!message.guild) return false;
    if (message.author?.id === message.client.user.id) return false; // not on the bot's own messages
    if (!message.content?.trim()) return false;

    if (!githubService.hasToken()) {
        await message.reply({ content: '📋 I can\'t file issues: no `GITHUB_TOKEN` with Issues write access is configured.', allowedMentions: { repliedUser: false } }).catch(() => {});
        return true;
    }

    const repo = resolveTargetRepo(message.guild.id, message.channel.id);
    if (!repo) {
        const hasAny = repoWatchService.listWatches(message.guild.id).length > 0;
        await message.reply({
            content: hasAny
                ? '📋 Several repos are watched here and I can\'t tell which one this belongs to — ask me in chat instead (e.g. "@Goobster file this as an issue on owner/repo").'
                : '📋 No repositories are watched in this server. An admin can add one with `/github watch`.',
            allowedMentions: { repliedUser: false }
        }).catch(() => {});
        return true;
    }

    if (hasPendingCapture(message.id)) return true; // already proposed

    const draft = await draftIssue(message);
    const { message: proposal } = integrationActionService.createPending({
        type: 'github-issue',
        guildId: message.guild.id,
        channelId: message.channel.id,
        requestedBy: user.id,
        payload: { repo, title: draft.title, body: draft.body, sourceMessageId: message.id }
    });
    await message.reply({ ...proposal, allowedMentions: { repliedUser: false } });
    integrationAudit.record({
        guildId: message.guild.id, userId: user.id,
        action: 'github.issue-proposed', detail: { repo, via: 'reaction', sourceMessageId: message.id }
    });
    return true;
}

module.exports = { handleIssueCaptureReaction, resolveTargetRepo, hasPendingCapture, draftIssue };
