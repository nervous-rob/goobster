/**
 * Delegated execution of `agent` plan steps (DA-4a, ADR 0019) against a
 * throwaway database, with a scripted model and fake workspace files (no
 * provider, no network).
 *
 * The properties under test are the DA-4a acceptance scenarios: an eligible
 * step advances once, produces its artifacts and links evidence; a plan or a
 * grant that changed invalidates dispatch before anything runs; a
 * collaborator's responsibility runs as that collaborator, with them as the
 * payer; private knowledge is not copied into a shared project; lost
 * membership stops queued and running work from reading or publishing;
 * failed verification is a blocker, never a completed objective; and no
 * human confirmation receipt is forged or reused.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-plan-step-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const workContext = require('@goobster/core/utils/workContext');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runs = require('@goobster/core/services/assistantRunService');
const runner = require('@goobster/core/services/assistantRunnerService');
const updates = require('@goobster/core/services/assistantUpdateService');
const policies = require('@goobster/core/services/attentionPolicyService');
const missions = require('@goobster/core/services/projectMissionService');
const projects = require('@goobster/core/services/projectService');
const transfers = require('@goobster/core/services/knowledgeTransferService');
const { useState } = require('./helpers/featureFixtures');

const A = '760000000000000001';
const B = '760000000000000002';
const C = '760000000000000003';

afterAll(async () => {
    initiatives.stopListening();
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

let files;
let lookup;
beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    runner._reset();
    for (const table of [
        'assistant_run_operations', 'assistant_runs', 'assistant_initiatives', 'assistant_source_cursors',
        'assistant_update_receipts', 'assistant_updates', 'assistant_responsibility_revisions', 'assistant_responsibilities',
        'attention_policies', 'attention_items', 'inbox_items', 'usage_reservations', 'work_failures',
        'project_mission_approval_receipts', 'project_mission_events', 'project_mission_evidence', 'project_mission_steps',
        'project_missions', 'observatory_share_links', 'project_members', 'observatory_projects'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    files = new Map();
    const notFound = () => Object.assign(new Error('No such file.'), { code: 'NOT_FOUND', status: 404 });
    jest.spyOn(projects, 'readWorkspaceFile').mockImplementation(async ({ relativePath }) => {
        if (!files.has(relativePath)) throw notFound();
        const bytes = Buffer.from(files.get(relativePath));
        return { relativePath, name: relativePath, mime: 'text/markdown', bytes, size: bytes.length };
    });
    jest.spyOn(projects, 'writeWorkspaceFile').mockImplementation(async ({ relativePath, bytes }) => {
        files.set(relativePath, bytes.toString('utf8'));
        return { relativePath };
    });
    const realExecute = toolsRegistry.execute.bind(toolsRegistry);
    lookup = jest.fn(async () => 'PRIVATE: the budget ceiling is 40k');
    jest.spyOn(toolsRegistry, 'execute').mockImplementation(async (name, args) => (
        name === 'lookupNotes' ? lookup(args) : realExecute(name, args)
    ));
});

let callId = 0;
const call = (name, args = {}) => ({ id: `p${++callId}`, name, arguments: JSON.stringify(args) });
/** Script the model: each entry is one round's tool calls, a final text, or a function returning either. */
function script(...rounds) {
    const queue = [...rounds];
    return jest.spyOn(aiService, 'chat').mockImplementation(async () => {
        let next = queue.shift();
        if (typeof next === 'function') next = await next();
        if (next === undefined) return { content: 'Nothing more.', toolCalls: [] };
        if (next instanceof Error) throw next;
        return typeof next === 'string' ? { content: next, toolCalls: [] } : { content: '', toolCalls: next };
    });
}

const WRITE = call('writeProjectFile', { path: 'docs/report.md', content: '# Comparison\nLibrary X is faster.' });
const REPORT = (extra = {}) => call('reportStepResult', {
    outcome: 'done', title: 'Wrote the comparison', summary: 'Compared X and Y from their docs.', artifacts: ['docs/report.md'], ...extra
});

const planOps = (pid, { paths = ['docs'] } = {}) => [
    { operation: 'read', resource: { kind: 'project', ids: [String(pid)] } },
    { operation: 'file.edit', resource: { kind: 'project', ids: [String(pid)], paths } },
    { operation: 'plan.step.execute', resource: { kind: 'project', ids: [String(pid)] } }
];

async function approveAsHuman(args) {
    const receipt = await missions.mintApprovalReceipt({ ...args, origin: 'portal' });
    return missions.approve({ ...args, receiptId: receipt.id, nonce: receipt.nonce });
}

/** A project owned by `owner` with an approved, started plan holding agent steps. */
async function plan({ owner = A, members = [], steps = null, budget = undefined } = {}) {
    const pid = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'lab', 'Lab')", { u: owner });
    for (const member of members) {
        await db.run(
            'INSERT INTO project_members (projectId, userId, userName, invitedBy) VALUES (@pid, @u, @u, @owner)',
            { pid, u: member, owner }
        );
    }
    const args = { userId: owner, project: 'lab' };
    await missions.create({
        ...args,
        title: 'Choose a charting library',
        objective: 'Decide between library X and library Y.',
        successCriteria: ['A written comparison exists', 'A recommendation is recorded'],
        budget,
        steps: steps || [{ kind: 'agent', title: 'Write the comparison report', actionParams: { artifacts: ['docs/report.md'] } }]
    });
    await approveAsHuman(args);
    const started = await missions.start(args);
    return { pid, args, mission: started, stepId: started.steps[0].id };
}

