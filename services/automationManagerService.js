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

/**
 * Validate a 5-part cron expression and its firing cadence. An unattended
 * agent turn every minute is a runaway cost, not a feature: the next few
 * fires are sampled and must be at least 15 minutes apart.
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
        interval = CronExpressionParser.parse(clean);
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
    create({ userId, scope, channelId, name, prompt, cron, createdVia = 'assistant' }) {
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

        const existing = db.get(
            'SELECT COUNT(*) AS c FROM automations WHERE userId = @userId AND guildId = @scope',
            { userId, scope }
        );
        if ((existing?.c || 0) >= MAX_AUTOMATIONS_PER_SCOPE) {
            throw new AutomationError('TOO_MANY_TASKS',
                `At most ${MAX_AUTOMATIONS_PER_SCOPE} automations here - cancel one first.`);
        }
        if (this._findByName({ userId, scope, name: cleanName })) {
            throw new AutomationError('DUPLICATE_NAME', `An automation named "${cleanName}" already exists.`);
        }

        const { cron: cleanCron, nextRun } = validateCron(cron);
        const row = db.get(
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
    list({ userId, scope }) {
        return db.all(
            `SELECT id, name, promptText, schedule, isEnabled, lastRun, nextRun
             FROM automations
             WHERE userId = @userId AND guildId = @scope
             ORDER BY isEnabled DESC, name ASC`,
            { userId, scope }
        ).map(row => ({
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
    setEnabled({ userId, scope, name, enabled }) {
        const row = this._findByName({ userId, scope, name });
        if (!row) {
            throw new AutomationError('NOT_FOUND', `No automation named "${String(name ?? '').trim()}" here.`);
        }
        if (enabled) {
            const nextRun = CronExpressionParser.parse(row.schedule).next().toDate();
            db.run(
                `UPDATE automations SET isEnabled = 1, nextRun = @nextRun, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { id: row.id, nextRun }
            );
            return { id: row.id, name: row.name, enabled: true, nextRun };
        }
        db.run(
            `UPDATE automations SET isEnabled = 0, nextRun = NULL, updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { id: row.id }
        );
        return { id: row.id, name: row.name, enabled: false, nextRun: null };
    }

    /**
     * Cancel (delete) one of the user's automations.
     * @param {Object} params - { userId, scope, name }
     * @returns {{id: number, name: string}}
     */
    remove({ userId, scope, name }) {
        const row = this._findByName({ userId, scope, name });
        if (!row) {
            throw new AutomationError('NOT_FOUND', `No automation named "${String(name ?? '').trim()}" here.`);
        }
        db.run('DELETE FROM automations WHERE id = @id', { id: row.id });
        return { id: row.id, name: row.name };
    }

    /** Case-insensitive lookup by name so a chatty caller need not match case. */
    _findByName({ userId, scope, name }) {
        const cleanName = String(name ?? '').trim();
        if (!cleanName) return null;
        return db.get(
            `SELECT id, name, schedule, isEnabled FROM automations
             WHERE userId = @userId AND guildId = @scope AND name = @name COLLATE NOCASE`,
            { userId, scope, name: cleanName }
        );
    }
}

module.exports = new AutomationManagerService();
module.exports.AutomationManagerService = AutomationManagerService;
module.exports.AutomationError = AutomationError;
module.exports.validateCron = validateCron;
