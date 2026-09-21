/**
 * Delivery of due follow-ups (shared-instance Increment C, spec §6).
 *
 * One pass, two destinations:
 *  - Personal follow-ups (DM scope, including every reminder created from
 *    the portal's Tasks pane) are written to the person's inbox first and
 *    echoed to their Discord DM when they can receive one. They need no
 *    Discord client, so the pass runs in whichever process holds the
 *    `heartbeat_followups` singleton lock - bot, api, or a Discord-less
 *    installation.
 *  - Guild follow-ups (`/followup` in a server channel) post to that
 *    channel and therefore need the live client; a process without one
 *    leaves them PENDING for the bot to deliver.
 *
 * HeartbeatService delegates here; the core runtime runs it directly when
 * there is no bot process.
 */

const db = require('../db');
const followupService = require('./followupService');
const inboxService = require('./inboxService');
const aiService = require('./aiService');
const identityConfig = require('../config/identityConfig');
const { isDmScopeId } = require('../utils/dmScope');
const { toGateway } = require('../gateway');
const logger = require('../utils/logger');

const LOCK = 'heartbeat_followups';

class FollowupDeliveryService {
    constructor() {
        this.delivering = false;
    }

    /**
     * Deliver everything due, under the singleton lock. Re-entrancy guarded:
     * a slow pass (model calls can outlast the minute timer) never overlaps
     * the next one and double-delivers.
     * @param {{ client?: Object|null, gateway?: Object|null }} [params]
     * @returns {Promise<{ skipped?: boolean, delivered?: number, left?: number }>}
     */
    async deliverDue({ client = null, gateway = null } = {}) {
        const outcome = await db.withSingletonLock(LOCK, async () => {
            if (this.delivering) return { delivered: 0, left: 0 };
            this.delivering = true;
            try {
                return await this._deliverDueBody({ client, gateway });
            } finally {
                this.delivering = false;
            }
        });
        if (!outcome.acquired) {
            logger.warn?.('[followups] Delivery pass skipped: another process holds the singleton lock');
            return { skipped: true };
        }
        return outcome.result;
    }

    async _deliverDueBody({ client, gateway }) {
        const resolvedGateway = toGateway(gateway || client);
        let delivered = 0;
        let left = 0;
        for (const followup of await followupService.getDue()) {
            try {
                if (isDmScopeId(followup.guildId) && followup.userId) {
                    await this._deliverPersonal(followup, resolvedGateway);
                } else if (client) {
                    const posted = await this._deliverToGuildChannel(followup, client);
                    if (!posted) continue;
                } else {
                    // A guild follow-up needs the bot; leave it for that process.
                    left += 1;
                    continue;
                }
                const { recurring, nextDueAt } = await followupService.recordDelivery(followup);
                delivered += 1;
                logger.info?.(`[followups] Delivered follow-up #${followup.id}${recurring ? ` (recurring, next at ${nextDueAt} UTC)` : ''}: ${followup.note}`);
            } catch (error) {
                logger.error?.(`[followups] Follow-up #${followup.id} failed: ${error.message}`);
                // Leave PENDING so the next pass retries
            }
        }
        return { delivered, left };
    }

    /** Phrase the reminder; the note itself is the fallback. */
    async _compose(followup, { mention = false } = {}) {
        try {
            const text = await aiService.generateText(
                `You are ${identityConfig.assistantName}, a friendly assistant. You previously promised to follow up on something, and now is the time. Write a short (1-2 sentence), casual follow-up message${mention && followup.userId ? ` addressed to <@${followup.userId}>` : ''}.

Follow-up note: "${followup.note}"${followup.recurrence ? `
This is a recurring check-in (repeats ${followup.recurrence}) - it will fire again automatically.` : ''}

Respond with ONLY the message text.`,
                { temperature: 0.7, max_tokens: 120 }
            );
            const trimmed = String(text || '').trim();
            if (trimmed) return trimmed;
        } catch (error) {
            logger.warn?.(`[followups] Could not phrase follow-up #${followup.id} (${error.message}); using the note`);
        }
        return `Following up as promised: ${followup.note}`;
    }

    /** Inbox first, Discord echo second. */
    async _deliverPersonal(followup, gateway) {
        const message = await this._compose(followup);
        const note = String(followup.note || '').trim();
        await inboxService.deliver({
            userId: followup.userId,
            kind: 'reminder',
            title: `Reminder: ${note.length > 80 ? `${note.slice(0, 79)}…` : note}`,
            body: message,
            source: { type: 'followup', id: followup.id },
            link: '/tasks',
            dedupeKey: `followup:${followup.id}:${followup.dueAt}`,
            discord: gateway ? { gateway, payload: { content: `⏰ ${message}`, allowedMentions: { users: [], roles: [] } } } : false
        });
    }

    /** The guild path, unchanged: post where the follow-up was asked for. */
    async _deliverToGuildChannel(followup, client) {
        const channel = await client.channels.fetch(followup.channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            await followupService.cancel(followup.id);
            return false;
        }
        const message = await this._compose(followup, { mention: true });
        await channel.send({
            content: `⏰ ${message}`,
            allowedMentions: followup.userId ? { users: [followup.userId] } : { users: [], roles: [] }
        });
        return true;
    }
}

module.exports = new FollowupDeliveryService();
module.exports.FollowupDeliveryService = FollowupDeliveryService;
module.exports.LOCK = LOCK;
