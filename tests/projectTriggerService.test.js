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
const { PROJECTS_ROOT } = require('@goobster/core/services/projectService');
const projectTriggerService = require('@goobster/core/services/projectTriggerService');

let userSeq = 0;
const createdUsers = [];
function nextUser() {
    const userId = `trig-user-${process.pid}-${userSeq++}`;
    createdUsers.push(userId);
    return userId;
}

// Real-Observatory runs materialize workspaces under data/; do not leave them behind.
afterAll(() => {
    for (const userId of createdUsers) {
        try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* */ }
    }
});

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

/** 'YYYY-MM-DD HH:MM:SS' UTC text. Bound datetime() modifiers are not translated. */
function utcText(ms = Date.now()) {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function utcAgo({ minutes = 0, days = 0 } = {}) {
    return utcText(Date.now() - (days * 86_400_000) - (minutes * 60_000));
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
        // A background launch is "started", never "ok": the stage has not settled yet.
        expect(row.lastOutcome).toMatch(/^started: job #\d+ \(ingest v1\), awaiting settlement$/);
        expect(row.lastJobOutcome).toBeNull();
    });
});

async function insertSettledJob(userId, projectSlug, fields = {}) {
    const project = await db.get(
        `SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug`,
        { userId, slug: projectSlug }
    );
    const finishedAt = fields.finishedAt || utcAgo({ minutes: 1 });
    const id = await db.insert(
        `INSERT INTO observatory_jobs
            (projectId, userId, language, code, status, finishedAt, startedBy, triggerId,
             assetVersionId, parentJobId)
         VALUES (@projectId, @userId, 'python', 'print(1)', @status,
                 @finishedAt, @startedBy, @triggerId, @assetVersionId, @parentJobId)`,
        {
            projectId: project.id,
            userId,
            status: fields.status || 'COMPLETED',
            finishedAt,
            startedBy: fields.startedBy || 'chat',
            triggerId: fields.triggerId ?? null,
            assetVersionId: fields.assetVersionId ?? null,
            parentJobId: fields.parentJobId ?? null
        }
    );
    return await db.get('SELECT * FROM observatory_jobs WHERE id = @id', { id });
}

/** A second script asset in the project (a different pipeline stage). */
async function seedNamedScript(userId, project, name, source = 'print("stage")') {
    const assets = new ProjectAssetService();
    return await assets.save({
        userId, project, name, kind: 'script', language: 'python', source, origin: 'portal'
    });
}

/** A real Observatory over a fake sandbox: real job rows, no processes. */
function makeRealObservatory(sandboxRun) {
    const fakeSandbox = {
        enabled: true,
        languages: ['python', 'bash'],
        _normalizeLanguage: (language) => (['python', 'bash'].includes(language) ? language : null),
        run: sandboxRun
    };
    return new ObservatoryService({
        config: {
            enabled: true, scope: 'everywhere',
            maxProjectsPerUser: 5, maxProjectMb: 256,
            maxActiveJobsPerUser: 4, maxResumes: 2,
            maxWorkspaceFiles: 50, maxWorkspaceReadMb: 8,
            maxRenderFrames: 10, renderFps: 24, ffmpegCommand: 'ffmpeg'
        },
        sandbox: fakeSandbox
    });
}

const okSandboxResult = {
    ok: true, timedOut: false, aborted: false, files: [],
    stdout: 'done', stderr: '', exitCode: 0, durationMs: 1, language: 'bash', signal: null
};

async function waitForSettled(jobId, { timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const job = await db.get('SELECT * FROM observatory_jobs WHERE id = @id', { id: jobId });
        if (job && job.status !== 'RUNNING') return job;
        if (Date.now() > deadline) throw new Error(`job #${jobId} still RUNNING`);
        await new Promise(resolve => setTimeout(resolve, 40));
    }
}

describe('event fire, catch-up, and chain-depth', () => {
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
            `UPDATE project_triggers SET lastRun = @lastRun WHERE id = @id`,
            { id: trigger.id, lastRun: utcAgo({ days: 1 }) }
        );
        await insertSettledJob(USER, 'lab', {
            status: 'COMPLETED',
            finishedAt: utcAgo({ minutes: 5 })
        });
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
        // evaluateJobSettled runs after _finishJob (status flip), dashboard
        // refresh, and notify — wait for the spy, not just a terminal row.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && spy.mock.calls.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        expect(spy).toHaveBeenCalledWith(outcome.jobId, expect.anything());
        spy.mockRestore();
    }, 15_000);
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

