/**
 * Service-seam gating (#318 review, epic #315).
 *
 * The execution surfaces were gated at their doors; these specs prove the
 * seams *behind* the doors refuse too, so a caller that reaches a service
 * through a route nobody gated (a mission step, a project trigger, the
 * personal heartbeat, the exchange risk sweep, the Inbox echo, voice
 * construction, an automation claim) cannot run a feature that is enforced
 * off.
 *
 * Unlike the surface specs these use the LIVE config modules (the legacy
 * switches stay ON through env) and drive only the enforcement state, so the
 * thing under test is not mocked: a service must refuse because of
 * `features.enforcedOff`, not because a fixture said "disabled". Every refusal
 * is checked for no database write, no fetch, no provider call and no child
 * process; every "no state" case is checked for today's answer.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.GOOBSTER_DB_PATH = process.env.GOOBSTER_DB_PATH
    || path.join(os.tmpdir(), `goobster-gating-services-${process.pid}.sqlite`);
process.env.GOOBSTER_SANDBOX_ENABLED = '1';
process.env.GOOBSTER_OBSERVATORY_ENABLED = '1';
process.env.GOOBSTER_VAPID_PUBLIC_KEY = 'BIPUL12DLfytvTajnryr2PRdAgXS3HGKiLqndGcJGabyhHheJPFbo0gxnXrbZw4mE0-lrGvJ60YaHKY5aCcB4Ho';
process.env.GOOBSTER_VAPID_PRIVATE_KEY = 'kU0z4tWfbfKvGwb1cQ8M9Cn0jbDYpR0yYQpCwjvSb1k';
process.env.GOOBSTER_VAPID_SUBJECT = 'mailto:test@example.com';
process.env.GOOBSTER_MAIL_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 're_test_key';
process.env.GOOBSTER_MAIL_FROM = 'Goobster <goobster@example.test>';

const mockChildProcess = (() => {
    const actual = jest.requireActual('node:child_process');
    return {
        ...actual,
        spawn: jest.fn((...args) => actual.spawn(...args)),
        spawnSync: jest.fn((...args) => actual.spawnSync(...args)),
        execSync: jest.fn((...args) => actual.execSync(...args)),
        exec: jest.fn((...args) => actual.exec(...args)),
        execFile: jest.fn((...args) => actual.execFile(...args)),
        execFileSync: jest.fn((...args) => actual.execFileSync(...args))
    };
})();
jest.mock('node:child_process', () => mockChildProcess);
jest.mock('child_process', () => mockChildProcess);

const mockWheel = { spin: jest.fn() };
jest.mock('@goobster/core/services/exchange/wheelService', () => ({ spin: (...args) => mockWheel.spin(...args) }));
jest.mock('@goobster/core/services/exchange/wheelPresenter', () => ({
    buildWheelEmbed: () => ({ title: 'wheel' }),
    resolveNames: async () => new Map()
}));
jest.mock('@goobster/core/services/economyService', () => ({
    getSettings: async () => ({ currencyName: 'jimbucks' })
}));

const db = require('@goobster/core/db');
const { features, envVarFor } = require('@goobster/core/features/featureState');
const inventory = require('@goobster/core/features/inventory');
const sandboxConfig = require('@goobster/core/config/sandboxConfig');
const observatoryConfig = require('@goobster/core/config/observatoryConfig');
const spitballConfig = require('@goobster/core/config/spitballConfig');
const sandboxService = require('@goobster/core/services/sandboxService');
const { SandboxService } = sandboxService;
const observatoryService = require('@goobster/core/services/observatoryService');
const { ObservatoryService } = require('@goobster/core/services/projectService');
const spitballService = require('@goobster/core/services/spitballExpeditionService');
const { SpitballExpeditionService } = spitballService;
const spitballRunner = require('@goobster/core/services/spitballExpeditionRunner');
const { ProjectMissionService } = require('@goobster/core/services/projectMissionService');
const projectMissionService = require('@goobster/core/services/projectMissionService');
const { ProjectTriggerService } = require('@goobster/core/services/projectTriggerService');
const { ProjectAssetService } = require('@goobster/core/services/projectAssetService');
const PersonalHeartbeatService = require('@goobster/core/services/personalHeartbeatService');
const RiskEngine = require('@goobster/core/services/exchange/riskEngine');
const predictionService = require('@goobster/core/services/exchange/predictionService');
const pushService = require('@goobster/core/services/pushService');
const inboxService = require('@goobster/core/services/inboxService');
const { MailService } = require('@goobster/core/services/mailService');
const AutomationService = require('@goobster/core/services/automationService');
const eventBusService = require('@goobster/core/services/eventBusService');
const { FollowedSourceService } = require('@goobster/core/services/followedSourceService');
const { PROJECTS_ROOT } = require('@goobster/core/services/projectService');

const FILE = '/virtual/data/features.json';
const MANAGEABLE = inventory.FEATURE_IDS.filter(id => id !== 'core');

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function memoryFs(files = {}) {
    const store = new Map(Object.entries(files));
    const missing = (p) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    return {
        existsSync: p => store.has(p),
        readFileSync(p) { if (!store.has(p)) throw missing(p); return store.get(p); },
        writeFileSync: (p, data) => store.set(p, String(data)),
        renameSync(from, to) { store.set(to, store.get(from)); store.delete(from); },
        mkdirSync() {},
        unlinkSync: p => store.delete(p)
    };
}

/**
 * Drive only the enforcement state. `off` uses GOOBSTER_FEATURE_<ID>=off
 * (the override path); `inactive` writes a features.json with those ids off
 * and everything else on (the state-file path). Neither touches the legacy
 * switches the services read from the live config modules.
 */
