/**
 * Watches: the third scheduling primitive.
 *
 *   Follow-up   "Remind me Friday."                     → waits for a TIME
 *   Automation  "Every Friday, check the experiment."    → repeats on a CRON
 *   Watch       "When the experiment finishes, look."    → waits for a CONDITION
 *
 * A watch arms itself against a domain event topic (optionally with a payload
 * predicate) and, when that condition occurs, runs one full unattended agent
 * turn — the same `handleChatInteraction` pipeline an automation uses, with
 * the same tools and the same guardrails. Then it is spent.
 *
 * This is what makes long-running work feel attended rather than polled. The
 * assistant can launch an overnight Observatory job, arm a watch on its
 * completion, and go away; when the job finishes it wakes up, inspects the
 * output, compares it against the stated hypothesis, and says something
 * useful. No cron job, no fixed interval, no "check every six hours" wrapper
 * around something that happens exactly once.
 *
 * Firing is claimed atomically before the turn runs (the automation rule): a
 * restart or a duplicated event can never double-run a watch.
 *
 * Spec: documentation/attention.md
 */

const db = require('../db');
const domainEventBus = require('./domainEventBus');
const config = require('../config/attentionConfig');
const { isDmScopeId, dmScopeId } = require('../utils/dmScope');
const logger = require('../utils/logger');

const { WATCHES } = config;

const MAX_LABEL_LENGTH = 60;
const MAX_PROMPT_LENGTH = 1500;

/** Topics a watch may arm against: the observable ones, not the internal ones. */
const WATCHABLE_TOPICS = [
    domainEventBus.TOPICS.OBSERVATORY_JOB_COMPLETED,
    domainEventBus.TOPICS.OBSERVATORY_JOB_FAILED,
    domainEventBus.TOPICS.OBSERVATORY_JOB_INTERRUPTED,
    domainEventBus.TOPICS.OBSERVATORY_JOB_STARTED,
    domainEventBus.TOPICS.REFLECTION_COMPLETED,
    domainEventBus.TOPICS.KNOWLEDGE_CONTRADICTION_DETECTED,
    domainEventBus.TOPICS.ATTENTION_ITEM_RESOLVED,
    domainEventBus.TOPICS.AUTOMATION_RAN,
    'observatory.*',
    'knowledge.*'
];

class WatchError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'WatchError';
        this.code = code;
    }
}

