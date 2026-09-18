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
 *
 * Multi-stage pipelines: an event trigger may be filtered to jobs from
 * one script asset (sourceAssetId) and/or one upstream trigger
 * (sourceTriggerId); `matchesEventTrigger` is the single matcher both the
 * settle path and catch-up use, and only a matching job claims lastRun.
 * A run_script action may declare `requiredOutputs`; the resolved
 * contract is frozen onto the job it starts (utils/outputContract.js),
 * and event-started children record their source job as parentJobId.
 */

const { CronExpressionParser } = require('cron-parser');
const db = require('../db');
const { validateCron } = require('./automationManagerService');
const sandboxConfig = require('../config/sandboxConfig');
const { assessUrl, SafeFetchError } = require('../utils/safeFetch');
const { dmScopeId } = require('../utils/dmScope');
const { backgroundJobHint } = require('../utils/projectSetupContract');
const {
    OUTPUT_CONTRACT_FAILED,
    OutputContractError,
    normalizeRequiredOutputs,
    resolveOutputContract,
    summarizeContractFailure
} = require('../utils/outputContract');

const MAX_NAME = 80;
const MAX_OUTCOME = 240;
const MAX_PROMPT = 4000;
const DEFAULT_MAX_CHAIN_DEPTH = 3;
/** Hard stop for the parent walk (maxChainDepth caps at 20; this is the safety net). */
const MAX_CHAIN_WALK = 64;
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

/**
 * Trigger lastOutcome for a foreground run_script. Distinguishes exit
 * failure, timeout, cancellation, validated success, and "exit 0 but the
 * output contract failed" — never a bare "ok: exit 0" for the last one.
 * @param {string} label - "<slug> v<n>"
 * @param {object} result - the foreground sandbox result (+ outputContract)
 */
function describeForegroundOutcome(label, result) {
    const exit = `exit ${result.exitCode ?? '?'}`;
    if (result.aborted) return outcomeText('failed', `${label} cancelled`);
    if (result.timedOut) return outcomeText('failed', `${label} timed out`);
    if (result.errorCode === OUTPUT_CONTRACT_FAILED || (result.outputContract && result.outputContract.ok === false)) {
        return outcomeText('failed', `${label} ${exit}; ${summarizeContractFailure(result.outputContract)}`);
    }
    if (!result.ok) return outcomeText('failed', `${label} ${exit}`);
    const validated = result.outputContract?.ok
        ? `, ${result.outputContract.checks.length} required output(s) validated`
        : '';
    return outcomeText('ok', `${label} ${exit}${validated}`);
}

/**
 * THE event matcher. Both the settle path and startup catch-up decide
 * with this and nothing else, so the two can never disagree about which
 * jobs a trigger reacts to. `job.assetId` is the parent asset of the
 * version the job executed (joined in by the job loaders below).
 *
 * @param {object} trigger - project_triggers row
 * @param {object} job - observatory_jobs row + assetId
 * @returns {boolean}
 */
function matchesEventTrigger(trigger, job) {
    if (!trigger || !job || trigger.kind !== 'event') return false;
    if (Number(trigger.projectId) !== Number(job.projectId)) return false;
    if (!topicsForJob(job).includes(trigger.eventTopic)) return false;
    if (trigger.sourceTriggerId != null
        && (job.triggerId == null || Number(job.triggerId) !== Number(trigger.sourceTriggerId))) {
        return false;
    }
    if (trigger.sourceAssetId != null
        && (job.assetId == null || Number(job.assetId) !== Number(trigger.sourceAssetId))) {
        return false;
    }
    return true;
}

