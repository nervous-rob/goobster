/**
 * Project-scoped triggers: cron or domain-event automations whose actions
 * are deterministic (run a stored script, render frames, re-fetch an
 * allowlisted URL) or agentic (a prompt through the Observatory-command
 * machinery). The common case — "run my ingest script nightly" — spends
 * no tokens.
 *
 * Cron rows join the existing automation minute loop (same singleton lock,
 * same claim-by-advancing-nextRun, same disable-on-unparseable-schedule).
 * Event rows evaluate from DB state on job settle; a startup catch-up
 * compares finishedAt against lastRun so a restart never drops a fire.
 * Events are hints, never the source of truth.
 */

const { CronExpressionParser } = require('cron-parser');
const db = require('../db');
const { validateCron } = require('./automationManagerService');
const sandboxConfig = require('../config/sandboxConfig');
const { assessUrl, SafeFetchError } = require('../utils/safeFetch');
const { dmScopeId } = require('../utils/dmScope');

const MAX_NAME = 80;
const MAX_OUTCOME = 240;
const MAX_PROMPT = 4000;
const DEFAULT_MAX_CHAIN_DEPTH = 3;
const EVENT_TOPICS = new Set(['job_completed', 'job_failed', 'job_settled']);
const ACTIONS = new Set(['run_script', 'render', 'fetch_data', 'agent_prompt']);
const KINDS = new Set(['cron', 'event']);

class ProjectTriggerError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ProjectTriggerError';
        this.status = status;
        this.code = code;
    }
}

