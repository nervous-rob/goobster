const db = require('../db');
const { CronExpressionParser } = require('cron-parser');
const aiService = require('./aiService');

/**
 * Management layer over the durable `automations` table: the recurring
 * scheduled tasks executed by automationService's minute poll. Rows live in
 * SQLite, so schedules survive restarts, and the executor advances nextRun
 * after every fire (success or error) so an occurrence never runs twice.
 *
 * Consumers: the /automation slash command (schedule conversion helpers) and
 * the manageAutomation AI tool (full create/list/pause/resume/update/cancel),
 * which is how a chat request like "check the lab feed every hour" becomes a
 * durable automation instead of a chained one-shot follow-up.
 */

const MAX_NAME_LENGTH = 60;       // matches the portal Tasks pane
const MAX_PROMPT_LENGTH = 2000;
const MAX_AUTOMATIONS_PER_SCOPE = 10; // tool-created cap per user per scope
const MIN_RUN_GAP_MS = 15 * 60 * 1000; // a cron may not fire more than every 15 min
const CRON_SAMPLE_RUNS = 5;

// Helper function to convert natural language to cron expression
async function convertToCron(schedule) {
    try {
        const cronText = await aiService.chatText([
            {
                role: 'system',
                content: `You are a cron expression converter. Convert any natural language scheduling description into a cron expression.
                Only respond with the cron expression, nothing else.
                Format: minute hour day-of-month month day-of-week
                
                Always use the standard 5-part cron format with EXACTLY one space between each part (no extra spaces).
                The format must be strictly: "m h dom mon dow" where each part is separated by exactly one space.
                
                Examples:
                - "every day at 9am" -> "0 9 * * *"
                - "every Monday at 3:30pm" -> "30 15 * * 1"
                - "every hour" -> "0 * * * *"
                - "every 30 minutes" -> "*/30 * * * *"
                - "at 2:45pm on weekdays" -> "45 14 * * 1-5"
                - "Every 30 minutes" -> "*/30 * * * *"
                - "every thirty minutes" -> "*/30 * * * *"
                - "each half hour" -> "*/30 * * * *"
                - "twice per hour" -> "0,30 * * * *"
                - "every other hour" -> "0 */2 * * *"
                - "thrice daily" -> "0 */8 * * *"
                - "weekday mornings" -> "0 9 * * 1-5"
                - "weekend afternoons" -> "0 14 * * 0,6"
                
                Be flexible and creative in interpreting the input. If the input is ambiguous, make a reasonable assumption.
                If you're unsure about the exact interpretation, choose a reasonable default that matches the spirit of the request.
                
                IMPORTANT: Your response must ONLY be a 5-part cron expression with one space between each part, matching this pattern: "m h dom mon dow"
                If the input is completely invalid or impossible to interpret, respond with "INVALID"`
            },
            {
                role: 'user',
                content: schedule
            }
        ], {
            preset: 'deterministic',
            max_tokens: 20
        });

        const cronExpression = cronText.trim();
        if (cronExpression === 'INVALID') {
            throw new Error('Could not understand the schedule description. Please try rephrasing it.');
        }

        // Format validation - ensure we have the standard 5-part cron format
        // m h dom mon dow
        const cronParts = cronExpression.split(' ');
        if (cronParts.length !== 5) {
            console.error('Invalid cron format (wrong number of parts):', cronExpression);
            throw new Error('Failed to create a valid schedule format. Please try rephrasing your request.');
        }

        // Validate the generated cron expression using the CronExpressionParser
        try {
            CronExpressionParser.parse(cronExpression);

            // Reformat the cron expression to strictly match database constraint pattern
            // This ensures the spacing is exactly as the SQL constraint requires
            const formattedCron = cronParts.join(' ');
            console.log(`Formatted cron expression: "${formattedCron}"`);

            return formattedCron;
        } catch (cronError) {
            console.error('Invalid cron expression generated:', cronError);
            throw new Error('Failed to create a valid schedule. Please try rephrasing your request.', { cause: cronError });
        }
    } catch (error) {
        if (error.message.includes('Could not understand')) {
            throw error;
        }
        throw new Error('Failed to convert schedule. Please try again with a clearer description.', { cause: error });
    }
}

// Manually handle common schedule patterns so they never depend on a model call
function getManualCron(scheduleText) {
    const lowerSchedule = scheduleText.toLowerCase().trim();

    // Common patterns that might need special handling
    if (lowerSchedule === 'every 30 minutes' || lowerSchedule === 'every thirty minutes' || lowerSchedule === 'each half hour') {
        return '*/30 * * * *';
    }
    if (lowerSchedule === 'hourly' || lowerSchedule === 'every hour') {
        return '0 * * * *';
    }
    if (lowerSchedule === 'daily' || lowerSchedule === 'every day') {
        return '0 0 * * *';
    }
    if (lowerSchedule === 'weekly' || lowerSchedule === 'every week') {
        return '0 0 * * 0';
    }
    if (lowerSchedule === 'monthly' || lowerSchedule === 'every month') {
        return '0 0 1 * *';
    }

    // No match found, return null to proceed with AI-based conversion
    return null;
}

