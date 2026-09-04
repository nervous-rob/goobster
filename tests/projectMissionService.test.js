/**
 * Project Missions (services/projectMissionService.js).
 *
 * State machine, one-open-per-project, approval before execution,
 * evidence vs criteria, append-only timeline, job/expedition settle hooks,
 * attention only for BLOCKED/REVIEW, and /forget-me.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-missions-${process.pid}.sqlite`);

jest.mock('@goobster/core/services/aiService', () => ({
    generateText: jest.fn()
}));
jest.mock('@goobster/core/utils/chatHandler', () => ({
    handleChatInteraction: jest.fn()
}));

const db = require('@goobster/core/db');
const {
    ProjectMissionService,
    ProjectMissionError
} = require('@goobster/core/services/projectMissionService');
const attention = require('@goobster/core/services/attentionService');
const policies = require('@goobster/core/services/attentionPolicyService');
const privacyService = require('@goobster/core/services/privacyService');
const aiService = require('@goobster/core/services/aiService');
const domainEventBus = require('@goobster/core/services/domainEventBus');

let userSeq = 0;
function nextUser() {
    return `mission-user-${process.pid}-${userSeq++}`;
}

function makeService(overrides = {}) {
    return new ProjectMissionService(overrides);
}

async function seedProject(userId, slug = 'lab', name = 'Lab') {
    await db.run(
        `INSERT INTO observatory_projects (userId, slug, name)
         VALUES (@userId, @slug, @name)`,
        { userId, slug, name }
    );
    return { slug, name };
}

async function expectThrow(fn, expected) {
    let caught = null;
    try { await fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(ProjectMissionError);
    expect(caught).toMatchObject(expected);
    return caught;
}

async function approveAsHuman(svc, args) {
    const receipt = await svc.mintApprovalReceipt({ ...args, origin: 'portal' });
    return svc.approve({ ...args, receiptId: receipt.id, nonce: receipt.nonce });
}

async function completeAsHuman(svc, args) {
    const receipt = await svc.mintApprovalReceipt({ ...args, origin: 'portal', kind: 'complete' });
    return svc.complete({ ...args, receiptId: receipt.id, nonce: receipt.nonce });
}

function draftArgs(userId, extra = {}) {
    return {
        userId,
        project: 'lab',
        title: 'pgvector at one million notes',
        objective: 'Determine whether pgvector recall remains useful above one million notes.',
        successCriteria: [
            'A reproducible benchmark artifact exists',
            'A written keep / shard / replace recommendation'
        ],
        deadline: '2026-09-12',
        ...extra
    };
}

afterAll(async () => {
    await db.closeConnection();
    try { fs.rmSync(process.env.GOOBSTER_DB_PATH, { force: true }); } catch { /* held open */ }
    for (const suffix of ['-shm', '-wal']) {
        try { fs.rmSync(process.env.GOOBSTER_DB_PATH + suffix, { force: true }); } catch { /* gone */ }
    }
});

describe('draft + one-open rule', () => {
    test('creates a draft with criteria, deadline, and a timeline event', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        const mission = await svc.create(draftArgs(USER));
        expect(mission.status).toBe('DRAFT');
        expect(mission.successCriteria).toHaveLength(2);
        expect(mission.successCriteria[0].id).toBe('c1');
        expect(mission.deadline).toBe('2026-09-12 23:59:59');
        expect(mission.timeline[0].kind).toBe('created');
        expect(mission.evaluation.overall).toBe('unassessed');
    });

    test('refuses a second open mission on the same project', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER));
        await expectThrow(() => svc.create(draftArgs(USER, { title: 'Another' })), {
            status: 409, code: 'MISSION_OPEN'
        });
    });

    test('refuses a draft without measurable criteria', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await expectThrow(() => svc.create(draftArgs(USER, { successCriteria: 'x' })), {
            status: 400, code: 'BAD_CRITERIA'
        });
    });
});

