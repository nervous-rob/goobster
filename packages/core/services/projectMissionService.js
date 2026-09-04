/**
 * Project Missions: durable intent and evaluation for one piece of project
 * work. The model proposes a plan and evaluates evidence; this module owns
 * permissions, budgets, transitions, and what counts as completed.
 *
 * State machine (deterministic):
 *   DRAFT → APPROVED → ACTIVE → BLOCKED|REVIEW → COMPLETED
 *   any open status → CANCELLED
 *
 * One open mission per project (DRAFT/APPROVED/ACTIVE/BLOCKED/REVIEW).
 * COMPLETED and CANCELLED free the slot. Attention notices only for
 * BLOCKED, REVIEW, and an approaching deadline — never "step done".
 *
 * Events on the domain bus are hints. Step linkage is updated from the
 * job / expedition / watch settle paths so a missed event cannot leave
 * a step running forever.
 */

const crypto = require('node:crypto');
const db = require('../db');
const { dmScopeId } = require('../utils/dmScope');
const domainEventBus = require('./domainEventBus');
const logger = require('../utils/logger');

const OPEN_STATUSES = ['DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED', 'REVIEW'];
const TERMINAL_STATUSES = ['COMPLETED', 'CANCELLED'];
const STEP_KINDS = new Set(['expedition', 'job', 'watch', 'human']);
const EVIDENCE_KINDS = new Set(['claim', 'note', 'job', 'artifact']);
const POLARITIES = new Set(['for', 'against', 'neutral']);
const VERDICTS = new Set(['met', 'unmet', 'mixed']);
const ASSESSMENTS = new Set(['supported', 'contested', 'unassessed']);
const HUMAN_ORIGINS = new Set(['portal', 'discord']);
const RECEIPT_KINDS = new Set(['approve', 'complete']);
const RECEIPT_TTL_MS = 15 * 60 * 1000;
const STARTING_STALE_MS = 2 * 60 * 1000;
const IN_FLIGHT_STEP = new Set(['STARTING', 'RUNNING']);

const MAX_TITLE = 120;
const MAX_OBJECTIVE = 2000;
const MAX_CRITERIA = 12;
const MAX_CRITERION = 400;
const MAX_STEPS = 16;
const MAX_STEP_TITLE = 160;
const MAX_STEP_DESC = 800;
const MAX_EVIDENCE = 40;
const MAX_EVIDENCE_LABEL = 200;
const MAX_REVIEW_NOTES = 4000;
const MAX_REOPEN = 400;
const DEFAULT_BUDGET = { maxExpeditions: 3, maxJobs: 5, maxWatches: 3 };

class ProjectMissionError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ProjectMissionError';
        this.status = status;
        this.code = code;
    }
}

function parseJson(raw, fallback) {
    if (raw && typeof raw === 'object') return raw;
    if (!raw) return fallback;
    try {
        const parsed = JSON.parse(raw);
        return parsed == null ? fallback : parsed;
    } catch {
        return fallback;
    }
}

function clip(text, max) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function toUtcText(value) {
    if (!value) return null;
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        return value.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    }
    const raw = String(value).trim();
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} 23:59:59`;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function legalizeCriteria(input) {
    let list = input;
    if (typeof input === 'string') {
        list = input.split(/\n|;|\|/g).map(s => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(list)) {
        throw new ProjectMissionError(400, 'BAD_CRITERIA',
            'A mission needs measurable success criteria (one or more).');
    }
    const out = [];
    for (const item of list.slice(0, MAX_CRITERIA)) {
        if (typeof item === 'string') {
            const text = clip(item, MAX_CRITERION);
            if (text.length < 4) continue;
            out.push({ id: `c${out.length + 1}`, text });
            continue;
        }
        if (!item || typeof item !== 'object') continue;
        const text = clip(item.text || item.label || item.criterion, MAX_CRITERION);
        if (text.length < 4) continue;
        const id = String(item.id || `c${out.length + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)
            || `c${out.length + 1}`;
        out.push({ id, text });
    }
    if (out.length === 0) {
        throw new ProjectMissionError(400, 'BAD_CRITERIA',
            'Write at least one measurable success criterion (what would count as done).');
    }
    return out;
}

function legalizeBudget(input) {
    const raw = parseJson(input, {}) || {};
    const num = (value, fallback, max) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(0, Math.min(max, Math.floor(n)));
    };
    return {
        maxExpeditions: num(raw.maxExpeditions, DEFAULT_BUDGET.maxExpeditions, 12),
        maxJobs: num(raw.maxJobs, DEFAULT_BUDGET.maxJobs, 20),
        maxWatches: num(raw.maxWatches, DEFAULT_BUDGET.maxWatches, 12),
        notes: clip(raw.notes, 400) || null
    };
}