/**
 * Resolve a schedule description into a validated cron expression.
 * Accepts a raw 5-part cron, a known manual pattern ("every hour"), or
 * natural language (converted via a deterministic model call). Enforces the
 * same 15-minute firing floor as the portal: automations are unattended
 * agent turns, and a minute-cadence cron is a runaway cost, not a feature.
 * @param {string} scheduleText
 * @returns {Promise<{cron: string, nextRun: Date}>}
 */
async function resolveSchedule(scheduleText) {
    const clean = String(scheduleText || '').trim().replace(/\s+/g, ' ');
    if (!clean) throw new Error('A schedule is required, e.g. "every hour" or "0 * * * *".');

    let cron = null;
    if (clean.split(' ').length === 5) {
        try {
            CronExpressionParser.parse(clean);
            cron = clean;
        } catch { /* not a raw cron - fall through to conversion */ }
    }
    if (!cron) cron = getManualCron(clean);
    if (!cron) cron = await convertToCron(clean);
    if (cron.length > 100) throw new Error('That schedule is too long.');

    // Guardrail (portal parity): sample the next fires and require a gap.
    const interval = CronExpressionParser.parse(cron);
    const fires = [];
    for (let i = 0; i < CRON_SAMPLE_RUNS; i++) fires.push(interval.next().toDate().getTime());
    for (let i = 1; i < fires.length; i++) {
        if (fires[i] - fires[i - 1] < MIN_RUN_GAP_MS) {
            throw new Error('Automations may run at most every 15 minutes.');
        }
    }
    return { cron, nextRun: new Date(fires[0]) };
}

class AutomationManagementService {
    /**
     * Create a durable recurring automation.
     * @param {Object} params
     * @param {string} params.userId - owning user snowflake
     * @param {string} params.scopeId - guild id or "dm:<userId>" scope
     * @param {string} params.channelId - delivery channel
     * @param {string} params.name - unique per user+scope
     * @param {string} params.prompt - the unattended agent task
     * @param {string} params.schedule - cron, manual pattern, or natural language
     * @param {string} [params.createdVia] - metadata provenance tag
     * @returns {Promise<{id: number, cron: string, nextRun: Date}>}
     */
    async create({ userId, scopeId, channelId, name, prompt, schedule, createdVia = 'tool' }) {
        if (!userId || !scopeId || !channelId) {
            throw new Error('Automations need a user, scope, and delivery channel.');
        }
        const cleanName = String(name ?? '').trim();
        const cleanPrompt = String(prompt ?? '').trim();
        if (!cleanName || cleanName.length > MAX_NAME_LENGTH) {
            throw new Error(`A name is required (max ${MAX_NAME_LENGTH} characters).`);
        }
        if (!cleanPrompt || cleanPrompt.length > MAX_PROMPT_LENGTH) {
            throw new Error(`A task prompt is required (max ${MAX_PROMPT_LENGTH} characters).`);
        }

        const count = db.get(
            'SELECT COUNT(*) AS c FROM automations WHERE userId = @userId AND guildId = @scopeId',
            { userId, scopeId }
        );
        if ((count?.c || 0) >= MAX_AUTOMATIONS_PER_SCOPE) {
            throw new Error(`You already have ${MAX_AUTOMATIONS_PER_SCOPE} automations here - cancel one first.`);
        }

        // Names are the user-facing handle for pause/update/cancel, so a
        // duplicate is refused instead of silently creating a second copy of
        // the same recurring job.
        const duplicate = db.get(
            'SELECT id FROM automations WHERE userId = @userId AND guildId = @scopeId AND name = @name',
            { userId, scopeId, name: cleanName }
        );
        if (duplicate) {
            throw new Error(`An automation named "${cleanName}" already exists - update or cancel it instead of creating a duplicate.`);
        }

        const { cron, nextRun } = await resolveSchedule(schedule);
        const result = db.run(
            `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun, metadata)
             VALUES (@userId, @scopeId, @channelId, @name, @prompt, @cron, @nextRun, @metadata)`,
            {
                userId, scopeId, channelId,
                name: cleanName, prompt: cleanPrompt, cron, nextRun,
                metadata: JSON.stringify({ createdVia, originalSchedule: String(schedule).trim() })
            }
        );
        return { id: Number(result.lastInsertRowid), cron, nextRun };
    }

