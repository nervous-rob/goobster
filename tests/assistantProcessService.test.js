/**
 * The process catalog (DA-1d, ADR 0017): a read model over existing
 * recurring processes, optional contracts, and typed observations with a
 * stable occurrence identity, against a throwaway database.
 *
 * The properties under test: only the owner can see or annotate a process,
 * one occurrence is one observation however often it is reported, reason
 * codes stay machine codes, the instrumented schedulers record what they
 * did, erasure and retention reach every row, and a disabled feature
 * records nothing.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-process-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const processes = require('@goobster/core/services/assistantProcessService');
const AutomationService = require('@goobster/core/services/automationService');
const projectTriggers = require('@goobster/core/services/projectTriggerService');
const privacyService = require('@goobster/core/services/privacyService');
const { useState } = require('./helpers/featureFixtures');

const A = '740000000000000001';
const B = '740000000000000002';

afterAll(async () => {
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    useState();
    for (const table of [
        'assistant_process_observations', 'assistant_process_contracts', 'project_trigger_deliveries', 'project_triggers',
        'observatory_jobs', 'project_members', 'observatory_projects', 'automations', 'attention_items'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
});

async function automation(userId = A, overrides = {}) {
    return db.insert(
        `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun)
         VALUES (@userId, 'g1', 'c1', @name, 'summarize the day', '0 3 * * *', @nextRun)`,
        { userId, name: overrides.name || 'nightly digest', nextRun: overrides.nextRun || '2026-11-09 03:00:00' }
    );
}

const observations = () => db.all('SELECT * FROM assistant_process_observations ORDER BY id', {});

describe('the read model', () => {
    test('lists the owner\'s processes and hides everyone else\'s', async () => {
        const id = await automation(A);
        await automation(B, { name: 'theirs' });
        const { processes: mine } = await processes.list({ userId: A });
        expect(mine).toEqual([expect.objectContaining({ kind: 'automation', id, ref: `automation:${id}`, name: 'nightly digest', hasContract: false })]);
        await expect(processes.get({ userId: B, kind: 'automation', id })).rejects.toMatchObject({ status: 404 });
        await expect(processes.get({ userId: A, kind: 'nonsense', id })).rejects.toMatchObject({ status: 404 });
    });

    test('a process with no contract is reported, not judged', async () => {
        const id = await automation();
        const detail = await processes.get({ userId: A, kind: 'automation', id });
        expect(detail.process).toMatchObject({ name: 'nightly digest', enabled: true, trigger: { kind: 'cron', schedule: '0 3 * * *' } });
        expect(detail.contract).toBeNull();
        expect(detail.assessment).toEqual({ execution: 'unknown', relevance: 'unknown', purposeKnown: false });
    });
});

describe('contracts', () => {
    test('creating, replacing under compare-and-swap, and deleting a contract', async () => {
        const id = await automation();
        const { contract, created } = await processes.putContract({
            userId: A, kind: 'automation', id, body: { purpose: 'Tell me what happened overnight', criticality: 'high', expectedCadenceSeconds: 86400 }
        });
        expect(created).toBe(true);
        expect(contract).toMatchObject({ revision: 1, criticality: 'high', expectedCadenceSeconds: 86400 });
        await expect(processes.putContract({ userId: A, kind: 'automation', id, body: { purpose: 'x' } }))
            .rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
        const replaced = await processes.putContract({ userId: A, kind: 'automation', id, body: { purpose: 'x', expectedRevision: 1 } });
        expect(replaced.contract).toMatchObject({ revision: 2, purpose: 'x', criticality: 'normal' });
        expect((await processes.get({ userId: A, kind: 'automation', id })).assessment.purposeKnown).toBe(true);
        expect(await processes.deleteContract({ userId: A, kind: 'automation', id })).toEqual({ deleted: true });
    });

    test('unknown fields, bad values and links to someone else\'s records are refused', async () => {
        const id = await automation();
        await expect(processes.putContract({ userId: A, kind: 'automation', id, body: { url: 'https://x' } })).rejects.toMatchObject({ status: 400 });
        await expect(processes.putContract({ userId: A, kind: 'automation', id, body: { criticality: 'urgent' } })).rejects.toMatchObject({ status: 400 });
        await expect(processes.putContract({ userId: A, kind: 'automation', id, body: { expectedCadenceSeconds: 5 } })).rejects.toMatchObject({ status: 400 });
        const theirs = await db.insert(
            "INSERT INTO attention_items (guildId, userId, kind, subject, state) VALUES ('g', @B, 'goal', 'x', 'active')", { B }
        );
        await expect(processes.putContract({ userId: A, kind: 'automation', id, body: { attentionItemId: theirs } }))
            .rejects.toMatchObject({ code: 'INVALID_LINK' });
        await expect(processes.putContract({ userId: B, kind: 'automation', id, body: { purpose: 'mine now' } }))
            .rejects.toMatchObject({ status: 404 });
    });
});

describe('observations', () => {
    const base = (id, overrides = {}) => ({
        processKind: 'automation', processId: id, ownerUserId: A, occurrenceKey: 'fire:2026-11-09 03:00:00',
        phase: 'outcome', outcome: 'ok', ...overrides
    });

    test('one occurrence and phase is one row; a re-report updates it and counts the attempt', async () => {
        const id = await automation();
        expect(await processes.record(base(id, { outcome: 'failed', reasonCode: 'RUN_FAILED' }))).toBe(true);
        expect(await processes.record(base(id))).toBe(true);
        await processes.record(base(id, { phase: 'delivery' }));
        const rows = await observations();
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ phase: 'outcome', outcome: 'ok', attempts: 2 });
    });

    test('free text never lands in reasonCode, and bad vocabulary is dropped without throwing', async () => {
        const id = await automation();
        await processes.record(base(id, { reasonCode: 'Request to https://secret.example/?token=abc failed' }));
        expect((await observations())[0].reasonCode).toBe('UNCLASSIFIED');
        expect(await processes.record(base(id, { phase: 'nonsense' }))).toBe(false);
        expect(await processes.record(base(id, { outcome: 'great' }))).toBe(false);
        expect(await processes.record({ ...base(id), ownerUserId: null })).toBe(false);
    });

    test('nothing is recorded while the assistant feature is off', async () => {
        const id = await automation();
        useState({ inactive: ['assistant'] });
        expect(await processes.record(base(id))).toBe(false);
        expect(await observations()).toEqual([]);
    });

    test('an automation fire records its typed outcome, keyed on the claimed fire time', async () => {
        const id = await automation();
        const row = await db.get('SELECT * FROM automations WHERE id = @id', { id });
        const service = new AutomationService(null);
        const result = await service._executeClaimedAutomation(row);
        expect(result).toEqual({ outcome: 'skipped', code: 'NO_DISCORD_CLIENT' });
        await service._executeClaimedAutomation(row);
        const rows = await observations();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            processKind: 'automation', processId: String(id), ownerUserId: A,
            occurrenceKey: 'fire:2026-11-09 03:00:00', phase: 'outcome', outcome: 'skipped', reasonCode: 'NO_DISCORD_CLIENT', attempts: 2
        });
        const detail = await processes.get({ userId: A, kind: 'automation', id });
        expect(detail.observations).toEqual([expect.objectContaining({ outcome: 'skipped', reasonCode: 'NO_DISCORD_CLIENT' })]);
    });

    test('a project trigger dispatch records one observation per source job, and its delivery ledger reads as history', async () => {
        const projectId = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@A, 'p', 'P')", { A });
        const triggerId = await db.insert(
            `INSERT INTO project_triggers (projectId, userId, name, kind, eventTopic, action)
             VALUES (@projectId, @A, 'on finish', 'event', 'job_completed', 'render')`,
            { projectId, A }
        );
        const jobId = await db.insert(
            "INSERT INTO observatory_jobs (projectId, userId, language, code) VALUES (@projectId, @A, 'python', 'print(1)')", { projectId, A }
        );
        const trigger = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: triggerId });
        await projectTriggers._observeDispatch(trigger, { id: jobId }, 'retryable', { code: 'BUSY' });
        await projectTriggers._observeDispatch(trigger, { id: jobId }, 'delivered', { childJobId: 99 });
        const rows = await observations();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            processKind: 'project_trigger', occurrenceKey: `job:${jobId}`, phase: 'dispatch', outcome: 'ok',
            reasonCode: 'DISPATCH_DELIVERED', evidenceKind: 'observatory_job', evidenceId: '99', attempts: 2
        });
        await db.run(
            `INSERT INTO project_trigger_deliveries (triggerId, sourceJobId, projectId, status, attempts)
             VALUES (@triggerId, @jobId, @projectId, 'DELIVERED', 1)`,
            { triggerId, jobId, projectId }
        );
        const detail = await processes.get({ userId: A, kind: 'project_trigger', id: triggerId });
        expect(detail.history).toEqual([expect.objectContaining({ occurrenceKey: `job:${jobId}`, phase: 'delivery', outcome: 'ok', origin: 'project_trigger_deliveries' })]);
    });
});

describe('retention and erasure', () => {
    test('prune drops old observations and anything whose process is gone', async () => {
        const kept = await automation();
        const gone = await automation(A, { name: 'gone' });
        await processes.putContract({ userId: A, kind: 'automation', id: gone, body: { purpose: 'old' } });
        await processes.record({ processKind: 'automation', processId: kept, ownerUserId: A, occurrenceKey: 'old', phase: 'outcome', outcome: 'ok', observedAt: '2020-01-01T00:00:00Z' });
        await processes.record({ processKind: 'automation', processId: kept, ownerUserId: A, occurrenceKey: 'new', phase: 'outcome', outcome: 'ok' });
        await processes.record({ processKind: 'automation', processId: gone, ownerUserId: A, occurrenceKey: 'new', phase: 'outcome', outcome: 'ok' });
        await db.run('DELETE FROM automations WHERE id = @gone', { gone });
        expect(await processes.prune({ days: 90 })).toEqual({ observations: 2, contracts: 1 });
        expect((await observations()).map(r => r.occurrenceKey)).toEqual(['new']);
    });

    test('forget-me removes the person\'s contracts and observations and leaves others\'', async () => {
        const mine = await automation(A);
        const theirs = await automation(B, { name: 'theirs' });
        await processes.putContract({ userId: A, kind: 'automation', id: mine, body: { purpose: 'mine' } });
        await processes.putContract({ userId: B, kind: 'automation', id: theirs, body: { purpose: 'theirs' } });
        await processes.record({ processKind: 'automation', processId: mine, ownerUserId: A, occurrenceKey: 'k', phase: 'outcome', outcome: 'ok' });
        await processes.record({ processKind: 'automation', processId: theirs, ownerUserId: B, occurrenceKey: 'k', phase: 'outcome', outcome: 'ok' });
        const report = await privacyService.forgetUser({ userId: A });
        expect(report).toMatchObject({ processContracts: 1, processObservations: 1 });
        const audit = await privacyService.auditUser({ userId: A });
        expect(audit.byTable).toMatchObject({ assistant_process_contracts: 0, assistant_process_observations: 0 });
        expect(await db.all('SELECT ownerUserId FROM assistant_process_contracts', {})).toEqual([{ ownerUserId: B }]);
    });
});