function parseJson(text, fallback) {
    if (!text) return fallback;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function toUtcText(date) {
    return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

class AttentionWatchService {
    constructor() {
        this.client = null;
        this._unsubscribe = null;
        this._running = 0;
        AttentionWatchService.instance = this;
    }

    get watchableTopics() {
        return WATCHABLE_TOPICS;
    }

    /**
     * Start listening for conditions. Only the bot process attaches: firing a
     * watch runs an agent turn that talks to Discord, so it belongs where the
     * other singleton workers live.
     * @param {Object} client - the live discord.js client
     */
    attach(client) {
        this.client = client || null;
        if (this._unsubscribe) return;
        this._unsubscribe = domainEventBus.subscribe('*', event => this.onEvent(event));
        logger.info?.('[watches] Armed (condition-triggered agent turns)');
    }

    detach() {
        if (this._unsubscribe) this._unsubscribe();
        this._unsubscribe = null;
        this.client = null;
    }

    present(row) {
        if (!row) return null;
        return {
            id: row.id,
            userId: row.userId,
            guildId: row.guildId,
            channelId: row.channelId || null,
            label: row.label,
            topic: row.topic,
            condition: parseJson(row.condition, null),
            prompt: row.promptText,
            itemId: row.itemId ?? null,
            status: row.status,
            fireCount: row.fireCount,
            maxFires: row.maxFires,
            expiresAt: row.expiresAt || null,
            lastFiredAt: row.lastFiredAt || null,
            lastError: row.lastError || null,
            createdAt: row.createdAt
        };
    }

    /**
     * Arm a watch.
     * @param {Object} params
     * @param {string} params.userId
     * @param {string} params.guildId - conversation scope for the turn
     * @param {string} [params.channelId] - where to deliver; DM when omitted
     * @param {string} params.label - human handle, unique per person
     * @param {string} params.topic - a watchable topic or namespace wildcard
     * @param {Object} [params.condition] - payload fields that must match
     * @param {string} params.prompt - what to do when it fires
     * @param {number} [params.itemId] - the open loop this serves
     * @param {number} [params.ttlHours]
     * @returns {Promise<Object>} the watch
     */
    async register({
        userId,
        guildId,
        channelId = null,
        label,
        topic,
        condition = null,
        prompt,
        itemId = null,
        ttlHours = null
    } = {}) {
        if (!userId) throw new WatchError('BAD_USER', 'A user id is required.');
        const cleanLabel = String(label ?? '').trim().slice(0, MAX_LABEL_LENGTH);
        const cleanPrompt = String(prompt ?? '').trim().slice(0, MAX_PROMPT_LENGTH);
        if (!cleanLabel) throw new WatchError('BAD_LABEL', 'A short label is required.');
        if (!cleanPrompt) {
            throw new WatchError('BAD_PROMPT', 'Say what you want done when the condition happens.');
        }
        if (!WATCHABLE_TOPICS.includes(topic)) {
            throw new WatchError('BAD_TOPIC',
                `Watchable conditions are: ${WATCHABLE_TOPICS.join(', ')}.`);
        }

        const armed = await db.get(
            `SELECT COUNT(*) AS c FROM attention_watches
             WHERE userId = @userId AND status = 'ARMED'`,
            { userId }
        );
        if ((armed?.c || 0) >= WATCHES.maxPerUser) {
            throw new WatchError('TOO_MANY_WATCHES',
                `At most ${WATCHES.maxPerUser} armed watches - cancel one first.`);
        }
        const duplicate = await db.get(
            'SELECT id FROM attention_watches WHERE userId = @userId AND label = @label',
            { userId, label: cleanLabel }
        );
        if (duplicate) {
            throw new WatchError('DUPLICATE_LABEL', 'You already have a watch with that label.');
        }

        const hours = Math.max(1, Math.min(24 * 90, Number(ttlHours) || WATCHES.defaultTtlHours));
        const id = Number(await db.insert(
            `INSERT INTO attention_watches
                (userId, guildId, channelId, label, topic, condition, promptText, itemId, expiresAt)
             VALUES
                (@userId, @guildId, @channelId, @label, @topic, @condition, @prompt, @itemId, @expiresAt)`,
            {
                userId,
                guildId: guildId || dmScopeId(userId),
                channelId,
                label: cleanLabel,
                topic,
                condition: condition && Object.keys(condition).length > 0
                    ? JSON.stringify(condition)
                    : null,
                prompt: cleanPrompt,
                itemId,
                expiresAt: toUtcText(new Date(Date.now() + hours * 3600_000))
            }
        ));
        logger.info?.(`[watches] Armed #${id} "${cleanLabel}" on ${topic} for ${userId}`);
        return await this.get(id);
    }

    async get(id) {
        const row = await db.get('SELECT * FROM attention_watches WHERE id = @id', { id: Number(id) });
        return this.present(row);
    }

    /**
     * @param {Object} params - { userId, statuses, limit }
     * @returns {Promise<Object[]>}
     */
    async list({ userId, statuses = ['ARMED'], limit = 25 } = {}) {
        if (!userId) return [];
        const list = Array.isArray(statuses) ? statuses : [statuses];
        if (list.length === 0) return [];
        const params = { userId, limit: Math.max(1, Math.min(100, Number(limit) || 25)) };
        list.forEach((status, i) => { params[`s${i}`] = status; });
        const rows = await db.all(
            `SELECT * FROM attention_watches
             WHERE userId = @userId AND status IN (${list.map((_, i) => `@s${i}`).join(', ')})
             ORDER BY id DESC LIMIT @limit`,
            params
        );
        return rows.map(row => this.present(row));
    }

    /**
     * Disarm a watch by label or id.
     * @param {Object} params - { userId, label, id }
     * @returns {Promise<boolean>}
     */
    async cancel({ userId, label = null, id = null } = {}) {
        if (!userId || (!label && !id)) return false;
        const result = await db.run(
            `UPDATE attention_watches SET status = 'CANCELLED'
             WHERE userId = @userId AND status = 'ARMED'
               AND (${id ? 'id = @id' : 'label = @label'})`,
            { userId, id: id ? Number(id) : null, label }
        );
        return result.changes > 0;
    }

    /** Disarm watches that outlived their window. */
    async expireStale() {
        const result = await db.run(
            `UPDATE attention_watches SET status = 'EXPIRED'
             WHERE status = 'ARMED' AND expiresAt IS NOT NULL AND expiresAt < CURRENT_TIMESTAMP`
        );
        if (result.changes > 0) {
            logger.debug?.(`[watches] Expired ${result.changes} stale watch(es)`);
        }
        return result.changes;
    }

    /* ------------------------------------------------------------------ */
    /* Firing                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * A condition happened: fire every armed watch that matches.
     * @param {Object} event - { topic, payload }
     */
    async onEvent(event) {
        if (!event?.topic) return;
        // Every stored message publishes an event, so this must not scan the
        // table. The three patterns topicMatches accepts are all expressible
        // as equality, which keeps the lookup on idx_attention_watches_armed.
        const namespace = String(event.topic).includes('.')
            ? `${String(event.topic).split('.')[0]}.*`
            : null;
        const rows = await db.all(
            `SELECT * FROM attention_watches
             WHERE status = 'ARMED' AND fireCount < maxFires
               AND topic IN (@topic, @namespace, '*')`,
            { topic: event.topic, namespace: namespace || event.topic }
        );
        for (const row of rows) {
            const watch = this.present(row);
            // Belt and braces: the SQL narrows, this is the actual rule.
            if (!domainEventBus.topicMatches(event.topic, watch.topic)) continue;
            if (!this._conditionMatches(watch.condition, event.payload)) continue;
            // A watch belongs to one person; another user's event is not it.
            if (event.payload?.userId && event.payload.userId !== watch.userId) continue;
            await this._fire(watch, event);
        }
    }

    /**
     * Payload predicate: every declared field must equal the event's value.
     * Compared as strings because ids cross the pg_notify JSON boundary and
     * a snowflake is text everywhere else in Goobster anyway.
     */
    _conditionMatches(condition, payload) {
        if (!condition) return true;
        for (const [key, expected] of Object.entries(condition)) {
            if (String(payload?.[key] ?? '') !== String(expected)) return false;
        }
        return true;
    }

    /** Claim-then-run, so a duplicated event cannot double-fire a watch. */
    async _fire(watch, event) {
        if (this._running >= WATCHES.maxConcurrentTurns) {
            logger.warn?.(`[watches] #${watch.id} skipped: ${this._running} turns already running`);
            return;
        }
        const claimed = (await db.run(
            `UPDATE attention_watches
             SET fireCount = fireCount + 1,
                 lastFiredAt = CURRENT_TIMESTAMP,
                 status = CASE WHEN fireCount + 1 >= maxFires THEN 'FIRED' ELSE 'ARMED' END
             WHERE id = @id AND status = 'ARMED' AND fireCount < maxFires`,
            { id: watch.id }
        )).changes > 0;
        if (!claimed) return;

        this._running++;
        try {
            await this._runTurn(watch, event);
            logger.info?.(`[watches] #${watch.id} "${watch.label}" fired on ${event.topic}`);
        } catch (error) {
            logger.error?.(`[watches] #${watch.id} failed: ${error.message}`);
            await db.run(
                `UPDATE attention_watches SET status = 'FAILED', lastError = @error WHERE id = @id`,
                { id: watch.id, error: String(error.message || error).slice(0, 500) }
            );
        } finally {
            this._running--;
        }
    }

    /**
     * What actually happened, in enough detail to reason about.
     *
     * A watch that wakes up knowing only "job 42 completed" has to go looking
     * for the result before it can say anything useful - and if the relevant
     * tool happens to be unavailable, it wakes up only to report that it
     * cannot help. Handing the turn the evidence up front is both cheaper and
     * more reliable, and it is the difference between "your run finished" and
     * "your run finished and here is what it showed".
     *
     * Kept to a bounded summary: the turn can still use its tools to dig
     * further, this is just the opening context.
     */
    async _describeEvent(event) {
        const payload = event.payload || {};
        const parts = [`Condition: ${event.topic}`];
        if (payload.jobId && String(event.topic).startsWith('observatory.')) {
            const job = await db.get(
                `SELECT j.status, j.exitCode, j.segments, j.resumeCount, j.error,
                        j.stdoutTail, j.stderrTail, j.finishedAt, p.name AS projectName
                 FROM observatory_jobs j
                 JOIN observatory_projects p ON p.id = j.projectId
                 WHERE j.id = @jobId`,
                { jobId: payload.jobId }
            ).catch(() => null);
            if (job) {
                parts.push(`Observatory job #${payload.jobId} in project "${job.projectName}"`
                    + ` finished ${job.finishedAt || 'just now'} with status ${job.status}`
                    + `${job.exitCode === null ? '' : ` (exit ${job.exitCode})`}`
                    + `, after ${job.segments} segment(s) and ${job.resumeCount} checkpoint resume(s).`);
                if (job.error) parts.push(`Reported error: ${job.error}`);
                if (job.stdoutTail) parts.push(`Tail of its output:\n${job.stdoutTail}`);
                if (job.stderrTail) parts.push(`Tail of stderr:\n${job.stderrTail}`);
            }
        }
        const extras = Object.entries(payload)
            .filter(([key]) => !['userId', 'jobId'].includes(key))
            .map(([key, value]) => `${key}=${value}`);
        if (extras.length > 0) parts.push(`Event details: ${extras.join(', ')}`);
        return parts.join('\n');
    }

    /**
     * Run the watch as an unattended agent turn. This is the automation
     * pseudo-interaction shape on purpose: one pipeline, one tool registry,
     * one set of guardrails for every unattended turn Goobster takes.
     */
    async _runTurn(watch, event) {
        if (!this.client) {
            throw new Error('no Discord client attached (watches fire in the bot process)');
        }
        const { handleChatInteraction } = require('../utils/chatHandler');
        const { chunkMessage } = require('../utils');

        const user = await this.client.users.fetch(watch.userId);
        const channel = watch.channelId
            ? await this.client.channels.fetch(watch.channelId).catch(() => null)
            : await user.createDM();
        if (!channel?.isTextBased?.()) {
            throw new Error('the delivery channel is gone');
        }
        const inDm = !watch.channelId || isDmScopeId(watch.guildId);

        const deliver = async (response) => {
            const content = typeof response === 'string' ? response : response?.content;
            if (!content) return;
            const chunks = chunkMessage(`🔔 **${watch.label}**\n\n${content}`);
            let sent;
            for (const [index, chunk] of chunks.entries()) {
                sent = await channel.send({
                    content: chunk,
                    embeds: index === chunks.length - 1 && typeof response === 'object'
                        ? response.embeds
                        : undefined,
                    allowedMentions: { users: [watch.userId], roles: [] }
                });
            }
            return sent;
        };

        const guild = inDm ? null : (channel.guild || null);
        const member = guild
            ? await guild.members.fetch(watch.userId).catch(() => null)
            : null;
        const evidence = await this._describeEvent(event);

        const pseudoInteraction = {
            user,
            member,
            guild,
            guildId: guild?.id || null,
            channel,
            channelId: channel.id,
            client: this.client,
            content: watch.prompt,
            // A watch turn is an unattended turn: same trusted-surface tool
            // set as an automation, same refusal to spawn new automations.
            isAutomation: true,
            sourceDescription:
                `A condition ${user.username} asked you to watch for just happened, and you woke up ` +
                `because of it. Nobody sent you a prompt and nobody is waiting at a keyboard.\n\n` +
                `WHAT HAPPENED:\n${evidence}\n\n` +
                `Carry out the instruction now against that, using your tools if you need more than the ` +
                `summary above. Then tell them what you found and what you make of it - not merely that ` +
                `the event occurred, which they can already see for themselves.`,
            deferReply: async () => channel.sendTyping?.(),
            editReply: deliver,
            reply: deliver,
            sendFullResponse: async (text) => await deliver(text),
            options: { getString: () => watch.prompt }
        };

        await handleChatInteraction(pseudoInteraction);
    }

    /** Erase one person's watches (privacy / forget-me). */
    async forgetUser(userId, handle = db) {
        if (!userId) return 0;
        return (await handle.run(
            'DELETE FROM attention_watches WHERE userId = @userId',
            { userId }
        )).changes;
    }
}

AttentionWatchService.instance = null;

module.exports = new AttentionWatchService();
module.exports.AttentionWatchService = AttentionWatchService;
module.exports.WatchError = WatchError;
module.exports.WATCHABLE_TOPICS = WATCHABLE_TOPICS;
