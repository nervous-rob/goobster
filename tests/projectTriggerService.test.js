/**
 * Project triggers (services/projectTriggerService.js).
 *
 * CRUD + per-action validation, cron claim-at-most-once / disable-on-bad-
 * cron, run_script provenance through a fake Observatory, event fire on
 * settle, startup catch-up, chain-depth guard, fetch_data allowlist, and
 * /forget-me. No network.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-project-triggers-${process.pid}.sqlite`);

const db = require('@goobster/core/db');
const {
    ProjectTriggerService,
    ProjectTriggerError
} = require('@goobster/core/services/projectTriggerService');
const { ProjectAssetService } = require('@goobster/core/services/projectAssetService');
const { ObservatoryService } = require('@goobster/core/services/observatoryService');
const projectTriggerService = require('@goobster/core/services/projectTriggerService');

let userSeq = 0;
function nextUser() {
    return `trig-user-${process.pid}-${userSeq++}`;
}

const ALLOWLIST_CFG = { fetchAllowedHosts: ['example.com', 'data.example.org'] };

function makeService(overrides = {}) {
    return new ProjectTriggerService({
        sandboxCfg: ALLOWLIST_CFG,
        ...overrides
    });
}

function makeFakeObservatory(runs) {
    return {
        async run(opts) {
            runs.push(opts);
            return {
                mode: opts.background === false ? 'foreground' : 'background',
                project: opts.project,
                jobId: 100 + runs.length,
                status: 'RUNNING',
                maxResumes: 12,
                result: {
                    ok: true, exitCode: 0, stdout: 'ok', stderr: '',
                    files: [], durationMs: 1, language: opts.language
                }
            };
        },
        async render(opts) {
            return { project: opts.project, frames: 4, relPath: 'renders/r.mp4', fps: opts.fps || 24, path: '/tmp/r.mp4', sizeBytes: 12 };
        }
    };
}

async function seedProject(userId, slug = 'lab', name = 'Lab') {
    await db.run(
        `INSERT INTO observatory_projects (userId, slug, name)
         VALUES (@userId, @slug, @name)`,
        { userId, slug, name }
    );
    return { slug, name };
}

async function seedScript(userId, project = 'lab', source = 'print("hi")') {
    const assets = new ProjectAssetService();
    return await assets.save({
        userId,
        project,
        name: 'Ingest',
        kind: 'script',
        language: 'python',
        source,
        origin: 'portal'
    });
}

async function expectThrow(fn, expected) {
    let caught = null;
    try { await fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(ProjectTriggerError);
    expect(caught).toMatchObject(expected);
    return caught;
}

async function setDue(triggerId) {
    await db.run(
        `UPDATE project_triggers SET nextRun = datetime('now', '-1 minute') WHERE id = @id`,
        { id: triggerId }
    );
}

afterAll(async () => {
    await db.closeConnection();
    try { fs.rmSync(process.env.GOOBSTER_DB_PATH, { force: true }); } catch { /* held open */ }
    for (const suffix of ['-shm', '-wal']) {
        try { fs.rmSync(process.env.GOOBSTER_DB_PATH + suffix, { force: true }); } catch { /* gone */ }
    }
});

