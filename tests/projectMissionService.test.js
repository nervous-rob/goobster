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
        expect(mission.evaluation.overall).toBe('open');
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
        const approved = await svc.approve({ userId: USER, project: 'lab' });
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

        const finished = await svc.complete({
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
        await svc.approve({ userId: USER, project: 'lab' });
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

        const resumed = await svc.resume({ userId: USER, project: 'lab' });
        expect(resumed.status).toBe('ACTIVE');
    });

    test('a completed expedition step advances to review when it is the last step', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await svc.create(draftArgs(USER, {
            steps: [{ kind: 'expedition', title: 'Survey recall literature' }]
        }));
        await svc.approve({ userId: USER, project: 'lab' });
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
        expect(updated.evaluation.criteria[0].verdict).toBe('met');
        expect(updated.evaluation.met).toBe(1);
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

        await svc.approve({ userId: USER, project: 'lab' });
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
        await svc.approve({ userId: USER, project: 'lab' });
        const started = await svc.start({ userId: USER, project: 'lab' });
        await svc.completeStep({ userId: USER, project: 'lab', stepId: started.steps[0].id });
        await svc.complete({ userId: USER, project: 'lab', verdict: 'met' });

        const counts = await svc.forgetUser(USER);
        expect(counts.missions).toBe(1);
        expect(counts.decisions).toBe(1);
        const audit = await privacyService.auditUser({ userId: USER });
        expect(audit.byTable.project_missions).toBe(0);
        expect(audit.byTable.project_decisions).toBe(0);
    });
});
