/**
 * The plan-step side of a delegated run (ADR 0019): what a run does
 * differently when its initiative carries out an `agent` step of a project
 * plan. `assistantRunService.execute` calls these; nothing else does.
 *
 *  - dispatch(): `authorize()` must allow `plan.step.execute` on the
 *    project, then projectMissionService.beginDelegatedStep claims the step
 *    (the plan revision a person approved and started, the step READY, the
 *    acting person still on the project, the plan's own budget).
 *  - messages(): the prompt, built from the plan and the step.
 *  - verify(): deterministic checks of the reported result against the
 *    run's own journal and the workspace. The model's word is not evidence.
 *  - settle() / release(): the step's outcome, written by the mission
 *    service under the project's write lock.
 *
 * The mission service is reached through the projects feature payload, so
 * an installation without projects has no plan-step runs.
 */

const db = require('../../db');
const requireOptional = require('../../utils/optionalModule').forModule(module);
const { sha, cleanPath } = require('./runTools/shared');

const OPERATION = 'plan.step.execute';
/** How soon a run waiting on a blocked plan looks again. */
const BLOCKED_RECHECK_MS = 30 * 60 * 1000;
/** beginDelegatedStep codes that mean the opportunity is gone, not that the run failed. */
const SUPERSEDING = new Set(['NO_STEP', 'STEP_NOT_ELIGIBLE', 'PLAN_NOT_ACTIVE', 'PLAN_REVISION_STALE']);

function missions() {
    return requireOptional('../projectMissionService', { feature: 'projects' });
}

function authorizeStep({ run, actor, project }) {
    return require('../assistantResponsibilityService').authorize({
        responsibilityId: run.responsibilityId,
        revision: run.responsibilityRevision,
        operation: OPERATION,
        resource: { kind: 'project', id: String(project.id) },
        actorUserId: actor
    });
}

/**
 * Authorize and claim the step for this run.
 * @returns {Promise<{ ok: true, step, mission, settled?: 'DONE'|'FAILED' }
 *   | { ok: false, code: string, authorize?: true }>}
 */
async function dispatch({ initiative, run, responsibility, actor, project }) {
    const service = missions();
    if (!service) return { ok: false, code: 'FEATURE_UNAVAILABLE', authorize: true };
    if (!project) return { ok: false, code: 'NO_STEP' };
    const verdict = await authorizeStep({ run, actor, project });
    if (!verdict.ok) return { ok: false, code: verdict.code, authorize: true };
    const context = await service.agentStepContext(initiative.planStep.id);
    // The step must belong to the project the responsibility is linked to.
    if (!context || context.mission.projectId !== Number(project.id)) return { ok: false, code: 'NO_STEP' };
    const begun = await service.beginDelegatedStep({
        stepId: initiative.planStep.id,
        planRevision: initiative.planStep.planRevision,
        runId: run.id,
        actorUserId: actor,
        responsibilityId: responsibility.id,
        grantRevision: run.responsibilityRevision
    });
    if (!begun.ok) return { ok: false, code: begun.code };
    return { ok: true, step: context.step, mission: context.mission, settled: begun.settled || null };
}