describe('trigger CRUD + validation', () => {
    test('creates a cron run_script trigger and lists it', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const svc = makeService();
        const created = await svc.create({
            userId: USER,
            project: 'lab',
            name: 'Nightly ingest',
            kind: 'cron',
            schedule: '0 2 * * *',
            action: 'run_script',
            actionAssetId: script.id,
            actionParams: { background: true }
        });
        expect(created.kind).toBe('cron');
        expect(created.schedule).toBe('0 2 * * *');
        expect(created.action).toBe('run_script');
        expect(created.actionAssetId).toBe(script.id);
        expect(created.isEnabled).toBe(true);
        expect(created.nextRun).toBeTruthy();

        const listed = await svc.list({ userId: USER, project: 'lab' });
        expect(listed).toHaveLength(1);
        expect(listed[0].name).toBe('Nightly ingest');
    });

    test('rejects a duplicate name, a bad cron, and a non-script asset', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const svc = makeService();
        await svc.create({
            userId: USER, project: 'lab', name: 'Dup', kind: 'cron',
            schedule: '0 3 * * *', action: 'run_script', actionAssetId: script.id
        });
        await expectThrow(() => svc.create({
            userId: USER, project: 'lab', name: 'Dup', kind: 'cron',
            schedule: '0 4 * * *', action: 'run_script', actionAssetId: script.id
        }), { code: 'DUPLICATE_NAME', status: 409 });

        await expectThrow(() => svc.create({
            userId: USER, project: 'lab', name: 'Bad cron', kind: 'cron',
            schedule: 'every day', action: 'render'
        }), { code: 'BAD_SCHEDULE', status: 400 });

        const assets = new ProjectAssetService();
        const note = await assets.save({
            userId: USER, project: 'lab', name: 'Readme', kind: 'note',
            language: 'markdown', source: '# hi', origin: 'portal'
        });
        await expectThrow(() => svc.create({
            userId: USER, project: 'lab', name: 'Wrong kind', kind: 'event',
            eventTopic: 'job_settled', action: 'run_script', actionAssetId: note.id
        }), { code: 'BAD_ASSET', status: 400 });
    });

    test('fetch_data is a validation error for an off-list host at write time', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        await expectThrow(() => svc.create({
            userId: USER, project: 'lab', name: 'Steal', kind: 'cron',
            schedule: '0 5 * * *', action: 'fetch_data',
            actionParams: { url: 'https://evil.example.net/dump' }
        }), { code: 'HOST_NOT_ALLOWED', status: 400 });
    });

    test('set upserts by name and update can pause a trigger', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        const first = await svc.set({
            userId: USER, project: 'lab', name: 'Refresh',
            kind: 'event', eventTopic: 'job_completed', action: 'render'
        });
        const second = await svc.set({
            userId: USER, project: 'lab', name: 'Refresh',
            eventTopic: 'job_settled'
        });
        expect(second.id).toBe(first.id);
        expect(second.eventTopic).toBe('job_settled');

        const paused = await svc.update({
            userId: USER, project: 'lab', trigger: first.id, isEnabled: false
        });
        expect(paused.isEnabled).toBe(false);
    });
});

describe('cron claim semantics', () => {
    test('a due cron trigger is claimed at most once', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const svc = makeService();
        const created = await svc.create({
            userId: USER, project: 'lab', name: 'Once', kind: 'cron',
            schedule: '0 * * * *', action: 'run_script', actionAssetId: script.id
        });
        await setDue(created.id);
        const row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: created.id });
        const [a, b] = await Promise.all([
            svc.claimDueCronRun(row),
            svc.claimDueCronRun(row)
        ]);
        expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    test('an unparseable schedule disables the trigger and records lastOutcome', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const notices = [];
        const svc = makeService();
        const id = await db.insert(
            `INSERT INTO project_triggers
                (projectId, userId, name, kind, schedule, nextRun, action, isEnabled)
             VALUES (
                (SELECT id FROM observatory_projects WHERE userId = @userId AND slug = 'lab'),
                @userId, 'Broken', 'cron', 'not a cron', datetime('now', '-1 minute'),
                'render', 1
             )`,
            { userId: USER }
        );
        const row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id });
        svc._notifyOwner = async (trigger, message) => { notices.push({ trigger, message }); };
        const claimed = await svc.claimDueCronRun(row);
        expect(claimed).toBe(false);
        const after = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id });
        expect(after.isEnabled).toBe(0);
        expect(after.nextRun).toBeNull();
        expect(after.lastOutcome).toMatch(/unparseable/);
        expect(notices).toHaveLength(1);
        expect(notices[0].message).toMatch(/paused/i);
    });
});