describe('event source filters', () => {
    async function pipeline(USER) {
        await seedProject(USER);
        const fetch = await seedNamedScript(USER, 'lab', 'Fetch');
        const other = await seedNamedScript(USER, 'lab', 'Other');
        const stage3 = await seedNamedScript(USER, 'lab', 'Stage Three');
        return { fetch, other, stage3 };
    }

    test('a filtered trigger fires for the selected source asset and not for another asset', async () => {
        const USER = nextUser();
        const { fetch, other, stage3 } = await pipeline(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const created = await svc.create({
            userId: USER, project: 'lab', name: 'After fetch', kind: 'event',
            eventTopic: 'job_completed', sourceAsset: 'fetch',
            action: 'run_script', actionAssetId: stage3.id, actionParams: { background: true }
        });
        expect(created.sourceAssetId).toBe(fetch.id);
        expect(created.sourceTriggerId).toBeNull();

        const unrelated = await insertSettledJob(USER, 'lab', { assetVersionId: other.versionId });
        expect(await svc.evaluateJobSettled(unrelated.id)).toBe(0);
        const adHoc = await insertSettledJob(USER, 'lab', { assetVersionId: null });
        expect(await svc.evaluateJobSettled(adHoc.id)).toBe(0);
        expect(runs).toHaveLength(0);
        let row = await db.get('SELECT lastRun FROM project_triggers WHERE id = @id', { id: created.id });
        expect(row.lastRun).toBeNull();

        const matching = await insertSettledJob(USER, 'lab', { assetVersionId: fetch.versionId });
        expect(await svc.evaluateJobSettled(matching.id)).toBe(1);
        expect(runs).toHaveLength(1);
        expect(runs[0].assetVersionId).toBe(stage3.versionId);
        expect(runs[0].parentJobId).toBe(matching.id);
        row = await db.get('SELECT lastRun FROM project_triggers WHERE id = @id', { id: created.id });
        expect(row.lastRun).toBe(matching.finishedAt);
    });

    test('sourceTrigger restricts to jobs started by that trigger; both filters must match', async () => {
        const USER = nextUser();
        const { fetch, stage3 } = await pipeline(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const nightly = await svc.create({
            userId: USER, project: 'lab', name: 'Nightly fetch', kind: 'cron',
            schedule: '0 2 * * *', action: 'run_script', actionAssetId: fetch.id
        });
        const manual = await svc.create({
            userId: USER, project: 'lab', name: 'Manual fetch', kind: 'cron',
            schedule: '0 3 * * *', action: 'run_script', actionAssetId: fetch.id
        });
        const downstream = await svc.create({
            userId: USER, project: 'lab', name: 'After nightly', kind: 'event',
            eventTopic: 'job_settled', sourceTrigger: 'Nightly fetch', sourceAsset: 'fetch',
            action: 'run_script', actionAssetId: stage3.id, actionParams: { background: true }
        });
        expect(downstream.sourceTriggerId).toBe(nightly.id);
        expect(downstream.sourceAssetId).toBe(fetch.id);

        const byManual = await insertSettledJob(USER, 'lab', {
            startedBy: 'trigger', triggerId: manual.id, assetVersionId: fetch.versionId
        });
        expect(await svc.evaluateJobSettled(byManual.id)).toBe(0);
        // Right trigger, wrong asset (a trigger re-pointed at another script).
        const wrongAsset = await insertSettledJob(USER, 'lab', {
            startedBy: 'trigger', triggerId: nightly.id, assetVersionId: stage3.versionId
        });
        expect(await svc.evaluateJobSettled(wrongAsset.id)).toBe(0);
        const byNightly = await insertSettledJob(USER, 'lab', {
            startedBy: 'trigger', triggerId: nightly.id, assetVersionId: fetch.versionId
        });
        expect(await svc.evaluateJobSettled(byNightly.id)).toBe(1);
        expect(runs).toHaveLength(1);
        expect(runs[0].parentJobId).toBe(byNightly.id);
    });

    test('filters must reference the same project, only on event triggers, and can be cleared', async () => {
        const USER = nextUser();
        const OTHER = nextUser();
        const { fetch, stage3 } = await pipeline(USER);
        await seedProject(OTHER, 'lab', 'Lab');
        const foreign = await seedNamedScript(OTHER, 'lab', 'Foreign');
        const svc = makeService();

        await expectThrow(() => svc.create({
            userId: USER, project: 'lab', name: 'Foreign filter', kind: 'event',
            eventTopic: 'job_completed', sourceAssetId: foreign.id, action: 'render'
        }), { code: 'BAD_FILTER', status: 400 });
        await expectThrow(() => svc.create({
            userId: USER, project: 'lab', name: 'Ghost trigger', kind: 'event',
            eventTopic: 'job_completed', sourceTriggerId: 999_999, action: 'render'
        }), { code: 'BAD_FILTER', status: 400 });
        await expectThrow(() => svc.create({
            userId: USER, project: 'lab', name: 'Cron filter', kind: 'cron', schedule: '0 1 * * *',
            sourceAssetId: fetch.id, action: 'render'
        }), { code: 'BAD_FILTER', status: 400 });
        const note = await new ProjectAssetService().save({
            userId: USER, project: 'lab', name: 'Readme', kind: 'note',
            language: 'markdown', source: '# hi', origin: 'portal'
        });
        await expectThrow(() => svc.create({
            userId: USER, project: 'lab', name: 'Note filter', kind: 'event',
            eventTopic: 'job_completed', sourceAssetId: note.id, action: 'render'
        }), { code: 'BAD_FILTER', status: 400 });

        const created = await svc.create({
            userId: USER, project: 'lab', name: 'Filtered', kind: 'event',
            eventTopic: 'job_completed', sourceAssetId: fetch.id,
            action: 'run_script', actionAssetId: stage3.id
        });
        const untouched = await svc.update({ userId: USER, project: 'lab', trigger: created.id, isEnabled: false });
        expect(untouched.sourceAssetId).toBe(fetch.id);
        const cleared = await svc.update({ userId: USER, project: 'lab', trigger: created.id, sourceAssetId: null });
        expect(cleared.sourceAssetId).toBeNull();
        const toCron = await svc.update({
            userId: USER, project: 'lab', trigger: created.id, sourceAssetId: fetch.id
        });
        expect(toCron.sourceAssetId).toBe(fetch.id);
        const swapped = await svc.update({
            userId: USER, project: 'lab', trigger: created.id, kind: 'cron', schedule: '0 4 * * *'
        });
        expect(swapped.kind).toBe('cron');
        expect(swapped.sourceAssetId).toBeNull();
        const listed = await svc.list({ userId: USER, project: 'lab' });
        expect(listed.find(t => t.id === created.id)).toMatchObject({ sourceAssetId: null, sourceTriggerId: null });
    });

    test('settle and catch-up use the identical matcher and a non-matching job never consumes a later match', async () => {
        const USER = nextUser();
        const { fetch, other, stage3 } = await pipeline(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const trigger = await svc.create({
            userId: USER, project: 'lab', name: 'Catch filtered', kind: 'event',
            eventTopic: 'job_completed', sourceAssetId: fetch.id,
            action: 'run_script', actionAssetId: stage3.id, actionParams: { background: true }
        });
        const rewoundTo = utcAgo({ days: 1 });
        await db.run(
            'UPDATE project_triggers SET lastRun = @lastRun WHERE id = @id',
            { id: trigger.id, lastRun: rewoundTo }
        );
        // Oldest first: unrelated, matching, unrelated-but-newer, failed-matching.
        const earlyOther = await insertSettledJob(USER, 'lab', {
            assetVersionId: other.versionId, finishedAt: utcAgo({ minutes: 40 })
        });
        const match = await insertSettledJob(USER, 'lab', {
            assetVersionId: fetch.versionId, finishedAt: utcAgo({ minutes: 30 })
        });
        const lateOther = await insertSettledJob(USER, 'lab', {
            assetVersionId: other.versionId, finishedAt: utcAgo({ minutes: 20 })
        });
        const failedMatch = await insertSettledJob(USER, 'lab', {
            assetVersionId: fetch.versionId, status: 'FAILED', finishedAt: utcAgo({ minutes: 10 })
        });

        // Settle path, deliberately out of order: the newest unrelated job
        // first must not advance lastRun past the older matching job.
        expect(await svc.evaluateJobSettled(lateOther.id)).toBe(0);
        expect(await svc.evaluateJobSettled(failedMatch.id)).toBe(0);
        expect(await svc.evaluateJobSettled(earlyOther.id)).toBe(0);
        expect(runs).toHaveLength(0);
        expect((await db.get('SELECT lastRun FROM project_triggers WHERE id = @id', { id: trigger.id })).lastRun)
            .toBe(rewoundTo);
        expect(await svc.evaluateJobSettled(match.id)).toBe(1);
        expect(runs).toHaveLength(1);
        expect(runs[0].parentJobId).toBe(match.id);

        // Rewinding lastRun alone replays nothing: the delivery record, not
        // the cursor, is the identity of a processed event.
        runs.length = 0;
        await db.run(
            'UPDATE project_triggers SET lastRun = @lastRun WHERE id = @id',
            { id: trigger.id, lastRun: utcAgo({ days: 1 }) }
        );
        expect(await svc.catchUpEventTriggers()).toBe(0);
        expect(runs).toHaveLength(0);

        // Forget the delivery too and catch-up reaches the identical verdict
        // on the same four jobs: exactly the one matching job fires.
        await db.run('DELETE FROM project_trigger_deliveries WHERE triggerId = @id', { id: trigger.id });
        await db.run(
            'UPDATE project_triggers SET lastRun = @lastRun WHERE id = @id',
            { id: trigger.id, lastRun: utcAgo({ days: 1 }) }
        );
        expect(await svc.catchUpEventTriggers()).toBe(1);
        expect(runs).toHaveLength(1);
        expect(runs[0].parentJobId).toBe(match.id);
        const after = await db.get('SELECT lastRun FROM project_triggers WHERE id = @id', { id: trigger.id });
        expect(after.lastRun).toBe(match.finishedAt);
        expect(await svc.catchUpEventTriggers()).toBe(0);
        expect(runs).toHaveLength(1);

        // The pure matcher agrees with both paths on every job.
        const { matchesEventTrigger } = projectTriggerService;
        const row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: trigger.id });
        const withAsset = async (job, assetId) => ({ ...job, assetId });
        expect(matchesEventTrigger(row, await withAsset(earlyOther, other.id))).toBe(false);
        expect(matchesEventTrigger(row, await withAsset(lateOther, other.id))).toBe(false);
        expect(matchesEventTrigger(row, await withAsset(failedMatch, fetch.id))).toBe(false);
        expect(matchesEventTrigger(row, await withAsset(match, fetch.id))).toBe(true);
    });

    test('an unfiltered event trigger keeps the legacy project-wide behaviour', async () => {
        const USER = nextUser();
        const { fetch, other } = await pipeline(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        await svc.create({
            userId: USER, project: 'lab', name: 'Anything', kind: 'event',
            eventTopic: 'job_settled', action: 'render'
        });
        for (const fields of [
            { assetVersionId: fetch.versionId, finishedAt: utcAgo({ minutes: 3 }) },
            { assetVersionId: other.versionId, finishedAt: utcAgo({ minutes: 2 }) },
            { assetVersionId: null, status: 'FAILED', finishedAt: utcAgo({ minutes: 1 }) }
        ]) {
            const job = await insertSettledJob(USER, 'lab', fields);
            expect(await svc.evaluateJobSettled(job.id)).toBe(1);
        }
    });
});

describe('explicit job parentage and chain depth', () => {
    test('chain depth follows parentJobId despite interleaved unrelated jobs', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const svc = makeService({ observatory: makeFakeObservatory([]) });
        const cron = await svc.create({
            userId: USER, project: 'lab', name: 'Root cron', kind: 'cron',
            schedule: '0 1 * * *', action: 'run_script', actionAssetId: script.id
        });
        const hop = await svc.create({
            userId: USER, project: 'lab', name: 'Hop', kind: 'event',
            eventTopic: 'job_settled', action: 'run_script', actionAssetId: script.id,
            actionParams: { allowSelfChain: true, maxChainDepth: 10 }
        });

        // Interleave: root, unrelated chat job, child 1, unrelated cron job, child 2.
        const root = await insertSettledJob(USER, 'lab', {
            startedBy: 'trigger', triggerId: cron.id, finishedAt: utcAgo({ minutes: 50 })
        });
        const noiseA = await insertSettledJob(USER, 'lab', {
            startedBy: 'chat', finishedAt: utcAgo({ minutes: 45 })
        });
        const child1 = await insertSettledJob(USER, 'lab', {
            startedBy: 'trigger', triggerId: hop.id, parentJobId: root.id, finishedAt: utcAgo({ minutes: 40 })
        });
        const noiseB = await insertSettledJob(USER, 'lab', {
            startedBy: 'trigger', triggerId: cron.id, finishedAt: utcAgo({ minutes: 35 })
        });
        const child2 = await insertSettledJob(USER, 'lab', {
            startedBy: 'trigger', triggerId: hop.id, parentJobId: child1.id, finishedAt: utcAgo({ minutes: 30 })
        });
        const child3 = await insertSettledJob(USER, 'lab', {
            startedBy: 'trigger', triggerId: hop.id, parentJobId: child2.id, finishedAt: utcAgo({ minutes: 25 })
        });

        expect(await svc.eventChainDepth(root)).toBe(0);
        expect(await svc.eventChainDepth(noiseA)).toBe(0);
        expect(await svc.eventChainDepth(noiseB)).toBe(0);
        expect(await svc.eventChainDepth(child1)).toBe(1);
        expect(await svc.eventChainDepth(child2)).toBe(2);
        expect(await svc.eventChainDepth(child3)).toBe(3);

        // A resumed child keeps its parentage (startedBy flips to 'resume').
        await db.run(`UPDATE observatory_jobs SET startedBy = 'resume' WHERE id = @id`, { id: child2.id });
        expect(await svc.eventChainDepth(await db.get('SELECT * FROM observatory_jobs WHERE id = @id', { id: child3.id })))
            .toBe(3);
    });

    test('the parent walk stops at a missing parent and refuses to loop on a cycle', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const svc = makeService();
        const orphan = await insertSettledJob(USER, 'lab', {
            startedBy: 'trigger', triggerId: 424242, parentJobId: 987_654_321
        });
        expect(await svc.eventChainDepth(orphan)).toBe(1);

        const a = await insertSettledJob(USER, 'lab', { startedBy: 'trigger', triggerId: 1 });
        const b = await insertSettledJob(USER, 'lab', { startedBy: 'trigger', triggerId: 1, parentJobId: a.id });
        await db.run('UPDATE observatory_jobs SET parentJobId = @parent WHERE id = @id', { id: a.id, parent: b.id });
        const looped = await db.get('SELECT * FROM observatory_jobs WHERE id = @id', { id: b.id });
        expect(await svc.eventChainDepth(looped)).toBe(2);
    });

    test('maxChainDepth counts explicit hops and allowSelfChain still gates self-fires', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const hop = await svc.create({
            userId: USER, project: 'lab', name: 'Two hops', kind: 'event',
            eventTopic: 'job_settled', action: 'run_script', actionAssetId: script.id,
            actionParams: { background: true, allowSelfChain: true, maxChainDepth: 2 }
        });
        const root = await insertSettledJob(USER, 'lab', { startedBy: 'chat', finishedAt: utcAgo({ minutes: 30 }) });
        expect(await svc.evaluateJobSettled(root.id)).toBe(1);
        expect(runs[0].parentJobId).toBe(root.id);
        const child1 = await insertSettledJob(USER, 'lab', {
            startedBy: 'trigger', triggerId: hop.id, parentJobId: root.id, finishedAt: utcAgo({ minutes: 20 })
        });
        expect(await svc.evaluateJobSettled(child1.id)).toBe(1);
        expect(runs[1].parentJobId).toBe(child1.id);
        const child2 = await insertSettledJob(USER, 'lab', {
            startedBy: 'trigger', triggerId: hop.id, parentJobId: child1.id, finishedAt: utcAgo({ minutes: 10 })
        });
        expect(await svc.evaluateJobSettled(child2.id)).toBe(0);
        expect(runs).toHaveLength(2);
        expect((await db.get('SELECT lastOutcome FROM project_triggers WHERE id = @id', { id: hop.id })).lastOutcome)
            .toMatch(/max chain depth/);

        // Silence the permissive trigger so only the strict one is judged.
        await svc.update({ userId: USER, project: 'lab', trigger: hop.id, isEnabled: false });
        const strict = await svc.create({
            userId: USER, project: 'lab', name: 'No self', kind: 'event',
            eventTopic: 'job_settled', action: 'render', actionParams: { allowSelfChain: false }
        });
        const own = await insertSettledJob(USER, 'lab', {
            startedBy: 'trigger', triggerId: strict.id, parentJobId: root.id, finishedAt: utcAgo({ minutes: 5 })
        });
        expect(await svc.evaluateJobSettled(own.id)).toBe(0);
        expect((await db.get('SELECT lastOutcome FROM project_triggers WHERE id = @id', { id: strict.id })).lastOutcome)
            .toMatch(/self-chain/);
    });

    test('a real event-triggered child job records parentJobId; a cron child does not', async () => {
        const USER = nextUser();
        await seedProject(USER, 'parent-lab', 'Parent Lab');
        const script = await seedNamedScript(USER, 'parent-lab', 'Stage');
        const singletonSpy = jest.spyOn(projectTriggerService, 'evaluateJobSettled').mockResolvedValue(0);
        try {
            const obs = makeRealObservatory(async () => okSandboxResult);
            const svc = makeService({ observatory: obs });
            const cron = await svc.create({
                userId: USER, project: 'parent-lab', name: 'Cron stage', kind: 'cron',
                schedule: '0 1 * * *', action: 'run_script', actionAssetId: script.id,
                actionParams: { background: true }
            });
            await setDue(cron.id);
            await svc.fireDueCronTriggers();
            const cronRow = await db.get('SELECT lastOutcome FROM project_triggers WHERE id = @id', { id: cron.id });
            const cronJobId = Number(/job #(\d+)/.exec(cronRow.lastOutcome)[1]);
            const cronJob = await waitForSettled(cronJobId);
            expect(cronJob.parentJobId).toBeNull();
            expect(cronJob.startedBy).toBe('trigger');

            await svc.create({
                userId: USER, project: 'parent-lab', name: 'Event stage', kind: 'event',
                eventTopic: 'job_completed', sourceTrigger: 'Cron stage',
                action: 'run_script', actionAssetId: script.id, actionParams: { background: true }
            });
            expect(await svc.evaluateJobSettled(cronJob.id)).toBe(1);
            const child = await db.get(
                'SELECT * FROM observatory_jobs WHERE parentJobId = @parent',
                { parent: cronJob.id }
            );
            expect(child).toBeTruthy();
            expect(child.projectId).toBe(cronJob.projectId);
            await waitForSettled(child.id);
            const detail = await obs.getJob({ userId: USER, jobId: child.id });
            expect(detail.parentJobId).toBe(cronJob.id);
        } finally {
            singletonSpy.mockRestore();
        }
    }, 20_000);
});