function setState({ off = [], inactive = null } = {}) {
    const env = {};
    for (const id of off) env[envVarFor(id)] = 'off';
    let files = {};
    if (inactive) {
        const entries = {};
        for (const id of MANAGEABLE) entries[id] = { installed: true, active: !inactive.includes(id) };
        files = {
            [FILE]: JSON.stringify({
                version: 1, revision: 1, updatedAt: '2026-10-06 12:00:00', origin: 'operator', features: entries
            })
        };
    }
    features._resetForTests({ fs: memoryFs(files), filePath: FILE, env, config: {} });
}

const spies = { fetch: null };

beforeEach(() => {
    setState();
    spies.fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => {
        throw new Error('network is off in this spec');
    });
    for (const fn of Object.values(mockChildProcess)) if (jest.isMockFunction(fn)) fn.mockClear();
    mockWheel.spin.mockReset();
});

afterEach(() => {
    jest.restoreAllMocks();
    setState();
});

afterAll(async () => {
    try { await eventBusService.close(); } catch { /* not opened */ }
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(process.env.GOOBSTER_DB_PATH + suffix, { force: true }); } catch { /* held open */ }
    }
    for (const userId of createdUsers) {
        try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* none */ }
    }
});

let userSeq = 0;
const createdUsers = [];
function nextUser() {
    const userId = `gate-svc-${process.pid}-${userSeq++}`;
    createdUsers.push(userId);
    return userId;
}

async function count(table, where = '1 = 1', params = {}) {
    const row = await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
    return Number(row.n);
}

async function seedProject(userId, slug = 'lab', name = 'Lab') {
    await db.run(
        'INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, @slug, @name)',
        { userId, slug, name }
    );
    return db.get('SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug', { userId, slug });
}

async function seedScript(userId, name = 'Bench', source = 'print("secret-source-text")') {
    return new ProjectAssetService().save({
        userId, project: 'lab', name, kind: 'script', language: 'python', source, origin: 'portal'
    });
}

async function expectRefusal(promise, { feature, code = 'FEATURE_UNAVAILABLE' } = {}) {
    let caught = null;
    try { await promise; } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe(code);
    if (feature) expect(caught.feature).toBe(feature);
    return caught;
}

function noChildProcess() {
    for (const name of ['spawn', 'spawnSync', 'execSync', 'exec', 'execFile', 'execFileSync']) {
        expect(mockChildProcess[name]).not.toHaveBeenCalled();
    }
}

/* ------------------------------------------------------------------ */
/* 1. observatory, sandbox, expeditions                                */
/* ------------------------------------------------------------------ */

describe('the reproducing probe: legacy on, enforced off', () => {
    test('the live config modules read true while the surfaces are enforced off', () => {
        setState({ off: ['sandbox', 'expeditions'] });
        expect(sandboxConfig.enabled).toBe(true);
        expect(observatoryConfig.enabled).toBe(true);
        expect(spitballConfig.enabled).toBe(true);
        const refused = features.enforcedUnavailable().map(entry => entry.id);
        expect(refused).toEqual(expect.arrayContaining(['sandbox', 'observatory', 'expeditions']));
        expect(sandboxService.enabled).toBe(false);
        expect(observatoryService.enabled).toBe(false);
        expect(spitballService.enabled).toBe(false);
    });
});

describe('sandbox.enabled and run', () => {
    test('no state, legacy on: enabled; a run gets past the gate and fails on its own validation', async () => {
        expect(sandboxService.enabled).toBe(true);
        await expectRefusal(sandboxService.run({ language: 'cobol', code: 'x', record: false }), { code: 'BAD_LANGUAGE' });
        noChildProcess();
    });

    test('no state, legacy off: exactly the old DISABLED answer (and its ledger row)', async () => {
        const off = new SandboxService({ enabled: false });
        expect(off.enabled).toBe(false);
        const before = await count('work_failures', "code = 'DISABLED'");
        await expectRefusal(off.run({ language: 'python', code: 'print(1)', userId: 'u1' }), { code: 'DISABLED' });
        expect(await count('work_failures', "code = 'DISABLED'")).toBe(before + 1);
    });

    test.each([
        ['override', { off: ['sandbox'] }],
        ['state file', { inactive: ['sandbox'] }]
    ])('enforced off (%s): refuses with FEATURE_UNAVAILABLE, writes nothing, spawns nothing', async (_name, state) => {
        setState(state);
        expect(sandboxService.enabled).toBe(false);
        const failures = await count('work_failures');
        const events = await count('resource_events');
        const error = await expectRefusal(
            sandboxService.run({ language: 'python', code: 'print(1)', userId: 'u1' }),
            { feature: 'sandbox' }
        );
        expect(error.status).toBe(404);
        expect(await count('work_failures')).toBe(failures);
        expect(await count('resource_events')).toBe(events);
        expect(spies.fetch).not.toHaveBeenCalled();
        noChildProcess();
    });
});