describe('run_script provenance', () => {
    test('cron fire resolves HEAD and records assetVersionId / startedBy / triggerId', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER, 'lab', 'print("v1")');
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const created = await svc.create({
            userId: USER, project: 'lab', name: 'Provenance', kind: 'cron',
            schedule: '0 6 * * *', action: 'run_script',
            actionAssetId: script.id, actionParams: { background: true }
        });
        await setDue(created.id);
        await svc.fireDueCronTriggers();
        expect(runs).toHaveLength(1);
        expect(runs[0].assetVersionId).toBe(script.versionId);
        expect(runs[0].startedBy).toBe('trigger');
        expect(runs[0].triggerId).toBe(created.id);
        expect(runs[0].code).toBe('print("v1")');
        expect(runs[0].userId).toBe(USER);

        const row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: created.id });
        expect(row.lastRun).toBeTruthy();
        expect(row.lastOutcome).toMatch(/^ok:/);
    });
});

describe('event fire, catch-up, and chain-depth', () => {
    async function insertSettledJob(userId, projectSlug, fields = {}) {
        const project = await db.get(
            `SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug`,
            { userId, slug: projectSlug }
        );
        const id = await db.insert(
            `INSERT INTO observatory_jobs
                (projectId, userId, language, code, status, finishedAt, startedBy, triggerId, assetVersionId)
             VALUES (@projectId, @userId, 'python', 'print(1)', @status,
                     datetime('now', @offset), @startedBy, @triggerId, @assetVersionId)`,
            {
                projectId: project.id,
                userId,
                status: fields.status || 'COMPLETED',
                offset: fields.offset || '-1 minute',
                startedBy: fields.startedBy || 'chat',
                triggerId: fields.triggerId ?? null,
                assetVersionId: fields.assetVersionId ?? null
            }
        );
        return await db.get('SELECT * FROM observatory_jobs WHERE id = @id', { id });
    }

    test('job settle fires a matching event trigger', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        await svc.create({
            userId: USER, project: 'lab', name: 'On done', kind: 'event',
            eventTopic: 'job_completed', action: 'run_script',
            actionAssetId: script.id, actionParams: { background: true }
        });
        const job = await insertSettledJob(USER, 'lab', { status: 'COMPLETED' });
        const fired = await svc.evaluateJobSettled(job.id);
        expect(fired).toBe(1);
        expect(runs).toHaveLength(1);
        expect(runs[0].startedBy).toBe('trigger');
    });

    test('job_failed does not fire a job_completed trigger', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        await svc.create({
            userId: USER, project: 'lab', name: 'Only success', kind: 'event',
            eventTopic: 'job_completed', action: 'render'
        });
        const job = await insertSettledJob(USER, 'lab', { status: 'FAILED' });
        const fired = await svc.evaluateJobSettled(job.id);
        expect(fired).toBe(0);
        expect(runs).toHaveLength(0);
    });

    test('startup catch-up fires for a job settled while "down"', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const trigger = await svc.create({
            userId: USER, project: 'lab', name: 'Catch me', kind: 'event',
            eventTopic: 'job_settled', action: 'run_script',
            actionAssetId: script.id, actionParams: { background: true }
        });
        await db.run(
            `UPDATE project_triggers SET lastRun = datetime('now', '-1 day') WHERE id = @id`,
            { id: trigger.id }
        );
        await insertSettledJob(USER, 'lab', { status: 'COMPLETED', offset: '-5 minutes' });
        const fired = await svc.catchUpEventTriggers();
        expect(fired).toBeGreaterThanOrEqual(1);
        expect(runs.length).toBeGreaterThanOrEqual(1);
        // A second catch-up after lastRun advanced must not double-fire.
        const again = await svc.catchUpEventTriggers();
        expect(again).toBe(0);
        expect(runs).toHaveLength(1);
    });

    test('chain-depth guard stops self-chaining', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const trigger = await svc.create({
            userId: USER, project: 'lab', name: 'Loop', kind: 'event',
            eventTopic: 'job_settled', action: 'run_script',
            actionAssetId: script.id,
            actionParams: { background: true, allowSelfChain: false }
        });
        const job = await insertSettledJob(USER, 'lab', {
            status: 'COMPLETED',
            startedBy: 'trigger',
            triggerId: trigger.id
        });
        const fired = await svc.evaluateJobSettled(job.id);
        expect(fired).toBe(0);
        expect(runs).toHaveLength(0);
        const row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: trigger.id });
        expect(row.lastOutcome).toMatch(/self-chain/);
    });

    test('allowSelfChain still stops at maxChainDepth', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const trigger = await svc.create({
            userId: USER, project: 'lab', name: 'Deep', kind: 'event',
            eventTopic: 'job_settled', action: 'run_script',
            actionAssetId: script.id,
            actionParams: { background: true, allowSelfChain: true, maxChainDepth: 1 }
        });
        const first = await insertSettledJob(USER, 'lab', {
            status: 'COMPLETED',
            startedBy: 'trigger',
            triggerId: trigger.id
        });
        // Depth of an event-started job is 1; maxChainDepth 1 blocks another hop.
        const fired = await svc.evaluateJobSettled(first.id);
        expect(fired).toBe(0);
        expect(runs).toHaveLength(0);
    });

    test('observatory settle path invokes evaluateJobSettled', async () => {
        const USER = nextUser();
        await seedProject(USER, 'settle-lab', 'Settle Lab');
        const spy = jest.spyOn(projectTriggerService, 'evaluateJobSettled');
        const fakeSandbox = {
            enabled: true,
            languages: ['python'],
            _normalizeLanguage: (language) => (language === 'python' ? 'python' : null),
            run: async () => ({
                ok: true, timedOut: false, aborted: false, files: [],
                stdout: 'done', stderr: '', exitCode: 0, durationMs: 1,
                language: 'python', signal: null
            })
        };
        const obs = new ObservatoryService({
            config: {
                enabled: true, scope: 'everywhere',
                maxProjectsPerUser: 5, maxProjectMb: 256,
                maxActiveJobsPerUser: 4, maxResumes: 2,
                maxWorkspaceFiles: 50, maxWorkspaceReadMb: 8,
                maxRenderFrames: 10, renderFps: 24, ffmpegCommand: 'ffmpeg'
            },
            sandbox: fakeSandbox
        });
        const outcome = await obs.run({
            userId: USER, project: 'settle-lab', language: 'python',
            code: 'print(1)', background: true
        });
        for (let i = 0; i < 40; i++) {
            const job = await db.get(
                'SELECT status FROM observatory_jobs WHERE id = @id',
                { id: outcome.jobId }
            );
            if (job && job.status !== 'RUNNING') break;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect(spy).toHaveBeenCalledWith(outcome.jobId, expect.anything());
        spy.mockRestore();
    });
});