describe('output contracts through triggers', () => {
    const utcDate = new Date().toISOString().slice(0, 10);

    function writingSandbox(relPath, body = '{"ok":true}') {
        return async ({ projectDir }) => {
            const target = path.join(projectDir, relPath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, body);
            return okSandboxResult;
        };
    }

    test('requiredOutputs are validated at write time and stored normalized', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const svc = makeService();
        for (const requiredOutputs of [
            [{ path: '../escape.json' }],
            [{ path: '/abs/manifest.json' }],
            [{ path: 'out/{unknown_var}.json' }],
            [{ path: 'out/a.json', type: 'exec' }],
            [{ path: 'out/a.json', minBytes: -1 }],
            'not json at all',
            { path: 'not-an-array' }
        ]) {
            await expectThrow(() => svc.create({
                userId: USER, project: 'lab', name: 'Bad contract', kind: 'cron', schedule: '0 1 * * *',
                action: 'run_script', actionAssetId: script.id, actionParams: { requiredOutputs }
            }), { code: 'BAD_OUTPUT_CONTRACT', status: 400 });
        }
        const created = await svc.create({
            userId: USER, project: 'lab', name: 'Good contract', kind: 'cron', schedule: '0 1 * * *',
            action: 'run_script', actionAssetId: script.id,
            actionParams: {
                requiredOutputs: ['pipeline/fetch_manifest_{utc_date}.json', { path: 'out/rows.csv', type: 'FILE', minBytes: '10' }]
            }
        });
        expect(created.actionParams.requiredOutputs).toEqual([
            { path: 'pipeline/fetch_manifest_{utc_date}.json', type: 'file' },
            { path: 'out/rows.csv', type: 'file', minBytes: 10 }
        ]);
        const cleared = await svc.update({
            userId: USER, project: 'lab', trigger: created.id, actionParams: { requiredOutputs: null }
        });
        expect(cleared.actionParams.requiredOutputs).toBeUndefined();
        const emptied = await svc.update({
            userId: USER, project: 'lab', trigger: created.id, actionParams: { requiredOutputs: [] }
        });
        expect(emptied.actionParams.requiredOutputs).toBeUndefined();
    });

    test('a foreground trigger run reports the contract verdict, never a bare "ok: exit 0"', async () => {
        const USER = nextUser();
        await seedProject(USER, 'fg-lab', 'FG Lab');
        const script = await seedNamedScript(USER, 'fg-lab', 'Fetch');
        const singletonSpy = jest.spyOn(projectTriggerService, 'evaluateJobSettled').mockResolvedValue(0);
        try {
            const forgetful = makeService({ observatory: makeRealObservatory(async () => okSandboxResult) });
            const trigger = await forgetful.create({
                userId: USER, project: 'fg-lab', name: 'FG fetch', kind: 'cron', schedule: '0 1 * * *',
                action: 'run_script', actionAssetId: script.id,
                actionParams: {
                    background: false,
                    requiredOutputs: [{ path: 'pipeline/fetch_manifest_{utc_date}.json', type: 'json', minBytes: 2 }]
                }
            });
            await setDue(trigger.id);
            await forgetful.fireDueCronTriggers();
            let row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: trigger.id });
            expect(row.lastOutcome).toBe(
                `failed: fetch v1 exit 0; output contract failed — missing pipeline/fetch_manifest_${utcDate}.json`
            );
            const failedJob = await db.get(
                `SELECT * FROM observatory_jobs WHERE triggerId = @id ORDER BY id DESC LIMIT 1`, { id: trigger.id }
            );
            expect(failedJob.status).toBe('FAILED');
            expect(failedJob.errorCode).toBe('OUTPUT_CONTRACT_FAILED');
            expect(JSON.parse(failedJob.outputContractJson).outputs[0].path)
                .toBe(`pipeline/fetch_manifest_${utcDate}.json`);

            const diligent = makeService({
                observatory: makeRealObservatory(writingSandbox(`pipeline/fetch_manifest_${utcDate}.json`))
            });
            await setDue(trigger.id);
            await diligent.fireDueCronTriggers();
            row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: trigger.id });
            expect(row.lastOutcome).toBe('ok: fetch v1 exit 0, 1 required output(s) validated');
            const okJob = await db.get(
                `SELECT * FROM observatory_jobs WHERE triggerId = @id ORDER BY id DESC LIMIT 1`, { id: trigger.id }
            );
            expect(okJob.status).toBe('COMPLETED');
            expect(okJob.errorCode).toBeNull();

            // Timeouts and cancellations stay distinguishable from contract failures.
            const sleepy = makeService({
                observatory: makeRealObservatory(async () => ({ ...okSandboxResult, ok: false, timedOut: true, exitCode: null }))
            });
            await setDue(trigger.id);
            await sleepy.fireDueCronTriggers();
            row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: trigger.id });
            expect(row.lastOutcome).toBe('failed: fetch v1 timed out');
        } finally {
            singletonSpy.mockRestore();
        }
    }, 20_000);

    test('a contract failure fires job_failed and job_settled but never job_completed', async () => {
        const USER = nextUser();
        await seedProject(USER, 'topic-lab', 'Topic Lab');
        const fetch = await seedNamedScript(USER, 'topic-lab', 'Fetch');
        const next = await seedNamedScript(USER, 'topic-lab', 'Next');
        const singletonSpy = jest.spyOn(projectTriggerService, 'evaluateJobSettled').mockResolvedValue(0);
        try {
            const obs = makeRealObservatory(async () => okSandboxResult);
            const starter = makeService({ observatory: obs });
            const stage = await starter.create({
                userId: USER, project: 'topic-lab', name: 'Fetch stage', kind: 'cron', schedule: '0 1 * * *',
                action: 'run_script', actionAssetId: fetch.id,
                actionParams: { background: true, requiredOutputs: [{ path: 'pipeline/manifest.json', type: 'json' }] }
            });
            await setDue(stage.id);
            await starter.fireDueCronTriggers();
            const stageRow = await db.get('SELECT lastOutcome FROM project_triggers WHERE id = @id', { id: stage.id });
            expect(stageRow.lastOutcome)
                .toMatch(/^started: job #\d+ \(fetch v1\), 1 required output\(s\), awaiting settlement$/);
            const jobId = Number(/job #(\d+)/.exec(stageRow.lastOutcome)[1]);
            const job = await waitForSettled(jobId);
            expect(job.status).toBe('FAILED');
            expect(job.exitCode).toBe(0);
            expect(job.errorCode).toBe('OUTPUT_CONTRACT_FAILED');
            // Settle evaluation writes the stage's result onto the trigger that
            // started it, separately from the dispatch text (the singleton hook
            // is mocked here, so drive it through this instance; no event
            // triggers exist yet, so nothing fires).
            expect(await starter.evaluateJobSettled(job.id)).toBe(0);
            const settledRow = await db.get(
                'SELECT lastOutcome, lastJobOutcome FROM project_triggers WHERE id = @id', { id: stage.id }
            );
            expect(settledRow.lastOutcome).toMatch(/^started: job #\d+/);
            expect(settledRow.lastJobOutcome)
                .toMatch(/^failed: job #\d+ exit 0; output contract failed — missing pipeline\/manifest\.json$/);

            const runs = [];
            const listener = makeService({ observatory: makeFakeObservatory(runs) });
            const topics = {};
            for (const topic of ['job_completed', 'job_failed', 'job_settled']) {
                topics[topic] = (await listener.create({
                    userId: USER, project: 'topic-lab', name: `On ${topic}`, kind: 'event',
                    eventTopic: topic, sourceAsset: 'fetch',
                    action: 'run_script', actionAssetId: next.id, actionParams: { background: true }
                })).id;
            }
            expect(await listener.evaluateJobSettled(job.id)).toBe(2);
            expect(runs.map(r => r.triggerId).sort()).toEqual([topics.job_failed, topics.job_settled].sort());
            expect(runs.every(r => r.parentJobId === job.id)).toBe(true);
            const completed = await db.get(
                'SELECT lastRun, lastOutcome FROM project_triggers WHERE id = @id', { id: topics.job_completed }
            );
            expect(completed.lastRun).toBeNull();
            expect(completed.lastOutcome).toBeNull();
        } finally {
            singletonSpy.mockRestore();
        }
    }, 20_000);

    test('editing the trigger while its job runs does not alter the frozen contract', async () => {
        const USER = nextUser();
        await seedProject(USER, 'freeze-lab', 'Freeze Lab');
        const script = await seedNamedScript(USER, 'freeze-lab', 'Fetch');
        const singletonSpy = jest.spyOn(projectTriggerService, 'evaluateJobSettled').mockResolvedValue(0);
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        try {
            const obs = makeRealObservatory(async ({ projectDir }) => {
                await gate;
                // The job writes the file the EDITED trigger asks for, not the original.
                fs.mkdirSync(path.join(projectDir, 'pipeline'), { recursive: true });
                fs.writeFileSync(path.join(projectDir, 'pipeline', 'renamed.json'), '{}');
                return okSandboxResult;
            });
            const svc = makeService({ observatory: obs });
            const trigger = await svc.create({
                userId: USER, project: 'freeze-lab', name: 'Frozen', kind: 'cron', schedule: '0 1 * * *',
                action: 'run_script', actionAssetId: script.id,
                actionParams: { background: true, requiredOutputs: [{ path: 'pipeline/original_{utc_date}.json' }] }
            });
            await setDue(trigger.id);
            await svc.fireDueCronTriggers();
            const running = await db.get(
                'SELECT * FROM observatory_jobs WHERE triggerId = @id', { id: trigger.id }
            );
            expect(running.status).toBe('RUNNING');
            const frozenBefore = running.outputContractJson;
            expect(JSON.parse(frozenBefore).outputs).toEqual([
                { path: `pipeline/original_${utcDate}.json`, type: 'file' }
            ]);

            await svc.update({
                userId: USER, project: 'freeze-lab', trigger: trigger.id,
                actionParams: { requiredOutputs: [{ path: 'pipeline/renamed.json' }] }
            });
            release();
            const settled = await waitForSettled(running.id);
            expect(settled.outputContractJson).toBe(frozenBefore);
            expect(settled.status).toBe('FAILED');
            expect(settled.errorCode).toBe('OUTPUT_CONTRACT_FAILED');
            expect(settled.error).toBe(`output contract failed — missing pipeline/original_${utcDate}.json`);
        } finally {
            release?.();
            singletonSpy.mockRestore();
        }
    }, 20_000);
});

/** Catch-up and retry are global sweeps; judge them by what they did for ONE trigger. */
function firesFor(runs, triggerId) {
    return runs.filter(r => r.triggerId === triggerId);
}

async function waitFor(predicate, { timeoutMs = 10_000, what = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 40));
    }
}