describe('state machine', () => {
    test('DRAFT → APPROVED → ACTIVE → REVIEW → COMPLETED writes a decision', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'human', title: 'Write the recommendation' }]
        }));
        const approved = await approveAsHuman(svc, { userId: USER, project: 'lab' });
        expect(approved.status).toBe('APPROVED');
        expect(approved.approvedBy).toBe(USER);

        const started = await svc.start({ userId: USER, project: 'lab' });
        expect(started.status).toBe('ACTIVE');
        expect(started.steps[0].status).toBe('READY');

        const done = await svc.completeStep({
            userId: USER, project: 'lab', stepId: started.steps[0].id
        });
        expect(done.status).toBe('REVIEW');
        expect(done.timeline.some(e => e.kind === 'review')).toBe(true);

        const finished = await completeAsHuman(svc, {
            userId: USER, project: 'lab', verdict: 'met', notes: 'Benchmark and rec are in the workspace.'
        });
        expect(finished.status).toBe('COMPLETED');
        expect(finished.review.verdict).toBe('met');
        const decision = await db.get(
            'SELECT * FROM project_decisions WHERE missionId = @id', { id: finished.id }
        );
        expect(decision).toBeTruthy();
        expect(decision.question).toContain('pgvector');
    });

    test('cannot start without approval', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER));
        await expectThrow(() => svc.start({ userId: USER, project: 'lab' }), {
            status: 409, code: 'BAD_STATUS'
        });
    });

    test('cancel frees the slot for a new draft', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER));
        const cancelled = await svc.cancel({ userId: USER, project: 'lab' });
        expect(cancelled.status).toBe('CANCELLED');
        const next = await svc.create(draftArgs(USER, { title: 'Second try' }));
        expect(next.status).toBe('DRAFT');
        expect(next.title).toBe('Second try');
    });

    test('a failed linked job blocks the mission', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'job', title: 'Run the benchmark' }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        await svc.start({ userId: USER, project: 'lab' });
        const open = await svc.get({ userId: USER, project: 'lab' });
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId', { userId: USER }
        );
        const jobId = await db.insert(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status)
             VALUES (@projectId, @userId, 'python', 'print(1)', 'RUNNING')`,
            { projectId: project.id, userId: USER }
        );
        await svc.linkStep({
            userId: USER, project: 'lab', stepId: open.steps[0].id, jobId
        });
        await db.run(
            `UPDATE project_mission_steps SET status = 'RUNNING' WHERE id = @id`,
            { id: open.steps[0].id }
        );
        const hooked = await svc.onJobSettled({ jobId, status: 'FAILED' });
        expect(hooked).toBe(true);
        const blocked = await svc.get({ userId: USER, project: 'lab' });
        expect(blocked.status).toBe('BLOCKED');
        expect(blocked.steps[0].status).toBe('FAILED');
        expect(blocked.timeline.some(e => e.kind === 'blocked')).toBe(true);

        await expectThrow(() => svc.resume({ userId: USER, project: 'lab' }), {
            status: 409, code: 'FAILED_STEPS'
        });
    });

    test('failure blocks the mission; skip resolves it and readies dependents for review', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        const created = await svc.create(draftArgs(USER, {
            steps: [{ kind: 'job', title: 'Run the benchmark' }]
        }));
        await svc.addStep({
            userId: USER, project: 'lab', kind: 'human', title: 'Write the rec',
            dependsOn: [created.steps[0].id]
        });
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        await svc.start({ userId: USER, project: 'lab' });
        const open = await svc.get({ userId: USER, project: 'lab' });
        const jobStep = open.steps.find(s => s.kind === 'job');
        const writeup = open.steps.find(s => s.kind === 'human');
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId', { userId: USER }
        );
        const jobId = await db.insert(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status)
             VALUES (@projectId, @userId, 'python', 'print(1)', 'RUNNING')`,
            { projectId: project.id, userId: USER }
        );
        await svc.linkStep({ userId: USER, project: 'lab', stepId: jobStep.id, jobId });
        await db.run(
            `UPDATE project_mission_steps SET status = 'RUNNING' WHERE id = @id`,
            { id: jobStep.id }
        );
        await svc.onJobSettled({ jobId, status: 'FAILED' });
        const blocked = await svc.get({ userId: USER, project: 'lab' });
        expect(blocked.status).toBe('BLOCKED');
        expect(blocked.steps.find(s => s.id === jobStep.id).status).toBe('FAILED');
        expect(blocked.steps.find(s => s.id === writeup.id).status).toBe('PENDING');
        await expectThrow(() => svc.resume({ userId: USER, project: 'lab' }), {
            status: 409, code: 'FAILED_STEPS'
        });

        const skipped = await svc.skipStep({
            userId: USER, project: 'lab', stepId: jobStep.id, reason: 'accept the failure'
        });
        expect(skipped.steps.find(s => s.id === jobStep.id).status).toBe('SKIPPED');
        expect(skipped.steps.find(s => s.id === writeup.id).status).toBe('READY');
        expect(skipped.status).toBe('ACTIVE');

        const reviewed = await svc.completeStep({
            userId: USER, project: 'lab', stepId: writeup.id
        });
        expect(reviewed.status).toBe('REVIEW');
    });

    test('retrying a failed step returns it to READY and unblocks the mission', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'job', title: 'Run the benchmark' }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        await svc.start({ userId: USER, project: 'lab' });
        const open = await svc.get({ userId: USER, project: 'lab' });
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId', { userId: USER }
        );
        const jobId = await db.insert(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status)
             VALUES (@projectId, @userId, 'python', 'print(1)', 'RUNNING')`,
            { projectId: project.id, userId: USER }
        );
        await svc.linkStep({
            userId: USER, project: 'lab', stepId: open.steps[0].id, jobId
        });
        await db.run(
            `UPDATE project_mission_steps SET status = 'RUNNING' WHERE id = @id`,
            { id: open.steps[0].id }
        );
        await svc.onJobSettled({ jobId, status: 'FAILED' });
        const retried = await svc.retryStep({
            userId: USER, project: 'lab', stepId: open.steps[0].id
        });
        expect(retried.status).toBe('ACTIVE');
        expect(retried.steps[0].status).toBe('READY');
        expect(retried.steps[0].jobId).toBeNull();
        expect(retried.timeline.some(e => e.kind === 'step_retried')).toBe(true);
    });

    test('a completed expedition step advances to review when it is the last step', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'expedition', title: 'Survey recall literature' }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        await svc.start({ userId: USER, project: 'lab' });
        const open = await svc.get({ userId: USER, project: 'lab' });
        const expeditionId = await db.insert(
            `INSERT INTO spitball_expeditions
                (userId, guildId, scopeKey, seed, depth, status)
             VALUES (@userId, @guildId, @scopeKey, 'recall', 'focused', 'RUNNING')`,
            { userId: USER, guildId: `dm:${USER}`, scopeKey: `USER:${USER}` }
        );
        await svc.linkStep({
            userId: USER, project: 'lab', stepId: open.steps[0].id, expeditionId
        });
        await db.run(
            `UPDATE project_mission_steps SET status = 'RUNNING' WHERE id = @id`,
            { id: open.steps[0].id }
        );
        await svc.onExpeditionSettled({ expeditionId, status: 'COMPLETED' });
        const reviewed = await svc.get({ userId: USER, project: 'lab' });
        expect(reviewed.status).toBe('REVIEW');
        expect(reviewed.steps[0].status).toBe('DONE');
    });
});

describe('evidence and evaluation', () => {
    test('linking supporting notes flips a criterion to met', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER));
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId', { userId: USER }
        );
        const noteId = await db.insert(
            `INSERT INTO kg_nodes (guildId, scopeKey, type, label, content)
             VALUES (@guildId, @scopeKey, 'fact', 'Benchmark', 'Recall@10 holds at 1e6')`,
            { guildId: `dm:${USER}`, scopeKey: `PROJECT:${project.id}` }
        );
        const updated = await svc.addEvidence({
            userId: USER,
            project: 'lab',
            kind: 'note',
            refId: noteId,
            criterionId: 'c1',
            polarity: 'for',
            label: 'Recall@10 holds'
        });
        expect(updated.evaluation.criteria[0].assessment).toBe('supported');
        expect(updated.evaluation.supported).toBe(1);
        expect(updated.timeline.some(e => e.kind === 'evidence_added')).toBe(true);
    });

    test('refuses evidence that is not on the project', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER));
        await expectThrow(() => svc.addEvidence({
            userId: USER, project: 'lab', kind: 'note', refId: 99999, criterionId: 'c1'
        }), { status: 404, code: 'NO_NOTE' });
    });
});

describe('attention notices', () => {
    test('the generator is registered and only BLOCKED/REVIEW are news', async () => {
        expect(attention.listGenerators().some(g => g.name === 'project_mission')).toBe(true);
        expect(domainEventBus.TOPICS.MISSION_BLOCKED).toBe('mission.blocked');
        const { WATCHABLE_TOPICS } = require('@goobster/core/services/attentionWatchService');
        expect(WATCHABLE_TOPICS).toEqual(expect.arrayContaining([
            'mission.blocked', 'mission.review', 'mission.*'
        ]));

        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'human', title: 'Sign off' }]
        }));
        await policies.setInitiative(USER, 'observe');
        aiService.generateText.mockImplementation(async (prompt) => {
            const keys = [...prompt.matchAll(/\[key: ([^\]]+)\]/g)].map(m => m[1]);
            return JSON.stringify({
                keep: keys.map(key => ({ key, adjust: 0, reason: 'worth it' })),
                drop: [],
                message: 'Mission news.'
            });
        });

        let summary = await attention.sweepUser({
            policy: await policies.get(USER),
            gateway: { isGoobsterGateway: true, sendDm: async () => ({ ok: true }) }
        });
        expect(summary.notices.some(n => String(n.key).startsWith('mission:'))).toBe(false);

        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        const started = await svc.start({ userId: USER, project: 'lab' });
        await svc.completeStep({ userId: USER, project: 'lab', stepId: started.steps[0].id });
        const reviewed = await svc.get({ userId: USER, project: 'lab' });
        expect(reviewed.status).toBe('REVIEW');

        summary = await attention.sweepUser({
            policy: await policies.get(USER),
            gateway: { isGoobsterGateway: true, sendDm: async () => ({ ok: true }) }
        });
        const notice = summary.notices.find(n => n.key === `mission:${reviewed.id}:REVIEW`);
        expect(notice).toBeTruthy();
        expect(notice.title).toContain('ready for review');
        expect(notice.category).toBe('observatory');
    });
});

describe('privacy', () => {
    test('forgetUser deletes missions and decisions; audit counts them', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'human', title: 'Sign off' }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        const started = await svc.start({ userId: USER, project: 'lab' });
        await svc.completeStep({ userId: USER, project: 'lab', stepId: started.steps[0].id });
        await completeAsHuman(svc, { userId: USER, project: 'lab', verdict: 'met' });

        const counts = await svc.forgetUser(USER);
        expect(counts.missions).toBe(1);
        expect(counts.decisions).toBe(1);
        const audit = await privacyService.auditUser({ userId: USER });
        expect(audit.byTable.project_missions).toBe(0);
        expect(audit.byTable.project_decisions).toBe(0);
    });
});

describe('human-only approval', () => {
    test('approve without a receipt is refused', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER));
        await expectThrow(() => svc.approve({ userId: USER, project: 'lab' }), {
            status: 403, code: 'HUMAN_ONLY'
        });
        const open = await svc.get({ userId: USER, project: 'lab' });
        expect(open.status).toBe('DRAFT');
        expect(open.approvedAt).toBeNull();
    });

    test('a receipt minted for the agent origin is refused', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER));
        await expectThrow(() => svc.mintApprovalReceipt({
            userId: USER, project: 'lab', origin: 'agent'
        }), { status: 403, code: 'HUMAN_ONLY' });
    });

    test('a stale receipt does not approve a mutated plan', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER));
        const receipt = await svc.mintApprovalReceipt({
            userId: USER, project: 'lab', origin: 'portal'
        });
        await svc.addStep({
            userId: USER, project: 'lab', kind: 'human', title: 'Write the rec'
        });
        await expectThrow(() => svc.approve({
            userId: USER, project: 'lab', receiptId: receipt.id, nonce: receipt.nonce
        }), { status: 403, code: 'HUMAN_ONLY' });
    });

    test('complete without a receipt is refused', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'human', title: 'Sign off' }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        const started = await svc.start({ userId: USER, project: 'lab' });
        await svc.completeStep({ userId: USER, project: 'lab', stepId: started.steps[0].id });
        await expectThrow(() => svc.complete({
            userId: USER, project: 'lab', verdict: 'met'
        }), { status: 403, code: 'HUMAN_ONLY' });
        expect((await svc.get({ userId: USER, project: 'lab' })).status).toBe('REVIEW');
    });
});

describe('approval invalidation', () => {
    test('adding a step after approval returns the mission to DRAFT', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'human', title: 'Write the recommendation' }]
        }));
        const approved = await approveAsHuman(svc, { userId: USER, project: 'lab' });
        expect(approved.status).toBe('APPROVED');
        expect(approved.approvedRevision).toBe(approved.planRevision);

        const mutated = await svc.addStep({
            userId: USER, project: 'lab', kind: 'human', title: 'A new step after approval'
        });
        expect(mutated.status).toBe('DRAFT');
        expect(mutated.approvedAt).toBeNull();
        expect(mutated.approvedRevision).toBeNull();
        expect(mutated.planRevision).toBeGreaterThan(approved.planRevision);
        expect(mutated.timeline.some(e => e.kind === 'approval_invalidated')).toBe(true);

        await expectThrow(() => svc.start({ userId: USER, project: 'lab' }), {
            status: 409, code: 'BAD_STATUS'
        });
        const again = await approveAsHuman(svc, { userId: USER, project: 'lab' });
        expect(again.status).toBe('APPROVED');
        expect(again.approvedRevision).toBe(again.planRevision);
    });

    test('concurrent plan mutations do not collapse onto the same revision', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER));
        await Promise.all([
            svc.addStep({ userId: USER, project: 'lab', kind: 'human', title: 'First concurrent' }),
            svc.addStep({ userId: USER, project: 'lab', kind: 'human', title: 'Second concurrent' })
        ]);
        const open = await svc.get({ userId: USER, project: 'lab' });
        expect(open.planRevision).toBe(3);
        expect(open.steps).toHaveLength(2);
        const receipt = await svc.mintApprovalReceipt({
            userId: USER, project: 'lab', origin: 'portal'
        });
        expect(receipt.planRevision).toBe(3);
    });

    test('addStep loses to start() and does not insert an unapproved step', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'human', title: 'Sign off' }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        const results = await Promise.allSettled([
            svc.start({ userId: USER, project: 'lab' }),
            svc.addStep({ userId: USER, project: 'lab', kind: 'human', title: 'Late addition' })
        ]);
        const fulfilled = results.filter(r => r.status === 'fulfilled').map(r => r.value);
        const rejected = results.filter(r => r.status === 'rejected');
        expect(fulfilled.length + rejected.length).toBe(2);
        const open = await svc.get({ userId: USER, project: 'lab' });
        if (open.status === 'ACTIVE') {
            expect(open.steps).toHaveLength(1);
            expect(rejected.some(r => r.reason?.code === 'BAD_STATUS')).toBe(true);
        } else {
            expect(open.status).toBe('DRAFT');
            expect(open.steps.some(s => s.title === 'Late addition')).toBe(true);
        }
    });
});

describe('atomic step start', () => {
    test('concurrent startStep launches the external job once', async () => {
        const USER = nextUser();
        await seedProject(USER);
        let kicks = 0;
        const svc = makeService({
            spitball: {
                createExpedition: async () => {
                    kicks += 1;
                    await new Promise(resolve => setTimeout(resolve, 40));
                    return { id: 9000 + kicks };
                }
            }
        });
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'expedition', title: 'Survey recall literature', actionParams: { seed: 'recall' } }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        await svc.start({ userId: USER, project: 'lab' });
        const open = await svc.get({ userId: USER, project: 'lab' });
        const stepId = open.steps[0].id;

        const results = await Promise.allSettled([
            svc.startStep({ userId: USER, project: 'lab', stepId }),
            svc.startStep({ userId: USER, project: 'lab', stepId })
        ]);
        const fulfilled = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toMatchObject({ code: 'BAD_STEP_STATUS' });
        expect(kicks).toBe(1);
        const after = await svc.get({ userId: USER, project: 'lab' });
        expect(after.steps[0].status).toBe('RUNNING');
        expect(after.steps[0].expeditionId).toBeTruthy();
        expect(after.steps[0].executionAttemptId).toBeTruthy();
    });

    test('a job step with only a title cannot start', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const run = jest.fn();
        const svc = makeService({ observatory: { run, cancel: jest.fn() } });
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'job', title: 'Run the benchmark' }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        await svc.start({ userId: USER, project: 'lab' });
        const open = await svc.get({ userId: USER, project: 'lab' });
        await expectThrow(() => svc.startStep({
            userId: USER, project: 'lab', stepId: open.steps[0].id
        }), { status: 400, code: 'BAD_STEP_PARAMS' });
        expect(run).not.toHaveBeenCalled();
        expect((await svc.get({ userId: USER, project: 'lab' })).steps[0].status).toBe('READY');
    });

    test('reconcile adopts a child found only by executionAttemptId and promotes the step', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'job', title: 'Run the benchmark', actionParams: { asset: 'bench' } }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        await svc.start({ userId: USER, project: 'lab' });
        const open = await svc.get({ userId: USER, project: 'lab' });
        const attemptId = 'attempt-adopt-1';
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId', { userId: USER }
        );
        await db.run(
            `UPDATE project_mission_steps
             SET status = 'STARTING', executionAttemptId = @attemptId,
                 startedAt = datetime('now'), updatedAt = datetime('now')
             WHERE id = @id`,
            { id: open.steps[0].id, attemptId }
        );
        const jobId = await db.insert(
            `INSERT INTO observatory_jobs
                (projectId, userId, language, code, status, executionAttemptId)
             VALUES (@projectId, @userId, 'python', 'print(1)', 'RUNNING', @attemptId)`,
            { projectId: project.id, userId: USER, attemptId }
        );

        const repaired = await svc.reconcileStartingSteps({ olderThanMs: 0 });
        expect(repaired).toBe(1);
        const after = await svc.get({ userId: USER, project: 'lab' });
        expect(after.status).toBe('ACTIVE');
        expect(after.steps[0].status).toBe('RUNNING');
        expect(after.steps[0].jobId).toBe(jobId);
    });

    test('reconcile fails an unlinked STARTING step and blocks the mission', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'job', title: 'Run the benchmark', actionParams: { asset: 'bench' } }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        await svc.start({ userId: USER, project: 'lab' });
        const open = await svc.get({ userId: USER, project: 'lab' });
        await db.run(
            `UPDATE project_mission_steps
             SET status = 'STARTING', executionAttemptId = @attemptId,
                 startedAt = datetime('now'), updatedAt = datetime('now')
             WHERE id = @id`,
            { id: open.steps[0].id, attemptId: 'attempt-orphan-1' }
        );

        const repaired = await svc.reconcileStartingSteps({ olderThanMs: 0 });
        expect(repaired).toBe(1);
        const after = await svc.get({ userId: USER, project: 'lab' });
        expect(after.status).toBe('BLOCKED');
        expect(after.steps[0].status).toBe('FAILED');
        expect(after.timeline.some(e => e.kind === 'blocked')).toBe(true);
    });

    test('reconcileRunningSteps settles a RUNNING step whose child is already terminal', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'job', title: 'Run the benchmark' }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        await svc.start({ userId: USER, project: 'lab' });
        const open = await svc.get({ userId: USER, project: 'lab' });
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId', { userId: USER }
        );
        const jobId = await db.insert(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status)
             VALUES (@projectId, @userId, 'python', 'print(1)', 'COMPLETED')`,
            { projectId: project.id, userId: USER }
        );
        await db.run(
            `UPDATE project_mission_steps
             SET status = 'RUNNING', jobId = @jobId, updatedAt = datetime('now')
             WHERE id = @id`,
            { id: open.steps[0].id, jobId }
        );

        const repaired = await svc.reconcileRunningSteps();
        expect(repaired).toBe(1);
        const after = await svc.get({ userId: USER, project: 'lab' });
        expect(after.steps[0].status).toBe('DONE');
    });

    test('reconcileRunningSteps does not treat FIRING, CANCELLED, or EXPIRED watches as success', async () => {
        const { watchReconcileOutcome } = require('@goobster/core/services/projectMissionService');
        expect(watchReconcileOutcome('ARMED')).toBeNull();
        expect(watchReconcileOutcome('FIRING')).toBeNull();
        expect(watchReconcileOutcome('FIRED')).toEqual({ failed: false });
        expect(watchReconcileOutcome('FAILED')).toEqual({ failed: true });
        expect(watchReconcileOutcome('CANCELLED')).toEqual({ failed: true });
        expect(watchReconcileOutcome('EXPIRED')).toEqual({ failed: true });
        expect(watchReconcileOutcome('UNKNOWN')).toBeNull();

        async function seedWatchMission(status) {
            const USER = nextUser();
            await seedProject(USER);
            const svc = makeService();
            await svc.create(draftArgs(USER, {
                steps: [{ kind: 'watch', title: 'When the run finishes' }]
            }));
            await approveAsHuman(svc, { userId: USER, project: 'lab' });
            await svc.start({ userId: USER, project: 'lab' });
            const open = await svc.get({ userId: USER, project: 'lab' });
            const watchId = await db.insert(
                `INSERT INTO attention_watches
                    (userId, guildId, label, topic, promptText, status)
                 VALUES (@userId, @guildId, @label, 'observatory.job_completed', 'inspect', @status)`,
                { userId: USER, guildId: `dm:${USER}`, label: `w-${status}-${USER}`, status }
            );
            await db.run(
                `UPDATE project_mission_steps
                 SET status = 'RUNNING', watchId = @watchId, updatedAt = datetime('now')
                 WHERE id = @id`,
                { id: open.steps[0].id, watchId }
            );
            return { USER, svc, watchId };
        }

        const firing = await seedWatchMission('FIRING');
        expect(await firing.svc.reconcileRunningSteps()).toBe(0);
        expect((await firing.svc.get({ userId: firing.USER, project: 'lab' })).steps[0].status)
            .toBe('RUNNING');

        const cancelled = await seedWatchMission('CANCELLED');
        expect(await cancelled.svc.reconcileRunningSteps()).toBe(1);
        expect((await cancelled.svc.get({ userId: cancelled.USER, project: 'lab' })).steps[0].status)
            .toBe('FAILED');

        const expired = await seedWatchMission('EXPIRED');
        expect(await expired.svc.reconcileRunningSteps()).toBe(1);
        expect((await expired.svc.get({ userId: expired.USER, project: 'lab' })).steps[0].status)
            .toBe('FAILED');

        const fired = await seedWatchMission('FIRED');
        expect(await fired.svc.reconcileRunningSteps()).toBe(1);
        expect((await fired.svc.get({ userId: fired.USER, project: 'lab' })).steps[0].status)
            .toBe('DONE');
    });
});