function uniqueEvidence(items) {
    const seen = new Set();
    const out = [];
    for (const item of items || []) {
        const key = `${item.kind}:${item.refId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function requiredStepParams(kind, params) {
    const body = parseJson(params, {}) || {};
    if (kind === 'job' && !(body.asset || body.assetSlug || body.slug)) {
        throw new ProjectMissionError(400, 'BAD_STEP_PARAMS',
            'A job step needs an asset slug before it can start.');
    }
    if (kind === 'watch' && !(body.topic || body.watchTopic)) {
        throw new ProjectMissionError(400, 'BAD_STEP_PARAMS',
            'A watch step needs a topic before it can start.');
    }
    return body;
}

function legalizeDependsOn(input) {
    if (input == null || input === '') return [];
    const list = Array.isArray(input)
        ? input
        : String(input).split(/[,\s]+/).filter(Boolean);
    const ids = [];
    for (const item of list) {
        const n = Number(item);
        if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
    }
    return ids;
}

class ProjectMissionService {
    constructor({
        observatory = null,
        spitball = null,
        watches = null
    } = {}) {
        this._observatory = observatory;
        this._spitball = spitball;
        this._watches = watches;
    }

    _obs() {
        return this._observatory || require('./observatoryService');
    }

    _expeditions() {
        return this._spitball || require('./spitballExpeditionService');
    }

    _watchService() {
        return this._watches || require('./attentionWatchService');
    }

    async _requireProject(userId, projectRef, owner = null) {
        try {
            return await require('./projectService').resolveProjectForActor({
                userId, project: projectRef, owner
            });
        } catch (error) {
            if (error?.status && error?.code) {
                throw new ProjectMissionError(error.status, error.code, error.message);
            }
            throw error;
        }
    }

    async _requireMissionRow(userId, projectRef, owner = null, missionId = null) {
        const project = await this._requireProject(userId, projectRef, owner);
        let row;
        if (missionId != null && missionId !== '') {
            row = await db.get(
                `SELECT * FROM project_missions
                 WHERE id = @id AND projectId = @projectId`,
                { id: Number(missionId), projectId: project.id }
            );
        } else {
            row = await db.get(
                `SELECT * FROM project_missions
                 WHERE projectId = @projectId AND status IN ('DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED', 'REVIEW')
                 ORDER BY id DESC LIMIT 1`,
                { projectId: project.id }
            );
        }
        if (!row) {
            throw new ProjectMissionError(404, 'NO_MISSION',
                missionId ? 'No such mission on this project.' : 'This project has no open mission.');
        }
        return { project, row };
    }

    async _requireOpen(userId, projectRef, owner, missionId, allowed) {
        const { project, row } = await this._requireMissionRow(userId, projectRef, owner, missionId);
        if (allowed && !allowed.includes(row.status)) {
            throw new ProjectMissionError(409, 'BAD_STATUS',
                `This mission is ${row.status} — that action is not available.`);
        }
        return { project, row };
    }

    async _appendEvent(handle, {
        missionId, userId, kind, payload = null
    }) {
        await handle.run(
            `INSERT INTO project_mission_events (missionId, userId, kind, payloadJson)
             VALUES (@missionId, @userId, @kind, @payloadJson)`,
            {
                missionId,
                userId,
                kind,
                payloadJson: payload ? JSON.stringify(payload) : null
            }
        );
    }

    _publish(topic, payload) {
        try {
            domainEventBus.publish(topic, payload);
        } catch (error) {
            logger.warn?.(`[mission] Event ${topic} not published: ${error.message}`);
        }
        try {
            if (payload?.userId && payload?.slug) {
                require('./eventBusService').publishProjectChange({
                    userId: payload.userId,
                    slug: payload.slug,
                    reason: 'mission',
                    projectId: payload.projectId || null
                });
            }
        } catch { /* portal refetch is best-effort */ }
    }

    async _shape(row, { includeTimeline = true } = {}) {
        const steps = await db.all(
            `SELECT * FROM project_mission_steps
             WHERE missionId = @missionId
             ORDER BY sortOrder ASC, id ASC`,
            { missionId: row.id }
        );
        const evidence = await db.all(
            `SELECT * FROM project_mission_evidence
             WHERE missionId = @missionId
             ORDER BY id ASC`,
            { missionId: row.id }
        );
        let events = [];
        if (includeTimeline) {
            events = await db.all(
                `SELECT id, kind, payloadJson, createdAt
                 FROM project_mission_events
                 WHERE missionId = @missionId
                 ORDER BY id ASC`,
                { missionId: row.id }
            );
        }
        const criteria = parseJson(row.successCriteriaJson, []);
        const budget = legalizeBudget(row.budgetJson);
        const shapedSteps = steps.map(step => this._shapeStep(step));
        const shapedEvidence = evidence.map(item => this._shapeEvidence(item));
        const evaluation = this._evaluate(criteria, shapedEvidence, shapedSteps);
        return {
            id: row.id,
            projectId: row.projectId,
            userId: row.userId,
            title: row.title,
            objective: row.objective,
            successCriteria: criteria,
            deadline: row.deadline || null,
            budget,
            status: row.status,
            review: parseJson(row.reviewJson, null),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            approvedAt: row.approvedAt || null,
            approvedBy: row.approvedBy || null,
            planRevision: Number(row.planRevision) || 1,
            approvedRevision: row.approvedRevision != null ? Number(row.approvedRevision) : null,
            startedAt: row.startedAt || null,
            completedAt: row.completedAt || null,
            steps: shapedSteps,
            evidence: shapedEvidence,
            evaluation,
            timeline: events.map(event => ({
                id: event.id,
                kind: event.kind,
                payload: parseJson(event.payloadJson, null),
                createdAt: event.createdAt
            }))
        };
    }

    _shapeStep(row) {
        return {
            id: row.id,
            missionId: row.missionId,
            kind: row.kind,
            title: row.title,
            description: row.description || null,
            status: row.status,
            dependsOn: parseJson(row.dependsOnJson, []) || [],
            requiresApproval: Boolean(row.requiresApproval),
            expeditionId: row.expeditionId || null,
            jobId: row.jobId || null,
            watchId: row.watchId || null,
            actionParams: parseJson(row.actionParamsJson, {}) || {},
            executionAttemptId: row.executionAttemptId || null,
            planRevision: Number(row.planRevision) || 0,
            sortOrder: row.sortOrder,
            startedAt: row.startedAt || null,
            finishedAt: row.finishedAt || null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt
        };
    }

    _shapeEvidence(row) {
        return {
            id: row.id,
            missionId: row.missionId,
            criterionId: row.criterionId || null,
            kind: row.kind,
            refId: row.refId,
            label: row.label || null,
            polarity: row.polarity,
            provenance: parseJson(row.provenanceJson, null),
            createdAt: row.createdAt
        };
    }

    /**
     * Automatic evidence rollup. Never returns met/unmet/mixed — those
     * verdicts are reserved for a human review. Duplicate (kind, refId)
     * links on one criterion count once.
     */
    _evaluate(criteria, evidence, steps) {
        const byCriterion = (criteria || []).map(criterion => {
            const linked = uniqueEvidence(
                (evidence || []).filter(item => item.criterionId === criterion.id)
            );
            const support = linked.filter(item => item.polarity === 'for').length;
            const against = linked.filter(item => item.polarity === 'against').length;
            let assessment = 'unassessed';
            if (against > 0 && against >= support) assessment = 'contested';
            else if (support > against) assessment = 'supported';
            return {
                id: criterion.id,
                text: criterion.text,
                support,
                against,
                linked: linked.length,
                assessment
            };
        });
        const supported = byCriterion.filter(c => c.assessment === 'supported').length;
        const contested = byCriterion.filter(c => c.assessment === 'contested').length;
        const unassessed = byCriterion.filter(c => c.assessment === 'unassessed').length;
        const failedSteps = (steps || []).filter(s => s.status === 'FAILED').length;
        const doneSteps = (steps || []).filter(s => s.status === 'DONE' || s.status === 'SKIPPED').length;
        let overall = 'unassessed';
        if (contested > 0) overall = 'contested';
        else if (supported > 0 && unassessed === 0) overall = 'supported';
        return {
            overall,
            supported,
            contested,
            unassessed,
            failedSteps,
            doneSteps,
            totalSteps: (steps || []).length,
            criteria: byCriterion
        };
    }

    async _refreshReadySteps(handle, missionId) {
        const steps = await handle.all(
            'SELECT * FROM project_mission_steps WHERE missionId = @missionId',
            { missionId }
        );
        const byId = new Map(steps.map(s => [s.id, s]));
        for (const step of steps) {
            if (step.status !== 'PENDING') continue;
            const deps = parseJson(step.dependsOnJson, []) || [];
            const ready = deps.every((id) => {
                const dep = byId.get(Number(id));
                return dep && (dep.status === 'DONE' || dep.status === 'SKIPPED');
            });
            if (!ready) continue;
            await handle.run(
                `UPDATE project_mission_steps
                 SET status = 'READY', updatedAt = datetime('now')
                 WHERE id = @id AND status = 'PENDING'`,
                { id: step.id }
            );
        }
    }

    async _maybeAdvanceToReview(handle, mission, actorId) {
        if (mission.status !== 'ACTIVE') return false;
        const pending = await handle.get(
            `SELECT COUNT(*) AS c FROM project_mission_steps
             WHERE missionId = @missionId
               AND status NOT IN ('DONE', 'SKIPPED')`,
            { missionId: mission.id }
        );
        if ((pending?.c || 0) > 0) return false;
        const changed = (await handle.run(
            `UPDATE project_missions
             SET status = 'REVIEW', updatedAt = datetime('now')
             WHERE id = @id AND status = 'ACTIVE'`,
            { id: mission.id }
        )).changes > 0;
        if (changed) {
            await this._appendEvent(handle, {
                missionId: mission.id,
                userId: actorId || mission.userId,
                kind: 'review',
                payload: { reason: 'all_steps_done' }
            });
        }
        return changed;
    }

    async _maybeUnblock(handle, mission, actorId) {
        if (mission.status !== 'BLOCKED') return false;
        const remaining = await handle.get(
            `SELECT COUNT(*) AS c FROM project_mission_steps
             WHERE missionId = @missionId AND status = 'FAILED'`,
            { missionId: mission.id }
        );
        if ((remaining?.c || 0) > 0) return false;
        const changed = (await handle.run(
            `UPDATE project_missions
             SET status = 'ACTIVE', updatedAt = datetime('now')
             WHERE id = @id AND status = 'BLOCKED'`,
            { id: mission.id }
        )).changes > 0;
        if (changed) {
            await this._appendEvent(handle, {
                missionId: mission.id,
                userId: actorId || mission.userId,
                kind: 'unblocked',
                payload: { reason: 'failed_steps_resolved' }
            });
        }
        return changed;
    }

    async _maybeBlock(handle, mission, actorId, reason) {
        if (mission.status !== 'ACTIVE') return false;
        const changed = (await handle.run(
            `UPDATE project_missions
             SET status = 'BLOCKED', updatedAt = datetime('now')
             WHERE id = @id AND status = 'ACTIVE'`,
            { id: mission.id }
        )).changes > 0;
        if (changed) {
            await this._appendEvent(handle, {
                missionId: mission.id,
                userId: actorId || mission.userId,
                kind: 'blocked',
                payload: { reason: clip(reason, 240) || 'A step failed.' }
            });
        }
        return changed;
    }

    /**
     * Draft a mission. Fails if the project already has an open one.
     */
    async create({
        userId,
        project,
        owner = null,
        title,
        objective,
        successCriteria,
        deadline = null,
        budget = null,
        steps = []
    } = {}) {
        if (!userId) {
            throw new ProjectMissionError(400, 'BAD_USER', 'A user is required.');
        }
        const projectRow = await this._requireProject(userId, project, owner);
        const cleanTitle = clip(title, MAX_TITLE) || clip(objective, MAX_TITLE);
        const cleanObjective = clip(objective, MAX_OBJECTIVE);
        if (!cleanTitle || !cleanObjective) {
            throw new ProjectMissionError(400, 'BAD_OBJECTIVE',
                'A mission needs a title and an objective — what outcome are we pursuing?');
        }
        const criteria = legalizeCriteria(successCriteria);
        const cleanDeadline = toUtcText(deadline);
        if (deadline && !cleanDeadline) {
            throw new ProjectMissionError(400, 'BAD_DEADLINE',
                'Deadline must be a date (YYYY-MM-DD) or UTC timestamp.');
        }
        const cleanBudget = legalizeBudget(budget);
        const open = await db.get(
            `SELECT id, title, status FROM project_missions
             WHERE projectId = @projectId AND status IN ('DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED', 'REVIEW')
             LIMIT 1`,
            { projectId: projectRow.id }
        );
        if (open) {
            throw new ProjectMissionError(409, 'MISSION_OPEN',
                `This project already has a ${open.status.toLowerCase()} mission (“${open.title}”). `
                + 'Complete or cancel it before starting another.');
        }

        const id = await db.transaction(async (tx) => {
            const missionId = await tx.insert(
                `INSERT INTO project_missions
                    (projectId, userId, title, objective, successCriteriaJson, deadline, budgetJson,
                     status, planRevision)
                 VALUES
                    (@projectId, @userId, @title, @objective, @criteria, @deadline, @budget,
                     'DRAFT', 1)`,
                {
                    projectId: projectRow.id,
                    userId: projectRow.ownerId || projectRow.userId,
                    title: cleanTitle,
                    objective: cleanObjective,
                    criteria: JSON.stringify(criteria),
                    deadline: cleanDeadline,
                    budget: JSON.stringify(cleanBudget)
                }
            );
            await this._appendEvent(tx, {
                missionId,
                userId,
                kind: 'created',
                payload: { title: cleanTitle }
            });
            const planned = Array.isArray(steps) ? steps.slice(0, MAX_STEPS) : [];
            let order = 0;
            for (const step of planned) {
                await this._insertStep(tx, {
                    missionId,
                    userId,
                    kind: step.kind,
                    title: step.title,
                    description: step.description,
                    dependsOn: step.dependsOn,
                    requiresApproval: step.requiresApproval,
                    actionParams: step.actionParams,
                    sortOrder: step.sortOrder != null ? step.sortOrder : order,
                    planRevision: 1
                });
                order += 1;
            }
            return missionId;
        });

        this._publish(domainEventBus.TOPICS.MISSION_CREATED, {
            userId,
            missionId: id,
            projectId: projectRow.id,
            slug: projectRow.slug,
            status: 'DRAFT'
        });
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: id });
    }

    async _insertStep(handle, {
        missionId, userId, kind, title, description = null, dependsOn = [],
        requiresApproval = false, actionParams = {}, sortOrder = 0, planRevision = 0
    }) {
        const cleanKind = String(kind || '').trim().toLowerCase();
        if (!STEP_KINDS.has(cleanKind)) {
            throw new ProjectMissionError(400, 'BAD_STEP_KIND',
                'Step kind must be expedition, job, watch, or human.');
        }
        const cleanTitle = clip(title, MAX_STEP_TITLE);
        if (!cleanTitle) {
            throw new ProjectMissionError(400, 'BAD_STEP', 'Each step needs a short title.');
        }
        const params = parseJson(actionParams, {}) || {};
        return handle.insert(
            `INSERT INTO project_mission_steps
                (missionId, userId, kind, title, description, status, dependsOnJson,
                 requiresApproval, actionParamsJson, planRevision, sortOrder)
             VALUES
                (@missionId, @userId, @kind, @title, @description, 'PENDING', @dependsOn,
                 @requiresApproval, @actionParams, @planRevision, @sortOrder)`,
            {
                missionId,
                userId,
                kind: cleanKind,
                title: cleanTitle,
                description: clip(description, MAX_STEP_DESC) || null,
                dependsOn: JSON.stringify(legalizeDependsOn(dependsOn)),
                requiresApproval: requiresApproval ? 1 : 0,
                actionParams: JSON.stringify(params),
                planRevision: Number.isFinite(Number(planRevision)) ? Number(planRevision) : 0,
                sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0
            }
        );
    }

    async _bumpPlanRevision(handle, mission, userId, reason) {
        const wasApproved = mission.status === 'APPROVED';
        const bumped = await handle.get(
            `UPDATE project_missions
             SET planRevision = planRevision + 1,
                 status = CASE WHEN status = 'APPROVED' THEN 'DRAFT' ELSE status END,
                 approvedAt = CASE WHEN status = 'APPROVED' THEN NULL ELSE approvedAt END,
                 approvedBy = CASE WHEN status = 'APPROVED' THEN NULL ELSE approvedBy END,
                 approvedRevision = CASE WHEN status = 'APPROVED' THEN NULL ELSE approvedRevision END,
                 updatedAt = datetime('now')
             WHERE id = @id AND status IN ('DRAFT', 'APPROVED')
             RETURNING planRevision`,
            { id: mission.id }
        );
        if (!bumped) {
            throw new ProjectMissionError(409, 'BAD_STATUS',
                'This mission is no longer a draft, so the plan cannot change.');
        }
        const nextRevision = Number(bumped.planRevision);
        if (wasApproved) {
            await this._appendEvent(handle, {
                missionId: mission.id,
                userId,
                kind: 'approval_invalidated',
                payload: { reason: clip(reason, 80) || 'plan_changed', planRevision: nextRevision }
            });
        }
        return nextRevision;
    }

    async get({ userId, project, owner = null, missionId = null } = {}) {
        const { row } = await this._requireMissionRow(userId, project, owner, missionId);
        const shaped = await this._shape(row);
        const projectRow = await this._requireProject(userId, project, owner);
        return { ...shaped, project: projectRow.slug, projectName: projectRow.name };
    }

    async getOpen({ userId, project, owner = null } = {}) {
        try {
            return await this.get({ userId, project, owner });
        } catch (error) {
            if (error?.code === 'NO_MISSION') return null;
            throw error;
        }
    }

    async list({ userId, project, owner = null, limit = 20 } = {}) {
        const projectRow = await this._requireProject(userId, project, owner);
        const rows = await db.all(
            `SELECT id, title, status, deadline, createdAt, updatedAt, completedAt
             FROM project_missions
             WHERE projectId = @projectId
             ORDER BY id DESC
             LIMIT @limit`,
            { projectId: projectRow.id, limit: Math.min(50, Math.max(1, Number(limit) || 20)) }
        );
        return rows.map(row => ({
            id: row.id,
            title: row.title,
            status: row.status,
            deadline: row.deadline || null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            completedAt: row.completedAt || null
        }));
    }

    async updateDraft({
        userId, project, owner = null, missionId = null,
        title, objective, successCriteria, deadline, budget
    } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, ['DRAFT', 'APPROVED']
        );
        const nextTitle = title != null ? clip(title, MAX_TITLE) : row.title;
        const nextObjective = objective != null ? clip(objective, MAX_OBJECTIVE) : row.objective;
        if (!nextTitle || !nextObjective) {
            throw new ProjectMissionError(400, 'BAD_OBJECTIVE', 'Title and objective cannot be empty.');
        }
        const nextCriteria = successCriteria != null
            ? legalizeCriteria(successCriteria)
            : parseJson(row.successCriteriaJson, []);
        let nextDeadline = row.deadline;
        if (deadline !== undefined) {
            nextDeadline = deadline ? toUtcText(deadline) : null;
            if (deadline && !nextDeadline) {
                throw new ProjectMissionError(400, 'BAD_DEADLINE',
                    'Deadline must be a date (YYYY-MM-DD) or UTC timestamp.');
            }
        }
        const nextBudget = budget !== undefined ? legalizeBudget(budget) : legalizeBudget(row.budgetJson);
        await db.transaction(async (tx) => {
            const planRevision = await this._bumpPlanRevision(tx, row, userId, 'updated');
            await tx.run(
                `UPDATE project_missions
                 SET title = @title, objective = @objective, successCriteriaJson = @criteria,
                     deadline = @deadline, budgetJson = @budget, updatedAt = datetime('now')
                 WHERE id = @id AND status IN ('DRAFT', 'APPROVED')`,
                {
                    id: row.id,
                    title: nextTitle,
                    objective: nextObjective,
                    criteria: JSON.stringify(nextCriteria),
                    deadline: nextDeadline,
                    budget: JSON.stringify(nextBudget)
                }
            );
            await this._appendEvent(tx, {
                missionId: row.id, userId, kind: 'updated',
                payload: { title: nextTitle, planRevision }
            });
        });
        this._publish(domainEventBus.TOPICS.MISSION_CREATED, {
            userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug, status: 'DRAFT'
        });
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
    }

    async addStep({
        userId, project, owner = null, missionId = null,
        kind, title, description, dependsOn, requiresApproval, actionParams, sortOrder
    } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, ['DRAFT', 'APPROVED']
        );
        const count = await db.get(
            'SELECT COUNT(*) AS c FROM project_mission_steps WHERE missionId = @missionId',
            { missionId: row.id }
        );
        if ((count?.c || 0) >= MAX_STEPS) {
            throw new ProjectMissionError(400, 'TOO_MANY_STEPS',
                `A mission can hold at most ${MAX_STEPS} steps.`);
        }
        await db.transaction(async (tx) => {
            const planRevision = await this._bumpPlanRevision(tx, row, userId, 'step_added');
            const stepId = await this._insertStep(tx, {
                missionId: row.id,
                userId,
                kind,
                title,
                description,
                dependsOn,
                requiresApproval,
                actionParams,
                sortOrder: sortOrder != null ? sortOrder : count.c,
                planRevision
            });
            await this._appendEvent(tx, {
                missionId: row.id, userId, kind: 'step_added',
                payload: { stepId, stepKind: String(kind || '').toLowerCase(), planRevision }
            });
        });
        this._publish(domainEventBus.TOPICS.MISSION_CREATED, {
            userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug,
            status: row.status === 'APPROVED' ? 'DRAFT' : row.status
        });
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
    }

    /**
     * Mint a short-lived approval receipt. Only human surfaces (portal,
     * Discord) may call this — the agent tool never does.
     */
    async mintApprovalReceipt({
        userId, project, owner = null, missionId = null, origin, kind = 'approve'
    } = {}) {
        if (!HUMAN_ORIGINS.has(origin)) {
            throw new ProjectMissionError(403, 'HUMAN_ONLY',
                'Mission confirmation receipts can only be minted from a human surface.');
        }
        const cleanKind = RECEIPT_KINDS.has(kind) ? kind : 'approve';
        const allowed = cleanKind === 'complete' ? ['REVIEW'] : ['DRAFT'];
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, allowed
        );
        const nonce = crypto.randomBytes(16).toString('hex');
        const planRevision = Number(row.planRevision) || 1;
        const expiresAt = toUtcText(new Date(Date.now() + RECEIPT_TTL_MS));
        const id = await db.insert(
            `INSERT INTO project_mission_approval_receipts
                (missionId, userId, nonce, planRevision, origin, kind, expiresAt)
             VALUES
                (@missionId, @userId, @nonce, @planRevision, @origin, @kind, @expiresAt)`,
            {
                missionId: row.id,
                userId,
                nonce,
                planRevision,
                origin,
                kind: cleanKind,
                expiresAt
            }
        );
        return {
            id,
            nonce,
            planRevision,
            origin,
            kind: cleanKind,
            expiresAt,
            project: projectRow.slug
        };
    }

    async _consumeReceipt(handle, {
        missionId, userId, receiptId, nonce, planRevision, kind = 'approve'
    }) {
        if (!receiptId || !nonce) {
            throw new ProjectMissionError(403, 'HUMAN_ONLY',
                'This action needs a human confirmation receipt from the portal.');
        }
        const cleanKind = RECEIPT_KINDS.has(kind) ? kind : 'approve';
        const now = toUtcText(new Date());
        const changed = (await handle.run(
            `UPDATE project_mission_approval_receipts
             SET consumedAt = datetime('now')
             WHERE id = @id AND nonce = @nonce AND missionId = @missionId
               AND userId = @userId AND planRevision = @planRevision
               AND kind = @kind
               AND consumedAt IS NULL AND expiresAt >= @now`,
            {
                id: Number(receiptId),
                nonce: String(nonce),
                missionId,
                userId,
                planRevision,
                kind: cleanKind,
                now
            }
        )).changes > 0;
        if (!changed) {
            throw new ProjectMissionError(403, 'HUMAN_ONLY',
                'That confirmation receipt is missing, expired, already used, or for a different plan.');
        }
    }

    async approve({
        userId, project, owner = null, missionId = null,
        receiptId = null, nonce = null
    } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, ['DRAFT']
        );
        const planRevision = Number(row.planRevision) || 1;
        await db.transaction(async (tx) => {
            await this._consumeReceipt(tx, {
                missionId: row.id, userId, receiptId, nonce, planRevision
            });
            const changed = (await tx.run(
                `UPDATE project_missions
                 SET status = 'APPROVED', approvedAt = datetime('now'), approvedBy = @userId,
                     approvedRevision = @planRevision, updatedAt = datetime('now')
                 WHERE id = @id AND status = 'DRAFT' AND planRevision = @planRevision`,
                { id: row.id, userId, planRevision }
            )).changes > 0;
            if (!changed) {
                throw new ProjectMissionError(409, 'BAD_STATUS',
                    'This mission is no longer a draft, or the plan changed.');
            }
            await this._appendEvent(tx, {
                missionId: row.id, userId, kind: 'approved',
                payload: { planRevision, receiptId: Number(receiptId) }
            });
        });
        this._publish(domainEventBus.TOPICS.MISSION_APPROVED, {
            userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug, status: 'APPROVED'
        });
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
    }

    async start({ userId, project, owner = null, missionId = null } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, ['APPROVED']
        );
        const planRevision = Number(row.planRevision) || 1;
        const approvedRevision = row.approvedRevision != null
            ? Number(row.approvedRevision)
            : (row.approvedAt ? planRevision : null);
        if (!row.approvedAt || approvedRevision !== planRevision) {
            throw new ProjectMissionError(409, 'NEEDS_APPROVAL',
                'The plan changed after approval. A human has to approve this revision again.');
        }
        let becameReview = false;
        await db.transaction(async (tx) => {
            const changed = (await tx.run(
                `UPDATE project_missions
                 SET status = 'ACTIVE', startedAt = datetime('now'), updatedAt = datetime('now'),
                     approvedRevision = COALESCE(approvedRevision, @planRevision)
                 WHERE id = @id AND status = 'APPROVED' AND approvedAt IS NOT NULL
                   AND (approvedRevision = planRevision OR approvedRevision IS NULL)`,
                { id: row.id, planRevision }
            )).changes > 0;
            if (!changed) {
                throw new ProjectMissionError(409, 'BAD_STATUS', 'This mission is not waiting to start.');
            }
            await this._refreshReadySteps(tx, row.id);
            await this._appendEvent(tx, {
                missionId: row.id, userId, kind: 'started',
                payload: { planRevision }
            });
            becameReview = await this._maybeAdvanceToReview(tx, { ...row, status: 'ACTIVE' }, userId);
        });
        this._publish(
            becameReview ? domainEventBus.TOPICS.MISSION_REVIEW : domainEventBus.TOPICS.MISSION_STARTED,
            {
                userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug,
                status: becameReview ? 'REVIEW' : 'ACTIVE'
            }
        );
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
    }

    async cancel({ userId, project, owner = null, missionId = null } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, OPEN_STATUSES
        );
        const inFlight = await db.all(
            `SELECT * FROM project_mission_steps
             WHERE missionId = @missionId AND status IN ('STARTING', 'RUNNING')`,
            { missionId: row.id }
        );
        // Skip in-flight steps first so settle hooks cannot BLOCK the
        // mission while we cancel the linked work, then cancel that work
        // before the mission row itself flips to CANCELLED.
        await db.transaction(async (tx) => {
            await tx.run(
                `UPDATE project_mission_steps
                 SET status = CASE WHEN status IN ('DONE', 'SKIPPED', 'FAILED') THEN status ELSE 'SKIPPED' END,
                     finishedAt = COALESCE(finishedAt, datetime('now')),
                     updatedAt = datetime('now')
                 WHERE missionId = @missionId AND status NOT IN ('DONE', 'SKIPPED', 'FAILED')`,
                { missionId: row.id }
            );
        });
        for (const step of inFlight) {
            await this._cancelLinkedWork(step, userId);
        }
        await db.transaction(async (tx) => {
            const changed = (await tx.run(
                `UPDATE project_missions
                 SET status = 'CANCELLED', completedAt = datetime('now'), updatedAt = datetime('now')
                 WHERE id = @id AND status IN ('DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED', 'REVIEW')`,
                { id: row.id }
            )).changes > 0;
            if (!changed) {
                throw new ProjectMissionError(409, 'BAD_STATUS', 'This mission is no longer open.');
            }
            await this._appendEvent(tx, {
                missionId: row.id, userId, kind: 'cancelled'
            });
        });
        this._publish(domainEventBus.TOPICS.MISSION_CANCELLED, {
            userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug, status: 'CANCELLED'
        });
        return this.get({
            userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id
        });
    }

    async resume({ userId, project, owner = null, missionId = null } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, ['BLOCKED']
        );
        const failed = await db.get(
            `SELECT COUNT(*) AS c FROM project_mission_steps
             WHERE missionId = @missionId AND status = 'FAILED'`,
            { missionId: row.id }
        );
        if ((failed?.c || 0) > 0) {
            throw new ProjectMissionError(409, 'FAILED_STEPS',
                'Retry or skip the failed step before resuming.');
        }
        await db.transaction(async (tx) => {
            await tx.run(
                `UPDATE project_missions
                 SET status = 'ACTIVE', updatedAt = datetime('now')
                 WHERE id = @id AND status = 'BLOCKED'`,
                { id: row.id }
            );
            await this._appendEvent(tx, {
                missionId: row.id, userId, kind: 'resumed'
            });
        });
        this._publish(domainEventBus.TOPICS.MISSION_STARTED, {
            userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug, status: 'ACTIVE'
        });
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
    }

    async _getStep(missionId, stepId) {
        const step = await db.get(
            `SELECT * FROM project_mission_steps
             WHERE id = @id AND missionId = @missionId`,
            { id: Number(stepId), missionId }
        );
        if (!step) {
            throw new ProjectMissionError(404, 'NO_STEP', 'No such step on this mission.');
        }
        return step;
    }

    async startStep({
        userId, project, owner = null, missionId = null, stepId
    } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, ['ACTIVE']
        );
        await this.reconcileStartingSteps({ missionId: row.id });
        await this.reconcileRunningSteps({ missionId: row.id });
        const step = await this._getStep(row.id, stepId);
        if (step.status !== 'READY' && step.status !== 'PENDING') {
            throw new ProjectMissionError(409, 'BAD_STEP_STATUS',
                `Step “${step.title}” is ${step.status}, not ready to start.`);
        }
        if (step.status === 'PENDING') {
            const deps = legalizeDependsOn(parseJson(step.dependsOnJson, []));
            if (deps.length) {
                const all = await db.all(
                    'SELECT id, status FROM project_mission_steps WHERE missionId = @missionId',
                    { missionId: row.id }
                );
                const blocked = deps.some((id) => {
                    const dep = all.find(s => s.id === id);
                    return !dep || (dep.status !== 'DONE' && dep.status !== 'SKIPPED');
                });
                if (blocked) {
                    throw new ProjectMissionError(409, 'DEPS_UNMET',
                        `Step “${step.title}” still depends on unfinished steps.`);
                }
            }
        }
        const approvedRevision = row.approvedRevision != null
            ? Number(row.approvedRevision)
            : (row.approvedAt ? (Number(row.planRevision) || 1) : null);
        const stepRevision = Number(step.planRevision) || 0;
        if (!row.approvedAt || approvedRevision == null || stepRevision > approvedRevision) {
            throw new ProjectMissionError(409, 'NEEDS_APPROVAL',
                'This step is not part of the approved plan.');
        }

        if (step.kind !== 'human') {
            requiredStepParams(step.kind, step.actionParamsJson);
        }

        const budget = legalizeBudget(row.budgetJson);
        await this._enforceBudget(row.id, step.kind, budget);

        if (step.kind === 'human') {
            await db.run(
                `UPDATE project_mission_steps
                 SET status = 'READY', updatedAt = datetime('now')
                 WHERE id = @id AND status IN ('PENDING', 'READY')`,
                { id: step.id }
            );
            return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
        }

        const attemptId = crypto.randomUUID();
        const claimed = (await db.run(
            `UPDATE project_mission_steps
             SET status = 'STARTING', executionAttemptId = @attemptId,
                 startedByUserId = @startedBy, startedAt = datetime('now'),
                 updatedAt = datetime('now')
             WHERE id = @id AND missionId = @missionId
               AND status IN ('READY', 'PENDING')`,
            { id: step.id, missionId: row.id, attemptId, startedBy: userId }
        )).changes > 0;
        if (!claimed) {
            throw new ProjectMissionError(409, 'BAD_STEP_STATUS',
                `Step “${step.title}” is already starting or no longer ready.`);
        }

        let links;
        try {
            links = await this._kickStep({
                userId,
                project: projectRow,
                mission: row,
                step: { ...step, executionAttemptId: attemptId, startedByUserId: userId }
            });
            if (!links.expeditionId && !links.jobId && !links.watchId) {
                throw new ProjectMissionError(400, 'BAD_STEP_PARAMS',
                    `Step “${step.title}” launched nothing — required parameters are missing.`);
            }
        } catch (error) {
            const claimed = await db.get(
                'SELECT * FROM project_mission_steps WHERE id = @id',
                { id: step.id }
            );
            const found = claimed
                ? await this._findChildByAttempt({ ...claimed, kind: step.kind, executionAttemptId: attemptId })
                : null;
            await this._cancelLinkedWork({
                ...step,
                ...(claimed || {}),
                jobId: claimed?.jobId || (found?.col === 'jobId' ? found.id : null),
                expeditionId: claimed?.expeditionId || (found?.col === 'expeditionId' ? found.id : null),
                watchId: claimed?.watchId || (found?.col === 'watchId' ? found.id : null)
            }, userId);
            await db.run(
                `UPDATE project_mission_steps
                 SET status = 'READY', executionAttemptId = NULL, startedAt = NULL,
                     startedByUserId = NULL, expeditionId = NULL, jobId = NULL, watchId = NULL,
                     updatedAt = datetime('now')
                 WHERE id = @id AND status = 'STARTING' AND executionAttemptId = @attemptId`,
                { id: step.id, attemptId }
            );
            throw error;
        }

        const persisted = (await db.run(
            `UPDATE project_mission_steps
             SET status = 'RUNNING', updatedAt = datetime('now'),
                 expeditionId = COALESCE(@expeditionId, expeditionId),
                 jobId = COALESCE(@jobId, jobId),
                 watchId = COALESCE(@watchId, watchId)
             WHERE id = @id AND status = 'STARTING' AND executionAttemptId = @attemptId`,
            {
                id: step.id,
                attemptId,
                expeditionId: links.expeditionId || null,
                jobId: links.jobId || null,
                watchId: links.watchId || null
            }
        )).changes > 0;
        if (!persisted) {
            await this._cancelLinkedWork({ ...step, ...links }, userId);
            throw new ProjectMissionError(409, 'BAD_STEP_STATUS',
                `Step “${step.title}” was cancelled while starting.`);
        }
        await this._appendEvent(db, {
            missionId: row.id, userId, kind: 'step_started',
            payload: { stepId: step.id, stepKind: step.kind, attemptId, ...links }
        });
        this._publish(domainEventBus.TOPICS.MISSION_STEP_STARTED, {
            userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug,
            stepId: step.id, kind: step.kind
        });
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
    }

    async _enforceBudget(missionId, kind, budget) {
        if (kind === 'human') return;
        const key = kind === 'expedition' ? 'maxExpeditions'
            : kind === 'job' ? 'maxJobs'
                : 'maxWatches';
        const cap = budget[key];
        const used = await db.get(
            `SELECT COUNT(*) AS c FROM project_mission_steps
             WHERE missionId = @missionId AND kind = @kind
               AND status IN ('STARTING', 'RUNNING', 'DONE', 'FAILED')`,
            { missionId, kind }
        );
        if ((used?.c || 0) >= cap) {
            throw new ProjectMissionError(409, 'BUDGET',
                `This mission's ${kind} budget is ${cap}. Finish or skip one first.`);
        }
    }

    _ignoreChildCancel(error) {
        const code = error?.code || '';
        if (code === 'NOT_FOUND' || code === 'BAD_STATE' || code === 'NOT_RUNNING') return true;
        return /not running|not found|not (a )?paused|already/i.test(error?.message || '');
    }

    async _cancelLinkedWork(step, userId) {
        const actor = userId || step.startedByUserId || step.userId;
        if (step.jobId) {
            try {
                await this._obs().cancel({ userId: actor, jobId: step.jobId });
            } catch (error) {
                if (!this._ignoreChildCancel(error)) throw error;
            }
        }
        if (step.expeditionId) {
            const owner = await db.get(
                'SELECT userId FROM spitball_expeditions WHERE id = @id',
                { id: step.expeditionId }
            );
            try {
                await this._expeditions().cancelExpedition(step.expeditionId, {
                    userId: owner?.userId || actor
                });
            } catch (error) {
                if (!this._ignoreChildCancel(error)) throw error;
            }
        }
        if (step.watchId) {
            const owner = await db.get(
                'SELECT userId FROM attention_watches WHERE id = @id',
                { id: step.watchId }
            );
            try {
                await this._watchService().cancel({
                    userId: owner?.userId || actor,
                    id: step.watchId
                });
            } catch (error) {
                if (!this._ignoreChildCancel(error)) throw error;
            }
        }
    }

    /**
     * Repair STARTING rows left by a crash between claim and persist.
     * A child found by executionAttemptId is adopted and the step promoted;
     * a stale unlinked claim fails and blocks the mission.
     */
    async reconcileStartingSteps({ missionId = null, olderThanMs = STARTING_STALE_MS } = {}) {
        const cutoff = toUtcText(new Date(Date.now() - olderThanMs));
        const rows = missionId != null
            ? await db.all(
                `SELECT * FROM project_mission_steps
                 WHERE status = 'STARTING' AND missionId = @missionId AND startedAt <= @cutoff`,
                { missionId: Number(missionId), cutoff }
            )
            : await db.all(
                `SELECT * FROM project_mission_steps
                 WHERE status = 'STARTING' AND startedAt <= @cutoff`,
                { cutoff }
            );
        let repaired = 0;
        for (const step of rows) {
            try {
                const adopted = await this._adoptOrphanChild(step);
                if (adopted) repaired += 1;
            } catch (err) {
                logger.warn({ err, stepId: step.id }, 'Mission start reconcile failed');
            }
        }
        return repaired;
    }

    /**
     * Repair RUNNING steps whose child is already terminal. A crash after
     * the child's finish UPDATE can leave the step RUNNING forever;
     * reconcileStartingSteps only looks at STARTING.
     */
    async reconcileRunningSteps({ missionId = null } = {}) {
        const rows = missionId != null
            ? await db.all(
                `SELECT * FROM project_mission_steps
                 WHERE status = 'RUNNING' AND missionId = @missionId`,
                { missionId: Number(missionId) }
            )
            : await db.all(
                `SELECT * FROM project_mission_steps WHERE status = 'RUNNING'`
            );
        let repaired = 0;
        for (const step of rows) {
            try {
                const settled = await this._settleIfChildTerminal(step);
                if (settled) repaired += 1;
            } catch (err) {
                logger.warn({ err, stepId: step.id }, 'Mission running-step reconcile failed');
            }
        }
        return repaired;
    }

    async _settleIfChildTerminal(step) {
        if (step.kind === 'job' && step.jobId) {
            const job = await db.get(
                'SELECT status FROM observatory_jobs WHERE id = @id',
                { id: step.jobId }
            );
            if (job && job.status !== 'RUNNING') {
                return this.onJobSettled({ jobId: step.jobId, status: job.status });
            }
        }
        if (step.kind === 'expedition' && step.expeditionId) {
            const row = await db.get(
                'SELECT status FROM spitball_expeditions WHERE id = @id',
                { id: step.expeditionId }
            );
            if (row && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(row.status)) {
                return this.onExpeditionSettled({
                    expeditionId: step.expeditionId, status: row.status
                });
            }
        }
        if (step.kind === 'watch' && step.watchId) {
            const row = await db.get(
                'SELECT status FROM attention_watches WHERE id = @id',
                { id: step.watchId }
            );
            if (row && row.status !== 'ARMED') {
                return this.onWatchFired({
                    watchId: step.watchId, failed: row.status === 'FAILED'
                });
            }
        }
        return false;
    }

    async _findChildByAttempt(step) {
        if (!step.executionAttemptId) return null;
        if (step.kind === 'job') {
            const row = await db.get(
                'SELECT id FROM observatory_jobs WHERE executionAttemptId = @attemptId',
                { attemptId: step.executionAttemptId }
            );
            return row ? { col: 'jobId', id: row.id } : null;
        }
        if (step.kind === 'expedition') {
            const row = await db.get(
                'SELECT id FROM spitball_expeditions WHERE executionAttemptId = @attemptId',
                { attemptId: step.executionAttemptId }
            );
            return row ? { col: 'expeditionId', id: row.id } : null;
        }
        if (step.kind === 'watch') {
            const row = await db.get(
                'SELECT id FROM attention_watches WHERE executionAttemptId = @attemptId',
                { attemptId: step.executionAttemptId }
            );
            return row ? { col: 'watchId', id: row.id } : null;
        }
        return null;
    }

    async _ensureExpeditionDispatched(step) {
        if (step.kind !== 'expedition' || !step.expeditionId) return;
        const row = await db.get(
            'SELECT id, status, userId FROM spitball_expeditions WHERE id = @id',
            { id: step.expeditionId }
        );
        if (!row) return;
        if (row.status === 'DRAFT' || row.status === 'PAUSED') {
            const expeditions = this._expeditions();
            if (typeof expeditions.continueExpedition === 'function') {
                await expeditions.continueExpedition(row.id, { userId: row.userId });
            }
        }
        try {
            require('./spitballExpeditionRunner').kick(row.id);
        } catch { /* runner is optional in tests */ }
    }

    async _failStartingStep(step, reason) {
        const claimed = (await db.run(
            `UPDATE project_mission_steps
             SET status = 'FAILED', finishedAt = datetime('now'), updatedAt = datetime('now')
             WHERE id = @id AND status = 'STARTING'`,
            { id: step.id }
        )).changes > 0;
        if (!claimed) return false;
        await this._appendEvent(db, {
            missionId: step.missionId,
            userId: step.userId,
            kind: 'step_failed',
            payload: { stepId: step.id, reason: 'start_orphaned' }
        });
        const mission = await db.get(
            'SELECT * FROM project_missions WHERE id = @id',
            { id: step.missionId }
        );
        if (mission) {
            await this._maybeBlock(db, mission, step.userId, reason);
        }
        return true;
    }

    async _adoptOrphanChild(step) {
        let linked = {
            jobId: step.jobId,
            expeditionId: step.expeditionId,
            watchId: step.watchId
        };
        if (!linked.jobId && !linked.expeditionId && !linked.watchId) {
            const child = await this._findChildByAttempt(step);
            if (child) {
                linked[child.col] = child.id;
                await db.run(
                    `UPDATE project_mission_steps
                     SET ${child.col} = @childId, updatedAt = datetime('now')
                     WHERE id = @id AND status = 'STARTING'`,
                    { id: step.id, childId: child.id }
                );
            }
        }
        if (linked.jobId || linked.expeditionId || linked.watchId) {
            const promoted = (await db.run(
                `UPDATE project_mission_steps
                 SET status = 'RUNNING', updatedAt = datetime('now')
                 WHERE id = @id AND status = 'STARTING'`,
                { id: step.id }
            )).changes > 0;
            if (promoted) {
                await this._ensureExpeditionDispatched({ ...step, ...linked });
            }
            return promoted;
        }
        if (!step.executionAttemptId) {
            return this._failStartingStep(step, 'Start attempt had no correlation key');
        }
        return this._failStartingStep(step, 'Start attempt never persisted a child handle');
    }

    async _persistStartingLink(stepId, links) {
        await db.run(
            `UPDATE project_mission_steps
             SET expeditionId = COALESCE(@expeditionId, expeditionId),
                 jobId = COALESCE(@jobId, jobId),
                 watchId = COALESCE(@watchId, watchId),
                 updatedAt = datetime('now')
             WHERE id = @id AND status = 'STARTING'`,
            {
                id: stepId,
                expeditionId: links.expeditionId || null,
                jobId: links.jobId || null,
                watchId: links.watchId || null
            }
        );
    }

    async _kickStep({ userId, project, mission, step }) {
        const params = parseJson(step.actionParamsJson, {}) || {};
        const out = { expeditionId: null, jobId: null, watchId: null };
        try {
            if (step.kind === 'expedition') {
                const seed = clip(params.seed || step.title, 200);
                const created = await this._expeditions().createExpedition({
                    userId,
                    seed,
                    intent: clip(params.intent || mission.objective, 500),
                    depth: params.depth || 'focused',
                    projectId: project.id,
                    autoStart: false,
                    executionAttemptId: step.executionAttemptId || null
                });
                out.expeditionId = created?.id || null;
                if (out.expeditionId) {
                    await this._persistStartingLink(step.id, out);
                    const expeditions = this._expeditions();
                    if (typeof expeditions.continueExpedition === 'function') {
                        await expeditions.continueExpedition(out.expeditionId, { userId });
                    }
                    try {
                        require('./spitballExpeditionRunner').kick(out.expeditionId);
                    } catch { /* runner is optional in tests */ }
                }
            } else if (step.kind === 'job' && (params.asset || params.assetSlug || params.slug)) {
                const asset = params.asset || params.assetSlug || params.slug;
                const script = await require('./projectAssetService').get({
                    userId,
                    project: project.slug,
                    owner: project.ownerId,
                    asset
                });
                if (script.kind !== 'script') {
                    throw new ProjectMissionError(400, 'NOT_A_SCRIPT',
                        `“${script.slug}” is a ${script.kind}, not a script.`);
                }
                const outcome = await this._obs().run({
                    userId,
                    project: project.slug,
                    owner: project.ownerId,
                    language: script.language,
                    code: script.source,
                    background: true,
                    assetVersionId: script.versionId,
                    startedBy: 'trigger',
                    executionAttemptId: step.executionAttemptId || null
                });
                out.jobId = outcome?.jobId || null;
                if (out.jobId) await this._persistStartingLink(step.id, out);
            } else if (step.kind === 'watch' && (params.topic || params.watchTopic)) {
                const topic = params.topic || params.watchTopic;
                const watch = await this._watchService().register({
                    userId,
                    guildId: dmScopeId(userId),
                    label: clip(params.label || step.title, 60),
                    topic,
                    condition: params.condition || { projectId: project.id },
                    prompt: clip(params.prompt || `Mission “${mission.title}”: ${step.title}. Inspect the outcome and report.`, 1500),
                    executionAttemptId: step.executionAttemptId || null
                });
                out.watchId = watch?.id || null;
                if (out.watchId) await this._persistStartingLink(step.id, out);
            }
        } catch (error) {
            if (error instanceof ProjectMissionError) throw error;
            if (error?.status && error?.code) {
                throw new ProjectMissionError(error.status, error.code, error.message);
            }
            if (error?.code && error?.name === 'WatchError') {
                throw new ProjectMissionError(400, error.code, error.message);
            }
            if (error?.code && error?.name === 'SpitballError') {
                throw new ProjectMissionError(error.status || 400, error.code, error.message);
            }
            throw new ProjectMissionError(400, 'STEP_START_FAILED',
                error?.message || 'Could not start that step.');
        }
        return out;
    }

    async completeStep({
        userId, project, owner = null, missionId = null, stepId, note = null
    } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, ['ACTIVE', 'BLOCKED']
        );
        const step = await this._getStep(row.id, stepId);
        if (step.kind !== 'human' && step.status !== 'RUNNING' && step.status !== 'READY') {
            throw new ProjectMissionError(409, 'BAD_STEP_STATUS',
                `Step “${step.title}” cannot be marked done from ${step.status}.`);
        }
        let nextStatus = row.status;
        await db.transaction(async (tx) => {
            await tx.run(
                `UPDATE project_mission_steps
                 SET status = 'DONE', finishedAt = datetime('now'), updatedAt = datetime('now')
                 WHERE id = @id`,
                { id: step.id }
            );
            await this._appendEvent(tx, {
                missionId: row.id, userId, kind: 'step_done',
                payload: { stepId: step.id, note: clip(note, 240) || null }
            });
            await this._refreshReadySteps(tx, row.id);
            if (row.status === 'ACTIVE') {
                const advanced = await this._maybeAdvanceToReview(tx, row, userId);
                if (advanced) nextStatus = 'REVIEW';
            }
        });
        this._publish(
            nextStatus === 'REVIEW'
                ? domainEventBus.TOPICS.MISSION_REVIEW
                : domainEventBus.TOPICS.MISSION_STEP_COMPLETED,
            {
                userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug,
                stepId: step.id, status: nextStatus
            }
        );
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
    }

    async skipStep({
        userId, project, owner = null, missionId = null, stepId, reason = null
    } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, ['DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED']
        );
        const step = await this._getStep(row.id, stepId);
        const inFlight = IN_FLIGHT_STEP.has(step.status);
        // Finalize the skip before cancelling linked work so a settle hook
        // cannot mark the step FAILED / BLOCK the mission. Downstream
        // readiness is refreshed only after that work is cancelled.
        const skipped = (await db.run(
            `UPDATE project_mission_steps
             SET status = 'SKIPPED', finishedAt = datetime('now'), updatedAt = datetime('now')
             WHERE id = @id AND status NOT IN ('DONE', 'SKIPPED')`,
            { id: step.id }
        )).changes > 0;
        if (!skipped) {
            throw new ProjectMissionError(409, 'BAD_STEP_STATUS',
                `Step “${step.title}” is already ${step.status}.`);
        }
        if (inFlight) {
            await this._cancelLinkedWork(step, userId);
        }
        let nextStatus = row.status;
        await db.transaction(async (tx) => {
            if (row.status === 'DRAFT' || row.status === 'APPROVED') {
                await this._bumpPlanRevision(tx, row, userId, 'step_skipped');
                nextStatus = 'DRAFT';
            }
            await this._appendEvent(tx, {
                missionId: row.id, userId, kind: 'step_skipped',
                payload: { stepId: step.id, reason: clip(reason, 240) || null }
            });
            if (row.status === 'ACTIVE' || row.status === 'BLOCKED') {
                await this._refreshReadySteps(tx, row.id);
            }
            let working = { ...row, status: nextStatus };
            if (row.status === 'BLOCKED') {
                const unblocked = await this._maybeUnblock(tx, row, userId);
                if (unblocked) {
                    nextStatus = 'ACTIVE';
                    working = { ...row, status: 'ACTIVE' };
                }
            }
            if (working.status === 'ACTIVE') {
                const advanced = await this._maybeAdvanceToReview(tx, working, userId);
                if (advanced) nextStatus = 'REVIEW';
            }
        });
        this._publish(
            nextStatus === 'REVIEW'
                ? domainEventBus.TOPICS.MISSION_REVIEW
                : domainEventBus.TOPICS.MISSION_STEP_COMPLETED,
            {
                userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug,
                stepId: step.id, status: nextStatus
            }
        );
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
    }

    async retryStep({
        userId, project, owner = null, missionId = null, stepId
    } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, ['ACTIVE', 'BLOCKED']
        );
        const step = await this._getStep(row.id, stepId);
        const retried = (await db.run(
            `UPDATE project_mission_steps
             SET status = 'READY', executionAttemptId = NULL, startedByUserId = NULL,
                 expeditionId = NULL, jobId = NULL, watchId = NULL,
                 startedAt = NULL, finishedAt = NULL, updatedAt = datetime('now')
             WHERE id = @id AND status = 'FAILED'`,
            { id: step.id }
        )).changes > 0;
        if (!retried) {
            throw new ProjectMissionError(409, 'BAD_STEP_STATUS',
                `Step “${step.title}” is ${step.status}, not failed.`);
        }
        let nextStatus = row.status;
        await db.transaction(async (tx) => {
            await this._appendEvent(tx, {
                missionId: row.id, userId, kind: 'step_retried',
                payload: { stepId: step.id }
            });
            if (row.status === 'BLOCKED') {
                const unblocked = await this._maybeUnblock(tx, row, userId);
                if (unblocked) nextStatus = 'ACTIVE';
            }
        });
        this._publish(domainEventBus.TOPICS.MISSION_STEP_COMPLETED, {
            userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug,
            stepId: step.id, status: nextStatus
        });
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
    }

    async linkStep({
        userId, project, owner = null, missionId = null, stepId,
        expeditionId = null, jobId = null, watchId = null
    } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, ['DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED']
        );
        const step = await this._getStep(row.id, stepId);
        await db.run(
            `UPDATE project_mission_steps
             SET expeditionId = COALESCE(@expeditionId, expeditionId),
                 jobId = COALESCE(@jobId, jobId),
                 watchId = COALESCE(@watchId, watchId),
                 updatedAt = datetime('now')
             WHERE id = @id`,
            {
                id: step.id,
                expeditionId: expeditionId ? Number(expeditionId) : null,
                jobId: jobId ? Number(jobId) : null,
                watchId: watchId ? Number(watchId) : null
            }
        );
        await this._appendEvent(db, {
            missionId: row.id, userId, kind: 'step_linked',
            payload: { stepId: step.id, expeditionId, jobId, watchId }
        });
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
    }

    async addEvidence({
        userId, project, owner = null, missionId = null,
        kind, refId, criterionId = null, polarity = 'for', label = null,
        imported = false
    } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, OPEN_STATUSES
        );
        const cleanKind = String(kind || '').trim().toLowerCase();
        if (!EVIDENCE_KINDS.has(cleanKind)) {
            throw new ProjectMissionError(400, 'BAD_EVIDENCE',
                'Evidence must be a claim, note, job, or artifact.');
        }
        const id = Number(refId);
        if (!Number.isInteger(id) || id <= 0) {
            throw new ProjectMissionError(400, 'BAD_EVIDENCE', 'Evidence needs a refId.');
        }
        const cleanPolarity = POLARITIES.has(String(polarity)) ? String(polarity) : 'for';
        const criteria = parseJson(row.successCriteriaJson, []);
        const cleanCriterion = criterionId ? String(criterionId).slice(0, 24) : '';
        if (cleanCriterion && !criteria.some(c => c.id === cleanCriterion)) {
            throw new ProjectMissionError(400, 'BAD_CRITERION',
                'That success criterion is not on this mission.');
        }
        const provenance = await this._assertEvidenceExists(
            cleanKind, id, projectRow, { imported: imported === true }
        );
        const count = await db.get(
            'SELECT COUNT(*) AS c FROM project_mission_evidence WHERE missionId = @missionId',
            { missionId: row.id }
        );
        if ((count?.c || 0) >= MAX_EVIDENCE) {
            throw new ProjectMissionError(400, 'TOO_MUCH_EVIDENCE',
                `A mission can hold at most ${MAX_EVIDENCE} evidence links.`);
        }
        const dup = await db.get(
            `SELECT id FROM project_mission_evidence
             WHERE missionId = @missionId AND kind = @kind AND refId = @refId
               AND criterionId = @criterionId`,
            { missionId: row.id, kind: cleanKind, refId: id, criterionId: cleanCriterion }
        );
        if (dup) {
            throw new ProjectMissionError(409, 'DUPLICATE_EVIDENCE',
                'That evidence is already linked to this criterion.');
        }
        await db.transaction(async (tx) => {
            await tx.insert(
                `INSERT INTO project_mission_evidence
                    (missionId, userId, criterionId, kind, refId, label, polarity, provenanceJson)
                 VALUES
                    (@missionId, @userId, @criterionId, @kind, @refId, @label, @polarity, @provenance)`,
                {
                    missionId: row.id,
                    userId,
                    criterionId: cleanCriterion,
                    kind: cleanKind,
                    refId: id,
                    label: clip(label, MAX_EVIDENCE_LABEL) || null,
                    polarity: cleanPolarity,
                    provenance: JSON.stringify(provenance)
                }
            );
            await this._appendEvent(tx, {
                missionId: row.id, userId, kind: 'evidence_added',
                payload: {
                    evidenceKind: cleanKind, refId: id, criterionId: cleanCriterion || null,
                    polarity: cleanPolarity, scope: provenance.scope
                }
            });
        });
        this._publish(domainEventBus.TOPICS.MISSION_CREATED, {
            userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug, status: row.status
        });
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
    }

    async _assertEvidenceExists(kind, refId, projectRow, { imported = false } = {}) {
        if (kind === 'claim') {
            const row = await db.get(
                `SELECT c.id, e.projectId, e.userId, e.id AS expeditionId
                 FROM research_claims c
                 JOIN spitball_expeditions e ON e.id = c.expeditionId
                 WHERE c.id = @id`,
                { id: refId }
            );
            if (!row) throw new ProjectMissionError(404, 'NO_CLAIM', 'No such claim.');
            if (row.projectId === projectRow.id) {
                return { scope: 'project', expeditionId: row.expeditionId };
            }
            const ownerId = projectRow.ownerId || projectRow.userId;
            if (imported && row.userId === ownerId) {
                return {
                    scope: 'imported',
                    expeditionId: row.expeditionId,
                    sourceProjectId: row.projectId || null
                };
            }
            throw new ProjectMissionError(404, 'NO_CLAIM',
                imported
                    ? 'No such claim owned by this project\'s owner.'
                    : 'That claim is not on this project. Pass imported=true to link owner-scoped evidence.');
        }
        if (kind === 'note') {
            const row = await db.get(
                `SELECT id FROM kg_nodes WHERE id = @id AND scopeKey = @scopeKey`,
                { id: refId, scopeKey: `PROJECT:${projectRow.id}` }
            );
            if (!row) throw new ProjectMissionError(404, 'NO_NOTE', 'No such project note.');
            return { scope: 'project' };
        }
        if (kind === 'job') {
            const row = await db.get(
                'SELECT id FROM observatory_jobs WHERE id = @id AND projectId = @projectId',
                { id: refId, projectId: projectRow.id }
            );
            if (!row) throw new ProjectMissionError(404, 'NO_JOB', 'No such job on this project.');
            return { scope: 'project' };
        }
        const row = await db.get(
            'SELECT id FROM project_assets WHERE id = @id AND projectId = @projectId',
            { id: refId, projectId: projectRow.id }
        );
        if (!row) throw new ProjectMissionError(404, 'NO_ARTIFACT', 'No such asset on this project.');
        return { scope: 'project' };
    }

    async submitReview({
        userId, project, owner = null, missionId = null,
        notes = null, verdict = null, criterionResults = null, reopenWhen = null
    } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, ['ACTIVE', 'BLOCKED', 'REVIEW']
        );
        const shaped = await this._shape(row, { includeTimeline: false });
        const cleanVerdict = VERDICTS.has(String(verdict)) ? String(verdict) : 'mixed';
        const review = {
            notes: clip(notes, MAX_REVIEW_NOTES) || null,
            verdict: cleanVerdict,
            criteria: shaped.evaluation.criteria,
            criterionResults: parseJson(criterionResults, null),
            evaluatedAt: toUtcText(new Date()),
            reopenWhen: clip(reopenWhen, MAX_REOPEN) || null
        };
        await db.transaction(async (tx) => {
            await tx.run(
                `UPDATE project_missions
                 SET status = 'REVIEW', reviewJson = @review, updatedAt = datetime('now')
                 WHERE id = @id AND status IN ('ACTIVE', 'BLOCKED', 'REVIEW')`,
                { id: row.id, review: JSON.stringify(review) }
            );
            await this._appendEvent(tx, {
                missionId: row.id, userId, kind: 'review_submitted',
                payload: { verdict: review.verdict }
            });
        });
        this._publish(domainEventBus.TOPICS.MISSION_REVIEW, {
            userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug, status: 'REVIEW'
        });
        return this.get({ userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id });
    }

    async complete({
        userId, project, owner = null, missionId = null,
        notes = null, verdict = null, reopenWhen = null,
        receiptId = null, nonce = null
    } = {}) {
        const { project: projectRow, row } = await this._requireOpen(
            userId, project, owner, missionId, ['REVIEW']
        );
        const shaped = await this._shape(row, { includeTimeline: false });
        const existing = parseJson(row.reviewJson, {}) || {};
        const cleanVerdict = VERDICTS.has(String(verdict))
            ? String(verdict)
            : (VERDICTS.has(String(existing.verdict)) ? String(existing.verdict) : 'mixed');
        const review = {
            ...existing,
            notes: clip(notes, MAX_REVIEW_NOTES) || existing.notes || null,
            verdict: cleanVerdict,
            criteria: shaped.evaluation.criteria,
            evaluatedAt: existing.evaluatedAt || toUtcText(new Date()),
            reopenWhen: clip(reopenWhen, MAX_REOPEN) || existing.reopenWhen || null,
            completedBy: userId
        };
        const planRevision = Number(row.planRevision) || 1;
        await db.transaction(async (tx) => {
            await this._consumeReceipt(tx, {
                missionId: row.id, userId, receiptId, nonce, planRevision, kind: 'complete'
            });
            const changed = (await tx.run(
                `UPDATE project_missions
                 SET status = 'COMPLETED', reviewJson = @review,
                     completedAt = datetime('now'), updatedAt = datetime('now')
                 WHERE id = @id AND status = 'REVIEW'`,
                { id: row.id, review: JSON.stringify(review) }
            )).changes > 0;
            if (!changed) {
                throw new ProjectMissionError(409, 'BAD_STATUS',
                    'This mission is no longer waiting for completion.');
            }
            const already = await tx.get(
                'SELECT id FROM project_decisions WHERE missionId = @missionId',
                { missionId: row.id }
            );
            if (already) {
                throw new ProjectMissionError(409, 'DECISION_EXISTS',
                    'This mission already has a decision record.');
            }
            await this._appendEvent(tx, {
                missionId: row.id, userId, kind: 'completed',
                payload: { verdict: review.verdict }
            });
            await tx.insert(
                `INSERT INTO project_decisions
                    (projectId, missionId, userId, question, alternativesJson, evidenceJson,
                     selectedAction, expectedOutcomesJson, reopenWhen)
                 VALUES
                    (@projectId, @missionId, @userId, @question, @alternatives, @evidence,
                     @selected, @expected, @reopenWhen)`,
                {
                    projectId: projectRow.id,
                    missionId: row.id,
                    userId,
                    question: row.objective,
                    alternatives: null,
                    evidence: JSON.stringify({
                        evaluation: shaped.evaluation,
                        evidence: shaped.evidence
                    }),
                    selected: `Mission ${review.verdict}: ${row.title}`,
                    expected: JSON.stringify(row.successCriteriaJson
                        ? parseJson(row.successCriteriaJson, [])
                        : []),
                    reopenWhen: review.reopenWhen
                }
            );
        });
        this._publish(domainEventBus.TOPICS.MISSION_COMPLETED, {
            userId, missionId: row.id, projectId: projectRow.id, slug: projectRow.slug,
            status: 'COMPLETED', verdict: review.verdict
        });
        return this.get({
            userId, project: projectRow.slug, owner: projectRow.ownerId, missionId: row.id
        });
    }

    /**
     * Job settle hook. Marks a linked RUNNING job-step done or failed and
     * may BLOCK or REVIEW the mission. Safe no-op when nothing is linked.
     */
    async onJobSettled({ jobId, status } = {}) {
        const id = Number(jobId);
        if (!id) return false;
        const step = await db.get(
            `SELECT s.*, m.status AS missionStatus, m.userId AS ownerId, m.projectId,
                    p.slug
             FROM project_mission_steps s
             JOIN project_missions m ON m.id = s.missionId
             JOIN observatory_projects p ON p.id = m.projectId
             WHERE s.jobId = @jobId AND s.kind = 'job' AND s.status = 'RUNNING'
             LIMIT 1`,
            { jobId: id }
        );
        if (!step) return false;
        return this._settleLinkedStep(step, {
            ok: status === 'COMPLETED',
            reason: `Job #${id} ${String(status || '').toLowerCase()}`,
            topicOk: domainEventBus.TOPICS.MISSION_STEP_COMPLETED,
            topicFail: domainEventBus.TOPICS.MISSION_STEP_FAILED
        });
    }

    async onExpeditionSettled({ expeditionId, status } = {}) {
        const id = Number(expeditionId);
        if (!id) return false;
        const step = await db.get(
            `SELECT s.*, m.status AS missionStatus, m.userId AS ownerId, m.projectId,
                    p.slug
             FROM project_mission_steps s
             JOIN project_missions m ON m.id = s.missionId
             JOIN observatory_projects p ON p.id = m.projectId
             WHERE s.expeditionId = @expeditionId AND s.kind = 'expedition'
               AND s.status = 'RUNNING'
             LIMIT 1`,
            { expeditionId: id }
        );
        if (!step) return false;
        return this._settleLinkedStep(step, {
            ok: status === 'COMPLETED',
            reason: `Expedition #${id} ${String(status || '').toLowerCase()}`,
            topicOk: domainEventBus.TOPICS.MISSION_STEP_COMPLETED,
            topicFail: domainEventBus.TOPICS.MISSION_STEP_FAILED
        });
    }

    async onWatchFired({ watchId, failed = false } = {}) {
        const id = Number(watchId);
        if (!id) return false;
        const step = await db.get(
            `SELECT s.*, m.status AS missionStatus, m.userId AS ownerId, m.projectId,
                    p.slug
             FROM project_mission_steps s
             JOIN project_missions m ON m.id = s.missionId
             JOIN observatory_projects p ON p.id = m.projectId
             WHERE s.watchId = @watchId AND s.kind = 'watch' AND s.status = 'RUNNING'
             LIMIT 1`,
            { watchId: id }
        );
        if (!step) return false;
        return this._settleLinkedStep(step, {
            ok: !failed,
            reason: failed ? `Watch #${id} failed` : `Watch #${id} fired`,
            topicOk: domainEventBus.TOPICS.MISSION_STEP_COMPLETED,
            topicFail: domainEventBus.TOPICS.MISSION_STEP_FAILED
        });
    }

    async _settleLinkedStep(step, { ok, reason, topicOk, topicFail }) {
        const nextStepStatus = ok ? 'DONE' : 'FAILED';
        let nextMission = step.missionStatus;
        await db.transaction(async (tx) => {
            await tx.run(
                `UPDATE project_mission_steps
                 SET status = @status, finishedAt = datetime('now'), updatedAt = datetime('now')
                 WHERE id = @id AND status = 'RUNNING'`,
                { id: step.id, status: nextStepStatus }
            );
            await this._appendEvent(tx, {
                missionId: step.missionId,
                userId: step.ownerId,
                kind: ok ? 'step_done' : 'step_failed',
                payload: { stepId: step.id, reason }
            });
            await this._refreshReadySteps(tx, step.missionId);
            const mission = {
                id: step.missionId,
                status: step.missionStatus,
                userId: step.ownerId
            };
            if (!ok) {
                const blocked = await this._maybeBlock(tx, mission, step.ownerId, reason);
                if (blocked) nextMission = 'BLOCKED';
            } else if (step.missionStatus === 'ACTIVE') {
                const advanced = await this._maybeAdvanceToReview(tx, mission, step.ownerId);
                if (advanced) nextMission = 'REVIEW';
            }
        });
        const topic = nextMission === 'BLOCKED'
            ? domainEventBus.TOPICS.MISSION_BLOCKED
            : nextMission === 'REVIEW'
                ? domainEventBus.TOPICS.MISSION_REVIEW
                : (ok ? topicOk : topicFail);
        this._publish(topic, {
            userId: step.ownerId,
            missionId: step.missionId,
            projectId: step.projectId,
            slug: step.slug,
            stepId: step.id,
            status: nextMission
        });
        return true;
    }

    /**
     * Compact line for the project chat preamble.
     */
    async describeForManifest({ userId, project, owner = null } = {}) {
        const open = await this.getOpen({ userId, project, owner });
        if (!open) return null;
        const ready = open.steps.filter(s => s.status === 'READY').length;
        const running = open.steps.filter(s => s.status === 'RUNNING').length;
        const criteria = (open.successCriteria || []).map(c => c.text).slice(0, 4);
        return [
            `Mission (${open.status}): ${open.title}`,
            `Objective: ${open.objective}`,
            criteria.length ? `Success: ${criteria.join('; ')}` : null,
            open.deadline ? `Deadline: ${open.deadline}` : null,
            `Steps: ${open.evaluation.doneSteps}/${open.evaluation.totalSteps} done`
                + (ready ? `, ${ready} ready` : '')
                + (running ? `, ${running} running` : ''),
            open.status === 'DRAFT' ? 'Waiting for human approval before any step runs.' : null,
            open.status === 'REVIEW' ? 'Ready for review — compare evidence against the original criteria.' : null,
            open.status === 'BLOCKED' ? 'Blocked — a step failed. Resume after you decide what to do.' : null
        ].filter(Boolean).join('\n');
    }

    async forgetUser(userId) {
        if (!userId) return { missions: 0, decisions: 0 };
        const decisions = (await db.run(
            'DELETE FROM project_decisions WHERE userId = @userId', { userId }
        )).changes;
        const missions = (await db.run(
            'DELETE FROM project_missions WHERE userId = @userId', { userId }
        )).changes;
        return { missions, decisions };
    }

    async countUser(userId) {
        const row = await db.get(
            `SELECT
                (SELECT COUNT(*) FROM project_missions WHERE userId = @userId) AS missions,
                (SELECT COUNT(*) FROM project_decisions WHERE userId = @userId) AS decisions`,
            { userId }
        );
        return { missions: row?.missions || 0, decisions: row?.decisions || 0 };
    }
}

module.exports = new ProjectMissionService();
module.exports.ProjectMissionService = ProjectMissionService;
module.exports.ProjectMissionError = ProjectMissionError;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
module.exports.HUMAN_ORIGINS = HUMAN_ORIGINS;
module.exports.RECEIPT_KINDS = RECEIPT_KINDS;
module.exports.ASSESSMENTS = ASSESSMENTS;
module.exports.legalizeCriteria = legalizeCriteria;
module.exports.toUtcText = toUtcText;
