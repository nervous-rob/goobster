/**
 * Long-running work across a restart (#325 requirement 4,
 * documentation/manager_lifecycle.md): every kind keeps its declared
 * contract inside the shutdown bound.
 *
 *   expedition    checkpoint: the running cycle finishes, the expedition
 *                 is re-queued, the next process continues with the next
 *                 cycle - each cycle runs once across the restart; past the
 *                 bound it is parked PAUSED and noted INTERRUPTED
 *   sandbox run   cancel: new runs are refused RESTARTING, running ones
 *                 keep their timeout, a run the bound cuts is noted
 *                 INTERRUPTED with no output and never replayed
 *   voice session cancel: ended with a notice through the gateway seam,
 *                 noted INTERRUPTED
 *   runtime step  drain: no new pass opens, the running one finishes
 *                 inside the bound
 * Runs on both engines.
 */
const path = require('node:path');
const os = require('node:os');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-work-interruption-${process.pid}.sqlite`);

jest.mock('@goobster/core/services/embeddingService', () => ({
    embed: jest.fn(() => { throw new Error('no embeddings in tests'); }),
    embedBatch: jest.fn(() => { throw new Error('no embeddings in tests'); }),
    cosineSimilarity: jest.fn(() => 0)
}));
jest.mock('@goobster/core/services/serviceManager', () => ({ voiceService: null }));

const db = require('@goobster/core/db');
const lifecycle = require('@goobster/core/runtime/lifecycle');
const expeditionService = require('@goobster/core/services/spitballExpeditionService');
const { SpitballExpeditionRunner } = require('@goobster/core/services/spitballExpeditionRunner');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const voiceSessionService = require('@goobster/core/services/voice/voiceSessionService');
const { startCoreRuntime } = require('@goobster/core/runtime/coreRuntime');
const { createSandboxApp } = require('../apps/sandbox/server');

let seq = 0;
const nextUser = () => `wi-user-${process.pid}-${++seq}`;

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function cycleResult({ leads }) {
    return {
        plan: { questions: ['q'], searchQueries: ['s'] },
        counters: { sourceCount: 2, sourcesAccepted: 2, claimsExtracted: 2, notesProposed: 1, notesCreated: 1, notesMerged: 0, edgesCreated: 0, tagsAdded: 0, conflictsFound: 0 },
        coverage: { summary: 'ok', unresolvedQuestions: ['open'], majorNewConcepts: [`c${Math.random()}`], coverageScore: 0.3, noveltyScore: 0.9 },
        leads,
        noveltyScore: 0.9,
        coverageScore: 0.3
    };
}

const LEAD = [{ topic: 'next lead', kind: 'subtopic', reason: 'central', expectedValue: 0.8, novelty: 0.8 }];
const quietReflection = { async runScope() { return { runId: 1, summary: {} }; } };

async function failures(code) {
    return db.all(
        'SELECT kind, workId, phase, code, reason FROM work_failures WHERE code = @code ORDER BY id ASC',
        { code }
    );
}

describe('expeditions: checkpoint at the cycle boundary', () => {
    test('a restart mid-cycle lets that cycle finish, re-queues, and the next process runs only the rest - each cycle once', async () => {
        const userId = nextUser();
        const calls = [];
        const gate = deferred();
        const entered = deferred();
        const pipeline = {
            async runCycle({ expedition, cycle }) {
                if (expedition.userId !== userId) throw new Error('not part of this test');
                calls.push(cycle.cycleNumber);
                if (cycle.cycleNumber === 1) {
                    entered.resolve();
                    await gate.promise;
                }
                return cycleResult({ leads: cycle.cycleNumber < 3 ? LEAD : [] });
            }
        };
        const expedition = await expeditionService.createExpedition({ userId, seed: 'checkpoint topic', depth: 'standard' });

        const before = new SpitballExpeditionRunner({ service: expeditionService, pipeline, reflection: quietReflection });
        before.kick(expedition.id);
        await entered.promise;
        expect(before.requestCheckpoint()).toEqual([expedition.id]);
        expect(before.kick(expedition.id)).toBeUndefined();
        gate.resolve();
        const [settled] = await lifecycle.settle([{ name: 'expedition', drain: () => before.waitForCheckpoint() }], 5000);
        expect(settled.outcome).toBe('settled');

        const parked = await expeditionService.getById(expedition.id);
        expect(parked.status).toBe('QUEUED');
        expect(parked.stopReason).toBe('RESTART_CHECKPOINT');
        expect(parked.runnerId).toBeNull();
        expect(parked.currentCycle).toBe(1);
        expect(calls).toEqual([1]);

        const after = new SpitballExpeditionRunner({ service: expeditionService, pipeline, reflection: quietReflection });
        const kicked = await after.start();
        expect(kicked).toContain(expedition.id);
        for (const id of kicked) await after.waitFor(id);

        expect(calls).toEqual([1, 2, 3]);
        const done = await expeditionService.getById(expedition.id);
        expect(done.status).toBe('COMPLETED');
        expect(done.stopReason).not.toBe('RESTART_CHECKPOINT');
        const cycles = await db.all(
            'SELECT cycleNumber, status FROM spitball_expedition_cycles WHERE expeditionId = @id ORDER BY cycleNumber ASC',
            { id: expedition.id }
        );
        expect(cycles).toEqual([
            { cycleNumber: 1, status: 'COMPLETED' },
            { cycleNumber: 2, status: 'COMPLETED' },
            { cycleNumber: 3, status: 'COMPLETED' }
        ]);
    });

    test('a cycle the bound cuts is parked PAUSED, its cycle CANCELLED and the expedition noted INTERRUPTED', async () => {
        const userId = nextUser();
        const entered = deferred();
        const hang = deferred();
        const pipeline = {
            async runCycle({ expedition }) {
                if (expedition.userId !== userId) throw new Error('not part of this test');
                entered.resolve();
                await hang.promise;
                return cycleResult({ leads: LEAD });
            }
        };
        const expedition = await expeditionService.createExpedition({ userId, seed: 'cut topic', depth: 'standard' });
        const runner = new SpitballExpeditionRunner({ service: expeditionService, pipeline, reflection: quietReflection });
        runner.kick(expedition.id);
        await entered.promise;
        runner.requestCheckpoint();

        const [cut] = await lifecycle.settle([{
            name: 'expedition',
            drain: () => runner.waitForCheckpoint(),
            interrupt: () => runner.interruptLive()
        }], 30);
        expect(cut.outcome).toBe('interrupted');

        const parked = await expeditionService.getById(expedition.id);
        expect(parked.status).toBe('PAUSED');
        expect(parked.runnerId).toBeNull();
        expect(parked.lastError).toMatch(/restart/i);
        const cycle = await db.get('SELECT status FROM spitball_expedition_cycles WHERE expeditionId = @id', { id: expedition.id });
        expect(cycle.status).toBe('CANCELLED');
        const noted = (await failures('INTERRUPTED')).filter(row => row.kind === 'expedition' && row.workId === String(expedition.id));
        expect(noted).toEqual([expect.objectContaining({ phase: 'shutdown', code: 'INTERRUPTED' })]);

        hang.resolve();
        await runner.waitFor(expedition.id);
        expect((await expeditionService.getById(expedition.id)).status).toBe('PAUSED');
    });
});

describe('sandbox runs: refuse new, keep the timeout, INTERRUPTED past the bound', () => {
    test('pauseNewWork refuses new runs with RESTARTING (phase shutdown) and lets a running one finish', async () => {
        const sandbox = new SandboxService();
        const release = deferred();
        sandbox._run = async () => {
            await release.promise;
            return { ok: true, stdout: 'done', stderr: '', exitCode: 0, files: [], durationMs: 5 };
        };
        const running = sandbox.run({ language: 'python', code: 'print(1)', userId: 'wi-sandbox-a' });
        sandbox.pauseNewWork();
        await expect(sandbox.run({ language: 'python', code: 'print(2)', userId: 'wi-sandbox-a' }))
            .rejects.toMatchObject({ status: 503, code: 'RESTARTING' });
        release.resolve();
        const [drained] = await lifecycle.settle([{ name: 'sandboxRun', drain: () => sandbox.drainRuns() }], 2000);
        expect(drained.outcome).toBe('settled');
        await expect(running).resolves.toMatchObject({ ok: true, stdout: 'done' });
        const refused = (await failures('RESTARTING')).filter(row => row.kind === 'sandbox');
        expect(refused.length).toBeGreaterThanOrEqual(1);
        expect(refused.every(row => row.phase === 'shutdown')).toBe(true);
    });

    test('a run the bound cuts is noted INTERRUPTED once, with no output, and is not replayed', async () => {
        const sandbox = new SandboxService();
        let calls = 0;
        const hang = deferred();
        sandbox._run = async () => {
            calls += 1;
            await hang.promise;
            return { ok: true, stdout: 'SECRET-OUTPUT', stderr: '', exitCode: 0, files: [], durationMs: 5 };
        };
        const before = (await failures('INTERRUPTED')).length;
        const running = sandbox.run({ language: 'python', code: 'while True: pass', userId: 'wi-sandbox-b' });
        sandbox.pauseNewWork();
        const [cut] = await lifecycle.settle([{
            name: 'sandboxRun',
            drain: () => sandbox.drainRuns(),
            interrupt: () => sandbox.interruptRunning()
        }], 30);
        expect(cut.outcome).toBe('interrupted');
        hang.resolve();
        await running;
        expect(calls).toBe(1);
        const rows = await failures('INTERRUPTED');
        const added = rows.slice(before);
        expect(added).toEqual([expect.objectContaining({ kind: 'sandbox', phase: 'shutdown', code: 'INTERRUPTED' })]);
        expect(JSON.stringify(added)).not.toMatch(/SECRET-OUTPUT|while True/);
        expect(await sandbox.interruptRunning()).toBe(0);
    });

    describe('the runner process (apps/sandbox/server.js)', () => {
        const prevToken = process.env.GOOBSTER_INTERNAL_TOKEN;
        let server;
        let url;
        let app;
        const worker = lifecycle.createWorkerLifecycle();
        const hang = deferred();
        const started = deferred();
        const sandbox = {
            enabled: true,
            async run({ signal }) {
                started.resolve();
                await new Promise((resolve, reject) => {
                    hang.promise.then(resolve);
                    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })));
                });
                return { ok: true, stdout: '', files: [] };
            }
        };
        const post = body => fetch(`${url}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goobster-internal-token': 'wi-token' },
            body: JSON.stringify(body)
        });

        beforeAll(async () => {
            process.env.GOOBSTER_INTERNAL_TOKEN = 'wi-token';
            app = createSandboxApp({ sandbox, logger: { error() {} }, worker });
            await new Promise((resolve) => {
                server = app.listen(0, '127.0.0.1', () => {
                    url = `http://127.0.0.1:${server.address().port}`;
                    resolve();
                });
            });
        });

        afterAll(async () => {
            hang.resolve();
            await new Promise(resolve => server.close(resolve));
            if (prevToken === undefined) delete process.env.GOOBSTER_INTERNAL_TOKEN;
            else process.env.GOOBSTER_INTERNAL_TOKEN = prevToken;
        });

        test('a run still going at the bound answers 503 INTERRUPTED; new runs answer 503 RESTARTING', async () => {
            const inFlight = post({ language: 'python', code: 'x', runId: 'wi-run-1' });
            await started.promise;
            worker.pauseNewWork({ reason: 'shutdown' });
            const refused = await post({ language: 'python', code: 'y', runId: 'wi-run-2' });
            expect(refused.status).toBe(503);
            expect((await refused.json()).error.code).toBe('RESTARTING');

            expect(await app.drainRuns(30)).toBe(1);
            const answered = await inFlight;
            expect(answered.status).toBe(503);
            expect((await answered.json()).error.code).toBe('INTERRUPTED');
            expect(await app.drainRuns(30)).toBe(0);
        });
    });
});

