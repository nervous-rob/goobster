/**
 * The operator's view of guild-facing recurring work
 * (documentation/operator_schedules.md).
 *
 * Automations and follow-ups are owner-scoped everywhere else: the
 * owner manages them through /automation and the Tasks pane, and nobody
 * else can. When an owner will not (or cannot) turn something off, the
 * installation's operator needs the same four verbs over *any* row that
 * posts into a server: pause, resume, run now, delete. This service is
 * that, and nothing more.
 *
 * Boundaries:
 *  - Guild-facing only. A row whose scope is `dm:<userId>` or whose
 *    channel is `inbox:<userId>` is a person's private task; it is never
 *    listed and every action refuses it (`NOT_GUILD_SCOPE`).
 *  - No prompt text leaves this service. Automations are identified by
 *    name and kind label; a reminder carries its clipped note because
 *    that note is what is posted to the channel.
 *  - The cron and delivery machinery is not duplicated: automations go
 *    through automationManagerService's id-addressed methods, reminders
 *    through followupService.
 *
 * Callers (routes/admin.js) write the operator_audit row after a call
 * succeeds; the service itself only tells the owner, best-effort.
 */

const db = require('../db');
const logger = require('../utils/logger');
const automationManager = require('./automationManagerService');
const followupService = require('./followupService');
const { isDmScopeId } = require('../utils/dmScope');

const KINDS = ['automation', 'followup'];
const STATUSES = ['active', 'paused'];
const NOTE_PREVIEW = 120;

const AUTOMATION_LABELS = {
    __CHANNEL_DIGEST__: 'digest',
    __SERVER_WRAPPED__: 'wrapped',
    __GOBLIN_WHEEL__: 'wheel'
};

class OperatorScheduleError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'OperatorScheduleError';
        this.status = status;
        this.code = code;
    }
}