/** An active responsibility of `userId` on the project, and its proposed plan-step work. */
async function delegate({ userId = A, pid, operations = planOps(pid), queue = true, body = {} } = {}) {
    await policies.enroll({ userId, initiative: 'assist' });
    const { responsibility } = await responsibilities.create({
        userId, body: { title: 'Carry the charting plan forward', projectId: pid, operations, ...body }
    });
    const grant = (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
    // Activation takes the first look at the linked sources in its own transaction.
    const proposed = (await db.all('SELECT id FROM assistant_initiatives WHERE responsibilityId = @id ORDER BY id', { id: grant.id }))
        .map(row => Number(row.id));
    const out = { grant, proposed, initiative: null };
    if (proposed.length) {
        const row = await initiatives.get({ userId, id: proposed[0] });
        out.initiative = queue
            ? (await initiatives.act({ userId, id: row.id, action: 'queue', expectedRevision: row.revision })).initiative
            : row;
    }
    return out;
}

const stepRow = (id) => db.get('SELECT * FROM project_mission_steps WHERE id = @id', { id });
const missionRow = () => db.get('SELECT * FROM project_missions ORDER BY id DESC LIMIT 1', {});
const evidence = () => db.all('SELECT * FROM project_mission_evidence ORDER BY id', {});
const events = async () => (await db.all('SELECT kind, userId, payloadJson FROM project_mission_events ORDER BY id', {}))
    .map(row => ({ kind: row.kind, userId: row.userId, payload: row.payloadJson ? JSON.parse(row.payloadJson) : null }));
const initiativeRow = (id) => db.get('SELECT * FROM assistant_initiatives WHERE id = @id', { id });
const runRows = () => db.all('SELECT * FROM assistant_runs ORDER BY id', {});
const operations = () => db.all('SELECT tool, status, refusalCode FROM assistant_run_operations ORDER BY id', {});
const view = (args) => missions.get({ ...args });

describe('the grant vocabulary', () => {
    test('plan.step.execute is a project operation that takes no paths', async () => {
        const vocabulary = responsibilities.vocabulary();
        expect(vocabulary.operations.find(op => op.id === 'plan.step.execute')).toMatchObject({ resourceKinds: ['project'], action: 'compute' });
        const { pid } = await plan();
        await expect(responsibilities.create({
            userId: A,
            body: { title: 'x', projectId: pid, operations: [{ operation: 'plan.step.execute', resource: { kind: 'project', ids: [String(pid)], paths: ['docs'] } }] }
        })).rejects.toMatchObject({ code: 'INVALID_RESOURCE' });
        await expect(responsibilities.create({
            userId: A, body: { title: 'x', operations: [{ operation: 'plan.step.execute', resource: { kind: 'knowledge' } }] }
        })).rejects.toMatchObject({ code: 'INVALID_RESOURCE' });
    });

    test('there is no operation, and no run tool, that approves, starts or completes a plan', () => {
        const names = [...Object.keys(responsibilities.OPERATIONS), ...Object.keys(runs.TOOLS)].join(' ');
        expect(names).not.toMatch(/approve|plan\.start|plan\.complete|mission|receipt/i);
        expect(Object.keys(responsibilities.OPERATIONS).filter(op => op.startsWith('plan.'))).toEqual(['plan.step.execute']);
    });
});

describe('an eligible agent step', () => {
    test('advances once, produces its artifacts and links evidence', async () => {
        const { pid, args, stepId } = await plan();
        const { initiative, proposed } = await delegate({ pid });
        // A READY step is waiting work: proposed on the first look, tied to the step and the approved revision.
        expect(proposed).toHaveLength(1);
        expect(initiative).toMatchObject({ source: { kind: 'project_plan_step', id: String(stepId), revision: '1:0' }, planStep: { id: stepId, planRevision: 1 } });

        const chat = script([WRITE], [REPORT({ criteria: ['c1', 'nope'] })]);
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'COMPLETED', outcome: 'DONE' });

        const [run] = await runRows();
        expect(await stepRow(stepId)).toMatchObject({
            status: 'DONE', executionAttemptId: `assistant_run:${run.id}`, agentRunId: run.id, authorizationKind: 'delegated',
            startedByUserId: A, grantResponsibilityId: initiative.responsibilityId, grantRevision: initiative.responsibilityRevision
        });
        expect(files.get('docs/report.md')).toContain('Library X is faster');

        // Evidence: the run, linked to the criterion it named, with the verified files. Never counted for or against.
        const linked = await evidence();
        expect(linked).toHaveLength(1);
        expect(linked[0]).toMatchObject({ kind: 'agent_run', refId: run.id, criterionId: 'c1', polarity: 'neutral', userId: A, label: 'Write the comparison report' });
        const provenance = JSON.parse(linked[0].provenanceJson);
        expect(provenance).toMatchObject({ scope: 'project', stepId, authorization: 'delegated', responsibilityId: initiative.responsibilityId });
        expect(provenance.artifacts).toEqual([{ path: 'docs/report.md', bytes: Buffer.byteLength(files.get('docs/report.md')), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);

        // The plan waits for a person's review; nothing here completed it.
        const mission = await view(args);
        expect(mission.status).toBe('REVIEW');
        expect(mission.completedAt).toBeNull();
        expect(mission.evaluation.criteria.find(c => c.id === 'c1')).toMatchObject({ assessment: 'unassessed', linked: 1 });
        expect(mission.steps[0]).toMatchObject({ authorization: 'delegated', delegation: { actingUserId: A, runId: run.id } });

        const timeline = await events();
        expect(timeline.filter(e => e.kind === 'step_started')).toEqual([expect.objectContaining({
            userId: A, payload: expect.objectContaining({ stepId, stepKind: 'agent', authorization: 'delegated', runId: run.id, attemptId: `assistant_run:${run.id}` })
        })]);
        expect(timeline.filter(e => e.kind === 'step_done')).toHaveLength(1);

        expect(await initiativeRow(initiative.id)).toMatchObject({ status: 'COMPLETED', outcome: 'DONE', leaseToken: null });
        const [update] = (await updates.list({ userId: A })).updates;
        expect(update).toMatchObject({ title: 'Plan step done: Write the comparison report', kind: 'progress', initiativeId: initiative.id });
        expect(update.summary).toContain('docs/report.md');

        // Once: nothing is proposed or run again for the same step.
        expect((await initiatives.reconcileResponsibility(initiative.responsibilityId)).proposed).toEqual([]);
        expect((await runner.tick({ wait: true })).started).toBe(0);
        expect(chat).toHaveBeenCalledTimes(2);
        // The model was offered the step report, not the generic finish.
        const offered = chat.mock.calls[0][1].functions || chat.mock.calls[0][1].tools || [];
        const offeredNames = JSON.stringify(offered);
        expect(offeredNames).toContain('reportStepResult');
        expect(offeredNames).not.toContain('"finish"');
    });

    test('two responsibilities that cover the step: the first to dispatch carries it out, the other is void without a model call', async () => {
        const { pid, stepId } = await plan({ members: [B] });
        const first = await delegate({ userId: A, pid });
        const second = await delegate({ userId: B, pid });
        expect(second.initiative.planStep.id).toBe(stepId);

        const chat = script([WRITE], [REPORT()]);
        // One per person may run; A is older in the queue.
        const result = await runner.tick({ wait: true });
        const statuses = result.results.map(r => r.status).sort();
        expect(statuses).toEqual(['COMPLETED', 'SUPERSEDED']);
        expect(chat).toHaveBeenCalledTimes(2);
        expect(await evidence()).toHaveLength(1);
        const rows = [await initiativeRow(first.initiative.id), await initiativeRow(second.initiative.id)];
        expect(rows.map(r => r.status).sort()).toEqual(['COMPLETED', 'SUPERSEDED']);
        expect(rows.find(r => r.status === 'SUPERSEDED').stopCode).toBe('STEP_NOT_ELIGIBLE');
        expect((await stepRow(stepId)).status).toBe('DONE');
    });

    test('a run resumed after its step was settled closes the attempt without doing the work again', async () => {
        const { pid, stepId } = await plan();
        const { initiative } = await delegate({ pid });
        const chat = script([WRITE], [REPORT()]);
        await runner.tick({ wait: true });
        // The crash window: the step is settled, the attempt is not.
        await db.run("UPDATE assistant_initiatives SET status = 'QUEUED', outcome = NULL, endedAt = NULL WHERE id = @id", { id: initiative.id });
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'COMPLETED', outcome: 'DONE' });
        expect(chat).toHaveBeenCalledTimes(2);
        expect(await evidence()).toHaveLength(1);
        expect((await stepRow(stepId)).status).toBe('DONE');
        expect(await runRows()).toHaveLength(1);
    });

    test('work is proposed only for a plan a person approved and started, and waits for its owner unless they chose automatic starts', async () => {
        const pid = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'lab', 'Lab')", { u: A });
        const args = { userId: A, project: 'lab' };
        await missions.create({
            ...args, title: 'T', objective: 'An objective to pursue.', successCriteria: ['One criterion'],
            steps: [{ kind: 'agent', title: 'Do the thing' }, { kind: 'human', title: 'Decide' }]
        });
        const drafted = await delegate({ pid, queue: false });
        expect(drafted.proposed).toEqual([]);
        await approveAsHuman(args);
        expect((await initiatives.reconcileResponsibility(drafted.grant.id)).proposed).toEqual([]);
        await missions.start(args);
        const [id] = (await initiatives.reconcileResponsibility(drafted.grant.id)).proposed;
        // Only the agent step, and it waits to be started by its owner.
        expect(await initiativeRow(id)).toMatchObject({ status: 'CANDIDATE', sourceKind: 'project_plan_step' });
        expect((await runner.tick({ wait: true })).started).toBe(0);
        // A grant without plan.step.execute proposes no plan steps at all.
        const without = await delegate({ userId: A, pid, operations: planOps(pid).slice(0, 2), queue: false });
        expect(without.proposed).toEqual([]);
    });
});