describe('voice sessions: ended with a notice, noted INTERRUPTED', () => {
    test('endAllSessions posts a notice through the gateway, stops every session and records it', async () => {
        const sent = [];
        const gateway = { async sendToChannel(channelId, payload) { sent.push({ channelId, payload }); return { ok: true }; } };
        const destroyed = [];
        const session = guildId => ({
            guildId,
            textChannel: { id: `text-${guildId}` },
            connection: { destroy: () => destroyed.push(guildId), receiver: null, off() {} }
        });
        voiceSessionService.sessions.set('wi-guild-1', session('wi-guild-1'));
        voiceSessionService.sessions.set('wi-guild-2', { ...session('wi-guild-2'), textChannel: null });

        expect(await voiceSessionService.endAllSessions({ gateway })).toBe(2);
        expect(voiceSessionService.sessions.size).toBe(0);
        expect(destroyed.sort()).toEqual(['wi-guild-1', 'wi-guild-2']);
        expect(sent).toEqual([{ channelId: 'text-wi-guild-1', payload: { content: expect.stringMatching(/restarting/i) } }]);
        const noted = (await failures('INTERRUPTED')).filter(row => String(row.workId).startsWith('voice:wi-guild-'));
        expect(noted.map(row => row.workId).sort()).toEqual(['voice:wi-guild-1', 'voice:wi-guild-2']);
        expect(noted.every(row => row.phase === 'shutdown')).toBe(true);
        expect(await voiceSessionService.endAllSessions({ gateway })).toBe(0);
    });
});

