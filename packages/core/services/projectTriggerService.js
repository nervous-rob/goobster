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
 *
 * Event delivery is exactly-once per (trigger, source job): the claim is
 * an INSERT into project_trigger_deliveries, not a timestamp compare, so
 * same-second finishes and out-of-order settles are distinct events. A
 * delivery is DELIVERED only once the downstream job row exists; a busy
 * sandbox / project / active-job cap leaves it RETRYABLE and
 * retryEventDeliveries re-dispatches it from the minute loop. lastRun is
 * a display cursor and the catch-up scan's lower bound, nothing more.
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

/** project_trigger_deliveries.status values. */
const DELIVERY = Object.freeze({
    STARTED: 'STARTED',
    DELIVERED: 'DELIVERED',
    RETRYABLE: 'RETRYABLE',
    FAILED: 'FAILED',
    SKIPPED: 'SKIPPED'
});
/** Dispatch verdicts _executeAction reports (mapped onto DELIVERY by the fire path). */
const DISPATCH = Object.freeze({
    DELIVERED: 'delivered',
    RETRYABLE: 'retryable',
    FAILED: 'failed',
    SKIPPED: 'skipped'
});
/** Observatory/sandbox error codes that mean "not now", never "never". */
const TRANSIENT_CODES = new Set(['BUSY', 'PROJECT_BUSY', 'TOO_MANY_JOBS']);
const MAX_DELIVERY_ATTEMPTS = 10;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
/** A STARTED delivery older than this never finished dispatching (crash) - retry it. */
const STARTED_LEASE_MS = 10 * 60_000;
/**
 * Catch-up looks this far behind lastRun for undelivered matching jobs.
 * The delivery table makes re-examining a job free, so the window can be
 * generous; it exists only to bound the scan.
 */
const CATCH_UP_GRACE_MS = 24 * 60 * 60_000;
const MAX_DELIVERY_LIST = 50;

/** 'YYYY-MM-DD HH:MM:SS' UTC text (the db timestamp convention). */
function utcText(ms = Date.now()) {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function utcToMs(text) {
    if (!text) return NaN;
    return Date.parse(`${String(text).replace(' ', 'T')}Z`);
}

/** Exponential backoff for a RETRYABLE delivery: 1, 2, 4, ... capped at 15 minutes. */
function retryDelayMs(attempts) {
    const exp = Math.max(0, Number(attempts) - 1);
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** exp));
}

function eventExecutionAttemptId(trigger, sourceJob) {
    return `project-trigger:${trigger.id}:source-job:${sourceJob.id}`;
}

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
 * Trigger lastJobOutcome once a job this trigger started has settled -
 * the stage's real result, as opposed to "the dispatch worked".
 * @param {object} job - settled observatory_jobs row
 */