describe('stale dispatch authority', () => {
    test('a plan revision that moved on voids queued work before anything runs', async () => {
        const { pid, stepId } = await plan();
        const { initiative } = await delegate({ pid });
        // The approved scope changed after the work was queued.
        await db.run('UPDATE project_missions SET planRevision = planRevision + 1', {});
        const chat = script([WRITE], [REPORT()]);
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'SUPERSEDED', stopCode: 'PLAN_REVISION_STALE' });
        expect(chat).not.toHaveBeenCalled();
        expect(await initiativeRow(initiative.id)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'PLAN_REVISION_STALE' });
        expect(await stepRow(stepId)).toMatchObject({ status: 'READY', executionAttemptId: null, authorizationKind: null, agentRunId: null });
        expect(await evidence()).toEqual([]);
        expect(files.size).toBe(0);
        // The mission service refuses the same thing when asked directly.
        expect(await missions.beginDelegatedStep({ stepId, planRevision: 1, runId: 999, actorUserId: A }))
            .toEqual({ ok: false, code: 'PLAN_REVISION_STALE' });
    });

    test('work proposed under an older approved revision does not dispatch under a newer one', async () => {
        const { pid, stepId } = await plan();
        const { initiative } = await delegate({ pid });
        await db.run('UPDATE project_missions SET planRevision = 2, approvedRevision = 2', {});
        script([WRITE], [REPORT()]);
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'SUPERSEDED', stopCode: 'PLAN_REVISION_STALE' });
        expect((await stepRow(stepId)).status).toBe('READY');
        // The newer revision is a new opportunity, and it supersedes nothing that ran.
        const [again] = (await initiatives.reconcileResponsibility(initiative.responsibilityId)).proposed;
        expect(await initiativeRow(again)).toMatchObject({ sourceRevision: '2:0', planRevision: 2, status: 'CANDIDATE' });
    });

    test('a cancelled plan voids queued work', async () => {
        const { pid, args, stepId } = await plan();
        const { initiative } = await delegate({ pid });
        await missions.cancel(args);
        const chat = script([WRITE], [REPORT()]);
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'SUPERSEDED', stopCode: 'PLAN_NOT_ACTIVE' });
        expect(chat).not.toHaveBeenCalled();
        expect((await initiativeRow(initiative.id)).status).toBe('SUPERSEDED');
        expect((await stepRow(stepId)).status).toBe('SKIPPED');
    });

    test('a grant edited after the work was queued does not dispatch until its owner approves it again, and then only within the new grant', async () => {
        const { pid, stepId } = await plan();
        const { grant, initiative } = await delegate({ pid });
        const paused = (await responsibilities.act({ userId: A, id: grant.id, action: 'pause', expectedRevision: grant.revision })).responsibility;
        expect(await initiativeRow(initiative.id)).toMatchObject({ status: 'WAITING', waitReason: 'responsibility' });
        const edited = (await responsibilities.update({
            userId: A, id: grant.id, expectedRevision: paused.revision, body: { operations: planOps(pid).slice(0, 2) }
        })).responsibility;
        await responsibilities.act({ userId: A, id: grant.id, action: 'resume', expectedRevision: edited.revision });

        const chat = script([WRITE], [REPORT()]);
        // Still parked: the runner takes nothing.
        expect((await runner.tick({ wait: true })).started).toBe(0);
        // Even put back in the queue as it was, the claim refuses the older authority.
        await db.run("UPDATE assistant_initiatives SET status = 'QUEUED', waitReason = NULL WHERE id = @id", { id: initiative.id });
        expect(await initiatives.claim({ id: initiative.id })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
        expect(await initiativeRow(initiative.id)).toMatchObject({ status: 'WAITING', stopCode: 'REPLAN_REQUIRED' });

        // Its owner approves it again under the edited grant, which no longer covers plan steps.
        const parked = await initiatives.get({ userId: A, id: initiative.id });
        await initiatives.act({ userId: A, id: initiative.id, action: 'queue', expectedRevision: parked.revision });
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'WAITING', stopCode: 'OPERATION_OUT_OF_SCOPE' });
        expect(chat).not.toHaveBeenCalled();
        expect(await stepRow(stepId)).toMatchObject({ status: 'READY', authorizationKind: null });
        expect(await initiativeRow(initiative.id)).toMatchObject({ status: 'WAITING', waitReason: 'responsibility' });
    });

    test('pausing the grant while a step runs stops the run and gives the step back', async () => {
        const { pid, stepId } = await plan();
        const { grant } = await delegate({ pid });
        script(
            async () => {
                const current = await responsibilities.get({ userId: A, id: grant.id });
                await responsibilities.act({ userId: A, id: grant.id, action: 'pause', expectedRevision: current.revision });
                return [WRITE];
            },
            [REPORT()]
        );
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'CANCELLED', stopCode: 'LEASE_LOST' });
        expect(files.size).toBe(0);
        expect(await stepRow(stepId)).toMatchObject({ status: 'READY', executionAttemptId: null, agentRunId: null, authorizationKind: null });
        expect(await evidence()).toEqual([]);
        expect((await events()).map(e => e.kind)).toContain('step_released');
    });
});