describe('fetch_data allowlist at fire time', () => {
    test('an off-list host at fire time is a skip recorded in lastOutcome', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const cfg = { fetchAllowedHosts: ['example.com'] };
        const svc = makeService({ sandboxCfg: cfg });
        const created = await svc.create({
            userId: USER, project: 'lab', name: 'Fetch', kind: 'cron',
            schedule: '0 7 * * *', action: 'fetch_data',
            actionParams: { url: 'https://example.com/data.csv' }
        });
        cfg.fetchAllowedHosts = [];
        await setDue(created.id);
        await svc.fireDueCronTriggers();
        const row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: created.id });
        expect(row.lastOutcome).toMatch(/^skipped:/);
        expect(row.lastOutcome).toMatch(/not on sandbox.fetchAllowedHosts|cannot be automated/i);
        expect(row.isEnabled).toBe(1);
    });
});

describe('erasure', () => {
    test('forgetUser deletes triggers by userId and leaves others', async () => {
        const USER = nextUser();
        const OTHER = nextUser();
        await seedProject(USER, 'lab', 'Lab');
        await seedProject(OTHER, 'lab', 'Lab');
        const svc = makeService();
        await svc.create({
            userId: USER, project: 'lab', name: 'Mine', kind: 'event',
            eventTopic: 'job_settled', action: 'render'
        });
        await svc.create({
            userId: OTHER, project: 'lab', name: 'Theirs', kind: 'event',
            eventTopic: 'job_settled', action: 'render'
        });
        const forgotten = await svc.forgetUser(USER);
        expect(forgotten.triggers).toBe(1);
        expect(await svc.countUser(USER)).toBe(0);
        expect(await svc.countUser(OTHER)).toBe(1);
    });
});