function describeSettledJob(job) {
    const head = `job #${job.id}`;
    const contract = job.outputContractResultJson
        ? (() => { try { return JSON.parse(job.outputContractResultJson); } catch { return null; } })()
        : null;
    if (job.status === 'COMPLETED') {
        const validated = contract?.ok
            ? `, ${contract.checks.length} required output(s) validated`
            : '';
        return outcomeText('ok', `${head} completed${validated}`);
    }
    if (job.errorCode === OUTPUT_CONTRACT_FAILED) {
        return outcomeText('failed', `${head} exit ${job.exitCode ?? '?'}; ${summarizeContractFailure(contract)}`);
    }
    if (job.status === 'TIMED_OUT') return outcomeText('failed', `${head} timed out`);
    if (job.status === 'CANCELLED') return outcomeText('failed', `${head} cancelled`);
    const reason = job.error ? `: ${String(job.error).slice(0, 120)}` : '';
    return outcomeText('failed', `${head} ${String(job.status).toLowerCase()}${reason}`);
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
            // Dispatch result ("started: job #12, awaiting settlement") vs.
            // how the most recently started stage actually ended.
            lastOutcome: row.lastOutcome || null,
            lastJobOutcome: row.lastJobOutcome || null,
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
     * Claim one event = one (trigger, source job) pair. The INSERT into
     * project_trigger_deliveries is the claim: a second caller (settle vs.
     * catch-up, two replicas) hits the unique constraint and gets false.
     * A RETRYABLE delivery whose backoff has elapsed is re-claimed by
     * flipping it back to STARTED. lastRun advances as a display cursor
     * (and the catch-up scan's lower bound) but never decides anything.
     *
     * @returns {Promise<boolean>} true when this caller owns the dispatch
     */
    async claimEventFire(trigger, job) {
        if (!job?.finishedAt || !trigger?.id) return false;
        const enabled = await db.get(
            'SELECT isEnabled FROM project_triggers WHERE id = @id',
            { id: trigger.id }
        );
        if (!enabled?.isEnabled) return false;
        const key = { triggerId: trigger.id, sourceJobId: job.id };
        const inserted = await db.run(
            `INSERT INTO project_trigger_deliveries
                (triggerId, sourceJobId, projectId, status, attempts)
             VALUES (@triggerId, @sourceJobId, @projectId, 'STARTED', 1)
             ON CONFLICT (triggerId, sourceJobId) DO NOTHING`,
            { ...key, projectId: Number(job.projectId) }
        );
        if (inserted.changes > 0) {
            await this._advanceLastRun(trigger.id, job.finishedAt);
            return true;
        }
        const retried = await db.run(
            `UPDATE project_trigger_deliveries
             SET status = 'STARTED', attempts = attempts + 1, nextAttemptAt = NULL,
                 updatedAt = datetime('now')
             WHERE triggerId = @triggerId AND sourceJobId = @sourceJobId
               AND status = 'RETRYABLE'
               AND (nextAttemptAt IS NULL OR nextAttemptAt <= @now)`,
            { ...key, now: utcText() }
        );
        return retried.changes > 0;
    }

    async _advanceLastRun(triggerId, finishedAt) {
        await db.run(
            `UPDATE project_triggers
             SET lastRun = @finishedAt, updatedAt = datetime('now')
             WHERE id = @id AND (lastRun IS NULL OR lastRun < @finishedAt)`,
            { id: triggerId, finishedAt }
        );
    }

    /**
     * Record how a claimed dispatch ended. DELIVERED only when the action
     * really happened (for run_script: the child job row exists). A
     * transient refusal stays RETRYABLE with exponential backoff until
     * MAX_DELIVERY_ATTEMPTS, then becomes FAILED and the owner is told -
     * a relay that quietly disappears is the bug this table exists to fix.
     *
     * @param {object} trigger
     * @param {object} job - the source job
     * @param {{ status: string, detail?: string, childJobId?: number|null }} dispatch
     * @param {{ client?: object|null }} [ctx]
     */
    async _finishDelivery(trigger, job, dispatch, { client = null } = {}) {
        const row = await db.get(
            `SELECT id, attempts, status FROM project_trigger_deliveries
             WHERE triggerId = @triggerId AND sourceJobId = @sourceJobId`,
            { triggerId: trigger.id, sourceJobId: job.id }
        );
        if (!row) return null;
        if (row.status === DELIVERY.DELIVERED) return DELIVERY.DELIVERED;
        const detail = dispatch.detail ? String(dispatch.detail).slice(0, MAX_OUTCOME) : null;
        let status;
        let nextAttemptAt = null;
        if (dispatch.status === DISPATCH.DELIVERED) {
            status = DELIVERY.DELIVERED;
        } else if (dispatch.status === DISPATCH.SKIPPED) {
            status = DELIVERY.SKIPPED;
        } else if (dispatch.status === DISPATCH.RETRYABLE && row.attempts < MAX_DELIVERY_ATTEMPTS) {
            status = DELIVERY.RETRYABLE;
            nextAttemptAt = utcText(Date.now() + retryDelayMs(row.attempts));
        } else {
            status = DELIVERY.FAILED;
        }
        const updated = await db.run(
            `UPDATE project_trigger_deliveries
             SET status = @status, detail = @detail, childJobId = @childJobId,
                 nextAttemptAt = @nextAttemptAt, updatedAt = datetime('now')
             WHERE id = @id AND status <> 'DELIVERED'`,
            {
                id: row.id,
                status,
                detail,
                childJobId: dispatch.childJobId == null ? null : Number(dispatch.childJobId),
                nextAttemptAt
            }
        );
        // A reclaimed lease may finish before its original dispatcher.
        // Never let that late dispatcher undo an acknowledged child.
        if (!updated.changes) {
            const current = await db.get('SELECT status FROM project_trigger_deliveries WHERE id = @id', { id: row.id });
            return current?.status ?? null;
        }
        if (status === DELIVERY.FAILED) {
            // One ledger row per failed relay (documentation/work_ledger.md);
            // the detail is the dispatcher's own phrase, never job output.
            await require('./workFailureService').note({
                kind: 'trigger',
                workId: trigger.id,
                actor: trigger.userId || job.userId || null,
                phase: 'delivery',
                code: dispatch.status === DISPATCH.RETRYABLE ? 'DELIVERY_EXHAUSTED' : 'DISPATCH_FAILED',
                reason: detail || 'the trigger could not start its stage'
            });
        }
        if (status === DELIVERY.FAILED && dispatch.status === DISPATCH.RETRYABLE) {
            const gaveUp = `gave up after ${row.attempts} attempts: ${detail || 'still busy'}`;
            await this._recordOutcome(trigger.id, outcomeText('failed', gaveUp));
            await this._notifyOwner(
                trigger,
                `⚠️ Project trigger "${trigger.name}" could not start its stage for job #${job.id}: ${gaveUp}. `
                + 'The event is not lost - re-run the upstream stage, or start the script by hand.',
                client
            );
        }
        return status;
    }

    /**
     * Re-dispatch RETRYABLE deliveries whose backoff has elapsed, and
     * reclaim STARTED rows a crash left behind. Runs from the automation
     * minute loop next to fireDueCronTriggers / catchUpEventTriggers.
     * @returns {Promise<number>} deliveries that became DELIVERED
     */
    async retryEventDeliveries({ client = null } = {}) {
        const now = utcText();
        // A dispatch that never reported back (process died mid-run) is
        // indistinguishable from a slow one until the lease passes.
        await db.run(
            `UPDATE project_trigger_deliveries
             SET status = 'RETRYABLE', nextAttemptAt = @now, detail = 'dispatch interrupted',
                 updatedAt = datetime('now')
             WHERE status = 'STARTED' AND updatedAt < @staleBefore`,
            { now, staleBefore: utcText(Date.now() - STARTED_LEASE_MS) }
        );
        const due = await db.all(
            `SELECT d.triggerId, d.sourceJobId
             FROM project_trigger_deliveries d
             JOIN project_triggers t ON t.id = d.triggerId
             WHERE d.status = 'RETRYABLE'
               AND (d.nextAttemptAt IS NULL OR d.nextAttemptAt <= @now)
               AND t.isEnabled = 1 AND t.kind = 'event'
             ORDER BY d.updatedAt ASC, d.id ASC
             LIMIT 100`,
            { now }
        );
        let delivered = 0;
        for (const item of due) {
            const trigger = await db.get(
                'SELECT * FROM project_triggers WHERE id = @id', { id: item.triggerId }
            );
            const job = await this._loadEventJob(item.sourceJobId);
            if (!trigger || !job) {
                await db.run(
                    `UPDATE project_trigger_deliveries SET status = 'FAILED', detail = 'source job or trigger is gone',
                         updatedAt = datetime('now')
                     WHERE triggerId = @triggerId AND sourceJobId = @sourceJobId`,
                    item
                );
                continue;
            }
            if (await this._fireEventTrigger(trigger, job, { client })) delivered++;
        }
        return delivered;
    }

    /**
     * Delivery records for one trigger (newest first) - the answer to "did
     * stage 3 actually start after stage 2 finished, and if not, why".
     */
    async listDeliveries({ userId, project, trigger, owner = null, limit = 20 }) {
        const projectRow = await this._requireProject(userId, project, owner);
        const row = await this._requireTrigger(projectRow, trigger);
        const rows = await db.all(
            `SELECT d.id, d.triggerId, d.sourceJobId, d.status, d.attempts, d.childJobId, d.detail,
                    d.nextAttemptAt, d.createdAt, d.updatedAt,
                    s.status AS sourceStatus, s.finishedAt AS sourceFinishedAt,
                    c.status AS childStatus, c.errorCode AS childErrorCode
             FROM project_trigger_deliveries d
             LEFT JOIN observatory_jobs s ON s.id = d.sourceJobId
             LEFT JOIN observatory_jobs c ON c.id = d.childJobId
             WHERE d.triggerId = @triggerId
             ORDER BY d.id DESC
             LIMIT @limit`,
            { triggerId: row.id, limit: Math.max(1, Math.min(MAX_DELIVERY_LIST, Number(limit) || 20)) }
        );
        return rows.map(d => ({
            id: d.id,
            triggerId: d.triggerId,
            sourceJobId: d.sourceJobId,
            sourceStatus: d.sourceStatus || null,
            sourceFinishedAt: d.sourceFinishedAt || null,
            status: d.status,
            attempts: d.attempts,
            childJobId: d.childJobId ?? null,
            childStatus: d.childStatus || null,
            childErrorCode: d.childErrorCode || null,
            detail: d.detail || null,
            nextAttemptAt: d.nextAttemptAt || null,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt
        }));
    }

    async _notifyOwner(trigger, message) {
        try {
            // A personal follow-up due now: delivered to the owner's inbox
            // (and echoed to Discord when they have it) by the follow-up
            // pass, so no gateway is needed to file it.
            const { inboxChannelId } = require('./inboxService');
            const channelId = inboxChannelId(trigger.userId);
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
        await this._recordStartedJobSettled(job);
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
     * A job that a trigger started has settled: write the stage's real
     * result onto that trigger as lastJobOutcome. lastOutcome still says
     * "started: job #N, awaiting settlement" - the two are separate on
     * purpose, so a launched-but-failed stage never reads as "ok".
     */
    async _recordStartedJobSettled(job) {
        if (job.startedBy !== 'trigger' || job.triggerId == null) return;
        await db.run(
            `UPDATE project_triggers
             SET lastJobOutcome = @lastJobOutcome, updatedAt = datetime('now')
             WHERE id = @id`,
            { id: Number(job.triggerId), lastJobOutcome: describeSettledJob(job) }
        );
    }

    /**
     * Startup (and periodic) catch-up: matching settled jobs with no
     * delivery record yet. Same matcher and same claim as the settle path,
     * so a restart never double-fires and never drops a fire. The scan is
     * bounded below by lastRun minus a grace window (the delivery table,
     * not the cursor, decides what is new), and a trigger from before
     * delivery records is back-filled first so its already-consumed
     * history is not replayed.
     */
    async catchUpEventTriggers({ client = null } = {}) {
        const triggers = await db.all(
            `SELECT * FROM project_triggers
             WHERE kind = 'event' AND isEnabled = 1
             ORDER BY id ASC`
        );
        let fired = 0;
        for (const trigger of triggers) {
            await this._backfillLegacyDeliveries(trigger);
            const jobs = await this._undeliveredEventJobs(trigger);
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

    /**
     * Settled project jobs this trigger has no delivery row for, oldest
     * first, from (lastRun - grace) onward. Non-matching jobs are returned
     * too (the matcher runs in JS); the window keeps that cheap.
     */
    async _undeliveredEventJobs(trigger) {
        const sinceMs = utcToMs(trigger.lastRun);
        const since = Number.isFinite(sinceMs) ? utcText(sinceMs - CATCH_UP_GRACE_MS) : null;
        return await db.all(
            `${EVENT_JOB_SELECT}
             LEFT JOIN project_trigger_deliveries d
               ON d.triggerId = @triggerId AND d.sourceJobId = j.id
             WHERE j.projectId = @projectId
               AND j.finishedAt IS NOT NULL
               AND d.id IS NULL
               ${since ? 'AND j.finishedAt >= @since' : ''}
             ORDER BY j.finishedAt ASC, j.id ASC`,
            since
                ? { triggerId: trigger.id, projectId: trigger.projectId, since }
                : { triggerId: trigger.id, projectId: trigger.projectId }
        );
    }

    /**
     * A trigger that has a lastRun but no delivery rows predates the
     * delivery table: under the old cursor semantics every matching job
     * with finishedAt <= lastRun was consumed (fired, skipped, or
     * collapsed), so record those as DELIVERED(legacy) once. Without this
     * the catch-up window would replay them.
     */
    async _backfillLegacyDeliveries(trigger) {
        if (!trigger.lastRun) return 0;
        const any = await db.get(
            'SELECT id FROM project_trigger_deliveries WHERE triggerId = @id LIMIT 1',
            { id: trigger.id }
        );
        if (any) return 0;
        const jobs = await db.all(
            `${EVENT_JOB_SELECT}
             WHERE j.projectId = @projectId
               AND j.finishedAt IS NOT NULL
               AND j.finishedAt <= @lastRun
             ORDER BY j.id ASC`,
            { projectId: trigger.projectId, lastRun: trigger.lastRun }
        );
        let filled = 0;
        for (const job of jobs) {
            if (!matchesEventTrigger(trigger, job)) continue;
            const result = await db.run(
                `INSERT INTO project_trigger_deliveries
                    (triggerId, sourceJobId, projectId, status, attempts, detail)
                 VALUES (@triggerId, @sourceJobId, @projectId, 'DELIVERED', 0, 'legacy: consumed by lastRun before delivery records')
                 ON CONFLICT (triggerId, sourceJobId) DO NOTHING`,
                { triggerId: trigger.id, sourceJobId: job.id, projectId: trigger.projectId }
            );
            filled += result.changes > 0 ? 1 : 0;
        }
        return filled;
    }

    /**
     * Claim, dispatch, and record the delivery for one (trigger, job).
     * @returns {Promise<boolean>} true when the action was delivered
     */
    async _fireEventTrigger(trigger, job, { client = null } = {}) {
        const skip = await this.shouldSkipChain(trigger, job);
        if (skip) {
            if (await this.claimEventFire(trigger, job)) {
                await this._finishDelivery(trigger, job, { status: DISPATCH.SKIPPED, detail: skip }, { client });
                await this._recordOutcome(trigger.id, outcomeText('skipped', skip));
            }
            return false;
        }
        if (!await this.claimEventFire(trigger, job)) return false;
        let dispatch;
        try {
            dispatch = await this._executeAction(trigger, { client, sourceJob: job });
        } catch (error) {
            dispatch = { status: DISPATCH.FAILED, detail: error.message };
            await this._recordOutcome(trigger.id, outcomeText('failed', error.message));
            console.error(`Project trigger "${trigger.name}" failed:`, error);
        }
        const status = await this._finishDelivery(trigger, job, dispatch, { client });
        return status === DELIVERY.DELIVERED;
    }

    /**
     * Re-validate params, then run the action under the owner's identity.
     * Rate limits, quotas, and active-job caps all apply. A busy sandbox,
     * a busy project, or an active-job cap is "not now" (retryable for an
     * event delivery; the next tick for cron), never a failed trigger.
     *
     * Always records lastOutcome and returns the dispatch verdict
     * { status: 'delivered'|'retryable'|'failed'|'skipped', detail, childJobId }
     * so the event path can settle its delivery record from it.
     *
     * @param {object} trigger
     * @param {{ client?: object|null, sourceJob?: object|null }} [ctx] - sourceJob is
     *   the settled job an event trigger is reacting to; a run_script child
     *   records it as parentJobId. Cron fires pass none.
     */
    async _executeAction(trigger, { client = null, sourceJob = null } = {}) {
        const report = async (status, detail, extra = {}) => {
            const label = extra.label
                || (status === DISPATCH.DELIVERED ? 'ok' : status === DISPATCH.RETRYABLE ? 'deferred' : status);
            await this._recordOutcome(trigger.id, outcomeText(label, detail));
            return { status, detail, childJobId: extra.childJobId ?? null };
        };
        // Reconcile before validating today's asset/config: an existing
        // child already froze its code and contract at the original fire.
        const recovered = await this._recoverEventChild(trigger, sourceJob, report);
        if (recovered) return recovered;
        const projectRow = await db.get(
            'SELECT id, slug, name, userId FROM observatory_projects WHERE id = @id',
            { id: trigger.projectId }
        );
        if (!projectRow) return await report(DISPATCH.FAILED, 'project is gone');
        if (sourceJob && Number(sourceJob.projectId) !== Number(projectRow.id)) {
            return await report(DISPATCH.FAILED, `source job #${sourceJob.id} belongs to another project`);
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
            if (error.code === 'HOST_NOT_ALLOWED') return await report(DISPATCH.SKIPPED, error.message);
            return await report(DISPATCH.FAILED, error.message);
        }

        const params = validated.actionParams;
        try {
            if (trigger.action === 'run_script') {
                return await this._runScript(trigger, projectRow, validated.actionAssetId, params, client, sourceJob, report);
            }
            if (trigger.action === 'render') {
                const render = await this._observatoryService().render({
                    userId: trigger.userId,
                    project: projectRow.slug,
                    fps: params.fps ?? null
                });
                return await report(DISPATCH.DELIVERED, `${render.frames} frame(s) → ${render.relPath}`);
            }
            if (trigger.action === 'fetch_data') {
                const result = await this._requestService().requestFetch({
                    userId: trigger.userId,
                    project: projectRow.slug,
                    url: params.url,
                    saveAs: params.filename || params.saveAs || '',
                    reason: `project trigger "${trigger.name}"`,
                    client
                });
                return await report(DISPATCH.DELIVERED, String(result).slice(0, 180));
            }
            if (trigger.action === 'agent_prompt') {
                await this._executeAgentPrompt(trigger, projectRow, params, client);
                return await report(DISPATCH.DELIVERED, 'agent prompt');
            }
            return await report(DISPATCH.FAILED, `unknown action ${trigger.action}`);
        } catch (error) {
            // Another dispatcher may have inserted the same attempt after
            // our initial lookup. The unique DB key prevents a second job;
            // adopt the winner even if it has already finished.
            const racedChild = await this._recoverEventChild(trigger, sourceJob, report);
            if (racedChild) return racedChild;
            if (TRANSIENT_CODES.has(error?.code)) {
                return await report(DISPATCH.RETRYABLE,
                    `${error.message || 'sandbox busy'} — ${sourceJob ? 'will retry' : 'next scheduled run'}`);
            }
            throw error;
        }
    }

    async _recoverEventChild(trigger, sourceJob, report) {
        if (!sourceJob || trigger.action !== 'run_script') return null;
        const child = await db.get(
            `SELECT * FROM observatory_jobs
             WHERE projectId = @projectId AND userId = @userId
               AND startedBy = 'trigger' AND triggerId = @triggerId AND parentJobId = @parentJobId
               AND (executionAttemptId = @attemptId OR executionAttemptId IS NULL)
             ORDER BY id ASC LIMIT 1`,
            {
                projectId: trigger.projectId, userId: trigger.userId,
                triggerId: trigger.id, parentJobId: sourceJob.id,
                attemptId: eventExecutionAttemptId(trigger, sourceJob)
            }
        );
        if (!child) return null;
        // NULL attempt keys cover jobs launched before this fix. Their
        // explicit trigger + parent provenance identifies the same event.
        if (child.finishedAt) await this._recordStartedJobSettled(child);
        return await report(DISPATCH.DELIVERED,
            `job #${child.id}; recovered existing dispatch; stage ${child.status}`,
            { label: 'recovered', childJobId: child.id });
    }

    /**
     * Start the script's head version. The output contract (if any) is
     * resolved NOW — {utc_date} is the fire date — and handed to the
     * Observatory to freeze on the job, so a later trigger edit cannot
     * change what a running job is judged against. `sourceJob` becomes the
     * child's parentJobId.
     */
    async _runScript(trigger, projectRow, assetId, params, client, sourceJob = null, report) {
        const asset = await db.get(
            `SELECT id, slug, currentVersionId FROM project_assets
             WHERE id = @id`,
            { id: assetId }
        );
        if (!asset?.currentVersionId) {
            return await report(DISPATCH.FAILED, 'script asset has no head version');
        }
        const head = await db.get(
            `SELECT id, language, source, version FROM project_asset_versions
             WHERE id = @id AND assetId = @assetId`,
            { id: asset.currentVersionId, assetId: asset.id }
        );
        if (!head) return await report(DISPATCH.FAILED, 'head version is missing');
        const background = params.background !== false && params.background !== 0;
        let outputContract = null;
        if (params.requiredOutputs) {
            try {
                outputContract = resolveOutputContract(params.requiredOutputs);
            } catch (error) {
                return await report(DISPATCH.FAILED, `output contract: ${error.message}`);
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
            executionAttemptId: sourceJob ? eventExecutionAttemptId(trigger, sourceJob) : null,
            parentJobId: sourceJob?.id ?? null,
            outputContract
        });
        const label = `${asset.slug} v${head.version}`;
        if (outcome.mode === 'background') {
            // "started" is exactly what happened: the job row exists and is
            // running. How the stage ends lands in lastJobOutcome on settle.
            return await report(DISPATCH.DELIVERED,
                `job #${outcome.jobId} (${label})`
                    + `${outputContract ? `, ${outputContract.outputs.length} required output(s)` : ''}`
                    + ', awaiting settlement',
                { label: 'started', childJobId: outcome.jobId });
        }
        // Foreground: the trigger outcome IS the record, so it must say
        // more than "exit 0" when the declared outputs did not appear.
        const text = describeForegroundOutcome(label, outcome.result || {});
        const [status, ...rest] = text.split(': ');
        return await report(DISPATCH.DELIVERED, rest.join(': '), {
            label: status, childJobId: outcome.jobId ?? null
        });
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

    /** /forget-me: every trigger belonging to the user (deliveries cascade; made explicit). */
    async forgetUser(userId) {
        await db.run(
            `DELETE FROM project_trigger_deliveries
             WHERE triggerId IN (SELECT id FROM project_triggers WHERE userId = @userId)`,
            { userId }
        );
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
module.exports.describeSettledJob = describeSettledJob;
module.exports.DELIVERY = DELIVERY;
module.exports.MAX_DELIVERY_ATTEMPTS = MAX_DELIVERY_ATTEMPTS;
module.exports.STARTED_LEASE_MS = STARTED_LEASE_MS;
module.exports.CATCH_UP_GRACE_MS = CATCH_UP_GRACE_MS;
module.exports.retryDelayMs = retryDelayMs;
module.exports.DEFAULT_MAX_CHAIN_DEPTH = DEFAULT_MAX_CHAIN_DEPTH;
module.exports.MAX_PROMPT = MAX_PROMPT;