describe('event delivery records', () => {
    const { DELIVERY, MAX_DELIVERY_ATTEMPTS } = projectTriggerService;

    async function deliveries(triggerId) {
        return await db.all(
            'SELECT * FROM project_trigger_deliveries WHERE triggerId = @id ORDER BY id ASC', { id: triggerId }
        );
    }

    /** A fake Observatory whose first `busyTimes` runs refuse with a transient code. */
    function busyThenOkObservatory(runs, busyTimes, code = 'PROJECT_BUSY') {
        const inner = makeFakeObservatory(runs);
        let refusals = 0;
        return {
            ...inner,
            async run(opts) {
                if (refusals < busyTimes) {
                    refusals++;
                    const error = new Error('Project already has a running job.');
                    error.code = code;
                    throw error;
                }
                return await inner.run(opts);
            }
        };
    }

    test('two matching jobs that finished in the same second are two events, not one', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const trigger = await svc.create({
            userId: USER, project: 'lab', name: 'Fan in', kind: 'event',
            eventTopic: 'job_completed', action: 'run_script',
            actionAssetId: script.id, actionParams: { background: true }
        });
        const sameSecond = utcAgo({ minutes: 2 });
        const a = await insertSettledJob(USER, 'lab', { finishedAt: sameSecond });
        const b = await insertSettledJob(USER, 'lab', { finishedAt: sameSecond });
        expect(await svc.evaluateJobSettled(a.id)).toBe(1);
        expect(await svc.evaluateJobSettled(b.id)).toBe(1);
        expect(runs.map(r => r.parentJobId)).toEqual([a.id, b.id]);
        const rows = await deliveries(trigger.id);
        expect(rows.map(r => [r.sourceJobId, r.status, r.childJobId])).toEqual([
            [a.id, DELIVERY.DELIVERED, 101], [b.id, DELIVERY.DELIVERED, 102]
        ]);
        expect((await db.get('SELECT lastRun FROM project_triggers WHERE id = @id', { id: trigger.id })).lastRun)
            .toBe(sameSecond);
        // Neither the settle path nor catch-up can process either event again.
        expect(await svc.evaluateJobSettled(a.id)).toBe(0);
        await svc.catchUpEventTriggers();
        expect(firesFor(runs, trigger.id)).toHaveLength(2);
        expect(await deliveries(trigger.id)).toHaveLength(2);
    });

    test('an older matching job examined after a newer one is still delivered', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const trigger = await svc.create({
            userId: USER, project: 'lab', name: 'Late arrival', kind: 'event',
            eventTopic: 'job_settled', action: 'render'
        });
        const older = await insertSettledJob(USER, 'lab', { finishedAt: utcAgo({ minutes: 10 }) });
        const newer = await insertSettledJob(USER, 'lab', { finishedAt: utcAgo({ minutes: 1 }) });
        expect(await svc.evaluateJobSettled(newer.id)).toBe(1);
        expect(await svc.evaluateJobSettled(older.id)).toBe(1);
        const rows = await deliveries(trigger.id);
        expect(rows.map(r => r.sourceJobId).sort()).toEqual([older.id, newer.id].sort());
        expect(rows.every(r => r.status === DELIVERY.DELIVERED)).toBe(true);
        // lastRun is a display cursor: it stays at the newest finish.
        expect((await db.get('SELECT lastRun FROM project_triggers WHERE id = @id', { id: trigger.id })).lastRun)
            .toBe(newer.finishedAt);
    });

    test('a busy project leaves the delivery RETRYABLE and the retry creates exactly one child', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const runs = [];
        const svc = makeService({ observatory: busyThenOkObservatory(runs, 1) });
        const trigger = await svc.create({
            userId: USER, project: 'lab', name: 'Relay', kind: 'event',
            eventTopic: 'job_completed', action: 'run_script',
            actionAssetId: script.id, actionParams: { background: true }
        });
        const source = await insertSettledJob(USER, 'lab', {});

        expect(await svc.evaluateJobSettled(source.id)).toBe(0);
        expect(runs).toHaveLength(0);
        let [row] = await deliveries(trigger.id);
        expect(row).toMatchObject({ sourceJobId: source.id, status: DELIVERY.RETRYABLE, attempts: 1, childJobId: null });
        expect(row.nextAttemptAt).toBeTruthy();
        expect(row.nextAttemptAt > utcText()).toBe(true);
        const outcome = await db.get('SELECT lastOutcome FROM project_triggers WHERE id = @id', { id: trigger.id });
        expect(outcome.lastOutcome).toMatch(/^deferred: Project already has a running job\. — will retry$/);

        // The event is not re-examined by the settle path or catch-up, and
        // the retry loop honours the backoff.
        expect(await svc.evaluateJobSettled(source.id)).toBe(0);
        await svc.catchUpEventTriggers();
        await svc.retryEventDeliveries();
        expect(firesFor(runs, trigger.id)).toHaveLength(0);
        expect((await deliveries(trigger.id))[0]).toMatchObject({ status: DELIVERY.RETRYABLE, attempts: 1 });

        await db.run(
            'UPDATE project_trigger_deliveries SET nextAttemptAt = @past WHERE id = @id',
            { id: row.id, past: utcAgo({ minutes: 1 }) }
        );
        expect(await svc.retryEventDeliveries()).toBeGreaterThanOrEqual(1);
        const mine = firesFor(runs, trigger.id);
        expect(mine).toHaveLength(1);
        expect(mine[0].parentJobId).toBe(source.id);
        [row] = await deliveries(trigger.id);
        expect(row).toMatchObject({ status: DELIVERY.DELIVERED, attempts: 2, nextAttemptAt: null });
        expect(row.childJobId).toBeGreaterThan(100);
        expect((await db.get('SELECT lastOutcome FROM project_triggers WHERE id = @id', { id: trigger.id })).lastOutcome)
            .toMatch(new RegExp(`^started: job #${row.childJobId} \\(ingest v1\\), awaiting settlement$`));
        // And never again.
        await svc.retryEventDeliveries();
        await svc.catchUpEventTriggers();
        expect(firesFor(runs, trigger.id)).toHaveLength(1);
        expect(await deliveries(trigger.id)).toHaveLength(1);
    });

    test('a sandbox BUSY and an active-job cap are retryable; a missing head is a permanent failure', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        for (const code of ['BUSY', 'TOO_MANY_JOBS']) {
            const runs = [];
            const svc = makeService({ observatory: busyThenOkObservatory(runs, 5, code) });
            const trigger = await svc.create({
                userId: USER, project: 'lab', name: `Relay ${code}`, kind: 'event',
                eventTopic: 'job_settled', action: 'run_script',
                actionAssetId: script.id, actionParams: { background: true }
            });
            const source = await insertSettledJob(USER, 'lab', {});
            expect(await svc.evaluateJobSettled(source.id)).toBe(0);
            expect((await deliveries(trigger.id))[0].status).toBe(DELIVERY.RETRYABLE);
            await svc.update({ userId: USER, project: 'lab', trigger: trigger.id, isEnabled: false });
        }

        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const headless = await new ProjectAssetService().save({
            userId: USER, project: 'lab', name: 'Headless', kind: 'script',
            language: 'python', source: 'print(0)', origin: 'portal'
        });
        const trigger = await svc.create({
            userId: USER, project: 'lab', name: 'Broken relay', kind: 'event',
            eventTopic: 'job_settled', action: 'run_script',
            actionAssetId: headless.id, actionParams: { background: true }
        });
        await db.run('UPDATE project_assets SET currentVersionId = NULL WHERE id = @id', { id: headless.id });
        const source = await insertSettledJob(USER, 'lab', {});
        expect(await svc.evaluateJobSettled(source.id)).toBe(0);
        const [row] = await deliveries(trigger.id);
        expect(row).toMatchObject({ status: DELIVERY.FAILED, detail: 'script asset has no head version' });
        await svc.retryEventDeliveries();
        expect(firesFor(runs, trigger.id)).toHaveLength(0);
        expect((await deliveries(trigger.id))[0].status).toBe(DELIVERY.FAILED);
    });

    test('retries give up after MAX_DELIVERY_ATTEMPTS with a failed outcome, never silently', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const runs = [];
        const svc = makeService({ observatory: busyThenOkObservatory(runs, 1000) });
        const trigger = await svc.create({
            userId: USER, project: 'lab', name: 'Stuck relay', kind: 'event',
            eventTopic: 'job_completed', action: 'run_script',
            actionAssetId: script.id, actionParams: { background: true }
        });
        const source = await insertSettledJob(USER, 'lab', {});
        expect(await svc.evaluateJobSettled(source.id)).toBe(0);
        await db.run(
            `UPDATE project_trigger_deliveries SET attempts = @attempts, nextAttemptAt = @past
             WHERE triggerId = @id`,
            { id: trigger.id, attempts: MAX_DELIVERY_ATTEMPTS - 1, past: utcAgo({ minutes: 1 }) }
        );
        await svc.retryEventDeliveries();
        const [row] = await deliveries(trigger.id);
        expect(row).toMatchObject({ status: DELIVERY.FAILED, attempts: MAX_DELIVERY_ATTEMPTS, nextAttemptAt: null });
        expect((await db.get('SELECT lastOutcome FROM project_triggers WHERE id = @id', { id: trigger.id })).lastOutcome)
            .toMatch(new RegExp(`^failed: gave up after ${MAX_DELIVERY_ATTEMPTS} attempts: `));
        await svc.retryEventDeliveries();
        expect(firesFor(runs, trigger.id)).toHaveLength(0);
    });

    test('a STARTED delivery abandoned by a crash is reaped and retried after the lease', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const trigger = await svc.create({
            userId: USER, project: 'lab', name: 'Crashed mid-dispatch', kind: 'event',
            eventTopic: 'job_completed', action: 'run_script',
            actionAssetId: script.id, actionParams: { background: true }
        });
        const source = await insertSettledJob(USER, 'lab', {});
        // Claim without dispatching = the process died between the two.
        expect(await svc.claimEventFire({ ...trigger, isEnabled: 1 }, source)).toBe(true);
        await svc.retryEventDeliveries();
        expect(firesFor(runs, trigger.id)).toHaveLength(0);
        expect((await deliveries(trigger.id))[0].status).toBe(DELIVERY.STARTED);
        await db.run(
            'UPDATE project_trigger_deliveries SET updatedAt = @old WHERE triggerId = @id',
            { id: trigger.id, old: utcAgo({ minutes: 30 }) }
        );
        await svc.retryEventDeliveries();
        const mine = firesFor(runs, trigger.id);
        expect(mine).toHaveLength(1);
        expect(mine[0].parentJobId).toBe(source.id);
        const [row] = await deliveries(trigger.id);
        expect(row).toMatchObject({ status: DELIVERY.DELIVERED, attempts: 2 });
    });

    test('a trigger from before delivery records does not replay its consumed history', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const runs = [];
        const svc = makeService({ observatory: makeFakeObservatory(runs) });
        const trigger = await svc.create({
            userId: USER, project: 'lab', name: 'Legacy', kind: 'event',
            eventTopic: 'job_settled', action: 'run_script',
            actionAssetId: script.id, actionParams: { background: true }
        });
        const consumedA = await insertSettledJob(USER, 'lab', { finishedAt: utcAgo({ minutes: 50 }) });
        const consumedB = await insertSettledJob(USER, 'lab', { finishedAt: utcAgo({ minutes: 40 }) });
        const fresh = await insertSettledJob(USER, 'lab', { finishedAt: utcAgo({ minutes: 5 }) });
        // The old cursor said "everything up to consumedB was handled".
        await db.run(
            'UPDATE project_triggers SET lastRun = @lastRun WHERE id = @id',
            { id: trigger.id, lastRun: consumedB.finishedAt }
        );
        await svc.catchUpEventTriggers();
        const mine = firesFor(runs, trigger.id);
        expect(mine).toHaveLength(1);
        expect(mine[0].parentJobId).toBe(fresh.id);
        const rows = await deliveries(trigger.id);
        expect(rows.map(r => [r.sourceJobId, r.status])).toEqual([
            [consumedA.id, DELIVERY.DELIVERED], [consumedB.id, DELIVERY.DELIVERED], [fresh.id, DELIVERY.DELIVERED]
        ]);
        expect(rows[0].detail).toMatch(/^legacy:/);
        expect(rows[2].detail).toMatch(/^job #\d+/);
        await svc.catchUpEventTriggers();
        expect(firesFor(runs, trigger.id)).toHaveLength(1);
        expect(await deliveries(trigger.id)).toHaveLength(3);
    });

    test('listDeliveries explains each event; deleting the trigger or the user removes the records', async () => {
        const USER = nextUser();
        await seedProject(USER);
        const script = await seedScript(USER);
        const runs = [];
        const svc = makeService({ observatory: busyThenOkObservatory(runs, 1) });
        const trigger = await svc.create({
            userId: USER, project: 'lab', name: 'Explained', kind: 'event',
            eventTopic: 'job_completed', action: 'run_script',
            actionAssetId: script.id, actionParams: { background: true }
        });
        const first = await insertSettledJob(USER, 'lab', { finishedAt: utcAgo({ minutes: 3 }) });
        const second = await insertSettledJob(USER, 'lab', { finishedAt: utcAgo({ minutes: 1 }) });
        await svc.evaluateJobSettled(first.id);
        await svc.evaluateJobSettled(second.id);
        const listed = await svc.listDeliveries({ userId: USER, project: 'lab', trigger: 'Explained' });
        expect(listed).toHaveLength(2);
        expect(listed[0]).toMatchObject({
            sourceJobId: second.id, sourceStatus: 'COMPLETED', status: DELIVERY.DELIVERED, childJobId: 101, attempts: 1
        });
        expect(listed[1]).toMatchObject({
            sourceJobId: first.id, status: DELIVERY.RETRYABLE, childJobId: null, attempts: 1
        });
        expect(listed[1].detail).toMatch(/running job/);

        const other = await svc.create({
            userId: USER, project: 'lab', name: 'Kept', kind: 'event', eventTopic: 'job_settled', action: 'render'
        });
        await svc.evaluateJobSettled(second.id);
        await svc.delete({ userId: USER, project: 'lab', trigger: trigger.id });
        expect(await deliveries(trigger.id)).toHaveLength(0);
        expect(await deliveries(other.id)).toHaveLength(1);
        await svc.forgetUser(USER);
        expect(await deliveries(other.id)).toHaveLength(0);
    });
});