function toUtcText(date = new Date()) {
    return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function utcTextToMs(text) {
    return new Date(`${String(text).replace(' ', 'T')}Z`).getTime();
}

function isGuildFacing(row) {
    return Boolean(row.guildId) && !isDmScopeId(row.guildId)
        && !(typeof row.channelId === 'string' && row.channelId.startsWith('inbox:'));
}

function describeCadence(row) {
    return row.kind === 'automation' ? row.schedule : row.recurrence;
}

function capabilities(row) {
    if (row.kind === 'automation') return ['pause', 'resume', 'trigger', 'delete'];
    return row.recurring ? ['pause', 'resume', 'trigger', 'delete'] : ['trigger', 'delete'];
}

class OperatorScheduleService {
    constructor() {
        this.OperatorScheduleError = OperatorScheduleError;
        this.KINDS = KINDS;
        this.STATUSES = STATUSES;
    }

    _automationRow(row) {
        const view = {
            key: `automation:${row.id}`,
            kind: 'automation',
            id: Number(row.id),
            name: row.name,
            label: AUTOMATION_LABELS[row.promptText] || 'prompt',
            guildId: row.guildId,
            channelId: row.channelId,
            ownerId: row.userId,
            schedule: row.schedule,
            recurrence: null,
            recurring: true,
            paused: !row.isEnabled,
            lastRunAt: row.lastRun || null,
            nextRunAt: row.isEnabled ? row.nextRun || null : null,
            deliveryCount: null,
            note: null,
            createdAt: row.createdAt
        };
        return { ...view, cadence: describeCadence(view), actions: capabilities(view) };
    }

    _followupRow(row) {
        const view = {
            key: `followup:${row.id}`,
            kind: 'followup',
            id: Number(row.id),
            name: null,
            label: 'reminder',
            guildId: row.guildId,
            channelId: row.channelId,
            ownerId: row.userId || null,
            schedule: null,
            recurrence: row.recurrence || null,
            recurring: Boolean(row.recurMinutes),
            paused: Boolean(row.pausedAt),
            lastRunAt: row.lastDeliveredAt || null,
            nextRunAt: row.pausedAt ? null : row.dueAt,
            deliveryCount: Number(row.deliveryCount || 0),
            note: String(row.note || '').slice(0, NOTE_PREVIEW),
            createdAt: row.createdAt
        };
        return { ...view, cadence: row.recurMinutes ? describeCadence(view) : null, actions: capabilities(view) };
    }

    /**
     * Every guild-facing recurring or scheduled row, newest first within
     * server. Names are resolved through the gateway, best-effort: an
     * offline bot degrades to ids and `botOnline: false`, never an error.
     * @param {{ gateway?: Object|null, guildId?: string, kind?: string, status?: string }} [options]
     */
    async list({ gateway = null, guildId = null, kind = null, status = null } = {}) {
        if (kind && !KINDS.includes(kind)) throw new OperatorScheduleError(400, 'BAD_KIND', `kind must be one of ${KINDS.join(', ')}.`);
        if (status && !STATUSES.includes(status)) throw new OperatorScheduleError(400, 'BAD_STATUS', `status must be one of ${STATUSES.join(', ')}.`);

        const rows = [];
        if (!kind || kind === 'automation') {
            const automations = await db.all(
                `SELECT id, userId, guildId, channelId, name, promptText, schedule, isEnabled, lastRun, nextRun, createdAt
                 FROM automations
                 WHERE guildId NOT LIKE 'dm:%' AND channelId NOT LIKE 'inbox:%'
                 ORDER BY id DESC`
            );
            rows.push(...automations.filter(isGuildFacing).map(row => this._automationRow(row)));
        }
        if (!kind || kind === 'followup') {
            const followups = await db.all(
                `SELECT id, userId, guildId, channelId, note, dueAt, recurMinutes, recurrence, deliveryCount,
                        lastDeliveredAt, pausedAt, createdAt
                 FROM followups
                 WHERE status = 'PENDING' AND guildId NOT LIKE 'dm:%' AND channelId NOT LIKE 'inbox:%'
                 ORDER BY id DESC`
            );
            rows.push(...followups.filter(isGuildFacing).map(row => this._followupRow(row)));
        }

        const allGuildIds = [...new Set(rows.map(row => row.guildId))];
        const names = await this._guildNames(gateway, allGuildIds);
        const owners = await this._ownerNames(gateway, [...new Set(rows.map(row => row.ownerId).filter(Boolean))]);
        const botOnline = await this.botOnline(gateway);

        const counts = new Map();
        for (const row of rows) counts.set(row.guildId, (counts.get(row.guildId) || 0) + 1);
        const guilds = allGuildIds
            .map(id => ({ id, name: names.get(id) || null, count: counts.get(id) }))
            .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));

        const schedules = rows
            .filter(row => (!guildId || row.guildId === String(guildId))
                && (!status || (status === 'paused') === row.paused))
            .map(row => ({
                ...row,
                guildName: names.get(row.guildId) || null,
                ownerName: row.ownerId ? owners.get(row.ownerId) || null : null
            }));
        return { schedules, guilds, botOnline };
    }

    async botOnline(gateway) {
        if (!gateway) return false;
        try {
            return Boolean(await gateway.available());
        } catch {
            return false;
        }
    }

    async _guildNames(gateway, guildIds) {
        const names = new Map();
        if (!gateway) return names;
        await Promise.all(guildIds.map(async (id) => {
            try {
                const meta = await gateway.guildMeta(id);
                if (meta?.name) names.set(id, meta.name);
            } catch { /* offline or unknown - the id is the label */ }
        }));
        return names;
    }

    async _ownerNames(gateway, userIds) {
        const names = new Map();
        if (!gateway) return names;
        await Promise.all(userIds.map(async (id) => {
            try {
                const user = await gateway.getUser(id);
                const name = user?.globalName || user?.username;
                if (name) names.set(id, name);
            } catch { /* offline or unknown - the id is the label */ }
        }));
        return names;
    }

    /** One row as the list shape, or a typed refusal. */
    async get(kind, id, { gateway = null } = {}) {
        const raw = await this._load(kind, id);
        const view = kind === 'automation' ? this._automationRow(raw) : this._followupRow(raw);
        const names = await this._guildNames(gateway, [view.guildId]);
        return { ...view, guildName: names.get(view.guildId) || null, ownerName: null };
    }

    async _load(kind, id) {
        if (!KINDS.includes(kind)) throw new OperatorScheduleError(400, 'BAD_KIND', `kind must be one of ${KINDS.join(', ')}.`);
        const numeric = Number(id);
        if (!Number.isInteger(numeric) || numeric <= 0) throw new OperatorScheduleError(400, 'BAD_ID', 'id must be a positive integer.');
        const row = kind === 'automation'
            ? await db.get(
                `SELECT id, userId, guildId, channelId, name, promptText, schedule, isEnabled, lastRun, nextRun, createdAt
                 FROM automations WHERE id = @id`, { id: numeric })
            : await db.get(
                `SELECT id, userId, guildId, channelId, note, dueAt, recurMinutes, recurrence, deliveryCount,
                        lastDeliveredAt, pausedAt, status, createdAt
                 FROM followups WHERE id = @id`, { id: numeric });
        if (!row || (kind === 'followup' && row.status !== 'PENDING')) {
            throw new OperatorScheduleError(404, 'NOT_FOUND', `No ${kind === 'automation' ? 'automation' : 'reminder'} #${numeric}.`);
        }
        if (!isGuildFacing(row)) {
            throw new OperatorScheduleError(403, 'NOT_GUILD_SCOPE',
                'That task is private to its owner; the host panel only manages tasks that post into a server.');
        }
        return row;
    }

    /** @returns {Promise<{ kind: string, id: number, guildId: string, paused: boolean }>} */
    async pause(kind, id) {
        const row = await this._load(kind, id);
        if (kind === 'automation') {
            if (!row.isEnabled) throw new OperatorScheduleError(409, 'ALREADY_PAUSED', 'That automation is already paused.');
            await this._automation(() => automationManager.setEnabledById({ id: row.id, enabled: false }));
        } else {
            if (!row.recurMinutes) throw new OperatorScheduleError(409, 'UNSUPPORTED', 'A one-time reminder cannot be paused; run it now or cancel it.');
            if (row.pausedAt) throw new OperatorScheduleError(409, 'ALREADY_PAUSED', 'That reminder is already paused.');
            const changes = (await db.run(
                `UPDATE followups SET pausedAt = @now WHERE id = @id AND status = 'PENDING' AND pausedAt IS NULL`,
                { id: row.id, now: toUtcText() }
            )).changes;
            if (changes === 0) throw new OperatorScheduleError(409, 'CHANGED', 'That reminder changed while you were looking; refresh and try again.');
        }
        await this._notifyOwner(row, kind, 'paused');
        return { kind, id: row.id, guildId: row.guildId, paused: true };
    }

    async resume(kind, id) {
        const row = await this._load(kind, id);
        if (kind === 'automation') {
            if (row.isEnabled) throw new OperatorScheduleError(409, 'NOT_PAUSED', 'That automation is not paused.');
            await this._automation(() => automationManager.setEnabledById({ id: row.id, enabled: true }),
                'BAD_SCHEDULE', 'That automation\'s schedule is not a valid cron expression, so it cannot resume.');
        } else {
            if (!row.pausedAt) throw new OperatorScheduleError(409, 'NOT_PAUSED', 'That reminder is not paused.');
            // Nothing fires late: an occurrence that came due while paused is
            // skipped, a still-future one is kept.
            const now = Date.now();
            const dueAt = utcTextToMs(row.dueAt) > now
                ? row.dueAt
                : followupService.nextOccurrence(row.dueAt, row.recurMinutes, now);
            const changes = (await db.run(
                `UPDATE followups SET pausedAt = NULL, dueAt = @dueAt
                 WHERE id = @id AND status = 'PENDING' AND pausedAt IS NOT NULL`,
                { id: row.id, dueAt }
            )).changes;
            if (changes === 0) throw new OperatorScheduleError(409, 'CHANGED', 'That reminder changed while you were looking; refresh and try again.');
        }
        return { kind, id: row.id, guildId: row.guildId, paused: false };
    }

    /**
     * Make a row due now. The scheduler (the bot's automation poll or the
     * reminder delivery tick) claims and runs it within about a minute.
     */
    async trigger(kind, id) {
        const row = await this._load(kind, id);
        if (kind === 'automation') {
            if (!row.isEnabled) throw new OperatorScheduleError(409, 'PAUSED', 'That automation is paused - resume it first.');
            await this._automation(() => automationManager.triggerNow({ id: row.id }));
        } else {
            if (row.pausedAt) throw new OperatorScheduleError(409, 'PAUSED', 'That reminder is paused - resume it first.');
            const changes = (await db.run(
                `UPDATE followups SET dueAt = @now WHERE id = @id AND status = 'PENDING' AND pausedAt IS NULL`,
                { id: row.id, now: toUtcText() }
            )).changes;
            if (changes === 0) throw new OperatorScheduleError(409, 'CHANGED', 'That reminder changed while you were looking; refresh and try again.');
        }
        return { kind, id: row.id, guildId: row.guildId };
    }

    /** Delete an automation; cancel a reminder (its history row stays). */
    async remove(kind, id) {
        const row = await this._load(kind, id);
        if (kind === 'automation') {
            await this._automation(() => automationManager.removeById({ id: row.id }));
        } else if (await followupService.cancel(row.id) === 0) {
            throw new OperatorScheduleError(404, 'NOT_FOUND', `No reminder #${row.id}.`);
        }
        await this._notifyOwner(row, kind, 'deleted');
        return { kind, id: row.id, guildId: row.guildId, deleted: true };
    }

    /** Map the automation layer's errors (and a bad cron) onto the route contract. */
    async _automation(fn, otherCode = 'FAILED', otherMessage = 'The automation could not be changed.') {
        try {
            return await fn();
        } catch (error) {
            if (error?.name !== 'AutomationError') throw new OperatorScheduleError(409, otherCode, otherMessage);
            throw new OperatorScheduleError(error.code === 'NOT_FOUND' ? 404 : 409, error.code, error.message);
        }
    }

    /** Never silent: the owner's Inbox says what the host did. Never throws. */
    async _notifyOwner(row, kind, verb) {
        if (!row.userId) return;
        try {
            const what = kind === 'automation' ? `scheduled task "${row.name}"` : 'recurring reminder';
            await require('./inboxService').deliver({
                userId: row.userId,
                kind: 'system',
                title: `The host ${verb} one of your ${kind === 'automation' ? 'scheduled tasks' : 'reminders'}`,
                body: `The host of this installation ${verb} your ${what}`
                    + `${kind === 'followup' ? ` ("${String(row.note || '').slice(0, NOTE_PREVIEW)}")` : ''}. `
                    + (verb === 'paused' ? 'It will not run until the host resumes it.' : 'It will not run again.'),
                source: { type: 'operator_schedule', id: `${kind}:${row.id}` },
                link: '/activity/scheduled'
            });
        } catch (error) {
            logger.warn?.(`[operator_schedules] Could not notify the owner of ${kind} #${row.id}: ${error.message}`);
        }
    }
}

module.exports = new OperatorScheduleService();
module.exports.OperatorScheduleService = OperatorScheduleService;
module.exports.OperatorScheduleError = OperatorScheduleError;