describe('a collaborator', () => {
    test('their own responsibility runs as them, with them as the payer', async () => {
        const { pid, stepId } = await plan({ owner: A, members: [B] });
        const { initiative } = await delegate({ userId: B, pid });
        const seen = [];
        const chat = script(
            () => { seen.push(workContext.current()); return [WRITE]; },
            [REPORT({ criteria: ['c2'] })]
        );
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'COMPLETED' });

        const [run] = await runRows();
        expect(run).toMatchObject({ ownerUserId: B, actingUserId: B, payerUserId: B });
        // The model call is the collaborator's background work, paid by them.
        expect(chat.mock.calls[0][1]).toMatchObject({ background: true, usageContext: { userId: B, actorId: B } });
        expect(seen[0]).toMatchObject({ kind: 'assistant_run', id: String(run.id), actor: B, payer: B });
        // The file was written as the collaborator, in the owner's project.
        expect(projects.writeWorkspaceFile.mock.calls[0][0]).toMatchObject({ userId: B, slug: 'lab', owner: A });
        // The plan records who it ran for and under which grant.
        expect(await stepRow(stepId)).toMatchObject({ status: 'DONE', startedByUserId: B, authorizationKind: 'delegated', grantResponsibilityId: initiative.responsibilityId });
        expect((await evidence())[0]).toMatchObject({ userId: B, criterionId: 'c2' });
        expect((await events()).find(e => e.kind === 'step_done').userId).toBe(B);
        // The result is the collaborator's update; the project owner's feed is untouched.
        expect((await updates.list({ userId: B })).updates).toHaveLength(1);
        expect((await updates.list({ userId: A })).updates).toHaveLength(0);
    });

    test('erasing the collaborator removes their trace from the owner\'s plan and frees a step they held', async () => {
        const { pid, stepId, args } = await plan({
            owner: A, members: [B],
            steps: [
                { kind: 'agent', title: 'Write the comparison report', actionParams: { artifacts: ['docs/report.md'] } },
                { kind: 'agent', title: 'Write the recommendation', actionParams: { artifacts: ['docs/recommendation.md'] } }
            ]
        });
        const { grant } = await delegate({ userId: B, pid, queue: false, body: { rules: { autoStart: true } } });
        script([WRITE], [REPORT()]);
        expect((await runner.tick({ wait: true })).results[0]).toMatchObject({ status: 'COMPLETED' });
        // The second step is held by a run that is still open.
        const second = (await view(args)).steps[1];
        const next = await db.get("SELECT id FROM assistant_initiatives WHERE planStepId = @id", { id: second.id });
        const claimed = await initiatives.claim({ id: next.id });
        const runId = await db.insert(
            `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId, attempt)
             VALUES (@i, @r, @rev, @u, @u, @u, 1)`, { i: next.id, r: grant.id, rev: grant.revision, u: B }
        );
        expect(claimed.ok).toBe(true);
        expect(await missions.beginDelegatedStep({
            stepId: second.id, planRevision: 1, runId, actorUserId: B, responsibilityId: grant.id, grantRevision: grant.revision
        })).toMatchObject({ ok: true });

        await require('@goobster/core/services/privacyService').forgetUser({ userId: B });

        expect(await runRows()).toHaveLength(0);
        expect(await evidence()).toHaveLength(0);
        // The finished step stays done, with nothing pointing at the person, their run or their grant.
        expect(await stepRow(stepId)).toMatchObject({
            status: 'DONE', authorizationKind: 'delegated', startedByUserId: null, agentRunId: null,
            grantResponsibilityId: null, grantRevision: null, executionAttemptId: null
        });
        // The held step is ready for someone else.
        expect(await stepRow(second.id)).toMatchObject({
            status: 'READY', authorizationKind: null, startedByUserId: null, agentRunId: null, executionAttemptId: null
        });
        expect((await view(args)).steps.map(step => step.delegation?.actingUserId ?? null)).toEqual([null, null]);
    });

    test('someone who is not on the project cannot delegate its plan steps', async () => {
        const { pid } = await plan({ owner: A });
        await policies.enroll({ userId: C, initiative: 'assist' });
        await expect(responsibilities.create({ userId: C, body: { title: 'x', projectId: pid, operations: planOps(pid) } }))
            .rejects.toMatchObject({ code: 'INVALID_LINK' });
    });
});