describe('two-stage pipeline scenario (real Observatory, fake sandbox)', () => {
    const { DELIVERY } = projectTriggerService;

    function writingSandbox(relPath, body = '{"ok":true}') {
        return async ({ projectDir }) => {
            const target = path.join(projectDir, relPath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, body);
            return okSandboxResult;
        };
    }

    /**
     * Fire Stage 2 and wait until the Observatory's post-settle hook has run
     * for that job (the trigger that started it carries its verdict), so
     * assertions about downstream dispatch are not racing the settle path.
     */
    async function fireStage2(svc, stage2Id) {
        await setDue(stage2Id);
        await svc.fireDueCronTriggers();
        const row = await db.get('SELECT lastOutcome FROM project_triggers WHERE id = @id', { id: stage2Id });
        expect(row.lastOutcome).toMatch(/^started: job #\d+ \(fetch v1\), 1 required output\(s\), awaiting settlement$/);
        const jobId = Number(/job #(\d+)/.exec(row.lastOutcome)[1]);
        const job = await waitForSettled(jobId);
        await waitFor(async () => {
            const t = await db.get('SELECT lastJobOutcome FROM project_triggers WHERE id = @id', { id: stage2Id });
            return t.lastJobOutcome && t.lastJobOutcome.includes(`job #${jobId}`);
        }, { what: `settle hook for job #${jobId}` });
        return job;
    }

    test('a missing manifest never relays; a valid one relays exactly once; a busy project retries', async () => {
        const USER = nextUser();
        await seedProject(USER, 'atlas', 'Atlas');
        const fetch = await seedNamedScript(USER, 'atlas', 'Fetch');
        const stage3Script = await seedNamedScript(USER, 'atlas', 'Stage Three');
        const utcDate = new Date().toISOString().slice(0, 10);
        const manifest = `pipeline/fetch_manifest_${utcDate}.json`;

        // The sandbox behaviour is swapped per step; the Observatory (and
        // therefore the real settle path) stays the same instance.
        let sandboxBehaviour = async () => okSandboxResult;
        const obs = makeRealObservatory((opts) => sandboxBehaviour(opts));
        const svc = makeService({ observatory: obs });
        // Route the Observatory's singleton settle hook into this instance,
        // optionally making the project busy first (step 6).
        let blockBeforeSettle = false;
        const singletonSpy = jest.spyOn(projectTriggerService, 'evaluateJobSettled')
            .mockImplementation(async (jobId, opts) => {
                if (blockBeforeSettle) {
                    blockBeforeSettle = false;
                    const project = await db.get(
                        'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug',
                        { userId: USER, slug: 'atlas' }
                    );
                    await db.insert(
                        `INSERT INTO observatory_jobs (projectId, userId, language, code, status, startedBy)
                         VALUES (@projectId, @userId, 'python', 'print(1)', 'RUNNING', 'chat')`,
                        { projectId: project.id, userId: USER }
                    );
                }
                return await svc.evaluateJobSettled(jobId, opts);
            });
        try {
            const stage2 = await svc.create({
                userId: USER, project: 'atlas', name: 'Stage 2 fetch', kind: 'cron', schedule: '0 1 * * *',
                action: 'run_script', actionAssetId: fetch.id,
                actionParams: {
                    background: true,
                    requiredOutputs: [{ path: 'pipeline/fetch_manifest_{utc_date}.json', type: 'json', minBytes: 2 }]
                }
            });
            const stage3 = await svc.create({
                userId: USER, project: 'atlas', name: 'Stage 3 build', kind: 'event',
                eventTopic: 'job_completed', sourceAsset: 'fetch',
                action: 'run_script', actionAssetId: stage3Script.id, actionParams: { background: true }
            });
            const stage3Children = async () => await db.all(
                'SELECT * FROM observatory_jobs WHERE triggerId = @id ORDER BY id ASC', { id: stage3.id }
            );

            // 1-3. Stage 2 exits 0 without a manifest -> OUTPUT_CONTRACT_FAILED; Stage 3 never launches.
            const broken = await fireStage2(svc, stage2.id);
            expect(broken.status).toBe('FAILED');
            expect(broken.exitCode).toBe(0);
            expect(broken.errorCode).toBe('OUTPUT_CONTRACT_FAILED');
            expect(await stage3Children()).toHaveLength(0);
            expect(await db.all(
                'SELECT * FROM project_trigger_deliveries WHERE triggerId = @id', { id: stage3.id }
            )).toHaveLength(0);
            let stage2Row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: stage2.id });
            expect(stage2Row.lastJobOutcome)
                .toBe(`failed: job #${broken.id} exit 0; output contract failed — missing ${manifest}`);
            let stage3Row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: stage3.id });
            expect(stage3Row.lastOutcome).toBeNull();

            // 4-5. Stage 2 writes a valid manifest -> exactly one Stage 3 child with the right parent.
            sandboxBehaviour = writingSandbox(manifest);
            const good = await fireStage2(svc, stage2.id);
            expect(good.status).toBe('COMPLETED');
            expect(good.errorCode).toBeNull();
            expect(JSON.parse(good.outputContractResultJson)).toMatchObject({ ok: true });
            let children = await stage3Children();
            expect(children).toHaveLength(1);
            expect(children[0].parentJobId).toBe(good.id);
            expect(children[0].startedBy).toBe('trigger');
            const child = await waitForSettled(children[0].id);
            expect(child.status).toBe('COMPLETED');
            await waitFor(async () => (await db.get(
                'SELECT lastJobOutcome FROM project_triggers WHERE id = @id', { id: stage3.id }
            )).lastJobOutcome, { what: 'stage 3 settle hook' });
            stage2Row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: stage2.id });
            expect(stage2Row.lastJobOutcome)
                .toBe(`ok: job #${good.id} completed, 1 required output(s) validated`);
            stage3Row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: stage3.id });
            expect(stage3Row.lastOutcome)
                .toBe(`started: job #${child.id} (stage-three v1), awaiting settlement`);
            expect(stage3Row.lastJobOutcome).toBe(`ok: job #${child.id} completed`);
            let stage3Deliveries = await svc.listDeliveries({ userId: USER, project: 'atlas', trigger: stage3.id });
            expect(stage3Deliveries).toHaveLength(1);
            expect(stage3Deliveries[0]).toMatchObject({
                sourceJobId: good.id, status: DELIVERY.DELIVERED, childJobId: child.id, childStatus: 'COMPLETED'
            });
            // The catch-up and retry loops find nothing left to do here.
            await svc.catchUpEventTriggers();
            await svc.retryEventDeliveries();
            expect(await stage3Children()).toHaveLength(1);

            // 6-7. Stage 2 succeeds while the project is busy at dispatch time:
            // the Stage 3 event is RETRYABLE, not gone, and retries once free.
            blockBeforeSettle = true;
            const busyRun = await fireStage2(svc, stage2.id);
            expect(busyRun.status).toBe('COMPLETED');
            expect(await stage3Children()).toHaveLength(1);
            stage3Deliveries = await svc.listDeliveries({ userId: USER, project: 'atlas', trigger: stage3.id });
            expect(stage3Deliveries[0]).toMatchObject({
                sourceJobId: busyRun.id, status: DELIVERY.RETRYABLE, attempts: 1, childJobId: null
            });
            expect(stage3Deliveries[0].detail).toMatch(/running job/);
            stage3Row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: stage3.id });
            expect(stage3Row.lastOutcome).toMatch(/^deferred: .*will retry$/);

            // Still busy: the retry loop waits for the backoff and the project.
            await db.run(
                'UPDATE project_trigger_deliveries SET nextAttemptAt = @past WHERE triggerId = @id AND sourceJobId = @job',
                { id: stage3.id, job: busyRun.id, past: utcAgo({ minutes: 1 }) }
            );
            await svc.retryEventDeliveries();
            stage3Deliveries = await svc.listDeliveries({ userId: USER, project: 'atlas', trigger: stage3.id });
            expect(stage3Deliveries[0]).toMatchObject({ status: DELIVERY.RETRYABLE, attempts: 2 });
            expect(await stage3Children()).toHaveLength(1);

            // The blocker finishes; the next retry relays exactly one child.
            await db.run(
                `UPDATE observatory_jobs SET status = 'COMPLETED', finishedAt = datetime('now')
                 WHERE status = 'RUNNING' AND startedBy = 'chat' AND userId = @userId`,
                { userId: USER }
            );
            await db.run(
                'UPDATE project_trigger_deliveries SET nextAttemptAt = @past WHERE triggerId = @id AND sourceJobId = @job',
                { id: stage3.id, job: busyRun.id, past: utcAgo({ minutes: 1 }) }
            );
            expect(await svc.retryEventDeliveries()).toBeGreaterThanOrEqual(1);
            children = await stage3Children();
            expect(children).toHaveLength(2);
            expect(children[1].parentJobId).toBe(busyRun.id);
            await waitForSettled(children[1].id);
            stage3Deliveries = await svc.listDeliveries({ userId: USER, project: 'atlas', trigger: stage3.id });
            expect(stage3Deliveries[0]).toMatchObject({
                sourceJobId: busyRun.id, status: DELIVERY.DELIVERED, attempts: 3, childJobId: children[1].id
            });
            await svc.retryEventDeliveries();
            await svc.catchUpEventTriggers();
            expect(await stage3Children()).toHaveLength(2);
        } finally {
            singletonSpy.mockRestore();
        }
    }, 30_000);
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
