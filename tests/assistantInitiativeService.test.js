/**
 * Initiatives and source cursors (DA-1b, ADR 0017): opportunities derived
 * from a responsibility's linked sources, against a throwaway database.
 *
 * The properties under test: activation baselines instead of replaying
 * history, a source change proposes exactly one opportunity however many
 * times it is noticed, the state survives a restart because it lives in
 * cursors rather than events, ending a grant ends its work, and a claimed
 * attempt is fenced by its lease.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-initiative-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const { AssistantInitiativeService } = initiatives;
const policies = require('@goobster/core/services/attentionPolicyService');
const { useState } = require('./helpers/featureFixtures');

const A = '720000000000000001';
const B = '720000000000000002';
const KG_ADD = { operation: 'kg.generated.add', resource: { kind: 'knowledge', ids: ['personal'] } };

afterAll(async () => {
    initiatives.stopListening();
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    useState();
    for (const table of [
        'assistant_initiatives', 'assistant_source_cursors', 'assistant_update_receipts', 'assistant_updates',
        'assistant_responsibility_revisions', 'assistant_responsibilities', 'attention_policies', 'attention_items', 'inbox_items'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
});

async function goal(userId = A, text = 'Finish the garden plan') {
    return db.insert(
        `INSERT INTO attention_items (guildId, userId, kind, subject, goal, state)
         VALUES (@guildId, @userId, 'goal', 'garden', @text, 'active')`,
        { guildId: `dm:${userId}`, userId, text }
    );
}

async function changeGoal(id, text) {
    await db.run('UPDATE attention_items SET goal = @text WHERE id = @id', { id, text });
}

async function activeGrant(itemId, userId = A, body = {}) {
    await policies.enroll({ userId, initiative: 'assist' });
    const { responsibility } = await responsibilities.create({
        userId, body: { title: 'Keep the garden plan moving', operations: [KG_ADD], attentionItemId: itemId, ...body }
    });
    return (await responsibilities.act({
        userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision
    })).responsibility;
}

const rows = () => db.all('SELECT * FROM assistant_initiatives ORDER BY id', {});

describe('deriving opportunities', () => {
    test('activation records a baseline and proposes nothing', async () => {
        const item = await goal();
        const grant = await activeGrant(item);
        const cursors = await db.all('SELECT * FROM assistant_source_cursors WHERE responsibilityId = @id', { id: grant.id });
        expect(cursors).toHaveLength(1);
        expect(cursors[0]).toMatchObject({ sourceKind: 'attention_item', sourceId: String(item) });
        expect(await initiatives.reconcile()).toMatchObject({ proposed: 0 });
        expect(await rows()).toHaveLength(0);
    });

    test('one source change is one candidate, however often it is noticed', async () => {
        const item = await goal();
        const grant = await activeGrant(item);
        await changeGoal(item, 'Finish the garden plan by spring');
        const first = await initiatives.reconcileResponsibility(grant.id);
        expect(first.proposed).toHaveLength(1);
        for (let i = 0; i < 5; i += 1) await initiatives.reconcile({ userId: A });
        const all = await rows();
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ status: 'CANDIDATE', ownerUserId: A, sourceKind: 'attention_item', attempt: 1 });
        expect(all[0].title).not.toContain('spring');
    });

    test('a crash between proposing and advancing the cursor re-proposes nothing new', async () => {
        const item = await goal();
        const grant = await activeGrant(item);
        await changeGoal(item, 'v2');
        await initiatives.reconcileResponsibility(grant.id);
        const cursor = await db.get('SELECT * FROM assistant_source_cursors WHERE responsibilityId = @id', { id: grant.id });
        const v1 = (await db.get('SELECT sourceRevision FROM assistant_initiatives', {})).sourceRevision;
        // Simulate the cursor write being lost: put it back one revision.
        await db.run("UPDATE assistant_source_cursors SET sourceRevision = 'older' WHERE id = @id", { id: cursor.id });
        const restarted = new AssistantInitiativeService();
        expect((await restarted.reconcileResponsibility(grant.id)).proposed).toEqual([]);
        expect(await rows()).toHaveLength(1);
        expect((await db.get('SELECT sourceRevision FROM assistant_source_cursors WHERE id = @id', { id: cursor.id })).sourceRevision).toBe(v1);
    });

    test('a later change supersedes the open candidate instead of stacking', async () => {
        const item = await goal();
        const grant = await activeGrant(item);
        await changeGoal(item, 'v2');
        await initiatives.reconcileResponsibility(grant.id);
        await changeGoal(item, 'v3');
        await initiatives.reconcileResponsibility(grant.id);
        const all = await rows();
        expect(all.map(r => r.status)).toEqual(['SUPERSEDED', 'CANDIDATE']);
        expect(all[0].stopCode).toBe('NEWER_SOURCE_REVISION');
    });

    test('a paused grant or Attention turned off derives nothing', async () => {
        const item = await goal();
        const grant = await activeGrant(item);
        await responsibilities.act({ userId: A, id: grant.id, action: 'pause', expectedRevision: grant.revision });
        await changeGoal(item, 'v2');
        expect(await initiatives.reconcile()).toMatchObject({ proposed: 0 });
        await policies.disable(A);
        expect((await initiatives.reconcileResponsibility(grant.id)).proposed).toEqual([]);
    });

    test('a domain hint triggers an early reconcile for its owner', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        try {
            const item = await goal();
            const grant = await activeGrant(item);
            await changeGoal(item, 'v2');
            const service = new AssistantInitiativeService();
            const spy = jest.spyOn(service, 'reconcile');
            service.hint(A);
            service.hint(A);
            jest.advanceTimersByTime(2500);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith({ userId: A });
            await spy.mock.results[0].value;
            expect((await rows()).filter(r => r.responsibilityId === grant.id)).toHaveLength(1);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('the owner and the grant', () => {
    async function candidate() {
        const item = await goal();
        const grant = await activeGrant(item);
        await changeGoal(item, 'v2');
        const [id] = (await initiatives.reconcileResponsibility(grant.id)).proposed;
        return { grant, initiative: await initiatives.get({ userId: A, id }) };
    }

    test('someone else cannot see or act on an initiative', async () => {
        const { initiative } = await candidate();
        await expect(initiatives.get({ userId: B, id: initiative.id })).rejects.toMatchObject({ status: 404 });
        await expect(initiatives.act({ userId: B, id: initiative.id, action: 'cancel' })).rejects.toMatchObject({ status: 404 });
        expect((await initiatives.list({ userId: B })).initiatives).toEqual([]);
    });

    test('revoking the grant cancels its open attempts in the same change', async () => {
        const { grant, initiative } = await candidate();
        await responsibilities.act({ userId: A, id: grant.id, action: 'revoke', expectedRevision: grant.revision });
        expect(await initiatives.get({ userId: A, id: initiative.id })).toMatchObject({
            status: 'CANCELLED', stopCode: 'RESPONSIBILITY_REVOKED'
        });
    });

    test('pausing parks queued work; queuing it again re-approves it under the current grant', async () => {
        const { grant, initiative } = await candidate();
        const queued = (await initiatives.act({ userId: A, id: initiative.id, action: 'queue', expectedRevision: initiative.revision })).initiative;
        const paused = (await responsibilities.act({ userId: A, id: grant.id, action: 'pause', expectedRevision: grant.revision })).responsibility;
        const parked = await initiatives.get({ userId: A, id: queued.id });
        expect(parked).toMatchObject({ status: 'WAITING', waitReason: 'responsibility' });
        await expect(initiatives.act({ userId: A, id: parked.id, action: 'queue', expectedRevision: parked.revision }))
            .rejects.toMatchObject({ code: 'RESPONSIBILITY_INACTIVE' });
        await responsibilities.act({ userId: A, id: grant.id, action: 'resume', expectedRevision: paused.revision });
        const requeued = (await initiatives.act({ userId: A, id: parked.id, action: 'queue', expectedRevision: parked.revision })).initiative;
        expect(requeued.status).toBe('QUEUED');
        expect((await initiatives.claim({ id: requeued.id })).ok).toBe(true);
    });

    test('a stale expectedRevision is refused', async () => {
        const { initiative } = await candidate();
        await expect(initiatives.act({ userId: A, id: initiative.id, action: 'queue', expectedRevision: initiative.revision + 1 }))
            .rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
    });

    test('retry opens a new attempt only when none is open', async () => {
        const { initiative } = await candidate();
        const cancelled = (await initiatives.act({ userId: A, id: initiative.id, action: 'cancel' })).initiative;
        const retried = (await initiatives.act({ userId: A, id: cancelled.id, action: 'retry' })).initiative;
        expect(retried).toMatchObject({ status: 'QUEUED', attempt: 2, parentInitiativeId: cancelled.id });
        await expect(initiatives.act({ userId: A, id: cancelled.id, action: 'retry' })).rejects.toMatchObject({ code: 'ALREADY_OPEN' });
    });
});

describe('claiming and the lease', () => {
    async function queued(body) {
        const item = await goal();
        const grant = await activeGrant(item, A, body);
        await changeGoal(item, 'v2');
        const [id] = (await initiatives.reconcileResponsibility(grant.id)).proposed;
        const row = await initiatives.get({ userId: A, id });
        return { grant, initiative: (await initiatives.act({ userId: A, id, action: 'queue', expectedRevision: row.revision })).initiative };
    }

    test('only the current lease holder can settle an attempt', async () => {
        const { initiative } = await queued();
        const claimed = await initiatives.claim({ id: initiative.id });
        expect(claimed).toMatchObject({ ok: true });
        expect(await initiatives.claim({ id: initiative.id })).toMatchObject({ ok: false, code: 'NOT_QUEUED' });
        expect(await initiatives.settle({ id: initiative.id, leaseToken: 'stale', status: 'COMPLETED' }))
            .toEqual({ ok: false, code: 'LEASE_LOST' });
        const settled = await initiatives.settle({ id: initiative.id, leaseToken: claimed.leaseToken, status: 'COMPLETED', outcome: 'NO_CHANGE' });
        expect(settled.initiative).toMatchObject({ status: 'COMPLETED', outcome: 'NO_CHANGE', leased: false });
    });

    test('an expired lease returns the attempt to the queue and fences the old holder', async () => {
        const { initiative } = await queued();
        const claimed = await initiatives.claim({ id: initiative.id });
        expect(await initiatives.reapExpiredLeases({ now: new Date(Date.now() + 11 * 60 * 1000) })).toBe(1);
        expect(await initiatives.settle({ id: initiative.id, leaseToken: claimed.leaseToken, status: 'COMPLETED' }))
            .toMatchObject({ code: 'LEASE_LOST' });
        expect((await initiatives.get({ userId: A, id: initiative.id })).status).toBe('QUEUED');
    });

    test('an attempt planned under older authority must be re-planned', async () => {
        const { grant, initiative } = await queued();
        await db.run('UPDATE assistant_responsibilities SET authorityRevision = authorityRevision + 1 WHERE id = @id', { id: grant.id });
        expect(await initiatives.claim({ id: initiative.id })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
        expect(await initiatives.get({ userId: A, id: initiative.id })).toMatchObject({ status: 'WAITING', stopCode: 'REPLAN_REQUIRED' });
    });

    test('the concurrentInitiatives budget bounds running attempts', async () => {
        const { grant, initiative } = await queued({ budgets: { concurrentInitiatives: 1 } });
        expect((await initiatives.claim({ id: initiative.id })).ok).toBe(true);
        const extra = await db.insert(
            `INSERT INTO assistant_initiatives (responsibilityId, responsibilityRevision, ownerUserId, sourceKind, sourceId,
                sourceRevision, dedupeKey, title, status)
             VALUES (@rid, @rev, @owner, 'attention_item', 'x', 'r', 'attention_item:x', 'other', 'QUEUED')`,
            { rid: grant.id, rev: grant.revision, owner: A }
        );
        expect(await initiatives.claim({ id: extra })).toMatchObject({ ok: false, code: 'BUDGET_LIMIT' });
    });
});
