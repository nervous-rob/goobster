/**
 * Web portal scheduled tasks: surfaces the bot's existing automations
 * (recurring cron prompts run as unattended agent turns) and followups
 * (one-shot or interval-recurring reminders) so a user can view, create,
 * and cancel their scheduled prompts from the browser. Cancelling a
 * recurring followup ends the whole series (rows stay PENDING between
 * occurrences, so the same PENDING-gated cancel covers both kinds).
 *
 * Portal-created tasks live in the user's DM scope (guildId "dm:<userId>")
 * and deliver to their Discord DM channel - the one place the bot can
 * always reach them. automationService executes DM-scope rows through the
 * same handleChatInteraction pipeline as guild automations (a DM-shaped
 * pseudo-interaction, never a parallel executor). Guild automations the
 * user created via /automation are listed (and cancellable - the same
 * authority /automation delete gives them) but new guild automations stay
 * a Discord-side action.
 */

const { CronExpressionParser } = require('cron-parser');
const db = require('../db');
const { dmScopeId, isDmScopeId } = require('../utils/dmScope');
const { validateCron } = require('./automationManagerService');

const MAX_NAME_LENGTH = 60;
const MAX_PROMPT_LENGTH = 2000;
const MAX_FOLLOWUP_NOTE_LENGTH = 500; // the followups.note storage cap
const MAX_AUTOMATIONS_PER_USER = 10;  // portal-created (DM-scope) rows
const MAX_PENDING_FOLLOWUPS_PER_USER = 10;
const MAX_ONESHOT_AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** Machine-readable web app error (the PanelError status+code contract). */
class WebTaskError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'WebTaskError';
        this.status = status;
        this.code = code;
    }
}