describe('private knowledge and shared projects', () => {
    const NOTES = { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } };

    test('a plan-step run in a shared project is not offered the person\'s private knowledge, and its private report stays out of the project', async () => {
        const { pid, stepId } = await plan({ owner: A, members: [B] });
        await delegate({ pid, operations: [...planOps(pid), NOTES] });
        const chat = script(
            [call('lookupNotes', { query: 'budget' })],
            [WRITE],
            [REPORT({ summary: 'SECRET-SUMMARY drawn from my reading.' })]
        );
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'COMPLETED' });
        expect(lookup).not.toHaveBeenCalled();
        expect((await operations())[0]).toMatchObject({ tool: 'lookupNotes', status: 'REFUSED', refusalCode: 'UNKNOWN_TOOL' });
        expect(JSON.stringify(chat.mock.calls[0][1])).not.toContain('lookupNotes');
        // What the project's people can read holds file names and codes, not the run's report.
        const shared = JSON.stringify([await evidence(), await events(), await stepRow(stepId)]);
        expect(shared).not.toContain('SECRET-SUMMARY');
        expect(shared).not.toContain('Wrote the comparison');
        // The report went to the person only.
        expect((await updates.list({ userId: A })).updates[0].summary).toContain('SECRET-SUMMARY');
        expect((await updates.list({ userId: B })).updates).toHaveLength(0);
    });

    test('a run that read private knowledge cannot write into a project other people read', async () => {
        const pid = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'lab', 'Lab')", { u: A });
        await db.run('INSERT INTO project_members (projectId, userId, userName, invitedBy) VALUES (@pid, @u, @u, @a)', { pid, u: B, a: A });
        await policies.enroll({ userId: A, initiative: 'assist' });
        const item = await db.insert(
            "INSERT INTO attention_items (guildId, userId, kind, subject, goal, state) VALUES (@g, @u, 'goal', 'charts', 'Pick a library', 'active')",
            { g: `dm:${A}`, u: A }
        );
        const { responsibility } = await responsibilities.create({
            userId: A, body: { title: 'Keep the library choice moving', projectId: pid, attentionItemId: item, operations: [...planOps(pid).slice(0, 2), NOTES] }
        });
        const grant = (await responsibilities.act({ userId: A, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
        await initiatives.reconcileResponsibility(grant.id);
        await db.run("UPDATE attention_items SET goal = 'Pick a library this week' WHERE id = @id", { id: item });
        const [id] = (await initiatives.reconcileResponsibility(grant.id)).proposed;
        const row = await initiatives.get({ userId: A, id });
        await initiatives.act({ userId: A, id, action: 'queue', expectedRevision: row.revision });

        script(
            [call('lookupNotes', { query: 'budget' })],
            [call('writeProjectFile', { path: 'docs/notes.md', content: 'PRIVATE: the budget ceiling is 40k' })],
            [call('finish', { outcome: 'finding', title: 'Budget noted' })]
        );
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'COMPLETED' });
        expect(lookup).toHaveBeenCalledTimes(1);
        expect((await operations())[1]).toMatchObject({ tool: 'writeProjectFile', status: 'REFUSED', refusalCode: 'PRIVATE_CONTEXT' });
        expect(projects.writeWorkspaceFile).not.toHaveBeenCalled();
        expect(files.size).toBe(0);
    });

    test('the same write is allowed in a project only the person reads, and refused again once a share link exists', async () => {
        const { pid, stepId } = await plan({ owner: A });
        expect(await transfers.privateContextAllowed({ userId: A, project: { id: pid, ownerId: A } })).toBe(true);
        await delegate({ pid, operations: [...planOps(pid), NOTES] });
        script([call('lookupNotes', { query: 'budget' })], [WRITE], [REPORT()]);
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'COMPLETED' });
        expect(lookup).toHaveBeenCalledTimes(1);
        expect((await stepRow(stepId)).status).toBe('DONE');

        expect(await transfers.privateContextAllowed({ userId: B, project: { id: pid, ownerId: A } })).toBe(false);
        await db.run('INSERT INTO project_members (projectId, userId, userName, invitedBy) VALUES (@pid, @u, @u, @a)', { pid, u: B, a: A });
        expect(await transfers.privateContextAllowed({ userId: A, project: { id: pid, ownerId: A } })).toBe(false);
    });
});

