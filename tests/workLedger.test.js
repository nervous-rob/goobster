/**
 * The work ledger (roadmap #256): work_failures, resource_events,
 * operator_audit and the usage_reservations join.
 *
 * Drives the acceptance list headless on a throwaway database: every
 * listed kind of work writes a failure row with no prompt or body, a
 * person reads only their own rows, the operator's support view aggregates
 * per account, the 30-day / 90-day / one-year sweeps work, erasure nulls
 * the actor and keeps the row, the cost-per-result join returns the
 * expected numbers for a seeded run, and every operator action in the Host
 * room writes an operator_audit row. Runs on both engines.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-work-ledger-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const workContext = require('@goobster/core/utils/workContext');
const workFailures = require('@goobster/core/services/workFailureService');
const resourceEvents = require('@goobster/core/services/resourceEventService');
const operatorAudit = require('@goobster/core/services/operatorAuditService');
const costReport = require('@goobster/core/services/costReportService');
const accountSupport = require('@goobster/core/services/accountSupportService');
const ledgerRetention = require('@goobster/core/services/ledgerRetentionService');
const inboxService = require('@goobster/core/services/inboxService');
const privacyService = require('@goobster/core/services/privacyService');
const identityService = require('@goobster/core/services/identityService');
const identityConfig = require('@goobster/core/config/identityConfig');
const instanceState = require('@goobster/core/services/instanceStateService');
const { DisabledGateway } = require('@goobster/core/gateway');

const USER = '100000000000000201';
const OTHER = '100000000000000202';
const HOST = '100000000000000203';
const PROMPT = 'PROMPT-TEXT-that-must-never-be-stored';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 86_400_000;

function utcText(ms) {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
const daysAgo = (days) => utcText(Date.now() - days * DAY);

async function tableText(table) {
    const rows = await db.all(`SELECT * FROM ${table}`);
    return JSON.stringify(rows);
}

const LEDGER_TABLES = ['work_failures', 'resource_events', 'operator_audit', 'usage_reservations', 'inbox_items'];
async function clearLedgers() {
    for (const table of LEDGER_TABLES) await db.run(`DELETE FROM ${table}`);
}

afterAll(async () => {
    await ledgerRetention.stop();
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

describe('work context', () => {
    test('carries the current work; an inner run keeps the outer work unless it replaces it', async () => {
        expect(workContext.current()).toBeNull();
        await workContext.run({ kind: 'automation', id: 7, actor: USER }, async () => {
            expect(workContext.current()).toEqual({ kind: 'automation', id: '7', actor: USER, payer: USER });
            await workContext.run({ kind: 'chat', id: 'turn-1', actor: OTHER }, async () => {
                expect(workContext.current().kind).toBe('automation');
            });
            await workContext.run({ kind: 'job', id: 9, actor: OTHER }, async () => {
                expect(workContext.current()).toMatchObject({ kind: 'job', id: '9', actor: OTHER });
            }, { replace: true });
            expect(workContext.current().kind).toBe('automation');
        });
        expect(workContext.current()).toBeNull();
    });

    test('note() and record() fill kind, work id and actor from the context', async () => {
        await clearLedgers();
        await workContext.run({ kind: 'expedition', id: 41, actor: USER }, async () => {
            await workFailures.note({ phase: 'cycle', code: 'PROVIDER_DOWN', reason: 'the provider returned 503' });
            await resourceEvents.record({ kind: 'search_call', provider: 'wikipedia' });
        });
        expect(await workFailures.listForWork('expedition', 41)).toEqual([
            expect.objectContaining({ actor: USER, phase: 'cycle', code: 'PROVIDER_DOWN', reason: 'the provider returned 503' })
        ]);
        expect(await resourceEvents.listForWork('expedition', 41)).toEqual([
            expect.objectContaining({ kind: 'search_call', provider: 'wikipedia', actor: USER, payer: USER, quantity: 1 })
        ]);
        // Outside any work, note() without a kind writes nothing and does not throw.
        expect(await workFailures.note({ code: 'X' })).toBeNull();
    });
});

describe('work_failures: every listed kind writes a row with no prompt or body', () => {
    beforeAll(clearLedgers);

    test('each kind records kind, work id, phase, code, a short reason, actor and time', async () => {
        for (const kind of workFailures.KINDS) {
            const id = await workFailures.note({
                kind, workId: `${kind}-1`, phase: 'run', code: 'BOOM', actor: USER,
                reason: `${kind} failed while handling ${PROMPT} `.repeat(20)
            });
            expect(id).toEqual(expect.any(Number));
        }
        const rows = await db.all('SELECT kind, workId, phase, code, reason, actor, createdAt FROM work_failures ORDER BY id');
        expect(rows.map(row => row.kind)).toEqual([...workFailures.KINDS]);
        for (const row of rows) {
            expect(row).toMatchObject({ workId: `${row.kind}-1`, phase: 'run', code: 'BOOM', actor: USER });
            expect(row.reason.length).toBeLessThanOrEqual(300);
            expect(String(row.createdAt)).toMatch(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/);
        }
        // Long reasons are clipped; the ledger has no column a prompt could land in.
        expect(rows[0].reason).toContain(PROMPT);
        expect(rows[0].reason.length).toBe(300);
        expect(Object.keys(rows[0])).toEqual(['kind', 'workId', 'phase', 'code', 'reason', 'actor', 'createdAt']);
        expect(() => workFailures.record({ kind: 'nonsense', code: 'X' })).rejects.toThrow(/unknown kind/);
    });

    test('a research expedition that fails writes its row and an Inbox item that links to it', async () => {
        const expeditions = require('@goobster/core/services/spitballExpeditionService');
        const expedition = await expeditions.createExpedition({ userId: USER, seed: PROMPT, autoStart: true });
        expect(await expeditions.claimForRun(expedition.id, { runnerId: 'test' })).toBe(true);
        await expeditions.failExpedition(expedition.id, { error: 'the cycle threw: provider timeout' });

        const [row] = await workFailures.listForWork('expedition', expedition.id);
        expect(row).toMatchObject({ actor: USER, phase: 'cycle', code: 'CYCLE_FAILED', reason: 'the cycle threw: provider timeout' });
        expect(row.reason).not.toContain(PROMPT);

        const inbox = await inboxService.list({ userId: USER });
        const item = inbox.items.find(entry => entry.source?.type === workFailures.INBOX_SOURCE_TYPE);
        expect(item).toMatchObject({
            kind: 'system',
            link: '/knowledge/research',
            failure: { id: row.id, kind: 'expedition', code: 'CYCLE_FAILED', phase: 'cycle', workId: String(expedition.id) }
        });
        expect(item.title).not.toContain(PROMPT);
        expect(item.body || '').not.toContain(PROMPT);
        // The other person's Inbox does not resolve the row, even by id.
        expect(await workFailures.getManyForUser([row.id], OTHER)).toEqual([]);
    });

    test('a scheduled task that fails writes its row every run and the Inbox notice once per streak', async () => {
        const AutomationService = require('@goobster/core/services/automationService');
        const service = new AutomationService(null, { gateway: new DisabledGateway() });
        const automation = {
            id: 501, userId: USER, name: 'morning digest', channelId: `inbox:${USER}`, metadata: null, prompt: PROMPT
        };
        await service._notifyRunFailure(automation, Object.assign(new Error('provider quota exhausted'), { code: 'RATE_LIMITED' }));
        const meta = JSON.parse((await db.get('SELECT metadata FROM automations WHERE id = 501'))?.metadata || '{}');
        // No automations row exists for this fake: the flag update is a no-op, so pass the streak state by hand.
        expect(meta).toEqual({});
        await service._notifyRunFailure({ ...automation, metadata: JSON.stringify({ failureNotified: true }) }, new Error('still down'));

        const rows = await workFailures.listForWork('automation', 501);
        expect(rows.map(row => [row.code, row.reason])).toEqual([
            ['RATE_LIMITED', 'provider quota exhausted'],
            ['Error', 'still down']
        ]);
        const items = (await inboxService.list({ userId: USER })).items.filter(entry => entry.link === '/activity/scheduled');
        expect(items).toHaveLength(1);
        expect(items[0].failure).toMatchObject({ id: rows[0].id, kind: 'automation', code: 'RATE_LIMITED' });
        expect(items[0].body).not.toContain(PROMPT);
    });

    test('a code run that exits non-zero writes a sandbox failure and its seconds', async () => {
        const { SandboxService } = require('@goobster/core/services/sandboxService');
        const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-ledger-sandbox-'));
        const svc = new SandboxService({
            enabled: true, scope: 'everywhere', runsDir, timeoutMs: 15_000, maxCpuSeconds: 15, maxMemoryMb: 2048,
            maxWriteMb: 16, maxOutputBytes: 64 * 1024, maxOutputFiles: 8, maxFileSizeBytes: 8 * 1024 * 1024,
            runsPerWindow: 100, maxConcurrent: 4, retentionHours: 24, allowNetwork: false, pythonCommand: 'python3',
            extraBinds: [], requireStrongIsolation: false
        });
        try {
            const result = await svc.run({ language: 'bash', code: `echo "${PROMPT}" >&2; exit 3`, userId: USER });
            expect(result.ok).toBe(false);
            const [failure] = await workFailures.listForWork('sandbox', result.runId);
            expect(failure).toMatchObject({ actor: USER, phase: 'sandbox', code: 'EXIT_3', reason: 'the code exited with code 3' });
            expect(failure.reason).not.toContain(PROMPT);
            const [seconds] = await resourceEvents.listForWork('sandbox', result.runId);
            expect(seconds).toMatchObject({ kind: 'sandbox_seconds', actor: USER });
            expect(Number(seconds.quantity)).toBeGreaterThan(0);

            // Inside a project job the job settles its own verdict: seconds only.
            const inJob = await workContext.run({ kind: 'job', id: 77, actor: USER }, () =>
                svc.run({ language: 'bash', code: 'exit 1', userId: USER }), { replace: true });
            expect(inJob.ok).toBe(false);
            expect(await workFailures.listForWork('job', 77)).toEqual([]);
            expect(await resourceEvents.listForWork('job', 77)).toHaveLength(1);
            // The dedicated runner records nothing; its caller does.
            const unrecorded = await svc.run({ language: 'bash', code: 'exit 2', userId: USER, record: false });
            expect(await workFailures.listForWork('sandbox', unrecorded.runId)).toEqual([]);
        } finally {
            fs.rmSync(runsDir, { recursive: true, force: true });
        }
    });

    test('a project job that ends FAILED or TIMED_OUT writes a row from the code, never the output', async () => {
        const observatory = require('@goobster/core/services/projectService');
        await observatory._recordJobFailure(9001, 'TIMED_OUT', {});
        await observatory._recordJobFailure(9002, 'FAILED', { exitCode: 2, errorCode: 'EXIT_NONZERO' });
        expect((await workFailures.listForWork('job', 9001))[0]).toMatchObject({ code: 'TIMED_OUT', reason: 'the run hit its time limit' });
        expect((await workFailures.listForWork('job', 9002))[0]).toMatchObject({ code: 'EXIT_NONZERO', reason: 'the code exited with code 2' });
    });

    test('an Inbox echo that Discord refuses is a failed delivery; a missing adapter is not', async () => {
        const refusing = { isGoobsterGateway: true, kind: 'fake', sendDm: async () => ({ ok: false, error: 'CANNOT_DM_USER' }) };
        const { item, discord } = await inboxService.deliver({
            userId: USER, kind: 'system', title: 'A note', body: PROMPT,
            discord: { gateway: refusing, discordUserId: USER }
        });
        expect(discord).toEqual({ status: 'failed', error: 'CANNOT_DM_USER' });
        const [row] = await workFailures.listForWork('delivery', item.id);
        expect(row).toMatchObject({ actor: USER, phase: 'discord_echo', code: 'DISCORD_ECHO_FAILED', reason: 'CANNOT_DM_USER' });

        const skipped = await inboxService.deliver({
            userId: USER, kind: 'system', title: 'Another note',
            discord: { gateway: new DisabledGateway(), discordUserId: USER }
        });
        expect(skipped.discord.status).toBe('skipped');
        expect(await workFailures.listForWork('delivery', skipped.item.id)).toEqual([]);
    });

    test('the whole ledger holds no prompt, reply or body text', async () => {
        expect(await tableText('resource_events')).not.toContain(PROMPT);
        const failures = await db.all('SELECT reason FROM work_failures WHERE reason LIKE @needle', { needle: `%${PROMPT}%` });
        // Only the clipped synthetic reasons from the first test carry the marker.
        expect(failures.length).toBe(workFailures.KINDS.size);
    });
});

describe('resource_events: search calls, sandbox seconds and retries under the current work', () => {
    beforeAll(clearLedgers);

    test('the search service records one call per provider unless the adapter records itself', async () => {
        const { SpitballSearchService } = require('@goobster/core/services/spitballSearchService');
        const provider = (name, extra = {}) => ({
            name, sourceTypes: ['web'], isAvailable: () => true,
            search: async () => [{ text: 'a result', title: name, sourceType: 'web' }], ...extra
        });
        const service = new SpitballSearchService([provider('alpha'), provider('beta', { recordsOwnCalls: true }), provider('down', { isAvailable: () => false })]);
        await workContext.run({ kind: 'expedition', id: 88, actor: USER }, () => service.search(PROMPT));
        const rows = await resourceEvents.listForWork('expedition', 88);
        expect(rows.map(row => [row.kind, row.provider])).toEqual([['search_call', 'alpha']]);
    });

    test('the agent orchestrator records a retry when it has to finalise again', async () => {
        const before = (await db.get('SELECT COUNT(*) AS c FROM resource_events WHERE kind = @kind', { kind: 'retry' })).c;
        await workContext.run({ kind: 'chat', id: 'turn-9', actor: USER }, () =>
            resourceEvents.record({ kind: 'retry', provider: 'finalize' }));
        expect((await db.get('SELECT COUNT(*) AS c FROM resource_events WHERE kind = @kind', { kind: 'retry' })).c - before).toBe(1);
    });

    test('totals are per person and per kind, with the unit each quantity is counted in', async () => {
        await workContext.run({ kind: 'sandbox', id: 'r1', actor: USER }, async () => {
            await resourceEvents.record({ kind: 'sandbox_seconds', quantity: 2.5, provider: 'bwrap' });
            await resourceEvents.record({ kind: 'sandbox_seconds', quantity: 1.5, provider: 'bwrap' });
        });
        await resourceEvents.record({ kind: 'search_call', provider: 'wikipedia', work: { kind: 'chat', id: 'x' }, actor: OTHER });
        expect(await resourceEvents.totals({ userId: USER, days: 30 })).toEqual([
            { kind: 'retry', unit: 'retries', events: 1, quantity: 1 },
            { kind: 'sandbox_seconds', unit: 'seconds', events: 2, quantity: 4 },
            { kind: 'search_call', unit: 'calls', events: 1, quantity: 1 }
        ]);
        expect(await resourceEvents.totals({ userId: OTHER, days: 30 })).toEqual([
            { kind: 'search_call', unit: 'calls', events: 1, quantity: 1 }
        ]);
        expect(await resourceEvents.record({ kind: 'nope' })).toBeNull();
        expect(await resourceEvents.record({ kind: 'retry', quantity: -1 })).toBeNull();
    });
});

describe('cost per accepted result: usage_reservations joined with resource_events by work id', () => {
    beforeAll(async () => {
        await clearLedgers();
        const reservation = (workId, status, estimated, actual, payer = USER) => db.run(
            `INSERT INTO usage_reservations (actor, payer, workKind, workId, estimatedTokens, actualTokens, status)
             VALUES (@actor, @payer, 'expedition', @workId, @estimated, @actual, @status)`,
            { actor: payer, payer, workId: String(workId), estimated, actual, status }
        );
        // Three cycles of expedition 1 (two settled, one still held), one of expedition 2, one for someone else.
        await reservation(1, 'settled', 1000, 800);
        await reservation(1, 'settled', 1000, 400);
        await reservation(1, 'held', 500, null);
        await reservation(2, 'settled', 1000, 300);
        await reservation(3, 'settled', 1000, 999, OTHER);
        const event = (workId, kind, quantity, actor = USER) =>
            resourceEvents.record({ kind, quantity, provider: 'test', work: { kind: 'expedition', id: workId }, actor });
        await event(1, 'search_call', 1);
        await event(1, 'search_call', 1);
        await event(1, 'sandbox_seconds', 12.5);
        await event(2, 'search_call', 1);
        await event(2, 'retry', 1);
        await event(3, 'search_call', 5, OTHER);
        await workFailures.record({ kind: 'expedition', workId: 2, code: 'CYCLE_FAILED', actor: USER });
    });

    test('per-work rows carry settled tokens, held estimates, resources and failures', async () => {
        const rows = await costReport.workCosts({ workKind: 'expedition', payer: USER });
        expect(rows).toEqual([
            { workKind: 'expedition', workId: '1', payer: USER, actualTokens: 1200, estimatedTokens: 500, reservations: 3, resources: { search_call: 2, sandbox_seconds: 12.5 }, failures: 0 },
            { workKind: 'expedition', workId: '2', payer: USER, actualTokens: 300, estimatedTokens: 0, reservations: 1, resources: { search_call: 1, retry: 1 }, failures: 1 }
        ]);
    });

    test('the seeded run divides out to the expected cost per accepted result', async () => {
        const report = await costReport.costPerResult({ workKind: 'expedition', payer: USER, accepted: ['1'] });
        expect(report).toMatchObject({
            works: 2, accepted: 1,
            totals: { actualTokens: 1500, resources: { search_call: 3, sandbox_seconds: 12.5, retry: 1 }, failures: 1 },
            perAccepted: { actualTokens: 1500, resources: { search_call: 3, sandbox_seconds: 12.5, retry: 1 } }
        });
        const two = await costReport.costPerResult({ workKind: 'expedition', payer: USER, accepted: 2 });
        expect(two.perAccepted).toEqual({ actualTokens: 750, resources: { search_call: 1.5, sandbox_seconds: 6.25, retry: 0.5 } });
        expect((await costReport.costPerResult({ workKind: 'expedition', payer: USER })).perAccepted).toBeNull();
        // Everyone's work, when no payer is given.
        const all = await costReport.costPerResult({ workKind: 'expedition', accepted: 3 });
        expect(all.works).toBe(3);
        expect(all.totals.actualTokens).toBe(2499);
        expect(all.perAccepted.actualTokens).toBeCloseTo(833, 0);
    });
});

describe('a person reads only their own rows; the operator aggregates per account', () => {
    beforeAll(async () => {
        await clearLedgers();
        await workFailures.record({ kind: 'chat', workId: 't1', code: 'TURN_FAILED', actor: USER, reason: 'provider 500' });
        await workFailures.record({ kind: 'chat', workId: 't2', code: 'TURN_FAILED', actor: USER });
        await workFailures.record({ kind: 'sandbox', workId: 's1', code: 'TIMED_OUT', actor: USER });
        await workFailures.record({ kind: 'expedition', workId: 'e1', code: 'CYCLE_FAILED', actor: OTHER });
        await workFailures.record({ kind: 'delivery', workId: 'd1', code: 'X', actor: null });
        await resourceEvents.record({ kind: 'search_call', work: { kind: 'chat', id: 't1' }, actor: USER });
        await resourceEvents.record({ kind: 'search_call', work: { kind: 'expedition', id: 'e1' }, actor: OTHER });
        await db.run(
            `INSERT INTO usage_log (userId, provider, model, operation, inputTokens, outputTokens)
             VALUES (@userId, 'openai', 'm', 'chat', 100, 50)`, { userId: USER }
        );
        await db.run(
            `INSERT INTO usage_log (userId, provider, model, operation, inputTokens, outputTokens)
             VALUES (@userId, 'openai', 'm', 'chat', 7, 3)`, { userId: OTHER }
        );
    });

    test('own rows only', async () => {
        expect((await workFailures.listForUser(USER)).map(row => row.workId)).toEqual(['s1', 't2', 't1']);
        expect((await workFailures.listForUser(OTHER)).map(row => row.workId)).toEqual(['e1']);
        expect(await workFailures.summarize({ userId: USER })).toEqual({
            total: 3,
            byKind: [{ kind: 'chat', count: 2 }, { kind: 'sandbox', count: 1 }],
            byCode: [{ kind: 'chat', code: 'TURN_FAILED', count: 2 }, { kind: 'sandbox', code: 'TIMED_OUT', count: 1 }]
        });
        expect((await resourceEvents.listForUser(USER)).map(row => row.workId)).toEqual(['t1']);
    });

    test('the operator view is usage totals plus resources plus failures, per account', async () => {
        const view = await accountSupport.view({ principalId: USER, days: 30 });
        expect(view).toMatchObject({
            principalId: USER, days: 30,
            usage: { calls: 1, inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            resources: [{ kind: 'search_call', unit: 'calls', events: 1, quantity: 1 }],
            failures: { total: 3 }
        });
        expect(view.failures.recent.map(row => row.workId)).toEqual(['s1', 't2', 't1']);
        expect(view.failures.recent[0]).not.toHaveProperty('actor');
        expect((await accountSupport.view({ principalId: OTHER })).usage.totalTokens).toBe(10);
        expect(await accountSupport.failureCounts({ days: 30 })).toEqual(new Map([[USER, 3], [OTHER, 1]]));
        expect((await accountSupport.view({ principalId: USER, days: 9999 })).days).toBe(365);
        expect((await workFailures.summarize({})).total).toBe(5);
    });
});

describe('retention: 30 days for failures, 90 for resource events, a year for the audit', () => {
    beforeAll(clearLedgers);

    test('the sweep removes rows past each window, keeps the rest, and runs under the singleton lock', async () => {
        const fresh = await workFailures.record({ kind: 'chat', code: 'A', actor: USER });
        const old = await workFailures.record({ kind: 'chat', code: 'B', actor: USER });
        await db.run('UPDATE work_failures SET createdAt = @at WHERE id = @id', { at: daysAgo(31), id: old });
        await db.run('UPDATE work_failures SET createdAt = @at WHERE id = @id', { at: daysAgo(29), id: fresh });

        const keptEvent = await resourceEvents.record({ kind: 'retry', actor: USER });
        const oldEvent = await resourceEvents.record({ kind: 'retry', actor: USER });
        await db.run('UPDATE resource_events SET createdAt = @at WHERE id = @id', { at: daysAgo(91), id: oldEvent });
        await db.run('UPDATE resource_events SET createdAt = @at WHERE id = @id', { at: daysAgo(89), id: keptEvent });

        const keptAudit = await operatorAudit.record({ action: 'account.grant', actor: HOST, target: USER });
        const oldAudit = await operatorAudit.record({ action: 'account.grant', actor: HOST, target: OTHER });
        await db.run('UPDATE operator_audit SET createdAt = @at WHERE id = @id', { at: daysAgo(366), id: oldAudit });
        await db.run('UPDATE operator_audit SET createdAt = @at WHERE id = @id', { at: daysAgo(364), id: keptAudit });

        expect(await ledgerRetention.sweep()).toEqual({ skipped: false, workFailures: 1, resourceEvents: 1, operatorAudit: 1 });
        expect((await db.all('SELECT id FROM work_failures')).map(row => row.id)).toEqual([fresh]);
        expect((await db.all('SELECT id FROM resource_events')).map(row => row.id)).toEqual([keptEvent]);
        expect((await db.all('SELECT id FROM operator_audit')).map(row => row.id)).toEqual([keptAudit]);
        expect(await ledgerRetention.sweep()).toEqual({ skipped: false, workFailures: 0, resourceEvents: 0, operatorAudit: 0 });
    });

    test('the core runtime starts the sweep with the other schedulers', async () => {
        const { startCoreRuntime } = require('@goobster/core/runtime/coreRuntime');
        const started = [];
        const worker = (name) => ({ start: () => started.push(name), stop: () => {}, close: () => {} });
        const runtime = await startCoreRuntime({
            gateway: new DisabledGateway(), logger: quiet,
            deps: {
                eventBusService: worker('eventBus'),
                chatHistoryRetentionService: worker('retention'),
                selfDocsService: { seedOnStartup: async () => ({ acquired: false }) },
                workshopPinMigration: { runOnStartup: async () => ({ acquired: false }) },
                observatoryService: { autoResumeInterrupted: async () => [] },
                projectMissionService: { reconcileStartingSteps: async () => 0, reconcileRunningSteps: async () => 0 },
                projectTriggerService: { catchUpEventTriggers: async () => 0 },
                AutomationService: class { start() {} stop() {} },
                followupDeliveryService: { deliverDue: async () => ({ delivered: 0, left: 0 }) },
                PersonalHeartbeatService: class { start() {} stop() {} },
                spitballExpeditionRunner: { start: async () => [], stop: async () => {} },
                memoryConsolidationService: worker('consolidation'),
                knowledgeReflectionService: worker('reflection'),
                ledgerRetentionService: worker('ledgerRetention')
            }
        });
        expect(runtime.started).toContain('ledgerRetention');
        expect(started).toContain('ledgerRetention');
        await runtime.stop();
    });
});

describe('erasure nulls the actor and keeps the row', () => {
    beforeAll(async () => {
        await clearLedgers();
        await workFailures.record({ kind: 'chat', code: 'A', actor: USER });
        await workFailures.record({ kind: 'chat', code: 'B', actor: OTHER });
        await resourceEvents.record({ kind: 'search_call', actor: USER, payer: USER });
        await resourceEvents.record({ kind: 'search_call', actor: USER, payer: OTHER });
        await resourceEvents.record({ kind: 'search_call', actor: OTHER, payer: OTHER });
        await operatorAudit.record({ action: 'account.status', actor: USER, target: OTHER, detail: { status: 'disabled' } });
        await operatorAudit.record({ action: 'account.role', actor: HOST, target: USER, detail: { role: 'member' } });
        await db.run(
            `INSERT INTO usage_reservations (actor, payer, workKind, workId, estimatedTokens, status) VALUES
             (@user, @user, 'chat', 'a', 10, 'held'),
             (@user, @other, 'chat', 'b', 10, 'settled'),
             (@other, @other, 'chat', 'c', 10, 'settled')`,
            { user: USER, other: OTHER }
        );
        await db.run('INSERT INTO admission_locks (resource) VALUES (@lock)', { lock: `budget:${USER}` });
    });

    test('the audit and the report see the person; forgetUser anonymizes and the totals stay whole', async () => {
        const before = await privacyService.auditUser({ userId: USER });
        expect(before.byTable).toMatchObject({ work_failures: 1, resource_events: 2, operator_audit: 2, usage_reservations: 2 });
        const report = await privacyService.buildUserReport({ userId: USER });
        expect(report.resourceEvents).toHaveLength(2);
        expect(report.usageReservations).toHaveLength(2);
        expect(report.operatorAudit.map(row => row.role).sort()).toEqual(['actor', 'target']);

        const counts = await privacyService.forgetUser({ userId: USER });
        expect(counts).toMatchObject({
            anonymizedWorkFailures: 1, anonymizedResourceEvents: 3, anonymizedOperatorAudit: 2,
            anonymizedUsageReservations: 1, deletedUsageReservations: 1
        });
        expect((await db.get('SELECT COUNT(*) AS c FROM work_failures')).c).toBe(2);
        expect((await db.get('SELECT COUNT(*) AS c FROM resource_events')).c).toBe(3);
        expect((await db.get('SELECT COUNT(*) AS c FROM operator_audit')).c).toBe(2);
        expect((await db.get('SELECT COUNT(*) AS c FROM usage_reservations')).c).toBe(2);
        expect(await db.get('SELECT actor, payer FROM usage_reservations WHERE workId = @id', { id: 'b' })).toEqual({ actor: null, payer: OTHER });
        expect(await db.get('SELECT resource FROM admission_locks WHERE resource = @lock', { lock: `budget:${USER}` })).toBeFalsy();

        const after = await privacyService.auditUser({ userId: USER });
        expect(after.byTable).toMatchObject({ work_failures: 0, resource_events: 0, operator_audit: 0, usage_reservations: 0 });
        // The other person and the operator are untouched; the instance-wide counts still add up.
        expect(await workFailures.countForUser(OTHER)).toBe(1);
        expect((await operatorAudit.list()).entries.map(entry => [entry.actor, entry.target])).toEqual([[HOST, null], [null, OTHER]]);
        expect((await workFailures.summarize({})).total).toBe(2);
    });
});

describe('portal: the Host room writes an audit row for every operator action', () => {
    let server;
    let port;
    const TARGET = '100000000000000204';

    function request({ method = 'GET', reqPath, headers = {}, body = null }) {
        const payload = body ? JSON.stringify(body) : null;
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, method, path: reqPath,
                headers: {
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                    ...headers
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch { /* non-JSON */ }
                    resolve({ status: res.statusCode, headers: res.headers, json });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    async function cookieFor(userId, name) {
        const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
        const setCookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('goobster_web_session='));
        return setCookie.split(';')[0];
    }

    let host;
    let member;

    beforeAll(async () => {
        await clearLedgers();
        identityConfig.nativeLogin = true;
        identityConfig.requireAccount = false;
        await identityService.ensureLegacyPrincipal({ discordId: HOST, displayName: 'host' });
        await identityService.grantAccount({ principalId: HOST, entitlement: 'bootstrap', role: 'operator' });
        await identityService.ensureLegacyPrincipal({ discordId: OTHER, displayName: 'member' });
        await identityService.grantAccount({ principalId: OTHER, entitlement: 'migration' });
        await identityService.ensureLegacyPrincipal({ discordId: TARGET, displayName: 'target' });

        const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
        const ctx = createWebAppContext({
            gateway: new DisabledGateway(),
            config: { webapp: { enabled: true, devMode: true } },
            logger: quiet
        });
        const app = express();
        app.use(createWebAppApp(ctx));
        await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
        port = server.address().port;
        host = await cookieFor(HOST, 'host');
        member = await cookieFor(OTHER, 'member');

        await workFailures.record({ kind: 'chat', workId: 't1', code: 'TURN_FAILED', actor: OTHER, reason: 'provider 500' });
        await workFailures.record({ kind: 'chat', workId: 't2', code: 'TURN_FAILED', actor: HOST });
        await resourceEvents.record({ kind: 'search_call', work: { kind: 'chat', id: 't1' }, actor: OTHER });
    });

    afterAll(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
    });

    test('a person sees their own diagnostics only; the operator sees any account and the roster counts', async () => {
        const own = await request({ reqPath: '/api/app/usage/diagnostics?days=7', headers: { cookie: member } });
        expect(own.status).toBe(200);
        expect(own.json).toMatchObject({ principalId: OTHER, days: 7, failures: { total: 1 } });
        expect(own.json.failures.recent.map(row => row.workId)).toEqual(['t1']);
        expect(own.json.resources).toEqual([{ kind: 'search_call', unit: 'calls', events: 1, quantity: 1 }]);
        expect((await request({ reqPath: '/api/app/usage/diagnostics' })).status).toBe(401);

        expect((await request({ reqPath: `/api/app/admin/accounts/${HOST}/support`, headers: { cookie: member } })).status).toBe(403);
        expect((await request({ reqPath: '/api/app/admin/audit', headers: { cookie: member } })).status).toBe(403);
        const support = await request({ reqPath: `/api/app/admin/accounts/${OTHER}/support?days=30`, headers: { cookie: host } });
        expect(support.status).toBe(200);
        expect(support.json.failures.recent.map(row => row.code)).toEqual(['TURN_FAILED']);
        expect((await request({ reqPath: '/api/app/admin/accounts/not-a-principal/support', headers: { cookie: host } })).status).toBe(400);

        const roster = await request({ reqPath: '/api/app/admin/accounts', headers: { cookie: host } });
        expect(roster.json.failureWindowDays).toBe(30);
        const byId = Object.fromEntries(roster.json.accounts.map(account => [account.principalId, account.failures]));
        expect(byId).toMatchObject({ [HOST]: 1, [OTHER]: 1 });
    });

    test('invitations, accounts, recovery links and the instance each write one row - never a token or a link', async () => {
        const invite = await request({ method: 'POST', reqPath: '/api/app/admin/invites', headers: { cookie: host }, body: { role: 'member', note: 'for Pat' } });
        expect(invite.status).toBe(200);
        const token = new URL(invite.json.url, 'http://x').searchParams.get('token');
        await request({ method: 'DELETE', reqPath: `/api/app/admin/invites/${invite.json.invite.id}`, headers: { cookie: host } });

        expect((await request({ method: 'POST', reqPath: '/api/app/admin/accounts', headers: { cookie: host }, body: { principalId: TARGET } })).status).toBe(200);
        expect((await request({ method: 'PATCH', reqPath: `/api/app/admin/accounts/${TARGET}`, headers: { cookie: host }, body: { status: 'disabled' } })).status).toBe(200);
        expect((await request({ method: 'PATCH', reqPath: `/api/app/admin/accounts/${TARGET}`, headers: { cookie: host }, body: { status: 'active', role: 'operator' } })).status).toBe(200);
        const recovery = await request({ method: 'POST', reqPath: `/api/app/admin/accounts/${TARGET}/recovery`, headers: { cookie: host } });
        expect(recovery.status).toBe(200);
        const resetToken = new URL(recovery.json.url, 'http://x').searchParams.get('token');
        // A refused action writes nothing.
        expect((await request({ method: 'PATCH', reqPath: `/api/app/admin/accounts/${HOST}`, headers: { cookie: host }, body: { status: 'disabled' } })).status).toBe(409);

        await instanceState.pause({ reason: 'restore', by: 'npm run restore', detail: { archive: 'x.tar' } });
        expect((await request({ method: 'POST', reqPath: '/api/app/admin/instance/resume', headers: { cookie: host } })).status).toBe(200);

        const page = await request({ reqPath: '/api/app/admin/audit?limit=100', headers: { cookie: host } });
        expect(page.status).toBe(200);
        expect(page.json.nextCursor).toBeNull();
        expect(page.json.entries.map(entry => [entry.action, entry.target])).toEqual([
            ['instance.resume', null],
            ['instance.restore', null],
            ['account.recovery', TARGET],
            ['account.role', TARGET],
            ['account.status', TARGET],
            ['account.status', TARGET],
            ['account.grant', TARGET],
            ['invite.revoke', String(invite.json.invite.id)],
            ['invite.create', String(invite.json.invite.id)]
        ]);
        const byAction = Object.fromEntries(page.json.entries.map(entry => [entry.action, entry]));
        expect(byAction['invite.create']).toMatchObject({ actor: HOST, detail: { role: 'member', hasNote: true } });
        expect(byAction['account.grant'].detail).toEqual({ role: 'member', created: true, entitlement: 'migration' });
        expect(byAction['account.role'].detail).toEqual({ role: 'operator' });
        expect(byAction['account.recovery'].detail).toEqual({ expiresAt: expect.any(String) });
        expect(byAction['instance.resume']).toMatchObject({ actor: HOST, detail: { pauseReason: 'restore' } });
        expect(byAction['instance.restore']).toMatchObject({ actor: null, detail: { reason: 'restore', via: 'npm run restore' } });
        const text = await tableText('operator_audit');
        expect(text).not.toContain(token);
        expect(text).not.toContain(resetToken);
        expect(text).not.toContain('/app/');

        // Paging and filters.
        const first = await request({ reqPath: '/api/app/admin/audit?limit=2', headers: { cookie: host } });
        expect(first.json.entries).toHaveLength(2);
        const second = await request({ reqPath: `/api/app/admin/audit?limit=2&before=${first.json.nextCursor}`, headers: { cookie: host } });
        expect(second.json.entries[0].id).toBeLessThan(first.json.entries[1].id);
        const forTarget = await request({ reqPath: `/api/app/admin/audit?target=${TARGET}&action=account.status`, headers: { cookie: host } });
        expect(forTarget.json.entries).toHaveLength(2);
    });

    test('a detail that carries a secret is stripped before it is stored', async () => {
        const id = await operatorAudit.record({
            action: 'signup.mail_test', actor: HOST,
            detail: { provider: 'smtp', to: 'pat@example.com', token: 'nope', url: 'https://x/y', password: 'p', loginName: 'pat' }
        });
        const row = await db.get('SELECT detailJson FROM operator_audit WHERE id = @id', { id });
        expect(JSON.parse(row.detailJson)).toEqual({ provider: 'smtp' });
        expect(await operatorAudit.record({ action: 'not.an.action', actor: HOST })).toBeNull();
    });
});