    /**
     * The user's automations in a scope, newest-firing first.
     * @param {Object} params - { userId, scopeId }
     * @returns {Array<Object>}
     */
    list({ userId, scopeId }) {
        return db.all(
            `SELECT id, name, promptText, schedule, isEnabled, lastRun, nextRun, metadata
             FROM automations
             WHERE userId = @userId AND guildId = @scopeId
             ORDER BY isEnabled DESC, COALESCE(nextRun, '9999') ASC, id DESC`,
            { userId, scopeId }
        ).map(row => {
            let originalSchedule = null;
            try {
                originalSchedule = JSON.parse(row.metadata || '{}').originalSchedule || null;
            } catch { /* no metadata */ }
            return {
                id: row.id,
                name: row.name,
                prompt: row.promptText,
                cron: row.schedule,
                scheduleLabel: originalSchedule,
                enabled: Boolean(row.isEnabled),
                lastRun: row.lastRun,
                nextRun: row.nextRun
            };
        });
    }

    /**
     * Pause or resume an automation by name (same semantics as /automation
     * toggle: resuming recomputes the next run from now).
     * @param {Object} params - { userId, scopeId, name, enabled }
     * @returns {{id: number, enabled: boolean, nextRun: Date|null}}
     */
    setEnabled({ userId, scopeId, name, enabled }) {
        const row = this._find({ userId, scopeId, name });
        if (enabled) {
            const interval = CronExpressionParser.parse(row.schedule);
            const nextRun = interval.next().toDate();
            db.run(
                `UPDATE automations SET isEnabled = 1, nextRun = @nextRun, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { id: row.id, nextRun }
            );
            return { id: row.id, enabled: true, nextRun };
        }
        db.run(
            `UPDATE automations SET isEnabled = 0, nextRun = NULL, updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { id: row.id }
        );
        return { id: row.id, enabled: false, nextRun: null };
    }

    /**
     * Edit an automation's prompt and/or schedule (a schedule change
     * recomputes nextRun so the new cadence takes effect immediately).
     * @param {Object} params - { userId, scopeId, name, prompt?, schedule? }
     * @returns {Promise<{id: number, cron: string, nextRun: string|Date|null}>}
     */
    async update({ userId, scopeId, name, prompt = null, schedule = null }) {
        const row = this._find({ userId, scopeId, name });
        if (!prompt && !schedule) {
            throw new Error('Nothing to update - provide a new prompt and/or schedule.');
        }

        let cron = row.schedule;
        let nextRun;
        if (schedule) {
            ({ cron, nextRun } = await resolveSchedule(schedule));
        }
        const cleanPrompt = prompt === null ? null : String(prompt).trim();
        if (cleanPrompt !== null && (!cleanPrompt || cleanPrompt.length > MAX_PROMPT_LENGTH)) {
            throw new Error(`A task prompt is required (max ${MAX_PROMPT_LENGTH} characters).`);
        }

        let metadata = row.metadata;
        if (schedule) {
            try {
                const parsed = JSON.parse(row.metadata || '{}');
                parsed.originalSchedule = String(schedule).trim();
                metadata = JSON.stringify(parsed);
            } catch {
                metadata = JSON.stringify({ originalSchedule: String(schedule).trim() });
            }
        }

        db.run(
            `UPDATE automations
             SET promptText = COALESCE(@prompt, promptText),
                 schedule = @cron,
                 nextRun = CASE WHEN @rescheduled = 1 AND isEnabled = 1 THEN @nextRun ELSE nextRun END,
                 metadata = @metadata,
                 updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id`,
            {
                id: row.id,
                prompt: cleanPrompt,
                cron,
                rescheduled: schedule ? 1 : 0,
                nextRun: nextRun || null,
                metadata
            }
        );
        return { id: row.id, cron, nextRun: nextRun || row.nextRun };
    }

    /**
     * Cancel (delete) an automation by name.
     * @param {Object} params - { userId, scopeId, name }
     * @returns {{deleted: true}}
     */
    remove({ userId, scopeId, name }) {
        const row = this._find({ userId, scopeId, name });
        db.run('DELETE FROM automations WHERE id = @id', { id: row.id });
        return { deleted: true };
    }

    /** Look up an owned automation by name or throw a user-presentable error. */
    _find({ userId, scopeId, name }) {
        const cleanName = String(name ?? '').trim();
        if (!cleanName) throw new Error('Which automation? A name is required.');
        const row = db.get(
            `SELECT id, name, promptText, schedule, isEnabled, nextRun, metadata
             FROM automations WHERE userId = @userId AND guildId = @scopeId AND name = @name`,
            { userId, scopeId, name: cleanName }
        );
        if (!row) throw new Error(`No automation named "${cleanName}" here.`);
        return row;
    }
}

module.exports = new AutomationManagementService();
module.exports.AutomationManagementService = AutomationManagementService;
module.exports.resolveSchedule = resolveSchedule;
module.exports.convertToCron = convertToCron;
module.exports.getManualCron = getManualCron;
module.exports.MAX_AUTOMATIONS_PER_SCOPE = MAX_AUTOMATIONS_PER_SCOPE;
module.exports.MIN_RUN_GAP_MS = MIN_RUN_GAP_MS;