describe('lost membership', () => {
    test('queued work does not dispatch, read or publish', async () => {
        const { pid, stepId } = await plan({ owner: A, members: [B] });
        const { initiative, grant } = await delegate({ userId: B, pid });
        await db.run('DELETE FROM project_members WHERE userId = @u', { u: B });
        const chat = script([WRITE], [REPORT()]);
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'WAITING', stopCode: 'RESOURCE_UNAVAILABLE' });
        expect(chat).not.toHaveBeenCalled();
        expect(projects.readWorkspaceFile).not.toHaveBeenCalled();
        expect(await initiativeRow(initiative.id)).toMatchObject({ status: 'WAITING', waitReason: 'access' });
        expect(await stepRow(stepId)).toMatchObject({ status: 'READY', authorizationKind: null, startedByUserId: null });
        expect(await evidence()).toEqual([]);
        // Nothing more is derived from a project they can no longer reach.
        await db.run('DELETE FROM assistant_initiatives', {});
        await db.run('DELETE FROM assistant_source_cursors', {});
        expect((await initiatives.reconcileResponsibility(grant.id)).proposed).toEqual([]);
        // The mission service refuses on its own check too.
        expect(await missions.beginDelegatedStep({ stepId, planRevision: 1, runId: 999, actorUserId: B }))
            .toEqual({ ok: false, code: 'RESOURCE_UNAVAILABLE' });
    });

    test('running work stops at its next project call: nothing more is read or written, and the step goes back', async () => {
        const { pid, stepId } = await plan({ owner: A, members: [B] });
        const { initiative } = await delegate({ userId: B, pid });
        script(
            async () => {
                await db.run('DELETE FROM project_members WHERE userId = @u', { u: B });
                return [call('readProjectFile', { path: 'docs/existing.md' }), WRITE];
            },
            [REPORT()]
        );
        files.set('docs/existing.md', 'members only');
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'WAITING', stopCode: 'RESOURCE_UNAVAILABLE' });
        expect(projects.readWorkspaceFile).not.toHaveBeenCalled();
        expect(projects.writeWorkspaceFile).not.toHaveBeenCalled();
        expect((await operations())[0]).toMatchObject({ tool: 'readProjectFile', status: 'REFUSED', refusalCode: 'RESOURCE_UNAVAILABLE' });
        expect(await initiativeRow(initiative.id)).toMatchObject({ status: 'WAITING', waitReason: 'access' });
        expect(await stepRow(stepId)).toMatchObject({ status: 'READY', executionAttemptId: null, startedByUserId: null, agentRunId: null });
        expect(await evidence()).toEqual([]);
        expect((await updates.list({ userId: B })).updates).toHaveLength(0);
        // The release is recorded for the project without naming the person who left.
        const released = (await events()).find(e => e.kind === 'step_released');
        expect(released).toMatchObject({ userId: A, payload: { stepId, reason: 'RESOURCE_UNAVAILABLE' } });
    });

    test('membership lost after the work, before the result is recorded: no evidence is published', async () => {
        const { pid, stepId } = await plan({ owner: A, members: [B] });
        await delegate({ userId: B, pid });
        script(
            [WRITE],
            async () => {
                await db.run('DELETE FROM project_members WHERE userId = @u', { u: B });
                return [REPORT()];
            }
        );
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'WAITING', stopCode: 'RESOURCE_UNAVAILABLE' });
        expect(await stepRow(stepId)).toMatchObject({ status: 'READY' });
        expect(await evidence()).toEqual([]);
        // The settle path holds on its own as well: the project lock refuses a non-member.
        const [run] = await runRows();
        await db.run("UPDATE project_mission_steps SET status = 'RUNNING', executionAttemptId = @a WHERE id = @id", { a: `assistant_run:${run.id}`, id: stepId });
        expect(await missions.settleDelegatedStep({ stepId, runId: run.id, actorUserId: B, ok: true, evidence: { artifacts: [] } }))
            .toEqual({ ok: false, code: 'RESOURCE_UNAVAILABLE' });
        expect(await evidence()).toEqual([]);
    });
});

describe('verification', () => {
    async function blocked(rounds, { steps = null } = {}) {
        const made = await plan({ steps });
        const { initiative } = await delegate({ pid: made.pid });
        script(...rounds);
        const result = await runner.tick({ wait: true });
        return { ...made, initiative, result: result.results[0] };
    }

    async function expectBlocker({ args, stepId, initiative, result }, code, detail = null) {
        expect(result).toMatchObject({ status: 'FAILED', stopCode: code });
        expect(await stepRow(stepId)).toMatchObject({ status: 'FAILED', authorizationKind: 'delegated' });
        const mission = await view(args);
        // A blocker for the people on the project; the objective is not completed and nothing was linked.
        expect(mission.status).toBe('BLOCKED');
        expect(mission.completedAt).toBeNull();
        expect(mission.evidence).toEqual([]);
        expect(mission.timeline.filter(e => e.kind === 'step_failed')).toEqual([
            expect.objectContaining({ payload: expect.objectContaining({ stepId, reason: code, authorization: 'delegated' }) })
        ]);
        expect(mission.timeline.map(e => e.kind)).toContain('blocked');
        expect(await initiativeRow(initiative.id)).toMatchObject({ status: 'FAILED', stopCode: code });
        const [update] = (await updates.list({ userId: A })).updates;
        expect(update.title).toBe('Plan step blocked: Write the comparison report');
        expect(update.summary).toMatch(/marked failed and the plan is blocked/);
        // The ledger holds the code only.
        const failures = await db.all("SELECT kind, phase, code, reason FROM work_failures WHERE phase = 'verify'", {});
        expect(failures).toEqual([expect.objectContaining({ kind: 'assistant_run', code: detail || code })]);
        expect(failures[0].reason || '').not.toMatch(/comparison|report/i);
    }

    test('a file the run says it wrote but did not is a blocker, and the objective is not completed', async () => {
        const made = await blocked([[REPORT()]]);
        await expectBlocker(made, 'VERIFICATION_FAILED', 'ARTIFACT_NOT_WRITTEN');
    });

    test('a file that exists but was not written by this run is not its result', async () => {
        const made = await blocked([() => { files.set('docs/report.md', 'someone else wrote this'); return [REPORT()]; }]);
        await expectBlocker(made, 'VERIFICATION_FAILED', 'ARTIFACT_NOT_WRITTEN');
    });

    test('a file the step requires must be among the written ones, whatever the run reports', async () => {
        const made = await blocked(
            [[call('writeProjectFile', { path: 'docs/other.md', content: 'something else' })], [REPORT({ artifacts: ['docs/other.md'] })]]
        );
        await expectBlocker(made, 'VERIFICATION_FAILED', 'ARTIFACT_NOT_WRITTEN');
    });

    test('an empty file does not pass', async () => {
        const empty = await blocked([[call('writeProjectFile', { path: 'docs/report.md', content: '' })], [REPORT()]]);
        await expectBlocker(empty, 'VERIFICATION_FAILED', 'ARTIFACT_EMPTY');
    });

    test('a file removed before the result is recorded does not pass', async () => {
        const gone = await blocked([[WRITE], () => { files.delete('docs/report.md'); return [REPORT()]; }]);
        await expectBlocker(gone, 'VERIFICATION_FAILED', 'ARTIFACT_MISSING');
    });

    test('a step with no required file still needs one verified file', async () => {
        const made = await blocked([[REPORT({ artifacts: [] })]], { steps: [{ kind: 'agent', title: 'Write the comparison report' }] });
        await expectBlocker(made, 'VERIFICATION_FAILED', 'NO_ARTIFACT');
    });

    test('a run that reports it is blocked blocks the plan', async () => {
        const said = await blocked([[call('reportStepResult', { outcome: 'blocked', title: 'The docs for Y are offline' })]]);
        await expectBlocker(said, 'STEP_BLOCKED');
    });

    test('a run that ends without a report blocks the plan', async () => {
        const silent = await blocked([[WRITE], 'All done, I think.']);
        await expectBlocker(silent, 'NO_STEP_REPORT');
        // The file it wrote is still named to the person.
        expect((await updates.list({ userId: A })).updates[0].summary).toContain('Wrote docs/report.md.');
    });

    test('after a person retries the failed step it is proposed again, once, and can pass', async () => {
        const made = await blocked([[REPORT()]]);
        expect((await initiatives.reconcileResponsibility(made.initiative.responsibilityId)).proposed).toEqual([]);
        await missions.retryStep({ ...made.args, stepId: made.stepId });
        expect(await stepRow(made.stepId)).toMatchObject({ status: 'READY', retryCount: 1, agentRunId: null, authorizationKind: null, grantRevision: null });
        expect((await missionRow()).status).toBe('ACTIVE');
        const [again] = (await initiatives.reconcileResponsibility(made.initiative.responsibilityId)).proposed;
        expect(await initiativeRow(again)).toMatchObject({ sourceRevision: '1:1', status: 'CANDIDATE', planStepId: made.stepId });
        const row = await initiatives.get({ userId: A, id: again });
        await initiatives.act({ userId: A, id: again, action: 'queue', expectedRevision: row.revision });
        script([WRITE], [REPORT()]);
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'COMPLETED' });
        expect((await stepRow(made.stepId)).status).toBe('DONE');
        expect(await evidence()).toHaveLength(1);
    });

    test('a provider failure is not a failed step: the step goes back and the attempt can be retried', async () => {
        const { pid, stepId } = await plan();
        const { initiative } = await delegate({ pid });
        script(new Error('upstream exploded'));
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'FAILED', stopCode: 'PROVIDER_ERROR' });
        expect(await stepRow(stepId)).toMatchObject({ status: 'READY', agentRunId: null });
        expect((await missionRow()).status).toBe('ACTIVE');
        const retried = (await initiatives.act({ userId: A, id: initiative.id, action: 'retry' })).initiative;
        expect(retried).toMatchObject({ status: 'QUEUED', planStep: { id: stepId, planRevision: 1 } });
        script([WRITE], [REPORT()]);
        expect((await runner.tick({ wait: true })).results[0]).toMatchObject({ status: 'COMPLETED' });
        expect((await stepRow(stepId)).status).toBe('DONE');
    });
});