describe('propagated cancellation', () => {
    test('cancel stops the linked expedition before the mission is CANCELLED', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const cancelled = [];
        const svc = makeService({
            spitball: {
                createExpedition: async () => ({ id: 44 }),
                cancelExpedition: async (id) => { cancelled.push(id); return { id, status: 'CANCELLED' }; }
            }
        });
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'expedition', title: 'Survey', actionParams: { seed: 'recall' } }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        await svc.start({ userId: USER, project: 'lab' });
        const open = await svc.get({ userId: USER, project: 'lab' });
        await svc.startStep({ userId: USER, project: 'lab', stepId: open.steps[0].id });
        expect(cancelled).toEqual([]);

        const done = await svc.cancel({ userId: USER, project: 'lab' });
        expect(cancelled).toEqual([44]);
        expect(done.status).toBe('CANCELLED');
        expect(done.steps[0].status).toBe('SKIPPED');
    });

    test('skipping a running step cancels linked work before unblocking dependents', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const cancelled = [];
        const svc = makeService({
            spitball: {
                createExpedition: async () => ({ id: 55 }),
                cancelExpedition: async (id) => { cancelled.push(id); return { id, status: 'CANCELLED' }; }
            }
        });
        const created = await svc.create(draftArgs(USER, {
            steps: [{ kind: 'expedition', title: 'Survey', actionParams: { seed: 'recall' } }]
        }));
        await svc.addStep({
            userId: USER, project: 'lab', kind: 'human', title: 'Write it up',
            dependsOn: [created.steps[0].id]
        });
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        await svc.start({ userId: USER, project: 'lab' });
        const open = await svc.get({ userId: USER, project: 'lab' });
        const survey = open.steps.find(s => s.kind === 'expedition');
        const writeup = open.steps.find(s => s.kind === 'human');
        await svc.startStep({ userId: USER, project: 'lab', stepId: survey.id });
        expect(writeup.status).toBe('PENDING');

        const skipped = await svc.skipStep({ userId: USER, project: 'lab', stepId: survey.id });
        expect(cancelled).toEqual([55]);
        expect(skipped.steps.find(s => s.id === survey.id).status).toBe('SKIPPED');
        expect(skipped.steps.find(s => s.id === writeup.id).status).toBe('READY');
    });

    test('linked expedition cancel uses the launching owner, not the mission actor', async () => {
        const USER = nextUser();
        const COLLAB = nextUser();
        await seedProject(USER);
        const cancelled = [];
        const expeditionId = await db.insert(
            `INSERT INTO spitball_expeditions
                (userId, guildId, scopeKey, seed, depth, status)
             VALUES (@userId, @guildId, @scopeKey, 'recall', 'focused', 'RUNNING')`,
            { userId: USER, guildId: `dm:${USER}`, scopeKey: `USER:${USER}` }
        );
        const svc = makeService({
            spitball: {
                cancelExpedition: async (id, { userId }) => {
                    cancelled.push({ id, userId });
                    return { id, status: 'CANCELLED' };
                }
            }
        });
        await svc._cancelLinkedWork({
            expeditionId, jobId: null, watchId: null, userId: USER
        }, COLLAB);
        expect(cancelled).toEqual([{ id: expeditionId, userId: USER }]);
    });
});

