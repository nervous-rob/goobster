/**
 * Source adapter `project_plan_step` (ADR 0019): the READY `agent` steps of
 * the linked project's plan, for a responsibility that was granted
 * `plan.step.execute` on that project. Read only while the projects feature
 * is on.
 *
 * It is a standing source: a step that is ready when the responsibility
 * first looks is the work that was delegated, so it is proposed rather than
 * recorded as a baseline. A step is proposed once per approved plan
 * revision and human retry; a failed attempt is never proposed again by
 * itself.
 *
 * Nothing is read unless a person approved and started the plan revision
 * that is current, and the person the responsibility acts for can still
 * reach the project (the step title is project content). Dispatch checks
 * all of this again.
 */

const db = require('../../../db');

const OPERATION = 'plan.step.execute';

function grantsPlanSteps(responsibility) {
    let operations;
    try { operations = JSON.parse(responsibility.operationsJson || '[]'); } catch { operations = []; }
    const target = String(responsibility.projectId);
    return Array.isArray(operations) && operations.some(entry => (
        entry?.operation === OPERATION && entry.resource?.kind === 'project' && (entry.resource.ids || []).includes(target)
    ));
}

/** Why a proposed or queued attempt at a step can no longer be dispatched, or null. */
function staleCode(row) {
    if (row.stepId == null || row.kind !== 'agent') return 'NO_STEP';
    // Its own run holds the step (parked mid-work): still its to finish.
    if (row.runId != null && row.executionAttemptId === `assistant_run:${Number(row.runId)}`
        && ['STARTING', 'RUNNING'].includes(row.stepStatus)) return null;
    if (!['ACTIVE', 'BLOCKED'].includes(row.missionStatus)) return 'PLAN_NOT_ACTIVE';
    // Closed. A step another run holds may still come back, so dispatch decides that.
    if (['DONE', 'SKIPPED', 'FAILED'].includes(row.stepStatus)) return 'STEP_NOT_ELIGIBLE';
    const approved = row.approvedRevision != null ? Number(row.approvedRevision) : null;
    if (!row.approvedAt || approved == null
        || approved !== (Number(row.currentRevision) || 1)
        || (row.planRevision != null && Number(row.planRevision) !== approved)
        || (Number(row.stepRevision) || 0) > approved) return 'PLAN_REVISION_STALE';
    return null;
}

module.exports = {
    feature: 'projects',
    standing: true,
    OPERATION,
    /**
     * Proposed or queued attempts whose step can no longer be dispatched:
     * the same checks projectMissionService.beginDelegatedStep makes when
     * a run asks for the step, made here so a plan that moved on withdraws
     * the work it had proposed instead of leaving it listed (ADR 0021).
     * @returns {Promise<{ id: number, code: string, supersededBy: string|null }[]>}
     */
    async stale(responsibility) {
        const rows = await db.all(
            `SELECT i.id, i.planRevision, r.id AS runId,
                    s.id AS stepId, s.kind, s.status AS stepStatus, s.planRevision AS stepRevision, s.executionAttemptId,
                    m.id AS missionId, m.status AS missionStatus, m.planRevision AS currentRevision,
                    m.approvedRevision, m.approvedAt
             FROM assistant_initiatives i
             LEFT JOIN assistant_runs r ON r.initiativeId = i.id
             LEFT JOIN project_mission_steps s ON s.id = i.planStepId
             LEFT JOIN project_missions m ON m.id = s.missionId
             WHERE i.responsibilityId = @rid AND i.planStepId IS NOT NULL
               AND i.status IN ('CANDIDATE', 'QUEUED', 'WAITING')`,
            { rid: responsibility.id }
        );
        const out = [];
        for (const row of rows) {
            const code = staleCode(row);
            if (code) out.push({ id: Number(row.id), code, supersededBy: row.missionId != null ? `plan:${Number(row.missionId)}` : null });
        }
        return out;
    },
    async read(responsibility) {
        if (!responsibility.projectId || !grantsPlanSteps(responsibility)) return [];
        const actor = responsibility.actingUserId || responsibility.ownerUserId;
        const reachable = await db.get(
            `SELECT p.id FROM observatory_projects p
             WHERE p.id = @id AND (p.userId = @actor
                OR EXISTS (SELECT 1 FROM project_members m WHERE m.projectId = p.id AND m.userId = @actor))`,
            { id: responsibility.projectId, actor }
        );
        if (!reachable) return [];
        const plan = await db.get(
            `SELECT id, planRevision, approvedRevision, approvedAt FROM project_missions
             WHERE projectId = @projectId AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1`,
            { projectId: responsibility.projectId }
        );
        if (!plan || !plan.approvedAt || plan.approvedRevision == null) return [];
        // A responsibility linked to one plan works only on that plan.
        if (responsibility.planId && Number(responsibility.planId) !== Number(plan.id)) return [];
        const approved = Number(plan.approvedRevision);
        if (approved !== Number(plan.planRevision)) return [];
        const steps = await db.all(
            `SELECT id, title, planRevision, retryCount FROM project_mission_steps
             WHERE missionId = @missionId AND kind = 'agent' AND status = 'READY'
             ORDER BY sortOrder ASC, id ASC`,
            { missionId: plan.id }
        );
        return steps
            .filter(step => (Number(step.planRevision) || 0) <= approved)
            .map(step => ({
                sourceId: String(step.id),
                revision: `${approved}:${Number(step.retryCount) || 0}`,
                title: `Plan step ready: ${String(step.title).slice(0, 160)}`,
                reason: 'agent step of the approved plan',
                category: 'project',
                planStep: { id: Number(step.id), planRevision: approved }
            }));
    }
};
