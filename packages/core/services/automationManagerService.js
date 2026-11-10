/**
 * Durable recurring automations, managed by name within a conversation
 * scope (a guild id or a dm:<userId> scope). This is the shared management
 * layer behind the assistant's manageAutomations tool; the web portal's
 * Tasks pane (webTaskService) reuses the cron validation.
 *
 * Automations are rows in the `automations` table executed by
 * automationService's poll loop - durable by construction (they survive
 * restarts because the schedule and nextRun live in SQLite, not in a
 * process timer). Recurring work belongs here; one-shot reminders belong
 * in followups.
 */

const { CronExpressionParser } = require('cron-parser');
const db = require('../db');

const MAX_NAME_LENGTH = 60;
const MAX_PROMPT_LENGTH = 2000;
const MAX_AUTOMATIONS_PER_SCOPE = 10;   // per user per scope, same cap as the portal
const MIN_RUN_GAP_MS = 15 * 60 * 1000;  // a cron may not fire more than every 15 min
const CRON_SAMPLE_RUNS = 5;

/** Machine-readable automation error (code + user-presentable message). */
class AutomationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AutomationError';
        this.code = code;
    }
}

const changedError = (id) => new AutomationError('CHANGED',
    `Automation #${id} changed while this was being applied; refresh and try again.`);

const archivedError = (row) => new AutomationError('ARCHIVED',
    `"${row.name}" is archived. Restore it from the Assistant's Processes list before switching it on.`);

/** Stored UTC text ('YYYY-MM-DD HH:MM:SS' or ISO) -> epoch ms. */
function utcTextToMs(value) {
    if (value instanceof Date) return value.getTime();
    const text = String(value);
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
}

/**
 * Validate a 5-part cron expression and its firing cadence. An unattended
 * agent turn every minute is a runaway cost, not a feature: the next few
 * fires are sampled and must be at least 15 minutes apart.
 *
 * Crons are evaluated in UTC on every surface (creation here, execution in
 * automationService's claim) - never the server's local timezone.
 * @param {string} cron
 * @returns {{cron: string, nextRun: Date}} normalized cron + its next fire
 */
function validateCron(cron) {
    const clean = String(cron || '').trim().replace(/\s+/g, ' ');
    if (!clean || clean.split(' ').length !== 5 || clean.length > 100) {
        throw new AutomationError('BAD_SCHEDULE',
            'schedule must be a 5-part cron expression (minute hour day month weekday).');
    }
    let interval;
    try {
        interval = CronExpressionParser.parse(clean, { tz: 'UTC' });
    } catch {
        throw new AutomationError('BAD_SCHEDULE', `"${clean}" is not a valid cron expression.`);
    }
    const fires = [];
    for (let i = 0; i < CRON_SAMPLE_RUNS; i++) fires.push(interval.next().toDate().getTime());
    for (let i = 1; i < fires.length; i++) {
        if (fires[i] - fires[i - 1] < MIN_RUN_GAP_MS) {
            throw new AutomationError('SCHEDULE_TOO_FREQUENT',
                'Scheduled tasks may run at most every 15 minutes.');
        }
    }
    return { cron: clean, nextRun: new Date(fires[0]) };
}

class AutomationManagerService {
    /**
     * Create a recurring automation owned by userId in the given scope.
     * @param {Object} params - { userId, scope, channelId, name, prompt, cron, createdVia? }
     * @returns {{id: number, name: string, cron: string, nextRun: Date}}
     */
    async create({ userId, scope, channelId, name, prompt, cron, createdVia = 'assistant' }) {
        const cleanName = String(name ?? '').trim();
        const cleanPrompt = String(prompt ?? '').trim();
        if (!userId || !scope || !channelId) {
            throw new AutomationError('BAD_CONTEXT', 'Automations need a user, scope, and delivery channel.');
        }
        if (!cleanName || cleanName.length > MAX_NAME_LENGTH) {
            throw new AutomationError('BAD_NAME', `name is required (max ${MAX_NAME_LENGTH} characters).`);
        }
        if (!cleanPrompt || cleanPrompt.length > MAX_PROMPT_LENGTH) {
            throw new AutomationError('BAD_PROMPT', `prompt is required (max ${MAX_PROMPT_LENGTH} characters).`);
        }

        const existing = await db.get(
            'SELECT COUNT(*) AS c FROM automations WHERE userId = @userId AND guildId = @scope',
            { userId, scope }
        );
        if ((existing?.c || 0) >= MAX_AUTOMATIONS_PER_SCOPE) {
            throw new AutomationError('TOO_MANY_TASKS',
                `At most ${MAX_AUTOMATIONS_PER_SCOPE} automations here - cancel one first.`);
        }
        if (await this._findByName({ userId, scope, name: cleanName })) {
            throw new AutomationError('DUPLICATE_NAME', `An automation named "${cleanName}" already exists.`);
        }

        const { cron: cleanCron, nextRun } = validateCron(cron);
        const row = await db.get(
            `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun, metadata)
             VALUES (@userId, @scope, @channelId, @name, @prompt, @cron, @nextRun, @metadata)
             RETURNING id`,
            {
                userId, scope, channelId,
                name: cleanName, prompt: cleanPrompt, cron: cleanCron, nextRun,
                metadata: JSON.stringify({ createdVia, originalSchedule: cleanCron })
            }
        );
        return { id: row.id, name: cleanName, cron: cleanCron, nextRun };
    }