describe('confirmation receipts', () => {
    test('a delegated run mints, consumes and reuses none, and cannot approve, start or complete the plan', async () => {
        const { pid, args, stepId } = await plan();
        const before = await db.all('SELECT * FROM project_mission_approval_receipts ORDER BY id', {});
        // The one receipt is the person's own approval, already consumed.
        expect(before).toHaveLength(1);
        expect(before[0]).toMatchObject({ userId: A, origin: 'portal', kind: 'approve' });
        expect(before[0].consumedAt).toBeTruthy();

        await delegate({ pid });
        script([WRITE], [REPORT({ criteria: ['c1', 'c2'] })]);
        await runner.tick({ wait: true });
        expect((await stepRow(stepId)).status).toBe('DONE');

        expect(await db.all('SELECT * FROM project_mission_approval_receipts ORDER BY id', {})).toEqual(before);
        const mission = await missionRow();
        expect(mission).toMatchObject({ status: 'REVIEW', approvedBy: A, approvedRevision: 1, completedAt: null });
        const kinds = (await events()).map(e => e.kind);
        expect(kinds.filter(kind => kind === 'approved')).toHaveLength(1);
        expect(kinds.filter(kind => kind === 'started')).toHaveLength(1);
        expect(kinds).not.toContain('completed');
        // The delegation record is on the step and the timeline, not in the receipts table.
        expect(await stepRow(stepId)).toMatchObject({ authorizationKind: 'delegated' });

        // Completing still needs a person's receipt; the consumed approval receipt does not work again.
        await expect(missions.complete(args)).rejects.toMatchObject({ code: 'HUMAN_ONLY' });
        await expect(missions.complete({ ...args, receiptId: before[0].id, nonce: before[0].nonce })).rejects.toMatchObject({ code: 'HUMAN_ONLY' });
        await expect(missions.mintApprovalReceipt({ ...args, origin: 'assistant', kind: 'complete' })).rejects.toMatchObject({ code: 'HUMAN_ONLY' });
        expect((await missionRow()).status).toBe('REVIEW');
    });

    test('a person cannot hand-link agent_run evidence, and nobody starts an agent step from a human surface', async () => {
        const { args, stepId } = await plan();
        await expect(missions.addEvidence({ ...args, kind: 'agent_run', refId: 1 })).rejects.toMatchObject({ code: 'BAD_EVIDENCE' });
        await expect(missions.startStep({ ...args, stepId })).rejects.toMatchObject({ code: 'AGENT_STEP_DELEGATED', status: 409 });
        expect(await stepRow(stepId)).toMatchObject({ status: 'READY', executionAttemptId: null });
    });
});