describe('old-mission deadlines', () => {
    test('an untouched two-week mission still generates a deadline candidate', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        const soon = new Date(Date.now() + 36 * 3600_000);
        const deadline = soon.toISOString().slice(0, 10);
        await svc.create(draftArgs(USER, {
            deadline,
            steps: [{ kind: 'human', title: 'Sign off' }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        await svc.start({ userId: USER, project: 'lab' });
        const open = await svc.get({ userId: USER, project: 'lab' });
        await db.run(
            `UPDATE project_missions
             SET updatedAt = datetime('now', '-14 days')
             WHERE id = @id`,
            { id: open.id }
        );

        await policies.setInitiative(USER, 'observe');
        aiService.generateText.mockImplementation(async (prompt) => {
            const keys = [...prompt.matchAll(/\[key: ([^\]]+)\]/g)].map(m => m[1]);
            return JSON.stringify({
                keep: keys.map(key => ({ key, adjust: 0, reason: 'worth it' })),
                drop: [],
                message: 'Deadline news.'
            });
        });
        const summary = await attention.sweepUser({
            policy: await policies.get(USER),
            gateway: { isGoobsterGateway: true, sendDm: async () => ({ ok: true }) }
        });
        const notice = summary.notices.find(n => String(n.key).startsWith(`mission:${open.id}:deadline:`));
        expect(notice).toBeTruthy();
        expect(notice.title).toMatch(/deadline/);
    });
});

describe('one decision record', () => {
    test('completing twice writes exactly one decision', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'human', title: 'Write the recommendation' }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        const started = await svc.start({ userId: USER, project: 'lab' });
        await svc.completeStep({ userId: USER, project: 'lab', stepId: started.steps[0].id });
        await completeAsHuman(svc, { userId: USER, project: 'lab', verdict: 'met' });
        await expectThrow(() => completeAsHuman(svc, {
            userId: USER, project: 'lab', missionId: started.id, verdict: 'met'
        }), {
            status: 409, code: 'BAD_STATUS'
        });
        const rows = await db.all(
            'SELECT id FROM project_decisions WHERE missionId = @id', { id: started.id }
        );
        expect(rows).toHaveLength(1);
    });

    test('concurrent complete writes exactly one decision', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'human', title: 'Write the recommendation' }]
        }));
        await approveAsHuman(svc, { userId: USER, project: 'lab' });
        const started = await svc.start({ userId: USER, project: 'lab' });
        await svc.completeStep({ userId: USER, project: 'lab', stepId: started.steps[0].id });
        const results = await Promise.allSettled([
            completeAsHuman(svc, { userId: USER, project: 'lab', missionId: started.id, verdict: 'met' }),
            completeAsHuman(svc, { userId: USER, project: 'lab', missionId: started.id, verdict: 'unmet' })
        ]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
        const rows = await db.all(
            'SELECT id FROM project_decisions WHERE missionId = @id', { id: started.id }
        );
        expect(rows).toHaveLength(1);
    });
});