    /**
     * The user's automations in this scope (status/reporting view).
     * @param {Object} params - { userId, scope }
     */
    async list({ userId, scope }) {
        return (await db.all(
            `SELECT id, name, promptText, schedule, isEnabled, lastRun, nextRun
             FROM automations
             WHERE userId = @userId AND guildId = @scope
             ORDER BY isEnabled DESC, name ASC`,
            { userId, scope }
        )).map(row => ({
            id: row.id,
            name: row.name,
            prompt: row.promptText,
            cron: row.schedule,
            enabled: Boolean(row.isEnabled),
            lastRun: row.lastRun,
            nextRun: row.nextRun
        }));
    }

    /**
     * Pause or resume one of the user's automations (same semantics as
     * /automation toggle: resuming recomputes the next run).
     * @param {Object} params - { userId, scope, name, enabled }
     * @returns {{id: number, name: string, enabled: boolean, nextRun: Date|null}}
     */
    async setEnabled({ userId, scope, name, enabled }) {
        const row = await this._findByName({ userId, scope, name });
        if (!row) {
            throw new AutomationError('NOT_FOUND', `No automation named "${String(name ?? '').trim()}" here.`);
        }
        return await this._applyEnabled(row, enabled);
    }

    /**
     * Cancel (delete) one of the user's automations.
     * @param {Object} params - { userId, scope, name }
     * @returns {{id: number, name: string}}
     */
    async remove({ userId, scope, name }) {
        const row = await this._findByName({ userId, scope, name });
        if (!row) {
            throw new AutomationError('NOT_FOUND', `No automation named "${String(name ?? '').trim()}" here.`);
        }
        await db.run('DELETE FROM automations WHERE id = @id', { id: row.id });
        return { id: row.id, name: row.name };
    }

    /**
     * Id-addressed variants for the operator panel (operatorScheduleService),
     * which has already decided the caller may act on this row. They share
     * the cron handling and SQL shape of the name-addressed methods above.
     */
    async _findById(id) {
        const row = await db.get(
            'SELECT id, name, schedule, isEnabled, nextRun, archivedAt FROM automations WHERE id = @id',
            { id: Number(id) }
        );
        if (!row) throw new AutomationError('NOT_FOUND', `No automation #${id}.`);
        return row;
    }

    /** @returns {{id: number, name: string, enabled: boolean, nextRun: Date|null}} */
    async setEnabledById({ id, enabled }) {
        return await this._applyEnabled(await this._findById(id), enabled);
    }

    /** @returns {{id: number, name: string}} */
    async removeById({ id }) {
        const row = await this._findById(id);
        await db.run('DELETE FROM automations WHERE id = @id', { id: row.id });
        return { id: row.id, name: row.name };
    }

    /**
     * Make an enabled automation due now. The poll loop's atomic claim
     * (automationService.claimDueRun) then runs it and advances nextRun to
     * the next cron slot, so the schedule itself is unchanged.
     *
     * Compare-and-swap on the nextRun this call read: if the scheduler
     * claimed a due fire (advancing nextRun) between the read and the write,
     * the write matches nothing and the caller gets CHANGED instead of
     * queueing a second, immediate run. A row that is already due is left
     * alone - the claim will run it exactly once.
     * @returns {{id: number, name: string, alreadyDue?: boolean}}
     */
    async triggerNow({ id }) {
        const row = await this._findById(id);
        if (!row.isEnabled) throw new AutomationError('PAUSED', `Automation #${id} is paused - resume it first.`);
        const now = new Date();
        if (row.nextRun && utcTextToMs(row.nextRun) <= now.getTime()) {
            return { id: row.id, name: row.name, alreadyDue: true };
        }
        const result = await db.run(
            `UPDATE automations SET nextRun = @now, updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id AND isEnabled = 1 AND ${row.nextRun == null ? 'nextRun IS NULL' : 'nextRun = @seenNextRun'}`,
            row.nextRun == null ? { id: row.id, now } : { id: row.id, now, seenNextRun: row.nextRun }
        );
        if (result.changes === 0) throw changedError(id);
        return { id: row.id, name: row.name };
    }