/** Job rows for event evaluation carry the executed version's parent asset. */
const EVENT_JOB_SELECT = `
    SELECT j.*, v.assetId AS assetId
    FROM observatory_jobs j
    LEFT JOIN project_asset_versions v ON v.id = j.assetVersionId`;

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

    async _requireProject(userId, projectRef, owner = null) {
        try {
            return await require('./projectService').resolveProjectForActor({
                userId, project: projectRef, owner
            });
        } catch (error) {
            if (error.status && error.code) {
                throw new ProjectTriggerError(error.status, error.code, error.message);
            }
            throw error;
        }
    }

    _assertAgentPromptOwner(projectRow, action) {
        if (action === 'agent_prompt' && projectRow.role && projectRow.role !== 'owner') {
            throw new ProjectTriggerError(403, 'OWNER_ONLY',
                'Only the project owner can create or edit agent_prompt triggers.');
        }
    }

    async _requireTrigger(projectRow, triggerRef) {
        const ref = String(triggerRef ?? '').trim();
        if (!ref) {
            throw new ProjectTriggerError(400, 'BAD_TRIGGER',
                'Which trigger? Give its name or id.');
        }
        const asId = Number(ref);
        const byId = Number.isInteger(asId) && asId > 0
            ? await db.get(
                `SELECT * FROM project_triggers
                 WHERE id = @id AND projectId = @projectId`,
                { id: asId, projectId: projectRow.id }
            )
            : null;
        if (byId) return byId;
        const row = await db.get(
            `SELECT * FROM project_triggers
             WHERE projectId = @projectId AND name = @name COLLATE NOCASE`,
            { projectId: projectRow.id, name: ref }
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
            if (params.requiredOutputs !== undefined) {
                let normalized;
                try {
                    normalized = normalizeRequiredOutputs(params.requiredOutputs);
                } catch (error) {
                    if (error instanceof OutputContractError) {
                        throw new ProjectTriggerError(400, 'BAD_OUTPUT_CONTRACT', error.message);
                    }
                    throw error;
                }
                if (normalized) params.requiredOutputs = normalized;
                else delete params.requiredOutputs;
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

        if (action !== 'run_script') {
            assetId = null;
            delete params.requiredOutputs;
        }
        return { actionAssetId: assetId, actionParams: params };
    }

    /**
     * Resolve the optional event source filters. Each must reference a
     * row in the same project (a script asset, or another trigger). Only
     * event triggers may carry them; `undefined` leaves the stored value,
     * null / '' clears it.
     *
     * @returns {Promise<{ sourceAssetId: number|null, sourceTriggerId: number|null }>}
     */
    async _normalizeEventFilters({
        userId,
        projectRow,
        kind,
        sourceAssetId = undefined,
        sourceAsset = undefined,
        sourceTriggerId = undefined,
        sourceTrigger = undefined,
        existing = null
    }) {
        const isClear = (value) => value === null || value === '';
        const assetGiven = sourceAssetId !== undefined || sourceAsset !== undefined;
        const triggerGiven = sourceTriggerId !== undefined || sourceTrigger !== undefined;
        const assetWanted = assetGiven && !(isClear(sourceAssetId) && (sourceAsset === undefined || isClear(sourceAsset)));
        const triggerWanted = triggerGiven && !(isClear(sourceTriggerId) && (sourceTrigger === undefined || isClear(sourceTrigger)));

        if (kind !== 'event') {
            if (assetWanted || triggerWanted) {
                throw new ProjectTriggerError(400, 'BAD_FILTER',
                    'sourceAsset / sourceTrigger filters only apply to event triggers.');
            }
            return { sourceAssetId: null, sourceTriggerId: null };
        }

        let assetOut = existing?.sourceAssetId ?? null;
        if (assetGiven) {
            if (!assetWanted) {
                assetOut = null;
            } else {
                const ref = sourceAsset !== undefined && !isClear(sourceAsset) ? sourceAsset : sourceAssetId;
                try {
                    assetOut = (await this._resolveScriptAsset(userId, projectRow, ref)).id;
                } catch (error) {
                    throw new ProjectTriggerError(400, 'BAD_FILTER',
                        `sourceAsset must be a script asset in this project: ${error.message}`);
                }
            }
        }

        let triggerOut = existing?.sourceTriggerId ?? null;
        if (triggerGiven) {
            if (!triggerWanted) {
                triggerOut = null;
            } else {
                const ref = sourceTrigger !== undefined && !isClear(sourceTrigger) ? sourceTrigger : sourceTriggerId;
                try {
                    triggerOut = (await this._requireTrigger(projectRow, ref)).id;
                } catch (error) {
                    throw new ProjectTriggerError(400, 'BAD_FILTER',
                        `sourceTrigger must be a trigger in this project: ${error.message}`);
                }
            }
        }
        return { sourceAssetId: assetOut, sourceTriggerId: triggerOut };
    }

    async _resolveScriptAsset(userId, projectRow, ref) {
        const asId = Number(ref);
        let row = null;
        if (Number.isInteger(asId) && asId > 0 && String(asId) === String(ref).trim()) {
            row = await db.get(
                `SELECT id, slug, name, kind, currentVersionId
                 FROM project_assets
                 WHERE id = @id AND projectId = @projectId`,
                { id: asId, projectId: projectRow.id }
            );
        }
        if (!row) {
            const key = String(ref).trim();
            row = await db.get(
                `SELECT id, slug, name, kind, currentVersionId
                 FROM project_assets
                 WHERE projectId = @projectId
                   AND (slug = @slugRef OR name = @ref COLLATE NOCASE)`,
                { projectId: projectRow.id, slugRef: key.toLowerCase(), ref: key }
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
            sourceAssetId: row.sourceAssetId ?? null,
            sourceTriggerId: row.sourceTriggerId ?? null,
            action: row.action,
            actionAssetId: row.actionAssetId ?? null,
            actionParams: parseActionParams(row.actionParams),
            isEnabled: Boolean(row.isEnabled),
            lastRun: row.lastRun || null,
            lastOutcome: row.lastOutcome || null,
            createdBy: row.createdBy || null,
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
        owner = null,
        name,
        kind,
        schedule = null,
        eventTopic = null,
        sourceAssetId = undefined,
        sourceAsset = undefined,
        sourceTriggerId = undefined,
        sourceTrigger = undefined,
        action,
        actionAssetId = null,
        actionAsset = null,
        actionParams = {},
        isEnabled = true
    }) {
        const projectRow = await this._requireProject(userId, project, owner);
        const ownerId = projectRow.ownerId || projectRow.userId;
        const cleanName = this._normalizeName(name);
        const cleanKind = this._normalizeKind(kind);
        const cleanAction = this._normalizeAction(action);
        this._assertAgentPromptOwner(projectRow, cleanAction);
        const enabled = isEnabled === false || isEnabled === 0 ? 0 : 1;

        const existing = await db.get(
            `SELECT id FROM project_triggers
             WHERE projectId = @projectId AND name = @name COLLATE NOCASE`,
            { projectId: projectRow.id, name: cleanName }
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
        const filters = await this._normalizeEventFilters({
            userId, projectRow, kind: cleanKind,
            sourceAssetId, sourceAsset, sourceTriggerId, sourceTrigger
        });

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
                 sourceAssetId, sourceTriggerId,
                 action, actionAssetId, actionParams, isEnabled, createdBy)
             VALUES (@projectId, @userId, @name, @kind, @schedule, @nextRun, @eventTopic,
                     @sourceAssetId, @sourceTriggerId,
                     @action, @actionAssetId, @actionParams, @isEnabled, @createdBy)`,
            {
                projectId: projectRow.id,
                userId: ownerId,
                name: cleanName,
                kind: cleanKind,
                schedule: cronSchedule,
                nextRun,
                eventTopic: topic,
                sourceAssetId: filters.sourceAssetId,
                sourceTriggerId: filters.sourceTriggerId,
                action: cleanAction,
                actionAssetId: validated.actionAssetId,
                actionParams: JSON.stringify(validated.actionParams),
                isEnabled: enabled,
                createdBy: userId
            }
        );
        const row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id });
        const created = this._serialize(row, projectRow.slug);
        require('./eventBusService').publishProjectChange({
            userId, slug: projectRow.slug, reason: 'trigger', projectId: projectRow.id
        });
        return created;
    }

    async list({ userId, project, owner = null }) {
        const projectRow = await this._requireProject(userId, project, owner);
        const rows = await db.all(
            `SELECT * FROM project_triggers
             WHERE projectId = @projectId
             ORDER BY isEnabled DESC, name ASC, id ASC`,
            { projectId: projectRow.id }
        );
        return rows.map(row => this._serialize(row, projectRow.slug));
    }

    async get({ userId, project, trigger, owner = null }) {
        const projectRow = await this._requireProject(userId, project, owner);
        const row = await this._requireTrigger(projectRow, trigger);
        return this._serialize(row, projectRow.slug);
    }

    /**
     * Create-or-update by name (the tool's set_trigger).
     */
    async set(params) {
        const projectRow = await this._requireProject(
            params.userId, params.project, params.owner
        );
        const cleanName = this._normalizeName(params.name);
        const existing = await db.get(
            `SELECT id FROM project_triggers
             WHERE projectId = @projectId AND name = @name COLLATE NOCASE`,
            { projectId: projectRow.id, name: cleanName }
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
        owner = null,
        trigger,
        name = undefined,
        kind = undefined,
        schedule = undefined,
        eventTopic = undefined,
        sourceAssetId = undefined,
        sourceAsset = undefined,
        sourceTriggerId = undefined,
        sourceTrigger = undefined,
        action = undefined,
        actionAssetId = undefined,
        actionAsset = undefined,
        actionParams = undefined,
        isEnabled = undefined
    }) {
        const projectRow = await this._requireProject(userId, project, owner);
        const existing = await this._requireTrigger(projectRow, trigger);
        const cleanActionPreview = action !== undefined
            ? this._normalizeAction(action)
            : existing.action;
        this._assertAgentPromptOwner(projectRow, existing.action);
        this._assertAgentPromptOwner(projectRow, cleanActionPreview);

        const cleanName = name !== undefined ? this._normalizeName(name) : existing.name;
        if (name !== undefined && cleanName.toLowerCase() !== String(existing.name).toLowerCase()) {
            const clash = await db.get(
                `SELECT id FROM project_triggers
                 WHERE projectId = @projectId
                   AND name = @name COLLATE NOCASE AND id != @id`,
                { projectId: projectRow.id, name: cleanName, id: existing.id }
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
        const filters = await this._normalizeEventFilters({
            userId, projectRow, kind: cleanKind,
            sourceAssetId, sourceAsset, sourceTriggerId, sourceTrigger,
            existing
        });

        const incomingParams = actionParams !== undefined
            ? { ...parseActionParams(existing.actionParams), ...parseActionParams(actionParams) }
            : parseActionParams(existing.actionParams);
        // Merge semantics: an explicit null drops a knob (e.g. requiredOutputs).
        for (const key of Object.keys(incomingParams)) {
            if (incomingParams[key] === null) delete incomingParams[key];
        }
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
                 eventTopic = @eventTopic, sourceAssetId = @sourceAssetId,
                 sourceTriggerId = @sourceTriggerId,
                 action = @action, actionAssetId = @actionAssetId,
                 actionParams = @actionParams, isEnabled = @isEnabled,
                 updatedAt = datetime('now')
             WHERE id = @id`,
            {
                id: existing.id,
                name: cleanName,
                kind: cleanKind,
                schedule: cronSchedule,
                nextRun,
                eventTopic: topic,
                sourceAssetId: filters.sourceAssetId,
                sourceTriggerId: filters.sourceTriggerId,
                action: cleanAction,
                actionAssetId: validated.actionAssetId,
                actionParams: JSON.stringify(validated.actionParams),
                isEnabled: enabled
            }
        );
        const row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: existing.id });
        const updated = this._serialize(row, projectRow.slug);
        require('./eventBusService').publishProjectChange({
            userId, slug: projectRow.slug, reason: 'trigger', projectId: projectRow.id
        });
        return updated;
    }

    async delete({ userId, project, trigger, owner = null }) {
        const projectRow = await this._requireProject(userId, project, owner);
        const existing = await this._requireTrigger(projectRow, trigger);
        const result = await db.run(
            'DELETE FROM project_triggers WHERE id = @id',
            { id: existing.id }
        );
        if (result.changes === 0) {
            throw new ProjectTriggerError(404, 'NO_SUCH_TRIGGER',
                `No trigger called "${existing.name}" in "${projectRow.slug}".`);
        }
        require('./eventBusService').publishProjectChange({
            userId, slug: projectRow.slug, reason: 'trigger', projectId: projectRow.id
        });
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
     *
     * Ancestry is the explicit parentJobId chain — never inferred from
     * timestamps or ids, so interleaved unrelated jobs cannot be mistaken
     * for parents. A job carrying a parentJobId was by construction
     * started by an event trigger and counts as one hop even if that
     * trigger has since been deleted; legacy rows (no parentJobId) still
     * count themselves through their triggerId. The walk stops at a
     * missing parent row and refuses to loop on a cycle.
     */
    async eventChainDepth(job) {
        let depth = 0;
        let current = job;
        const seen = new Set();
        const kinds = new Map();
        const triggerKind = async (triggerId) => {
            const key = Number(triggerId);
            if (!kinds.has(key)) {
                const trig = await db.get(
                    'SELECT kind FROM project_triggers WHERE id = @id',
                    { id: key }
                );
                kinds.set(key, trig?.kind || null);
            }
            return kinds.get(key);
        };
        while (current) {
            const id = Number(current.id);
            if (seen.has(id) || seen.size >= MAX_CHAIN_WALK) break;
            seen.add(id);
            if (current.parentJobId != null) {
                depth++;
            } else if (current.startedBy === 'trigger' && current.triggerId != null
                && await triggerKind(current.triggerId) === 'event') {
                depth++;
            }
            if (current.parentJobId == null) break;
            current = await db.get(
                `SELECT id, projectId, startedBy, triggerId, parentJobId
                 FROM observatory_jobs WHERE id = @id`,
                { id: Number(current.parentJobId) }
            );
        }
        return depth;
    }

    /** One settled job in the shape the event matcher expects (or null). */
    async _loadEventJob(jobId) {
        return await db.get(`${EVENT_JOB_SELECT} WHERE j.id = @id`, { id: Number(jobId) });
    }

    /**
     * A project's settled jobs newer than `since` (or all of them), oldest
     * first — the catch-up scan order.
     */
    async _settledEventJobs(projectId, since = null) {
        if (since) {
            return await db.all(
                `${EVENT_JOB_SELECT}
                 WHERE j.projectId = @projectId
                   AND j.finishedAt IS NOT NULL
                   AND j.finishedAt > @since
                 ORDER BY j.finishedAt ASC, j.id ASC`,
                { projectId, since }
            );
        }
        return await db.all(
            `${EVENT_JOB_SELECT}
             WHERE j.projectId = @projectId
               AND j.finishedAt IS NOT NULL
             ORDER BY j.finishedAt ASC, j.id ASC`,
            { projectId }
        );
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
        const job = await this._loadEventJob(jobId);
        if (!job || !job.finishedAt || job.status === 'RUNNING') return 0;
        const rows = await db.all(
            `SELECT * FROM project_triggers
             WHERE projectId = @projectId
               AND kind = 'event' AND isEnabled = 1
             ORDER BY id ASC`,
            { projectId: job.projectId }
        );
        let fired = 0;
        for (const trigger of rows) {
            // A non-matching job is invisible to this trigger: it neither
            // fires nor claims lastRun, so a later matching job still can.
            if (!matchesEventTrigger(trigger, job)) continue;
            if (await this._fireEventTrigger(trigger, job, { client })) fired++;
        }
        return fired;
    }

    /**
     * Startup (and periodic) catch-up: jobs whose finishedAt is newer than
     * the trigger's lastRun. Same matcher and same claim as the settle
     * path, so a restart never double-fires and never drops a fire, and
     * unrelated jobs examined first never advance lastRun past a matching
     * job that settled later.
     */
    async catchUpEventTriggers({ client = null } = {}) {
        const triggers = await db.all(
            `SELECT * FROM project_triggers
             WHERE kind = 'event' AND isEnabled = 1
             ORDER BY id ASC`
        );
        let fired = 0;
        for (const trigger of triggers) {
            const jobs = await this._settledEventJobs(trigger.projectId, trigger.lastRun || null);
            for (const job of jobs) {
                const fresh = await db.get(
                    'SELECT * FROM project_triggers WHERE id = @id',
                    { id: trigger.id }
                );
                if (!fresh || !fresh.isEnabled) break;
                if (!matchesEventTrigger(fresh, job)) continue;
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
     *
     * @param {object} trigger
     * @param {{ client?: object|null, sourceJob?: object|null }} [ctx] - sourceJob is
     *   the settled job an event trigger is reacting to; a run_script child
     *   records it as parentJobId. Cron fires pass none.
     */
    async _executeAction(trigger, { client = null, sourceJob = null } = {}) {
        const projectRow = await db.get(
            'SELECT id, slug, name, userId FROM observatory_projects WHERE id = @id',
            { id: trigger.projectId }
        );
        if (!projectRow) {
            await this._recordOutcome(trigger.id, outcomeText('failed', 'project is gone'));
            return;
        }
        if (sourceJob && Number(sourceJob.projectId) !== Number(projectRow.id)) {
            await this._recordOutcome(trigger.id,
                outcomeText('failed', `source job #${sourceJob.id} belongs to another project`));
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
                await this._runScript(trigger, projectRow, validated.actionAssetId, params, client, sourceJob);
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

    /**
     * Start the script's head version. The output contract (if any) is
     * resolved NOW — {utc_date} is the fire date — and handed to the
     * Observatory to freeze on the job, so a later trigger edit cannot
     * change what a running job is judged against. `sourceJob` becomes the
     * child's parentJobId.
     */
    async _runScript(trigger, projectRow, assetId, params, client, sourceJob = null) {
        const asset = await db.get(
            `SELECT id, slug, currentVersionId FROM project_assets
             WHERE id = @id`,
            { id: assetId }
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
        let outputContract = null;
        if (params.requiredOutputs) {
            try {
                outputContract = resolveOutputContract(params.requiredOutputs);
            } catch (error) {
                await this._recordOutcome(trigger.id,
                    outcomeText('failed', `output contract: ${error.message}`));
                return;
            }
        }
        const outcome = await this._observatoryService().run({
            userId: trigger.userId,
            project: projectRow.slug,
            language: head.language,
            code: head.source,
            background,
            client,
            assetVersionId: head.id,
            startedBy: 'trigger',
            triggerId: trigger.id,
            parentJobId: sourceJob?.id ?? null,
            outputContract
        });
        const label = `${asset.slug} v${head.version}`;
        if (outcome.mode === 'background') {
            await this._recordOutcome(trigger.id,
                outcomeText('ok', `job #${outcome.jobId} (${label})`
                    + `${outputContract ? `, ${outputContract.outputs.length} required output(s)` : ''}`));
            return;
        }
        // Foreground: the trigger outcome IS the record, so it must say
        // more than "exit 0" when the declared outputs did not appear.
        await this._recordOutcome(trigger.id, describeForegroundOutcome(label, outcome.result || {}));
    }

    async _executeAgentPrompt(trigger, projectRow, params, client) {
        const prompt = String(params.prompt || '').trim();
        const message = `[Observatory command for project "${projectRow.name}" (slug: ${projectRow.slug})] `
            + 'Use the observatory tool on this project to carry out the instructions below. '
            + 'Start with action "inspect" if you need current project state. '
            + `${backgroundJobHint()}, and `
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
module.exports.matchesEventTrigger = matchesEventTrigger;
module.exports.topicsForJob = topicsForJob;
module.exports.describeForegroundOutcome = describeForegroundOutcome;
module.exports.DEFAULT_MAX_CHAIN_DEPTH = DEFAULT_MAX_CHAIN_DEPTH;
module.exports.MAX_PROMPT = MAX_PROMPT;