describe('the mission service on its own', () => {
    async function runFor(initiative) {
        const claimed = await initiatives.claim({ id: initiative.id });
        const runId = await db.insert(
            `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId)
             VALUES (@i, @r, @rev, @u, @u, @u)`,
            { i: initiative.id, r: initiative.responsibilityId, rev: initiative.responsibilityRevision, u: initiative.ownerUserId }
        );
        return { runId, claimed };
    }

    test('agent step parameters are legalized, and the plan budget caps agent runs', async () => {
        expect(missions.legalizeAgentActionParams({ instructions: ' compare ', artifacts: './docs/a.md, docs/a.md\nout/b.csv', other: 1 }))
            .toEqual({ instructions: 'compare', artifacts: ['docs/a.md', 'out/b.csv'] });
        for (const bad of ['/etc/passwd', '../up.md', 'docs/', 'a\\b']) {
            expect(() => missions.legalizeAgentActionParams({ artifacts: [bad] })).toThrow(/workspace-relative/);
        }
        const { stepId, mission } = await plan({
            budget: { maxAgentRuns: 1 },
            steps: [{ kind: 'agent', title: 'First' }, { kind: 'agent', title: 'Second' }]
        });
        expect(mission.budget.maxAgentRuns).toBe(1);
        const second = mission.steps[1].id;
        expect(await missions.beginDelegatedStep({ stepId, planRevision: 1, runId: 1, actorUserId: A })).toMatchObject({ ok: true });
        expect(await missions.beginDelegatedStep({ stepId: second, planRevision: 1, runId: 2, actorUserId: A })).toEqual({ ok: false, code: 'PLAN_BUDGET' });
        // The same run asking again resumes; another run is refused.
        expect(await missions.beginDelegatedStep({ stepId, planRevision: 1, runId: 1, actorUserId: A })).toMatchObject({ ok: true, resumed: true });
        expect(await missions.beginDelegatedStep({ stepId, planRevision: 1, runId: 3, actorUserId: A })).toEqual({ ok: false, code: 'STEP_NOT_ELIGIBLE' });
        // Only the holder settles it.
        expect(await missions.settleDelegatedStep({ stepId, runId: 3, actorUserId: A, ok: true })).toEqual({ ok: false, code: 'STEP_NOT_HELD' });
        expect(await missions.releaseDelegatedStep({ stepId, runId: 3 })).toBe(false);
        expect(await missions.releaseDelegatedStep({ stepId, runId: 1, code: 'TEST' })).toBe(true);
        expect((await stepRow(stepId)).status).toBe('READY');
    });

    test('a person who does the step themselves stops the run that held it', async () => {
        const { pid, args, stepId } = await plan();
        const { initiative } = await delegate({ pid });
        const { runId } = await runFor(initiative);
        expect(await missions.beginDelegatedStep({ stepId, planRevision: 1, runId, actorUserId: A, responsibilityId: initiative.responsibilityId, grantRevision: 1 }))
            .toMatchObject({ ok: true });
        expect(await stepRow(stepId)).toMatchObject({ status: 'RUNNING', agentRunId: runId });
        await missions.completeStep({ ...args, stepId, note: 'did it by hand' });
        expect((await stepRow(stepId)).status).toBe('DONE');
        expect(await initiativeRow(initiative.id)).toMatchObject({ status: 'CANCELLED', stopCode: 'PLAN_STEP_CLOSED', leaseToken: null });
        // The run's late result is refused: it no longer holds the step.
        expect(await missions.settleDelegatedStep({ stepId, runId, actorUserId: A, ok: false, code: 'X' })).toEqual({ ok: false, code: 'STEP_NOT_HELD' });
        expect(await evidence()).toEqual([]);
    });

    test('the reconcile backstop gives back a step whose attempt stopped, and keeps one that will continue', async () => {
        const { pid, stepId } = await plan();
        const { initiative } = await delegate({ pid });
        const { runId } = await runFor(initiative);
        await missions.beginDelegatedStep({ stepId, planRevision: 1, runId, actorUserId: A });
        // Still running: held.
        expect(await missions.reconcileRunningSteps()).toBe(0);
        // Waiting for a budget window: held.
        await db.run("UPDATE assistant_initiatives SET status = 'WAITING', waitReason = 'budget' WHERE id = @id", { id: initiative.id });
        expect(await missions.reconcileRunningSteps()).toBe(0);
        expect((await stepRow(stepId)).status).toBe('RUNNING');
        // Cancelled by its owner: the step goes back.
        await db.run("UPDATE assistant_initiatives SET status = 'CANCELLED' WHERE id = @id", { id: initiative.id });
        expect(await missions.reconcileRunningSteps()).toBe(1);
        expect(await stepRow(stepId)).toMatchObject({ status: 'READY', agentRunId: null, executionAttemptId: null });

        // A failed attempt that never closed its step is a blocker.
        await db.run("UPDATE assistant_initiatives SET status = 'RUNNING' WHERE id = @id", { id: initiative.id });
        await missions.beginDelegatedStep({ stepId, planRevision: 1, runId, actorUserId: A });
        await db.run("UPDATE assistant_initiatives SET status = 'FAILED', stopCode = 'PROVIDER_ERROR' WHERE id = @id", { id: initiative.id });
        expect(await missions.reconcileRunningSteps()).toBe(1);
        expect((await stepRow(stepId)).status).toBe('FAILED');
        expect((await missionRow()).status).toBe('BLOCKED');
    });

    test('a crash between claim and link is repaired from the attempt id', async () => {
        const { pid, stepId, mission } = await plan({ steps: [{ kind: 'agent', title: 'First' }, { kind: 'agent', title: 'Second' }] });
        const { initiative } = await delegate({ pid });
        const { runId } = await runFor(initiative);
        const old = '2020-01-01 00:00:00';
        await db.run(
            "UPDATE project_mission_steps SET status = 'STARTING', executionAttemptId = @a, startedAt = @old WHERE id = @id",
            { a: `assistant_run:${runId}`, old, id: stepId }
        );
        await db.run(
            "UPDATE project_mission_steps SET status = 'STARTING', executionAttemptId = 'assistant_run:987654', startedAt = @old WHERE id = @id",
            { old, id: mission.steps[1].id }
        );
        expect(await missions.reconcileStartingSteps()).toBe(2);
        // The run exists: adopted. No such run: the claim fails and blocks the plan.
        expect(await stepRow(stepId)).toMatchObject({ status: 'RUNNING', agentRunId: runId });
        expect((await stepRow(mission.steps[1].id)).status).toBe('FAILED');
    });
});