describe('evidence assessment', () => {
    test('a support/against tie is contested, not met', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER));
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId', { userId: USER }
        );
        const forNote = await db.insert(
            `INSERT INTO kg_nodes (guildId, scopeKey, type, label, content)
             VALUES (@guildId, @scopeKey, 'fact', 'For', 'holds')`,
            { guildId: `dm:${USER}`, scopeKey: `PROJECT:${project.id}` }
        );
        const againstNote = await db.insert(
            `INSERT INTO kg_nodes (guildId, scopeKey, type, label, content)
             VALUES (@guildId, @scopeKey, 'fact', 'Against', 'fails')`,
            { guildId: `dm:${USER}`, scopeKey: `PROJECT:${project.id}` }
        );
        await svc.addEvidence({
            userId: USER, project: 'lab', kind: 'note', refId: forNote,
            criterionId: 'c1', polarity: 'for'
        });
        const tied = await svc.addEvidence({
            userId: USER, project: 'lab', kind: 'note', refId: againstNote,
            criterionId: 'c1', polarity: 'against'
        });
        expect(tied.evaluation.criteria[0].assessment).toBe('contested');
        expect(tied.evaluation.overall).toBe('contested');
        expect(tied.review).toBeNull();
    });

    test('duplicate evidence links are rejected', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER));
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId', { userId: USER }
        );
        const noteId = await db.insert(
            `INSERT INTO kg_nodes (guildId, scopeKey, type, label, content)
             VALUES (@guildId, @scopeKey, 'fact', 'Benchmark', 'holds')`,
            { guildId: `dm:${USER}`, scopeKey: `PROJECT:${project.id}` }
        );
        await svc.addEvidence({
            userId: USER, project: 'lab', kind: 'note', refId: noteId, criterionId: 'c1'
        });
        await expectThrow(() => svc.addEvidence({
            userId: USER, project: 'lab', kind: 'note', refId: noteId, criterionId: 'c1'
        }), { status: 409, code: 'DUPLICATE_EVIDENCE' });
    });

    test('a claim from another project is refused without imported=true', async () => {
        const USER = nextUser();
        await seedProject(USER);
        await seedProject(USER, 'other', 'Other');
        const svc = makeService();
        await svc.create(draftArgs(USER));
        const other = await db.get(
            `SELECT id FROM observatory_projects WHERE userId = @userId AND slug = 'other'`,
            { userId: USER }
        );
        const expeditionId = await db.insert(
            `INSERT INTO spitball_expeditions
                (userId, guildId, scopeKey, seed, depth, status, projectId)
             VALUES (@userId, @guildId, @scopeKey, 'x', 'focused', 'COMPLETED', @projectId)`,
            { userId: USER, guildId: `dm:${USER}`, scopeKey: `USER:${USER}`, projectId: other.id }
        );
        const sourceId = await db.insert(
            `INSERT INTO research_sources (expeditionId, userId, url, title)
             VALUES (@expeditionId, @userId, 'https://example.test', 'src')`,
            { expeditionId, userId: USER }
        );
        const claimId = await db.insert(
            `INSERT INTO research_claims (expeditionId, sourceId, text)
             VALUES (@expeditionId, @sourceId, 'a claim')`,
            { expeditionId, sourceId }
        );
        await expectThrow(() => svc.addEvidence({
            userId: USER, project: 'lab', kind: 'claim', refId: claimId, criterionId: 'c1'
        }), { status: 404, code: 'NO_CLAIM' });
        const imported = await svc.addEvidence({
            userId: USER, project: 'lab', kind: 'claim', refId: claimId,
            criterionId: 'c1', imported: true
        });
        expect(imported.evidence[0].provenance.scope).toBe('imported');
    });
});