function parseActionParams(raw) {
    if (raw && typeof raw === 'object') return { ...raw };
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function outcomeText(status, detail) {
    const body = `${status}${detail ? `: ${detail}` : ''}`.slice(0, MAX_OUTCOME);
    return body;
}

function topicsForJob(job) {
    const topics = ['job_settled'];
    if (job.status === 'COMPLETED') topics.push('job_completed');
    if (job.status === 'FAILED' || job.status === 'TIMED_OUT') topics.push('job_failed');
    return topics;
}

class ProjectTriggerService {
    constructor({
        observatory = null,
        projectAssets = null,
        sandboxRequests = null,
        webChat = null,
        sandboxCfg = sandboxConfig,
        runAgentPrompt = null
    } = {}) {
        this._observatory = observatory;
        this._projectAssets = projectAssets;
        this._sandboxRequests = sandboxRequests;
        this._webChat = webChat;
        this.sandboxConfig = sandboxCfg;
        this._agentPromptFn = runAgentPrompt;
    }

    _observatoryService() {
        return this._observatory || require('./observatoryService');
    }

    _assetService() {
        return this._projectAssets || require('./projectAssetService');
    }

    _requestService() {
        return this._sandboxRequests || require('./sandboxRequestService');
    }

    _chatService() {
        return this._webChat || require('./webChatService');
    }

    async _requireProject(userId, projectRef) {
        const ref = String(projectRef ?? '').trim();
        if (!ref) {
            throw new ProjectTriggerError(400, 'BAD_PROJECT',
                'Which project? Give its name or slug.');
        }
        const row = await db.get(
            `SELECT id, slug, name FROM observatory_projects
             WHERE userId = @userId AND (slug = @slugRef OR name = @ref COLLATE NOCASE)`,
            { userId, slugRef: ref.toLowerCase(), ref }
        );
        if (!row) {
            throw new ProjectTriggerError(404, 'NO_SUCH_PROJECT',
                `No project called "${ref}".`);
        }
        return row;
    }

    async _requireTrigger(userId, projectRow, triggerRef) {
        const ref = String(triggerRef ?? '').trim();
        if (!ref) {
            throw new ProjectTriggerError(400, 'BAD_TRIGGER',
                'Which trigger? Give its name or id.');
        }
        const asId = Number(ref);
        const byId = Number.isInteger(asId) && asId > 0
            ? await db.get(
                `SELECT * FROM project_triggers
                 WHERE id = @id AND projectId = @projectId AND userId = @userId`,
                { id: asId, projectId: projectRow.id, userId }
            )
            : null;
        if (byId) return byId;
        const row = await db.get(
            `SELECT * FROM project_triggers
             WHERE projectId = @projectId AND userId = @userId AND name = @name COLLATE NOCASE`,
            { projectId: projectRow.id, userId, name: ref }
        );
        if (!row) {
            throw new ProjectTriggerError(404, 'NO_SUCH_TRIGGER',
                `No trigger called "${ref}" in "${projectRow.slug}".`);
        }
        return row;
    }

    _normalizeName(name) {
        const clean = String(name || '').trim().slice(0, MAX_NAME);
        if (!clean) {
            throw new ProjectTriggerError(400, 'BAD_NAME', 'A trigger needs a name.');
        }
        return clean;
    }

    _normalizeKind(kind) {
        const value = String(kind || '').trim().toLowerCase();
        if (!KINDS.has(value)) {
            throw new ProjectTriggerError(400, 'BAD_KIND',
                'Trigger kind must be cron or event.');
        }
        return value;
    }

    _normalizeAction(action) {
        const value = String(action || '').trim().toLowerCase();
        if (!ACTIONS.has(value)) {
            throw new ProjectTriggerError(400, 'BAD_ACTION',
                'Action must be run_script, render, fetch_data, or agent_prompt.');
        }
        return value;
    }

    _normalizeEventTopic(topic) {
        const value = String(topic || '').trim().toLowerCase();
        if (!EVENT_TOPICS.has(value)) {
            throw new ProjectTriggerError(400, 'BAD_EVENT',
                'eventTopic must be job_completed, job_failed, or job_settled.');
        }
        return value;
    }

    /**
     * Per-action validation of actionParams (and the asset pointer).
     * Used at write time and again at fire time so a later edit of the
     * allowlist or a deleted asset cannot sneak through.
     */
    async validateAction({
        userId,
        projectRow,
        action,
        actionAssetId = null,
        actionAsset = null,
        actionParams = {},
        atFire = false
    }) {
        const params = parseActionParams(actionParams);
        let assetId = actionAssetId == null || actionAssetId === ''
            ? null
            : Number(actionAssetId);

        if (action === 'run_script') {
            const ref = actionAsset || assetId;
            if (ref == null || ref === '') {
                throw new ProjectTriggerError(400, 'BAD_ASSET',
                    'run_script needs a script asset (slug or id).');
            }
            const asset = await this._resolveScriptAsset(userId, projectRow, ref);
            assetId = asset.id;
            if (params.background !== undefined && typeof params.background !== 'boolean'
                && params.background !== 0 && params.background !== 1) {
                throw new ProjectTriggerError(400, 'BAD_PARAMS',
                    'actionParams.background must be a boolean.');
            }
        } else if (action === 'render') {
            if (params.fps !== undefined && params.fps !== null && params.fps !== '') {
                const fps = Number(params.fps);
                if (!Number.isFinite(fps) || fps < 1 || fps > 120) {
                    throw new ProjectTriggerError(400, 'BAD_PARAMS',
                        'actionParams.fps must be between 1 and 120.');
                }
                params.fps = Math.round(fps);
            }
        } else if (action === 'fetch_data') {
            const url = String(params.url || '').trim();
            if (!url) {
                throw new ProjectTriggerError(400, 'BAD_PARAMS',
                    'fetch_data needs actionParams.url.');
            }
            let assessed;
            try {
                assessed = assessUrl(url, this.sandboxConfig.fetchAllowedHosts || []);
            } catch (error) {
                const message = error instanceof SafeFetchError
                    ? error.message
                    : 'That is not a valid fetch URL.';
                throw new ProjectTriggerError(error.status || 400, error.code || 'BAD_URL', message);
            }
            if (!assessed.allowlisted) {
                const err = new ProjectTriggerError(400, 'HOST_NOT_ALLOWED',
                    `${assessed.host} is not on sandbox.fetchAllowedHosts, so it cannot be automated.`);
                if (atFire) throw err;
                throw err;
            }
            params.url = assessed.url.href;
            if (params.filename !== undefined) {
                params.filename = String(params.filename || '').trim();
            }
        } else if (action === 'agent_prompt') {
            const prompt = String(params.prompt || '').trim();
            if (!prompt) {
                throw new ProjectTriggerError(400, 'BAD_PARAMS',
                    'agent_prompt needs actionParams.prompt.');
            }
            if (prompt.length > MAX_PROMPT) {
                throw new ProjectTriggerError(400, 'BAD_PARAMS',
                    `Keep the prompt under ${MAX_PROMPT} characters.`);
            }
            params.prompt = prompt;
        }

        if (params.allowSelfChain !== undefined
            && params.allowSelfChain !== true && params.allowSelfChain !== false
            && params.allowSelfChain !== 0 && params.allowSelfChain !== 1) {
            throw new ProjectTriggerError(400, 'BAD_PARAMS',
                'actionParams.allowSelfChain must be a boolean.');
        }
        if (params.maxChainDepth !== undefined && params.maxChainDepth !== null) {
            const depth = Number(params.maxChainDepth);
            if (!Number.isInteger(depth) || depth < 1 || depth > 20) {
                throw new ProjectTriggerError(400, 'BAD_PARAMS',
                    'actionParams.maxChainDepth must be an integer from 1 to 20.');
            }
            params.maxChainDepth = depth;
        }

        if (action !== 'run_script') assetId = null;
        return { actionAssetId: assetId, actionParams: params };
    }

    async _resolveScriptAsset(userId, projectRow, ref) {
        const asId = Number(ref);
        let row = null;
        if (Number.isInteger(asId) && asId > 0 && String(asId) === String(ref).trim()) {
            row = await db.get(
                `SELECT id, slug, name, kind, currentVersionId
                 FROM project_assets
                 WHERE id = @id AND projectId = @projectId AND userId = @userId`,
                { id: asId, projectId: projectRow.id, userId }
            );
        }
        if (!row) {
            const key = String(ref).trim();
            row = await db.get(
                `SELECT id, slug, name, kind, currentVersionId
                 FROM project_assets
                 WHERE projectId = @projectId AND userId = @userId
                   AND (slug = @slugRef OR name = @ref COLLATE NOCASE)`,
                { projectId: projectRow.id, userId, slugRef: key.toLowerCase(), ref: key }
            );
        }
        if (!row) {
            throw new ProjectTriggerError(404, 'NO_SUCH_ASSET',
                `No asset "${ref}" in "${projectRow.slug}".`);
        }
        if (row.kind !== 'script') {
            throw new ProjectTriggerError(400, 'BAD_ASSET',
                `"${row.slug}" is a ${row.kind}, not a script.`);
        }
        return row;
    }

    _serialize(row, projectSlug) {
        return {
            id: row.id,
            project: projectSlug,
            projectId: row.projectId,
            name: row.name,
            kind: row.kind,
            schedule: row.schedule || null,
            nextRun: row.nextRun || null,
            eventTopic: row.eventTopic || null,
            action: row.action,
            actionAssetId: row.actionAssetId ?? null,
            actionParams: parseActionParams(row.actionParams),
            isEnabled: Boolean(row.isEnabled),
            lastRun: row.lastRun || null,
            lastOutcome: row.lastOutcome || null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt
        };
    }

    /**
     * Create a trigger. Cron schedules use the automations contract
     * (5-field, UTC, 15-minute minimum gap).
     */
    async create({
        userId,
        project,
        name,
        kind,
        schedule = null,
        eventTopic = null,
        action,
        actionAssetId = null,
        actionAsset = null,
        actionParams = {},
        isEnabled = true
    }) {
        const projectRow = await this._requireProject(userId, project);
        const cleanName = this._normalizeName(name);
        const cleanKind = this._normalizeKind(kind);
        const cleanAction = this._normalizeAction(action);
        const enabled = isEnabled === false || isEnabled === 0 ? 0 : 1;

        const existing = await db.get(
            `SELECT id FROM project_triggers
             WHERE projectId = @projectId AND userId = @userId AND name = @name COLLATE NOCASE`,
            { projectId: projectRow.id, userId, name: cleanName }
        );
        if (existing) {
            throw new ProjectTriggerError(409, 'DUPLICATE_NAME',
                `A trigger named "${cleanName}" already exists in "${projectRow.slug}".`);
        }

        let cronSchedule = null;
        let nextRun = null;
        let topic = null;
        if (cleanKind === 'cron') {
            try {
                const parsed = validateCron(schedule);
                cronSchedule = parsed.cron;
                nextRun = parsed.nextRun;
            } catch (error) {
                throw new ProjectTriggerError(400, error.code || 'BAD_SCHEDULE', error.message);
            }
        } else {
            topic = this._normalizeEventTopic(eventTopic);
        }

        const validated = await this.validateAction({
            userId,
            projectRow,
            action: cleanAction,
            actionAssetId,
            actionAsset,
            actionParams
        });

        const id = await db.insert(
            `INSERT INTO project_triggers
                (projectId, userId, name, kind, schedule, nextRun, eventTopic,
                 action, actionAssetId, actionParams, isEnabled)
             VALUES (@projectId, @userId, @name, @kind, @schedule, @nextRun, @eventTopic,
                     @action, @actionAssetId, @actionParams, @isEnabled)`,
            {
                projectId: projectRow.id,
                userId,
                name: cleanName,
                kind: cleanKind,
                schedule: cronSchedule,
                nextRun,
                eventTopic: topic,
                action: cleanAction,
                actionAssetId: validated.actionAssetId,
                actionParams: JSON.stringify(validated.actionParams),
                isEnabled: enabled
            }
        );
        const row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id });
        return this._serialize(row, projectRow.slug);
    }

    async list({ userId, project }) {
        const projectRow = await this._requireProject(userId, project);
        const rows = await db.all(
            `SELECT * FROM project_triggers
             WHERE projectId = @projectId AND userId = @userId
             ORDER BY isEnabled DESC, name ASC, id ASC`,
            { projectId: projectRow.id, userId }
        );
        return rows.map(row => this._serialize(row, projectRow.slug));
    }

    async get({ userId, project, trigger }) {
        const projectRow = await this._requireProject(userId, project);
        const row = await this._requireTrigger(userId, projectRow, trigger);
        return this._serialize(row, projectRow.slug);
    }

    /**
     * Create-or-update by name (the tool's set_trigger).
     */
    async set(params) {
        const projectRow = await this._requireProject(params.userId, params.project);
        const cleanName = this._normalizeName(params.name);
        const existing = await db.get(
            `SELECT id FROM project_triggers
             WHERE projectId = @projectId AND userId = @userId AND name = @name COLLATE NOCASE`,
            { projectId: projectRow.id, userId: params.userId, name: cleanName }
        );
        if (existing) {
            return await this.update({
                ...params,
                trigger: existing.id,
                name: cleanName
            });
        }
        return await this.create({ ...params, name: cleanName });
    }

    async update({
        userId,
        project,
        trigger,
        name = undefined,
        kind = undefined,
        schedule = undefined,
        eventTopic = undefined,
        action = undefined,
        actionAssetId = undefined,
        actionAsset = undefined,
        actionParams = undefined,
        isEnabled = undefined
    }) {
        const projectRow = await this._requireProject(userId, project);
        const existing = await this._requireTrigger(userId, projectRow, trigger);

        const cleanName = name !== undefined ? this._normalizeName(name) : existing.name;
        if (name !== undefined && cleanName.toLowerCase() !== String(existing.name).toLowerCase()) {
            const clash = await db.get(
                `SELECT id FROM project_triggers
                 WHERE projectId = @projectId AND userId = @userId
                   AND name = @name COLLATE NOCASE AND id != @id`,
                { projectId: projectRow.id, userId, name: cleanName, id: existing.id }
            );
            if (clash) {
                throw new ProjectTriggerError(409, 'DUPLICATE_NAME',
                    `A trigger named "${cleanName}" already exists in "${projectRow.slug}".`);
            }
        }

        const cleanKind = kind !== undefined ? this._normalizeKind(kind) : existing.kind;
        const cleanAction = action !== undefined ? this._normalizeAction(action) : existing.action;
        const enabled = isEnabled === undefined
            ? existing.isEnabled
            : (isEnabled === false || isEnabled === 0 ? 0 : 1);

        let cronSchedule;
        let nextRun = existing.nextRun;
        let topic;
        if (cleanKind === 'cron') {
            const sched = schedule !== undefined ? schedule : existing.schedule;
            const scheduleChanged = schedule !== undefined && schedule !== existing.schedule;
            if (!sched) {
                throw new ProjectTriggerError(400, 'BAD_SCHEDULE',
                    'A cron trigger needs a 5-part schedule.');
            }
            try {
                const parsed = validateCron(sched);
                cronSchedule = parsed.cron;
                if (scheduleChanged || existing.kind !== 'cron' || !existing.nextRun) {
                    nextRun = parsed.nextRun;
                }
            } catch (error) {
                throw new ProjectTriggerError(400, error.code || 'BAD_SCHEDULE', error.message);
            }
            topic = null;
        } else {
            const incoming = eventTopic !== undefined ? eventTopic : existing.eventTopic;
            topic = this._normalizeEventTopic(incoming);
            cronSchedule = null;
            nextRun = null;
        }

        const incomingParams = actionParams !== undefined
            ? { ...parseActionParams(existing.actionParams), ...parseActionParams(actionParams) }
            : parseActionParams(existing.actionParams);
        const incomingAsset = actionAssetId !== undefined || actionAsset !== undefined
            ? { actionAssetId, actionAsset }
            : { actionAssetId: existing.actionAssetId, actionAsset: null };

        const validated = await this.validateAction({
            userId,
            projectRow,
            action: cleanAction,
            actionAssetId: incomingAsset.actionAssetId,
            actionAsset: incomingAsset.actionAsset,
            actionParams: incomingParams
        });

        await db.run(
            `UPDATE project_triggers
             SET name = @name, kind = @kind, schedule = @schedule, nextRun = @nextRun,
                 eventTopic = @eventTopic, action = @action, actionAssetId = @actionAssetId,
                 actionParams = @actionParams, isEnabled = @isEnabled,
                 updatedAt = datetime('now')
             WHERE id = @id AND userId = @userId`,
            {
                id: existing.id,
                userId,
                name: cleanName,
                kind: cleanKind,
                schedule: cronSchedule,
                nextRun,
                eventTopic: topic,
                action: cleanAction,
                actionAssetId: validated.actionAssetId,
                actionParams: JSON.stringify(validated.actionParams),
                isEnabled: enabled
            }
        );
        const row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: existing.id });
        return this._serialize(row, projectRow.slug);
    }

    async delete({ userId, project, trigger }) {
        const projectRow = await this._requireProject(userId, project);
        const existing = await this._requireTrigger(userId, projectRow, trigger);
        const result = await db.run(
            'DELETE FROM project_triggers WHERE id = @id AND userId = @userId',
            { id: existing.id, userId }
        );
        if (result.changes === 0) {
            throw new ProjectTriggerError(404, 'NO_SUCH_TRIGGER',
                `No trigger called "${existing.name}" in "${projectRow.slug}".`);
        }
        return { deleted: true, name: existing.name };
    }

    async _recordOutcome(triggerId, text) {
        await db.run(
            `UPDATE project_triggers
             SET lastOutcome = @lastOutcome, updatedAt = datetime('now')
             WHERE id = @id`,
            { id: triggerId, lastOutcome: String(text || '').slice(0, MAX_OUTCOME) }
        );
    }

    async _markCronRan(triggerId) {
        await db.run(
            `UPDATE project_triggers
             SET lastRun = datetime('now'), updatedAt = datetime('now')
             WHERE id = @id`,
            { id: triggerId }
        );
    }

    /**
     * Atomically claim a due cron trigger by advancing nextRun BEFORE the
     * action. Same contract as automationService.claimDueRun: UTC parse,
     * disable + tell the owner on an unparseable schedule, UPDATE matches
     * only while enabled and due.
     */
    async claimDueCronRun(trigger, { client = null } = {}) {
        let nextRun;
        try {
            nextRun = CronExpressionParser.parse(trigger.schedule, { tz: 'UTC' }).next().toDate();
        } catch (error) {
            console.error(
                `Project trigger "${trigger.name}" has an unparseable schedule ("${trigger.schedule}") - disabling it:`,
                error
            );
            await db.run(
                `UPDATE project_triggers
                 SET isEnabled = 0, nextRun = NULL, lastOutcome = @lastOutcome,
                     updatedAt = datetime('now')
                 WHERE id = @id`,
                { id: trigger.id, lastOutcome: outcomeText('failed', 'unparseable schedule — disabled') }
            );
            await this._notifyOwner(
                trigger,
                `⚠️ Project trigger "${trigger.name}" has been paused: its schedule (\`${trigger.schedule}\`) `
                + 'is not a valid cron expression, so it can never fire. Edit it with a fixed schedule.',
                client
            );
            return false;
        }
        try {
            const result = await db.run(
                `UPDATE project_triggers
                 SET nextRun = @nextRun, updatedAt = datetime('now')
                 WHERE id = @id AND isEnabled = 1 AND nextRun <= CURRENT_TIMESTAMP`,
                { nextRun, id: trigger.id }
            );
            return result.changes > 0;
        } catch (error) {
            console.error(`Error claiming project trigger ${trigger.name}:`, error);
            return false;
        }
    }

    /**
     * Claim an event fire so settle + catch-up cannot double-run the same
     * job. lastRun advances to the job's finishedAt while the row is still
     * enabled and has not already processed this (or a later) finish.
     */
    async claimEventFire(trigger, job) {
        if (!job?.finishedAt) return false;
        const result = await db.run(
            `UPDATE project_triggers
             SET lastRun = @finishedAt, updatedAt = datetime('now')
             WHERE id = @id AND isEnabled = 1
               AND (lastRun IS NULL OR lastRun < @finishedAt)`,
            { id: trigger.id, finishedAt: job.finishedAt }
        );
        return result.changes > 0;
    }

    async _notifyOwner(trigger, message, client) {
        try {
            const { toGateway } = require('../gateway');
            const gateway = toGateway(client);
            if (!gateway) return;
            const channelId = await gateway.resolveDmChannelId(trigger.userId);
            if (!channelId) return;
            await db.run(
                `INSERT INTO followups (guildId, channelId, userId, note, dueAt)
                 VALUES (@scope, @channelId, @userId, @note, datetime('now'))`,
                {
                    scope: dmScopeId(trigger.userId),
                    channelId,
                    userId: trigger.userId,
                    note: String(message).slice(0, 500)
                }
            );
        } catch { /* best-effort notice; lastOutcome is the durable record */ }
    }

    _chainConfig(params) {
        const allowSelfChain = params.allowSelfChain === true || params.allowSelfChain === 1;
        const raw = Number(params.maxChainDepth);
        const maxChainDepth = Number.isInteger(raw) && raw > 0
            ? raw
            : DEFAULT_MAX_CHAIN_DEPTH;
        return { allowSelfChain, maxChainDepth };
    }

    /**
     * How many event-trigger-started jobs sit in this job's ancestry
     * (including itself when it was started by an event trigger). Cron-
     * started and ad-hoc jobs are roots (depth 0).
     */
    async eventChainDepth(job) {
        let depth = 0;
        let current = job;
        const seen = new Set();
        while (current && current.startedBy === 'trigger' && current.triggerId && !seen.has(current.id)) {
            seen.add(current.id);
            const trig = await db.get(
                'SELECT kind FROM project_triggers WHERE id = @id',
                { id: current.triggerId }
            );
            if (trig?.kind === 'event') depth++;
            current = await db.get(
                `SELECT id, projectId, startedBy, triggerId, createdAt, finishedAt
                 FROM observatory_jobs
                 WHERE projectId = @projectId AND id < @id
                   AND finishedAt IS NOT NULL
                   AND finishedAt <= @createdAt
                 ORDER BY id DESC LIMIT 1`,
                {
                    projectId: current.projectId,
                    id: current.id,
                    createdAt: current.createdAt
                }
            );
        }
        return depth;
    }

    async shouldSkipChain(trigger, job) {
        const params = parseActionParams(trigger.actionParams);
        const { allowSelfChain, maxChainDepth } = this._chainConfig(params);
        if (job.triggerId != null && Number(job.triggerId) === Number(trigger.id) && !allowSelfChain) {
            return 'self-chain';
        }
        const depth = await this.eventChainDepth(job);
        if (depth >= maxChainDepth) return 'max chain depth';
        return null;
    }

    /**
     * Due cron triggers — invoked from automationService's locked minute
     * loop. Do not add a second poller.
     */
    async fireDueCronTriggers({ client = null } = {}) {
        const due = await db.all(
            `SELECT * FROM project_triggers
             WHERE kind = 'cron' AND isEnabled = 1 AND nextRun <= CURRENT_TIMESTAMP
             ORDER BY id ASC`
        );
        let fired = 0;
        for (const trigger of due) {
            if (!await this.claimDueCronRun(trigger, { client })) continue;
            try {
                await this._executeAction(trigger, { client });
                await this._markCronRan(trigger.id);
                fired++;
            } catch (error) {
                await this._markCronRan(trigger.id);
                await this._recordOutcome(trigger.id, outcomeText('failed', error.message));
                console.error(`Project trigger "${trigger.name}" failed:`, error);
            }
        }
        return fired;
    }

    /**
     * Evaluate matching event triggers for one settled job. Called from
     * observatoryService after it publishes observatory.job_* and files
     * the completion follow-up.
     */
    async evaluateJobSettled(jobId, { client = null } = {}) {
        const job = await db.get(
            'SELECT * FROM observatory_jobs WHERE id = @id',
            { id: jobId }
        );
        if (!job || !job.finishedAt || job.status === 'RUNNING') return 0;
        const topics = topicsForJob(job);
        const rows = await db.all(
            `SELECT * FROM project_triggers
             WHERE projectId = @projectId AND userId = @userId
               AND kind = 'event' AND isEnabled = 1
             ORDER BY id ASC`,
            { projectId: job.projectId, userId: job.userId }
        );
        let fired = 0;
        for (const trigger of rows) {
            if (!topics.includes(trigger.eventTopic)) continue;
            if (await this._fireEventTrigger(trigger, job, { client })) fired++;
        }
        return fired;
    }

    /**
     * Startup (and periodic) catch-up: jobs whose finishedAt is newer than
     * the trigger's lastRun. Same claim as the settle path, so a restart
     * never double-fires and never drops a fire.
     */
    async catchUpEventTriggers({ client = null } = {}) {
        const triggers = await db.all(
            `SELECT * FROM project_triggers
             WHERE kind = 'event' AND isEnabled = 1
             ORDER BY id ASC`
        );
        let fired = 0;
        for (const trigger of triggers) {
            let jobs;
            if (trigger.lastRun) {
                jobs = await db.all(
                    `SELECT * FROM observatory_jobs
                     WHERE projectId = @projectId AND userId = @userId
                       AND finishedAt IS NOT NULL
                       AND finishedAt > @lastRun
                     ORDER BY finishedAt ASC, id ASC`,
                    {
                        projectId: trigger.projectId,
                        userId: trigger.userId,
                        lastRun: trigger.lastRun
                    }
                );
            } else {
                jobs = await db.all(
                    `SELECT * FROM observatory_jobs
                     WHERE projectId = @projectId AND userId = @userId
                       AND finishedAt IS NOT NULL
                     ORDER BY finishedAt ASC, id ASC`,
                    { projectId: trigger.projectId, userId: trigger.userId }
                );
            }
            for (const job of jobs) {
                const fresh = await db.get(
                    'SELECT * FROM project_triggers WHERE id = @id',
                    { id: trigger.id }
                );
                if (!fresh || !fresh.isEnabled) break;
                const topics = topicsForJob(job);
                if (!topics.includes(fresh.eventTopic)) continue;
                if (await this._fireEventTrigger(fresh, job, { client })) fired++;
            }
        }
        return fired;
    }

    async _fireEventTrigger(trigger, job, { client = null } = {}) {
        const skip = await this.shouldSkipChain(trigger, job);
        if (skip) {
            if (await this.claimEventFire(trigger, job)) {
                await this._recordOutcome(trigger.id, outcomeText('skipped', skip));
            }
            return false;
        }
        if (!await this.claimEventFire(trigger, job)) return false;
        try {
            await this._executeAction(trigger, { client, sourceJob: job });
            return true;
        } catch (error) {
            await this._recordOutcome(trigger.id, outcomeText('failed', error.message));
            console.error(`Project trigger "${trigger.name}" failed:`, error);
            return false;
        }
    }

    /**
     * Re-validate params, then run the action under the owner's identity.
     * Rate limits, quotas, and active-job caps all apply. A busy sandbox
     * (or an active-job cap) is a skip, not a failed trigger.
     */
    async _executeAction(trigger, { client = null } = {}) {
        const projectRow = await db.get(
            'SELECT id, slug, name, userId FROM observatory_projects WHERE id = @id',
            { id: trigger.projectId }
        );
        if (!projectRow) {
            await this._recordOutcome(trigger.id, outcomeText('failed', 'project is gone'));
            return;
        }

        let validated;
        try {
            validated = await this.validateAction({
                userId: trigger.userId,
                projectRow,
                action: trigger.action,
                actionAssetId: trigger.actionAssetId,
                actionParams: trigger.actionParams,
                atFire: true
            });
        } catch (error) {
            if (error.code === 'HOST_NOT_ALLOWED') {
                await this._recordOutcome(trigger.id, outcomeText('skipped', error.message));
                return;
            }
            await this._recordOutcome(trigger.id, outcomeText('failed', error.message));
            return;
        }

        const params = validated.actionParams;
        try {
            if (trigger.action === 'run_script') {
                await this._runScript(trigger, projectRow, validated.actionAssetId, params, client);
            } else if (trigger.action === 'render') {
                const render = await this._observatoryService().render({
                    userId: trigger.userId,
                    project: projectRow.slug,
                    fps: params.fps ?? null
                });
                await this._recordOutcome(trigger.id,
                    outcomeText('ok', `${render.frames} frame(s) → ${render.relPath}`));
            } else if (trigger.action === 'fetch_data') {
                const result = await this._requestService().requestFetch({
                    userId: trigger.userId,
                    project: projectRow.slug,
                    url: params.url,
                    saveAs: params.filename || params.saveAs || '',
                    reason: `project trigger "${trigger.name}"`,
                    client
                });
                await this._recordOutcome(trigger.id, outcomeText('ok', String(result).slice(0, 180)));
            } else if (trigger.action === 'agent_prompt') {
                await this._executeAgentPrompt(trigger, projectRow, params, client);
                await this._recordOutcome(trigger.id, outcomeText('ok', 'agent prompt'));
            }
        } catch (error) {
            if (error?.code === 'BUSY' || error?.code === 'TOO_MANY_JOBS') {
                await this._recordOutcome(trigger.id,
                    outcomeText('skipped', error.message || 'sandbox busy — deferred'));
                return;
            }
            throw error;
        }
    }

    async _runScript(trigger, projectRow, assetId, params, client) {
        const asset = await db.get(
            `SELECT id, slug, currentVersionId FROM project_assets
             WHERE id = @id AND userId = @userId`,
            { id: assetId, userId: trigger.userId }
        );
        if (!asset?.currentVersionId) {
            await this._recordOutcome(trigger.id, outcomeText('failed', 'script asset has no head version'));
            return;
        }
        const head = await db.get(
            `SELECT id, language, source, version FROM project_asset_versions
             WHERE id = @id AND assetId = @assetId`,
            { id: asset.currentVersionId, assetId: asset.id }
        );
        if (!head) {
            await this._recordOutcome(trigger.id, outcomeText('failed', 'head version is missing'));
            return;
        }
        const background = params.background !== false && params.background !== 0;
        const outcome = await this._observatoryService().run({
            userId: trigger.userId,
            project: projectRow.slug,
            language: head.language,
            code: head.source,
            background,
            client,
            assetVersionId: head.id,
            startedBy: 'trigger',
            triggerId: trigger.id
        });
        if (outcome.mode === 'background') {
            await this._recordOutcome(trigger.id,
                outcomeText('ok', `job #${outcome.jobId} (${asset.slug} v${head.version})`));
        } else {
            const result = outcome.result || {};
            const status = result.ok ? 'ok' : 'failed';
            await this._recordOutcome(trigger.id,
                outcomeText(status, `${asset.slug} v${head.version} exit ${result.exitCode ?? '?'}`));
        }
    }

    async _executeAgentPrompt(trigger, projectRow, params, client) {
        const prompt = String(params.prompt || '').trim();
        const message = `[Observatory command for project "${projectRow.name}" (slug: ${projectRow.slug})] `
            + 'Use the observatory tool on this project to carry out the instructions below. '
            + 'Prefer background jobs with the checkpoint.json convention for anything long, and '
            + 'report back what you started, changed, or found.\n\n'
            + prompt;
        const sourceDescription =
            `You are executing "${trigger.name}", a scheduled project trigger ${trigger.userId} set up `
            + `for Observatory project "${projectRow.name}". Carry out the instructions now.`;

        if (typeof this._agentPromptFn === 'function') {
            await this._agentPromptFn({
                trigger, project: projectRow, message, prompt, client, sourceDescription
            });
            return;
        }

        const chat = this._chatService();
        const title = `🔭 ${projectRow.name}`;
        const existing = (await chat.listConversations(trigger.userId))
            .find(c => c.title === title);
        let conversationId;
        if (existing) {
            conversationId = existing.id;
        } else {
            const created = await chat.createConversation(trigger.userId);
            await chat.renameConversation({
                userId: trigger.userId,
                conversationId: created.id,
                title
            });
            conversationId = created.id;
        }

        await chat.runTurn({
            client,
            userId: trigger.userId,
            userName: 'owner',
            message,
            conversationId,
            isAutomation: true,
            sourceDescription
        });
    }

    /** /forget-me: every trigger belonging to the user. */
    async forgetUser(userId) {
        const triggers = (await db.run(
            'DELETE FROM project_triggers WHERE userId = @userId',
            { userId }
        )).changes;
        return { triggers };
    }

    async countUser(userId) {
        return (await db.get(
            'SELECT COUNT(*) AS c FROM project_triggers WHERE userId = @userId',
            { userId }
        ))?.c || 0;
    }
}

module.exports = new ProjectTriggerService();
module.exports.ProjectTriggerService = ProjectTriggerService;
module.exports.ProjectTriggerError = ProjectTriggerError;
module.exports.parseActionParams = parseActionParams;
module.exports.DEFAULT_MAX_CHAIN_DEPTH = DEFAULT_MAX_CHAIN_DEPTH;
module.exports.MAX_PROMPT = MAX_PROMPT;