describe('core runtime: stop new work, drain inside the bound', () => {
    function fakeDeps(log) {
        const worker = name => ({ start: () => log.push(`start:${name}`), stop: () => log.push(`stop:${name}`), close: () => log.push(`stop:${name}`) });
        class FakeAutomation { start() { log.push('start:automation'); } stop() { log.push('stop:automation'); } }
        class FakePersonal {
            constructor() { this.ticking = false; FakePersonal.last = this; }
            start() { log.push('start:personal'); }
            stop() { log.push('stop:personal'); }
        }
        const runner = {
            live: deferred(),
            async start() { return []; },
            async stop() { log.push('stop:expeditions'); },
            requestCheckpoint() { log.push('checkpoint:expeditions'); return []; },
            waitForCheckpoint() { return runner.live.promise; },
            async interruptLive() { log.push('interrupt:expeditions'); return []; }
        };
        return {
            FakePersonal,
            runner,
            deps: {
                eventBusService: worker('eventBus'),
                chatHistoryRetentionService: worker('retention'),
                accountExportService: worker('exports'),
                instanceStateService: { isPaused: async () => false, getPause: async () => null },
                selfDocsService: { seedOnStartup: async () => ({ acquired: false }) },
                workshopPinMigration: { runOnStartup: async () => ({ acquired: false }) },
                observatoryService: { autoResumeInterrupted: async () => [] },
                projectMissionService: { reconcileStartingSteps: async () => 0, reconcileRunningSteps: async () => 0 },
                projectTriggerService: { catchUpEventTriggers: async () => 0 },
                AutomationService: FakeAutomation,
                followupDeliveryService: { deliverDue: async () => ({ delivered: 0, left: 0 }) },
                PersonalHeartbeatService: FakePersonal,
                spitballExpeditionRunner: runner,
                memoryConsolidationService: { ...worker('consolidation'), running: false },
                knowledgeReflectionService: { start: () => log.push('start:reflection'), stop: async () => { log.push('stop:reflection'); } },
                ledgerRetentionService: worker('ledger')
            }
        };
    }
    const quiet = { info() {}, warn() {}, error() {} };

    test('pauseNewWork stops the schedulers (not the event bus) and is not the operator pause flag', async () => {
        const log = [];
        const { deps } = fakeDeps(log);
        const runtime = await startCoreRuntime({ gateway: null, logger: quiet, deps });
        expect(runtime.newWorkPaused).toBe(false);
        expect(runtime.pauseNewWork()).toBe(true);
        expect(runtime.pauseNewWork()).toBe(false);
        expect(runtime.newWorkPaused).toBe(true);
        expect(log).toEqual(expect.arrayContaining([
            'stop:automation', 'stop:personal', 'checkpoint:expeditions', 'stop:consolidation', 'stop:reflection', 'stop:ledger'
        ]));
        expect(log).not.toContain('stop:eventBus');
        expect(log).not.toContain('stop:retention');
        expect(runtime.pausedAtStart).toBe(false);
        await runtime.stop();
    });

    test('settleInFlight waits for a running pass, then interrupts what the bound cuts', async () => {
        const log = [];
        const { deps, FakePersonal, runner } = fakeDeps(log);
        const runtime = await startCoreRuntime({ gateway: null, logger: quiet, deps });
        FakePersonal.last.ticking = true;
        setTimeout(() => { FakePersonal.last.ticking = false; }, 60);
        runner.live.resolve();
        const results = await runtime.settleInFlight(2000);
        expect(Object.fromEntries(results.map(item => [item.name, item.outcome]))).toEqual({
            expedition: 'settled', knowledgeReflection: 'settled', runtimeSteps: 'settled'
        });
        await runtime.stop();

        const cutLog = [];
        const cut = fakeDeps(cutLog);
        const second = await startCoreRuntime({ gateway: null, logger: quiet, deps: cut.deps });
        cut.FakePersonal.last.ticking = true;
        const outcomes = await second.settleInFlight(40);
        expect(Object.fromEntries(outcomes.map(item => [item.name, item.outcome]))).toMatchObject({
            expedition: 'interrupted', runtimeSteps: 'interrupted'
        });
        expect(cutLog).toContain('interrupt:expeditions');
        cut.FakePersonal.last.ticking = false;
        await second.stop();
    });

    test('each in-flight kind gets its own contract bound inside the drain window: passes 15 s, the expedition checkpoint 45 s', async () => {
        const log = [];
        const { deps, FakePersonal } = fakeDeps(log);
        const runtime = await startCoreRuntime({ gateway: null, logger: quiet, deps });
        FakePersonal.last.ticking = true;
        jest.useFakeTimers();
        try {
            let results = null;
            runtime.settleInFlight(60_000).then((value) => { results = value; });
            await jest.advanceTimersByTimeAsync(14_900);
            expect(results).toBeNull();
            expect(log).not.toContain('interrupt:expeditions');
            await jest.advanceTimersByTimeAsync(30_000);
            expect(results).toBeNull();
            await jest.advanceTimersByTimeAsync(200);
            expect(Object.fromEntries(results.map(item => [item.name, item.outcome]))).toEqual({
                expedition: 'interrupted', knowledgeReflection: 'settled', runtimeSteps: 'interrupted'
            });
            expect(log).toContain('interrupt:expeditions');

            const quick = fakeDeps([]);
            const third = await startCoreRuntime({ gateway: null, logger: quiet, deps: quick.deps });
            quick.FakePersonal.last.ticking = true;
            quick.runner.live.resolve();
            let quickResults = null;
            third.settleInFlight(60_000).then((value) => { quickResults = value; });
            await jest.advanceTimersByTimeAsync(15_100);
            expect(Object.fromEntries(quickResults.map(item => [item.name, item.outcome]))).toEqual({
                expedition: 'settled', knowledgeReflection: 'settled', runtimeSteps: 'interrupted'
            });
            quick.FakePersonal.last.ticking = false;
            await third.stop();
        } finally {
            jest.useRealTimers();
        }
        FakePersonal.last.ticking = false;
        await runtime.stop();
    });

    test('a paused instance that stops new work never starts its workers on resume', async () => {
        const log = [];
        const { deps } = fakeDeps(log);
        let paused = true;
        deps.instanceStateService = { isPaused: async () => paused, getPause: async () => null };
        const runtime = await startCoreRuntime({ gateway: null, logger: quiet, deps, pausePollMs: 10 });
        expect(runtime.pausedAtStart).toBe(true);
        runtime.pauseNewWork();
        paused = false;
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(log).not.toContain('start:automation');
        await runtime.stop();
    });
});