describe('observatoryService.run', () => {
    async function runRequest(userId) {
        return observatoryService.run({
            userId, project: 'lab', language: 'python', code: 'print(1)', background: true
        });
    }

    test('no state, legacy on: the run gets past the gate (the project is what is missing)', async () => {
        const userId = nextUser();
        const error = await runRequest(userId).catch(e => e);
        expect(error.code).not.toBe('FEATURE_UNAVAILABLE');
        expect(error.code).not.toBe('DISABLED');
        noChildProcess();
    });

    test('no state, legacy off: the old DISABLED answer', async () => {
        const off = new ObservatoryService({
            config: { ...observatoryConfig, enabled: false, projectsEnabled: true },
            sandbox: { enabled: true }
        });
        await expectRefusal(off.run({ userId: 'u', project: 'lab', language: 'python', code: '1' }), { code: 'DISABLED' });
    });

    test.each([
        ['observatory override', { off: ['observatory'] }],
        ['observatory state file', { inactive: ['observatory'] }],
        ['projects override (dependency)', { off: ['projects'] }]
    ])('enforced off (%s): refuses with FEATURE_UNAVAILABLE and creates no job', async (_name, state) => {
        const userId = nextUser();
        const project = await seedProject(userId);
        setState(state);
        const jobs = await count('observatory_jobs');
        const error = await expectRefusal(runRequest(userId), { feature: 'observatory' });
        expect(error.status).toBe(404);
        expect(await count('observatory_jobs', 'projectId = @id', { id: project.id })).toBe(0);
        expect(await count('observatory_jobs')).toBe(jobs);
        expect(observatoryService.executionEnabled).toBe(false);
        expect(spies.fetch).not.toHaveBeenCalled();
        noChildProcess();
    });

    test('sandbox enforced off refuses the observatory run too (dependency rule)', async () => {
        const userId = nextUser();
        await seedProject(userId);
        setState({ off: ['sandbox'] });
        expect(features.enforcedOff('observatory')).toBe(true);
        const jobs = await count('observatory_jobs');
        await expectRefusal(runRequest(userId), { feature: 'observatory' });
        await expectRefusal(observatoryService.render({ userId, project: 'lab' }), { feature: 'observatory' });
        expect(await count('observatory_jobs')).toBe(jobs);
        noChildProcess();
    });

    test('an injected Observatory instance follows the same seam', async () => {
        const fake = new ObservatoryService({
            config: { ...observatoryConfig, enabled: true, projectsEnabled: true },
            sandbox: { enabled: true }
        });
        setState({ off: ['observatory'] });
        await expectRefusal(fake.run({ userId: 'u', project: 'lab', language: 'python', code: '1' }), { feature: 'observatory' });
        expect(fake.executionEnabled).toBe(false);
    });
});