    /**
     * Pause or resume a row already read. Compare-and-swap on the enabled
     * flag and schedule this call saw, so a concurrent pause/resume/edit is
     * reported (CHANGED) instead of silently overwritten.
     */
    async _applyEnabled(row, enabled) {
        const seen = { id: row.id, seenEnabled: row.isEnabled ? 1 : 0, seenSchedule: row.schedule };
        const guard = 'WHERE id = @id AND isEnabled = @seenEnabled AND schedule = @seenSchedule';
        if (enabled) {
            if (row.archivedAt) throw archivedError(row);
            const nextRun = CronExpressionParser.parse(row.schedule, { tz: 'UTC' }).next().toDate();
            // An archived automation cannot be switched on, whoever asks and
            // whenever it was archived: the guard is part of the write.
            const result = await db.run(
                `UPDATE automations SET isEnabled = 1, nextRun = @nextRun, updatedAt = CURRENT_TIMESTAMP ${guard} AND archivedAt IS NULL`,
                { ...seen, nextRun }
            );
            if (result.changes === 0) {
                const now = await db.get('SELECT archivedAt FROM automations WHERE id = @id', { id: row.id });
                throw now?.archivedAt ? archivedError(row) : changedError(row.id);
            }
            return { id: row.id, name: row.name, enabled: true, nextRun };
        }
        const result = await db.run(
            `UPDATE automations SET isEnabled = 0, nextRun = NULL, updatedAt = CURRENT_TIMESTAMP ${guard}`,
            seen
        );
        if (result.changes === 0) throw changedError(row.id);
        return { id: row.id, name: row.name, enabled: false, nextRun: null };
    }

    /**
     * Process stewardship (documentation/process_stewardship.md), called by
     * assistantProcessLifecycleService once it has checked who may act.
     *
     * Pause stops future fires in one write. A run the scheduler had already
     * claimed is not interrupted: it finishes and delivers, and the caller is
     * told how many such runs there were.
     * @returns {Promise<{ changed: boolean }>}
     */
    async stewardPause({ id }) {
        const result = await db.run(
            'UPDATE automations SET isEnabled = 0, nextRun = NULL, updatedAt = CURRENT_TIMESTAMP WHERE id = @id AND isEnabled = 1',
            { id: Number(id) }
        );
        return { changed: result.changes > 0 };
    }

    /** Resume a paused automation at its next scheduled time; never an archived one. */
    async stewardResume({ id }) {
        const row = await this._findById(id);
        if (row.archivedAt) throw archivedError(row);
        if (row.isEnabled) return { changed: false };
        await this._applyEnabled(row, true);
        return { changed: true };
    }

    /** Archive a switched-off automation: the row and its history stay. */
    async stewardArchive({ id, now }) {
        const result = await db.run(
            `UPDATE automations SET archivedAt = @now, nextRun = NULL, updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id AND isEnabled = 0 AND archivedAt IS NULL`,
            { id: Number(id), now }
        );
        return { changed: result.changes > 0 };
    }

    /** Restore an archived automation. It stays switched off. */
    async stewardRestore({ id }) {
        const result = await db.run(
            `UPDATE automations SET archivedAt = NULL, isEnabled = 0, nextRun = NULL, updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id AND archivedAt IS NOT NULL`,
            { id: Number(id) }
        );
        return { changed: result.changes > 0 };
    }

    /** Case-insensitive lookup by name so a chatty caller need not match case. */
    async _findByName({ userId, scope, name }) {
        const cleanName = String(name ?? '').trim();
        if (!cleanName) return null;
        return await db.get(
            `SELECT id, name, schedule, isEnabled, archivedAt FROM automations
             WHERE userId = @userId AND guildId = @scope AND name = @name COLLATE NOCASE`,
            { userId, scope, name: cleanName }
        );
    }
}

module.exports = new AutomationManagerService();
module.exports.AutomationManagerService = AutomationManagerService;
module.exports.AutomationError = AutomationError;
module.exports.validateCron = validateCron;
