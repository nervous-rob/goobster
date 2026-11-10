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

module.exports = {
    feature: 'projects',
    standing: true,
    OPERATION,
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