function messages({ responsibility, project, tools, step, mission }) {
    const required = step.actionParams?.artifacts || [];
    const system = [
        'You are carrying out one step of a project plan for a person, unattended. They are not watching and cannot answer questions now.',
        `They delegated this under the responsibility "${responsibility.title}".${responsibility.outcome ? ` What good looks like: ${responsibility.outcome}` : ''}`,
        `The plan belongs to the project "${project.name}". People approved and started it. You cannot approve, start, change or complete the plan, and you cannot decide that its objective is met: the people on the project review what you leave.`,
        `You may only use these tools: ${tools.join(', ')}. Anything else - sending, scheduling, deleting, changing what people wrote - is not yours to do. If the step needs an action you cannot take, report it as blocked instead of attempting it.`,
        'Do this one step and nothing else in the plan. Write its result into the project workspace with writeProjectFile. Other people on the project can read what you write there, so write only what belongs to the step.',
        'A refused tool call means that is outside what was delegated. Do not retry it or look for another way around it.',
        'Work in few steps. When the step is finished, call reportStepResult once and name every file you wrote for it. If you cannot finish it, call reportStepResult with outcome "blocked" and say what stopped you. Report only what you actually did. Never invent a source.'
    ].join('\n');
    const criteria = (mission.successCriteria || []).map(c => `  ${c.id}: ${c.text}`).join('\n');
    const user = [
        `Plan: ${mission.title}`,
        `Objective: ${mission.objective}`,
        criteria ? `Success criteria:\n${criteria}` : '',
        `The step to carry out: ${step.title}`,
        step.description ? `Detail: ${step.description}` : '',
        step.actionParams?.instructions ? `Instructions: ${step.actionParams.instructions}` : '',
        required.length ? `It must produce these files: ${required.join(', ')}` : 'It must produce at least one file holding its result.'
    ].filter(Boolean).join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Paths this run wrote, from its journal (not from what the model says it wrote). */
async function writtenPaths(runId) {
    const rows = await db.all(
        `SELECT resultText FROM assistant_run_operations
         WHERE runId = @runId AND tool = 'writeProjectFile' AND status = 'SUCCEEDED' ORDER BY id`,
        { runId }
    );
    const paths = new Set();
    for (const row of rows) {
        const match = /^Wrote (.+)\.$/.exec(String(row.resultText || ''));
        if (match) paths.add(cleanPath(match[1]));
    }
    return paths;
}

/**
 * Check the reported result. Passing means: the run reported the step done,
 * it is still allowed to carry out plan steps here, and every file it names
 * and every file the step requires was written by this run and is in the
 * workspace now, not empty.
 * @returns {Promise<{ ok: true, artifacts: { path, bytes, sha256 }[], criteria: string[] }
 *   | { ok: false, code: string, detail?: string, authorize?: true }>}
 */
async function verify({ ctx, step, mission }) {
    const report = ctx.stepReport;
    if (!report) return { ok: false, code: 'NO_STEP_REPORT' };
    if (report.outcome !== 'done') return { ok: false, code: 'STEP_BLOCKED' };
    const verdict = await authorizeStep({ run: ctx.run, actor: ctx.actor, project: ctx.project });
    if (!verdict.ok) return { ok: false, code: verdict.code, authorize: true };
    const fail = (detail) => ({ ok: false, code: 'VERIFICATION_FAILED', detail });
    const paths = [...new Set([...(step.actionParams?.artifacts || []).map(cleanPath), ...report.artifacts])].filter(Boolean);
    if (!paths.length) return fail('NO_ARTIFACT');
    const projects = requireOptional('../projectService', { feature: 'projects' });
    if (!projects) return { ok: false, code: 'FEATURE_UNAVAILABLE', authorize: true };
    const written = await writtenPaths(ctx.run.id);
    const artifacts = [];
    for (const path of paths) {
        if (!written.has(path)) return fail('ARTIFACT_NOT_WRITTEN');
        let file;
        try {
            file = await projects.readWorkspaceFile({
                userId: ctx.actor, slug: ctx.project.slug, owner: ctx.project.ownerId, relativePath: path, purpose: 'portal'
            });
        } catch {
            return fail('ARTIFACT_MISSING');
        }
        if (!file.bytes?.length) return fail('ARTIFACT_EMPTY');
        artifacts.push({ path, bytes: file.bytes.length, sha256: sha(file.bytes) });
    }
    const known = new Set((mission.successCriteria || []).map(c => c.id));
    return { ok: true, artifacts, criteria: report.criteria.filter(id => known.has(id)) };
}

/** Close the step: done with its verified evidence, or failed with a code. */
async function settle({ ctx, step, ok, code = null, verified = null }) {
    const service = missions();
    if (!service) return { ok: false, code: 'FEATURE_UNAVAILABLE' };
    return service.settleDelegatedStep({
        stepId: step.id,
        runId: ctx.run.id,
        actorUserId: ctx.actor,
        ok,
        code,
        evidence: ok ? { criteria: verified.criteria, label: step.title, artifacts: verified.artifacts } : null
    });
}

/** Give the step back without a result. Never throws. */
async function release({ runId, stepId, code }) {
    try {
        return Boolean(await missions()?.releaseDelegatedStep({ stepId, runId, code }));
    } catch {
        return false;
    }
}

module.exports = { OPERATION, BLOCKED_RECHECK_MS, SUPERSEDING, dispatch, messages, verify, settle, release };