describe('expedition service and runner', () => {
    test('no state, legacy on: an expedition is created as a draft', async () => {
        const userId = nextUser();
        const created = await spitballService.createExpedition({ userId, seed: 'baseline topic', autoStart: false });
        expect(created.id).toBeTruthy();
        expect(await count('spitball_expeditions', 'userId = @userId', { userId })).toBe(1);
    });

    test('no state, legacy off: the old DISABLED answer', async () => {
        const off = new SpitballExpeditionService({ ...spitballConfig, enabled: false });
        expect(off.enabled).toBe(false);
        await expectRefusal(off.createExpedition({ userId: 'u', seed: 'x' }), { code: 'DISABLED' });
    });

    test('enforced off: createExpedition refuses and leaves no orphan row', async () => {
        const userId = nextUser();
        setState({ off: ['expeditions'] });
        const rows = await count('spitball_expeditions');
        const error = await expectRefusal(
            spitballService.createExpedition({ userId, seed: 'must not exist', autoStart: false }),
            { feature: 'expeditions' }
        );
        expect(error.status).toBe(404);
        expect(await count('spitball_expeditions')).toBe(rows);
    });

    test('kick and _runLoop do nothing while enforced off; the row stays QUEUED', async () => {
        const userId = nextUser();
        const created = await spitballService.createExpedition({ userId, seed: 'queued topic', autoStart: true });
        const pipeline = { runCycle: jest.fn(async () => { throw new Error('pipeline must not run'); }) };
        const runner = new spitballRunner.SpitballExpeditionRunner({ pipeline });

        setState({ off: ['expeditions'] });
        const refusal = runner.kick(created.id);
        expect(refusal).toMatchObject({ ok: false, code: 'FEATURE_UNAVAILABLE', feature: 'expeditions' });
        expect(runner.isLive(created.id)).toBe(false);
        await runner._runLoop(created.id);
        await runner.start();
        expect(pipeline.runCycle).not.toHaveBeenCalled();
        const row = await db.get('SELECT status FROM spitball_expeditions WHERE id = @id', { id: created.id });
        expect(row.status).toBe('QUEUED');
        expect(spies.fetch).not.toHaveBeenCalled();
    });

    test('no state, legacy on: kick claims the expedition and drives the pipeline', async () => {
        const userId = nextUser();
        const created = await spitballService.createExpedition({ userId, seed: 'driven topic', autoStart: true });
        const pipeline = { runCycle: jest.fn(async () => { throw new Error('stop here'); }) };
        const runner = new spitballRunner.SpitballExpeditionRunner({ pipeline });
        expect(runner.kick(created.id)).toBeUndefined();
        await runner.waitFor(created.id);
        expect(pipeline.runCycle).toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ */
/* Missions and triggers (BLOCKER)                                     */
/* ------------------------------------------------------------------ */

async function approveAsHuman(svc, args) {
    const receipt = await svc.mintApprovalReceipt({ ...args, origin: 'portal' });
    return svc.approve({ ...args, receiptId: receipt.id, nonce: receipt.nonce });
}

async function readyMission(userId, steps, overrides = {}) {
    await seedProject(userId);
    const svc = new ProjectMissionService(overrides);
    await svc.create({
        userId,
        project: 'lab',
        title: 'Gated mission',
        objective: 'Prove the seam holds for every caller.',
        successCriteria: ['It refuses', 'It records why'],
        steps
    });
    await approveAsHuman(svc, { userId, project: 'lab' });
    await svc.start({ userId, project: 'lab' });
    const open = await svc.get({ userId, project: 'lab' });
    return { svc, open };
}

describe('mission steps', () => {
    test('a job step with observatory enforced off fails with FEATURE_UNAVAILABLE and ledgers a clean row', async () => {
        const userId = nextUser();
        await seedProject(userId);
        await seedScript(userId, 'Bench');
        const run = jest.fn();
        const { svc, open } = await (async () => {
            const service = new ProjectMissionService({ observatory: { run, cancel: jest.fn() } });
            await service.create({
                userId, project: 'lab', title: 'Gated mission', objective: 'Prove the seam holds.',
                successCriteria: ['It refuses', 'It records why'],
                steps: [{ kind: 'job', title: 'Run the secret benchmark', actionParams: { asset: 'bench' } }]
            });
            await approveAsHuman(service, { userId, project: 'lab' });
            await service.start({ userId, project: 'lab' });
            return { svc: service, open: await service.get({ userId, project: 'lab' }) };
        })();
        const stepId = open.steps[0].id;
        setState({ off: ['observatory'] });

        const jobs = await count('observatory_jobs');
        const error = await expectRefusal(svc.startStep({ userId, project: 'lab', stepId }), { feature: 'observatory' });
        expect(error).toMatchObject({ name: 'ProjectMissionError', status: 404 });
        expect(run).not.toHaveBeenCalled();
        expect(await count('observatory_jobs')).toBe(jobs);
        const step = (await svc.get({ userId, project: 'lab' })).steps[0];
        expect(step.status).toBe('READY');
        expect(step.executionAttemptId).toBeFalsy();

        const rows = await db.all(
            "SELECT * FROM work_failures WHERE kind = 'mission_step' AND workId = @id AND actor = @userId",
            { id: String(stepId), userId }
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ code: 'FEATURE_UNAVAILABLE', phase: 'start', actor: userId });
        const text = JSON.stringify(rows[0]);
        expect(text).not.toMatch(/secret|print\(|benchmark/i);
        noChildProcess();
    });

    test('an expedition step with expeditions enforced off creates no expedition', async () => {
        const userId = nextUser();
        const createExpedition = jest.fn();
        const { svc, open } = await readyMission(
            userId,
            [{ kind: 'expedition', title: 'Survey the literature', actionParams: { seed: 'recall' } }],
            { spitball: { createExpedition, continueExpedition: jest.fn() } }
        );
        setState({ off: ['expeditions'] });
        const rows = await count('spitball_expeditions');
        await expectRefusal(svc.startStep({ userId, project: 'lab', stepId: open.steps[0].id }), { feature: 'expeditions' });
        expect(createExpedition).not.toHaveBeenCalled();
        expect(await count('spitball_expeditions')).toBe(rows);
        expect((await svc.get({ userId, project: 'lab' })).steps[0].status).toBe('READY');
    });

    test('no state: the same steps start as today', async () => {
        const userId = nextUser();
        await seedProject(userId);
        const project = await db.get('SELECT id FROM observatory_projects WHERE userId = @userId', { userId });
        const jobId = await db.insert(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status)
             VALUES (@projectId, @userId, 'python', 'print(1)', 'RUNNING')`,
            { projectId: project.id, userId }
        );
        const run = jest.fn(async () => ({ jobId }));
        await seedScript(userId, 'Bench');
        const svc = new ProjectMissionService({ observatory: { run, cancel: jest.fn() } });
        await svc.create({
            userId, project: 'lab', title: 'Baseline mission', objective: 'Start a job step.',
            successCriteria: ['It starts', 'It runs'],
            steps: [{ kind: 'job', title: 'Run it', actionParams: { asset: 'bench' } }]
        });
        await approveAsHuman(svc, { userId, project: 'lab' });
        await svc.start({ userId, project: 'lab' });
        const open = await svc.get({ userId, project: 'lab' });
        await svc.startStep({ userId, project: 'lab', stepId: open.steps[0].id });
        expect(run).toHaveBeenCalledTimes(1);
        expect((await svc.get({ userId, project: 'lab' })).steps[0].status).toBe('RUNNING');
        expect(await count('work_failures', "code = 'FEATURE_UNAVAILABLE' AND kind = 'mission_step' AND actor = @userId", { userId })).toBe(0);
    });
});

describe('project triggers', () => {
    async function cronTrigger(userId, action, extra = {}) {
        await db.run('DELETE FROM project_triggers');
        await seedProject(userId);
        const script = await seedScript(userId, 'Ingest', 'print("trigger-secret-source")');
        const runs = [];
        const observatory = {
            run: jest.fn(async (opts) => { runs.push(opts); return { mode: 'background', jobId: 1, status: 'RUNNING' }; }),
            render: jest.fn(async () => ({ frames: 1, relPath: 'r.mp4' }))
        };
        const svc = new ProjectTriggerService({ observatory, sandboxCfg: { fetchAllowedHosts: ['example.com'] } });
        const trigger = await svc.create({
            userId, project: 'lab', name: 'Nightly', kind: 'cron', schedule: '0 6 * * *', action,
            ...(action === 'run_script' ? { actionAssetId: script.id } : {}),
            ...extra
        });
        await db.run("UPDATE project_triggers SET nextRun = datetime('now', '-1 minute') WHERE id = @id", { id: trigger.id });
        return { svc, trigger, observatory, runs };
    }

    test('run_script with observatory enforced off fails with FEATURE_UNAVAILABLE and a clean ledger row', async () => {
        const userId = nextUser();
        const { svc, trigger, observatory } = await cronTrigger(userId, 'run_script');
        setState({ off: ['observatory'] });
        const jobs = await count('observatory_jobs');

        expect(await svc.fireDueCronTriggers()).toBe(0);
        expect(observatory.run).not.toHaveBeenCalled();
        expect(await count('observatory_jobs')).toBe(jobs);
        const row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: trigger.id });
        expect(row.lastOutcome).toMatch(/FEATURE_UNAVAILABLE/);
        expect(row.lastRun).toBeNull();
        expect(row.nextRun).not.toBeNull();

        const ledger = await db.all(
            "SELECT * FROM work_failures WHERE kind = 'trigger' AND workId = @id AND actor = @userId",
            { id: String(trigger.id), userId }
        );
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({ code: 'FEATURE_UNAVAILABLE', phase: 'dispatch' });
        expect(JSON.stringify(ledger[0])).not.toMatch(/trigger-secret|print\(/);
        noChildProcess();
    });

    test('render and fetch_data are refused the same way; agent_prompt is not an observatory action', async () => {
        const userId = nextUser();
        const { svc, trigger, observatory } = await cronTrigger(userId, 'render');
        setState({ off: ['sandbox'] });
        const dispatch = await svc._executeAction(
            await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: trigger.id })
        );
        expect(dispatch).toMatchObject({ status: 'failed', code: 'FEATURE_UNAVAILABLE' });
        expect(observatory.render).not.toHaveBeenCalled();
        expect(spies.fetch).not.toHaveBeenCalled();
    });

    test('no state: the action runs as today and no refusal is recorded', async () => {
        const userId = nextUser();
        const { svc, trigger, observatory } = await cronTrigger(userId, 'run_script');
        expect(await svc.fireDueCronTriggers()).toBe(1);
        expect(observatory.run).toHaveBeenCalledTimes(1);
        const row = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: trigger.id });
        expect(row.lastRun).toBeTruthy();
        expect(await count('work_failures', "code = 'FEATURE_UNAVAILABLE' AND kind = 'trigger' AND actor = @userId", { userId })).toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/* 2. Personal heartbeat                                               */
/* ------------------------------------------------------------------ */

describe('personal heartbeat mission reconcile', () => {
    function spyReconcile() {
        return {
            starting: jest.spyOn(projectMissionService, 'reconcileStartingSteps').mockResolvedValue(0),
            running: jest.spyOn(projectMissionService, 'reconcileRunningSteps').mockResolvedValue(0),
            kick: jest.spyOn(spitballRunner, 'kick')
        };
    }

    test('no state: the tick reconciles as today', async () => {
        const spy = spyReconcile();
        await new PersonalHeartbeatService(null)._tickBody();
        expect(spy.starting).toHaveBeenCalledTimes(1);
        expect(spy.running).toHaveBeenCalledTimes(1);
    });

    test('missionReconcile enforced off: no reconcile and no kick', async () => {
        const spy = spyReconcile();
        setState({ off: ['projects'] });
        await new PersonalHeartbeatService(null)._tickBody();
        expect(spy.starting).not.toHaveBeenCalled();
        expect(spy.running).not.toHaveBeenCalled();
        expect(spy.kick).not.toHaveBeenCalled();
    });

    test('expeditions off, projects on: a reconcile never re-queues or kicks a linked expedition', async () => {
        const userId = nextUser();
        const { open } = await readyMission(
            userId,
            [{ kind: 'expedition', title: 'Survey', actionParams: { seed: 'recall' } }]
        );
        const expedition = await spitballService.createExpedition({ userId, seed: 'linked draft', autoStart: false });
        await db.run(
            `UPDATE project_mission_steps
             SET status = 'STARTING', executionAttemptId = 'attempt-gate', expeditionId = @expeditionId,
                 startedAt = datetime('now', '-1 hour')
             WHERE id = @id`,
            { id: open.steps[0].id, expeditionId: expedition.id }
        );
        const kick = jest.spyOn(spitballRunner, 'kick');
        setState({ off: ['expeditions'] });

        await new PersonalHeartbeatService(null)._tickBody();
        expect(kick).not.toHaveBeenCalled();
        const row = await db.get('SELECT status FROM spitball_expeditions WHERE id = @id', { id: expedition.id });
        expect(row.status).toBe('DRAFT');
    });
});

/* ------------------------------------------------------------------ */
/* 3. Exchange risk sweep versus prediction markets                    */
/* ------------------------------------------------------------------ */

describe('exchange risk sweep and prediction settlement', () => {
    const GUILD = '900000000000000001';

    test('no state: the sweep settles prediction markets as today', async () => {
        const settle = jest.spyOn(predictionService, 'settleDue').mockResolvedValue([]);
        const summary = await new RiskEngine(null).runGuild({ guildId: GUILD });
        expect(settle).toHaveBeenCalledTimes(1);
        expect(summary.marketsSettled).toEqual([]);
        expect(summary).not.toHaveProperty('marketsSkipped');
    });

    test('exchange on, gambling off: settleDue is not called and the summary says why', async () => {
        const settle = jest.spyOn(predictionService, 'settleDue').mockResolvedValue([{ id: 1 }]);
        setState({ off: ['gambling'] });
        expect(features.enforcedOff('exchange')).toBe(false);
        const summary = await new RiskEngine(null).runGuild({ guildId: GUILD });
        expect(settle).not.toHaveBeenCalled();
        expect(summary.marketsSettled).toEqual([]);
        expect(summary.marketsSkipped).toBe('gambling');
        expect(summary.orders).not.toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* 4. Push and mail                                                    */
/* ------------------------------------------------------------------ */

describe('push', () => {
    const USER = '910000000000000001';
    const ENDPOINT = 'https://push.example.test/send/gate-1';
    let sender;

    beforeEach(async () => {
        await db.run('DELETE FROM push_subscriptions');
        await db.run('DELETE FROM inbox_items WHERE userId = @userId', { userId: USER });
        await db.run(
            `INSERT INTO push_subscriptions (userId, endpoint, p256dh, auth) VALUES (@userId, @endpoint, 'p', 'a')`,
            { userId: USER, endpoint: ENDPOINT }
        );
        sender = { sendNotification: jest.fn(async () => ({ statusCode: 201 })) };
        pushService._sender = sender;
    });

    afterEach(() => { pushService._sender = null; });

    test('no state, legacy on: an Inbox item is echoed as a push', async () => {
        expect(pushService.enabled).toBe(true);
        const outcome = await inboxService.deliver({ userId: USER, kind: 'system', title: 'Hello', discord: false });
        expect(sender.sendNotification).toHaveBeenCalledTimes(1);
        expect(outcome.push).toMatchObject({ sent: 1 });
    });

    test('push enforced off: the Inbox echo sends nothing, keeps the device and its failCount', async () => {
        setState({ off: ['push'] });
        expect(pushService.enabled).toBe(false);
        const before = await db.get('SELECT * FROM push_subscriptions WHERE endpoint = @endpoint', { endpoint: ENDPOINT });
        const outcome = await inboxService.deliver({ userId: USER, kind: 'system', title: 'Hello', discord: false });

        expect(outcome.created).toBe(true);
        expect(outcome.push).toMatchObject({ sent: 0, failed: 0, pruned: 0, skipped: true });
        expect(sender.sendNotification).not.toHaveBeenCalled();
        expect(spies.fetch).not.toHaveBeenCalled();
        const after = await db.get('SELECT * FROM push_subscriptions WHERE endpoint = @endpoint', { endpoint: ENDPOINT });
        expect(after.failCount).toBe(before.failCount);
        expect(after.lastSentAt).toBe(before.lastSentAt);
        expect(await count('push_subscriptions')).toBe(1);

        const direct = await pushService.notify({ userId: USER, title: 'Direct' });
        expect(direct.skipped).toBe(true);
        expect(sender.sendNotification).not.toHaveBeenCalled();
    });

    test('push enforced off: subscribe is refused, unsubscribe still works ("disabled is not deleted")', async () => {
        setState({ off: ['push'] });
        await expectRefusal(
            pushService.subscribe({ userId: USER, subscription: { endpoint: 'https://push.example.test/new', keys: { p256dh: 'x', auth: 'y' } } }),
            { code: 'PUSH_DISABLED' }
        );
        expect(await count('push_subscriptions')).toBe(1);
        const removed = await pushService.unsubscribe({ userId: USER, endpoint: ENDPOINT });
        expect(removed).toMatchObject({ removed: 1, devices: 0 });
        expect((await pushService.describe(USER)).enabled).toBe(false);
    });
});

describe('mail', () => {
    test('no state, legacy on: a message goes to the provider', async () => {
        const post = jest.fn(async () => ({ status: 200 }));
        const mail = new MailService({ post });
        expect(mail.enabled).toBe(true);
        await mail.send({ to: 'person@example.test', subject: 's', text: 't' });
        expect(post).toHaveBeenCalledTimes(1);
    });

    test('no state, legacy off: the old MAIL_DISABLED answer', async () => {
        const post = jest.fn();
        const mail = new MailService({ post, config: { enabled: false, disabledReason: 'No mail provider is configured.' } });
        expect(mail.enabled).toBe(false);
        expect(mail.describe().reason).toBe('No mail provider is configured.');
        await expectRefusal(mail.send({ to: 'person@example.test', subject: 's', text: 't' }), { code: 'MAIL_DISABLED' });
        expect(post).not.toHaveBeenCalled();
    });

    test('enforced off: nothing is sent, no provider call, no transport', async () => {
        const post = jest.fn();
        const createSmtp = jest.fn();
        const mail = new MailService({ post, createSmtp });
        const override = jest.fn();
        setState({ off: ['mail'] });
        expect(mail.enabled).toBe(false);
        expect(mail.provider).toBeNull();
        expect(mail.describe()).toMatchObject({ enabled: false, provider: null, from: null });
        await expectRefusal(mail.send({ to: 'person@example.test', subject: 's', text: 't' }), { feature: 'mail' });
        mail.setTransport(override);
        await expectRefusal(mail.send({ to: 'person@example.test', subject: 's', text: 't' }), { feature: 'mail' });
        expect(post).not.toHaveBeenCalled();
        expect(createSmtp).not.toHaveBeenCalled();
        expect(override).not.toHaveBeenCalled();
        expect(spies.fetch).not.toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ */
/* 5. Voice construction                                               */
/* ------------------------------------------------------------------ */

describe('voice service construction', () => {
    const CONFIG = { elevenlabs: { apiKey: 'el-test-key' } };

    test('voice on, music enforced off: no ffmpeg probe, no music or ambience service, voice still constructs', async () => {
        setState({ off: ['music'] });
        const VoiceService = require('@goobster/core/services/voice');
        const voice = new VoiceService(CONFIG);
        await voice.initialize();
        expect(mockChildProcess.execSync).not.toHaveBeenCalled();
        noChildProcess();
        expect(voice.musicService).toBeNull();
        expect(voice.ambientService).toBeNull();
        expect(voice.tts).not.toBeNull();
        expect(voice._isInitialized).toBe(true);
        expect(voice.getCurrentMusicState()).toBeNull();
        await expect(voice.cleanup()).resolves.toBeUndefined();
    });

    test('no state: music and ambience are built exactly as before', async () => {
        const built = [];
        jest.isolateModules(() => {
            jest.doMock('@goobster/core/services/voice/musicService', () => class FakeMusic {
                constructor() { built.push('music'); }
                on() {}
            });
            jest.doMock('@goobster/core/services/voice/ambientService', () => class FakeAmbient {
                constructor() { built.push('ambient'); }
            });
            const IsolatedVoice = require('@goobster/core/services/voice');
            const isolatedFeatures = require('@goobster/core/features/featureState').features;
            isolatedFeatures._resetForTests({ fs: memoryFs(), filePath: FILE, env: {}, config: {} });
            const voice = new IsolatedVoice(CONFIG);
            return voice.initialize().then(() => {
                expect(voice.musicService).not.toBeNull();
                expect(voice.ambientService).not.toBeNull();
            });
        });
        await new Promise(resolve => setImmediate(resolve));
        expect(built).toEqual(['music', 'ambient']);
        jest.dontMock('@goobster/core/services/voice/musicService');
        jest.dontMock('@goobster/core/services/voice/ambientService');
    });
});

/* ------------------------------------------------------------------ */
/* 6. Followed-source research                                         */
/* ------------------------------------------------------------------ */

describe('followed-source research', () => {
    const USER = '920000000000000001';

    async function seedEntry() {
        await db.run('DELETE FROM followed_sources WHERE userId = @userId', { userId: USER });
        const projectId = await db.insert(
            "INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, @slug, 'Follow project')",
            { userId: USER, slug: `follow-${Date.now()}-${Math.random().toString(16).slice(2, 8)}` }
        );
        const service = new FollowedSourceService({ fetch: jest.fn(), now: () => Date.now() });
        const source = await service.create({ userId: USER, projectId, url: 'https://example.org/feed', label: 'Feed', kind: 'feed' });
        const entryId = await db.insert(
            `INSERT INTO followed_source_entries (sourceId, entryKey, url, title, contentHash, extractedText, isChange)
             VALUES (@sourceId, 'k1', 'https://example.org/item/1', 'A change', 'hash-1', 'Something new happened.', 1)`,
            { sourceId: source.id }
        );
        return { service, source, entryId };
    }

    test('no state: a draft expedition is prepared and linked to the entry', async () => {
        const { service, source, entryId } = await seedEntry();
        const result = await service.prepareResearch({ userId: USER, sourceId: source.id, entryId });
        expect(result.expeditionId).toBeTruthy();
        const entry = await db.get('SELECT expeditionId FROM followed_source_entries WHERE id = @id', { id: entryId });
        expect(entry.expeditionId).toBe(result.expeditionId);
    });

    test('expeditions enforced off: refused with FEATURE_UNAVAILABLE before anything is created', async () => {
        const { service, source, entryId } = await seedEntry();
        setState({ off: ['expeditions'] });
        const expeditions = await count('spitball_expeditions');
        const error = await expectRefusal(
            service.prepareResearch({ userId: USER, sourceId: source.id, entryId }),
            { feature: 'expeditions' }
        );
        expect(error.status).toBe(404);
        expect(await count('spitball_expeditions')).toBe(expeditions);
        const entry = await db.get('SELECT expeditionId FROM followed_source_entries WHERE id = @id', { id: entryId });
        expect(entry.expeditionId).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* 7. Automation claim order                                           */
/* ------------------------------------------------------------------ */

describe('automation claim order', () => {
    const GUILD = '930000000000000001';

    async function wheelAutomation() {
        const id = await db.insert(
            `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, isEnabled, nextRun)
             VALUES ('930000000000000009', @guildId, '930000000000000002', 'Daily wheel', '__GOBLIN_WHEEL__',
                     '0 12 * * *', 1, datetime('now', '-5 minutes'))`,
            { guildId: GUILD }
        );
        return db.get('SELECT * FROM automations WHERE id = @id', { id });
    }

    function fakeClient() {
        const channel = {
            id: '930000000000000002',
            guild: { id: GUILD },
            send: jest.fn(async () => ({})),
            sendTyping: jest.fn(async () => {})
        };
        return { channel, client: { channels: { fetch: jest.fn(async () => channel) }, users: { fetch: jest.fn() } } };
    }

    function watchRan() {
        const published = [];
        jest.spyOn(eventBusService, 'publish').mockImplementation((topic, payload) => { published.push({ topic, payload }); });
        return published;
    }

    test('no state: a wheel run is recorded and announced as today', async () => {
        mockWheel.spin.mockResolvedValue({ deployments: [] });
        const { client, channel } = fakeClient();
        const published = watchRan();
        const row = await wheelAutomation();
        await new AutomationService(client).executeWithTimeout(row);
        expect(mockWheel.spin).toHaveBeenCalledTimes(1);
        expect(channel.send).toHaveBeenCalled();
        const after = await db.get('SELECT * FROM automations WHERE id = @id', { id: row.id });
        expect(after.lastRun).toBeTruthy();
        expect(published.filter(event => event.topic === 'automation-ran')).toHaveLength(1);
    });

    test.each([
        ['gambling', { off: ['gambling'] }],
        ['exchange (the wheel needs it too)', { off: ['exchange'] }]
    ])('wheel enforced off (%s): claimed so it waits, but no run, no lastRun, no event', async (_name, state) => {
        setState(state);
        const { client, channel } = fakeClient();
        const published = watchRan();
        const row = await wheelAutomation();
        await new AutomationService(client).executeWithTimeout(row);

        expect(mockWheel.spin).not.toHaveBeenCalled();
        expect(channel.send).not.toHaveBeenCalled();
        expect(client.channels.fetch).not.toHaveBeenCalled();
        const after = await db.get('SELECT * FROM automations WHERE id = @id', { id: row.id });
        expect(after.lastRun).toBeNull();
        expect(after.nextRun).not.toBe(row.nextRun);
        expect(published.filter(event => event.topic === 'automation-ran')).toHaveLength(0);
        expect(await count('work_failures', "kind = 'automation' AND workId = @id", { id: String(row.id) })).toBe(0);
    });
});