/** 'YYYY-MM-DD HH:MM:SS' UTC text (the timestamp format the tables use). */
function toUtcText(date) {
    return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

class WebTaskService {
    /**
     * Everything the user has scheduled, bot-wide: automations they own
     * (DM-scope and guild) plus their pending one-shot followups.
     * @param {Object} params - { client, userId }
     */
    listTasks({ client, userId }) {
        const scopeName = (guildId) => {
            if (isDmScopeId(guildId)) return 'Direct messages';
            return client?.guilds?.cache?.get?.(guildId)?.name || `Server ${guildId}`;
        };

        const automations = db.all(
            `SELECT id, guildId, name, promptText, schedule, isEnabled, lastRun, nextRun, metadata
             FROM automations WHERE userId = @userId
             ORDER BY isEnabled DESC, COALESCE(nextRun, '9999') ASC, id DESC`,
            { userId }
        ).map(row => {
            let originalSchedule = null;
            try {
                originalSchedule = JSON.parse(row.metadata || '{}').originalSchedule || null;
            } catch { /* no metadata */ }
            return {
                id: row.id,
                kind: 'automation',
                name: row.name,
                prompt: row.promptText,
                schedule: row.schedule,
                scheduleLabel: originalSchedule,
                enabled: Boolean(row.isEnabled),
                lastRun: row.lastRun,
                nextRun: row.nextRun,
                scope: isDmScopeId(row.guildId) ? 'dm' : 'guild',
                scopeName: scopeName(row.guildId)
            };
        });

        const followups = db.all(
            `SELECT id, guildId, note, dueAt, createdAt, recurrence, recurMinutes, deliveryCount FROM followups
             WHERE userId = @userId AND status = 'PENDING'
             ORDER BY dueAt ASC`,
            { userId }
        ).map(row => ({
            id: row.id,
            kind: 'followup',
            prompt: row.note,
            dueAt: row.dueAt,
            createdAt: row.createdAt,
            recurrence: row.recurrence,
            recurMinutes: row.recurMinutes,
            deliveryCount: row.deliveryCount,
            scope: isDmScopeId(row.guildId) ? 'dm' : 'guild',
            scopeName: scopeName(row.guildId)
        }));

        return { automations, followups };
    }

    /**
     * Validate a 5-part cron and its firing cadence; returns the next run.
     * The one shared implementation lives in automationManagerService (the
     * 15-minute-gap guardrail must be identical on every creation surface);
     * this wrapper only maps failures onto the web error contract.
     */
    _validateCron(cron) {
        try {
            return validateCron(cron);
        } catch (error) {
            throw new WebTaskError(400, error.code || 'BAD_SCHEDULE', error.message);
        }
    }

    /** Resolve (creating if needed) the user's DM channel for delivery. */
    async _dmChannel({ client, userId }) {
        if (!client?.users?.fetch) {
            throw new WebTaskError(503, 'BOT_OFFLINE', 'Goobster is not connected to Discord yet.');
        }
        try {
            const user = await client.users.fetch(userId);
            return await user.createDM();
        } catch (error) {
            throw new WebTaskError(502, 'DM_UNAVAILABLE',
                'Could not open your Discord DM - scheduled prompts are delivered there.', { cause: error });
        }
    }

    /**
     * Create a scheduled prompt. `cron` makes a recurring automation;
     * `dueAt` (ISO 8601, future) makes a one-shot followup. Exactly one of
     * the two must be provided. Delivery is the user's Discord DM.
     * @param {Object} params - { client, userId, name, prompt, cron?, dueAt? }
     */
    async createTask({ client, userId, name, prompt, cron = null, dueAt = null }) {
        const cleanName = String(name ?? '').trim();
        const cleanPrompt = String(prompt ?? '').trim();
        if (!cleanName || cleanName.length > MAX_NAME_LENGTH) {
            throw new WebTaskError(400, 'BAD_NAME', `name is required (max ${MAX_NAME_LENGTH} characters).`);
        }
        if (!cleanPrompt || cleanPrompt.length > MAX_PROMPT_LENGTH) {
            throw new WebTaskError(400, 'BAD_PROMPT', `prompt is required (max ${MAX_PROMPT_LENGTH} characters).`);
        }
        if ((cron && dueAt) || (!cron && !dueAt)) {
            throw new WebTaskError(400, 'BAD_SCHEDULE', 'Provide either a cron schedule (recurring) or a due time (one-shot).');
        }

        const scope = dmScopeId(userId);

        if (cron) {
            const existing = db.get(
                'SELECT COUNT(*) AS c FROM automations WHERE userId = @userId AND guildId = @scope',
                { userId, scope }
            );
            if ((existing?.c || 0) >= MAX_AUTOMATIONS_PER_USER) {
                throw new WebTaskError(400, 'TOO_MANY_TASKS',
                    `At most ${MAX_AUTOMATIONS_PER_USER} recurring tasks - delete one first.`);
            }
            const duplicate = db.get(
                'SELECT 1 AS ok FROM automations WHERE userId = @userId AND guildId = @scope AND name = @name',
                { userId, scope, name: cleanName }
            );
            if (duplicate) {
                throw new WebTaskError(409, 'DUPLICATE_NAME', 'You already have a task with that name.');
            }

            const { cron: cleanCron, nextRun } = this._validateCron(cron);
            const channel = await this._dmChannel({ client, userId });
            const row = db.get(
                `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun, metadata)
                 VALUES (@userId, @scope, @channelId, @name, @prompt, @cron, @nextRun, @metadata)
                 RETURNING id, nextRun`,
                {
                    userId, scope, channelId: channel.id,
                    name: cleanName, prompt: cleanPrompt, cron: cleanCron,
                    nextRun,
                    metadata: JSON.stringify({ createdVia: 'web', originalSchedule: cleanCron })
                }
            );
            return { id: row.id, kind: 'automation', nextRun: row.nextRun };
        }

        // One-shot followup
        if (cleanPrompt.length > MAX_FOLLOWUP_NOTE_LENGTH) {
            throw new WebTaskError(400, 'BAD_PROMPT',
                `One-shot reminders are capped at ${MAX_FOLLOWUP_NOTE_LENGTH} characters.`);
        }
        const due = new Date(String(dueAt));
        if (Number.isNaN(due.getTime())) {
            throw new WebTaskError(400, 'BAD_DUE_AT', 'dueAt must be an ISO 8601 datetime.');
        }
        const now = Date.now();
        if (due.getTime() <= now + 30 * 1000) {
            throw new WebTaskError(400, 'BAD_DUE_AT', 'The due time must be in the future.');
        }
        if (due.getTime() > now + MAX_ONESHOT_AHEAD_MS) {
            throw new WebTaskError(400, 'BAD_DUE_AT', 'The due time is too far in the future (max 2 years).');
        }
        const pending = db.get(
            `SELECT COUNT(*) AS c FROM followups
             WHERE userId = @userId AND guildId = @scope AND status = 'PENDING'`,
            { userId, scope }
        );
        if ((pending?.c || 0) >= MAX_PENDING_FOLLOWUPS_PER_USER) {
            throw new WebTaskError(400, 'TOO_MANY_TASKS',
                `At most ${MAX_PENDING_FOLLOWUPS_PER_USER} pending reminders - cancel one first.`);
        }

        const channel = await this._dmChannel({ client, userId });
        const row = db.get(
            `INSERT INTO followups (guildId, channelId, userId, note, dueAt)
             VALUES (@scope, @channelId, @userId, @note, @dueAt)
             RETURNING id, dueAt`,
            { scope, channelId: channel.id, userId, note: cleanPrompt, dueAt: toUtcText(due) }
        );
        return { id: row.id, kind: 'followup', dueAt: row.dueAt };
    }

    /**
     * Enable/disable one of the user's automations (same semantics as
     * /automation toggle: enabling recomputes the next run).
     * @param {Object} params - { userId, automationId, enabled }
     */
    setAutomationEnabled({ userId, automationId, enabled }) {
        const row = db.get(
            'SELECT id, schedule FROM automations WHERE id = @id AND userId = @userId',
            { id: Number(automationId), userId }
        );
        if (!row) {
            throw new WebTaskError(404, 'NOT_FOUND', 'No such task.');
        }
        if (enabled) {
            const interval = CronExpressionParser.parse(row.schedule);
            db.run(
                `UPDATE automations SET isEnabled = 1, nextRun = @nextRun, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { id: row.id, nextRun: interval.next().toDate() }
            );
        } else {
            db.run(
                `UPDATE automations SET isEnabled = 0, nextRun = NULL, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { id: row.id }
            );
        }
        return { id: row.id, enabled: Boolean(enabled) };
    }

    /**
     * Delete one of the user's automations (DM-scope or guild - the same
     * authority /automation delete already gives the owner).
     * @param {Object} params - { userId, automationId }
     */
    deleteAutomation({ userId, automationId }) {
        const result = db.run(
            'DELETE FROM automations WHERE id = @id AND userId = @userId',
            { id: Number(automationId), userId }
        );
        if (result.changes === 0) {
            throw new WebTaskError(404, 'NOT_FOUND', 'No such task.');
        }
        return { deleted: true };
    }

    /**
     * Cancel one of the user's pending followups.
     * @param {Object} params - { userId, followupId }
     */
    cancelFollowup({ userId, followupId }) {
        const result = db.run(
            `UPDATE followups SET status = 'CANCELLED'
             WHERE id = @id AND userId = @userId AND status = 'PENDING'`,
            { id: Number(followupId), userId }
        );
        if (result.changes === 0) {
            throw new WebTaskError(404, 'NOT_FOUND', 'No such pending reminder.');
        }
        return { cancelled: true };
    }
}

module.exports = new WebTaskService();
module.exports.WebTaskService = WebTaskService;
module.exports.WebTaskError = WebTaskError;
