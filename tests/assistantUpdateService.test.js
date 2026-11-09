/**
 * Canonical updates and per-revision receipts (DA-1c, ADR 0017), against a
 * throwaway database.
 *
 * The properties under test: one durable fact is one update however many
 * times it is published, a material change is a new revision that is
 * unseen again, acknowledgment is per person and per exact revision,
 * component counts never multiply one update, the Inbox envelope is a
 * projection whose read acknowledges only the revision it rendered, and
 * project updates follow current membership.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-update-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const updates = require('@goobster/core/services/assistantUpdateService');
const inbox = require('@goobster/core/services/inboxService');
const { useState } = require('./helpers/featureFixtures');

const A = '730000000000000001';
const B = '730000000000000002';
const C = '730000000000000003';

afterAll(async () => {
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    useState();
    for (const table of ['assistant_update_receipts', 'assistant_updates', 'inbox_items', 'project_members', 'observatory_projects']) {
        await db.run(`DELETE FROM ${table}`, {});
    }
});

const finding = (overrides = {}) => ({
    audience: { userId: A },
    identityKey: 'finding:garden-frost',
    kind: 'finding',
    title: 'Frost expected Thursday',
    summary: 'Cover the seedlings.',
    components: ['research', 'knowledge'],
    deliver: false,
    ...overrides
});

async function project(owner = A) {
    const id = await db.insert(
        "INSERT INTO observatory_projects (userId, slug, name) VALUES (@owner, 'garden', 'Garden')", { owner }
    );
    return id;
}

describe('identity and revisions', () => {
    test('republishing the same fact is a no-op; a material change is a new, unseen revision', async () => {
        const first = await updates.publish(finding());
        expect(first).toMatchObject({ created: true, changed: true });
        expect(first.update).toMatchObject({ revision: 1, unseen: true, componentIds: ['knowledge', 'research'] });

        const again = await updates.publish(finding());
        expect(again).toMatchObject({ created: false, changed: false });
        expect(again.update.sequence).toBe(first.update.sequence);
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_updates', {})).toMatchObject({ n: 1 });

        await updates.acknowledge({ userId: A, items: [{ id: first.update.id, revision: 1 }] });
        const changed = await updates.publish(finding({ summary: 'Cover the seedlings and the beans.' }));
        expect(changed).toMatchObject({ created: false, changed: true });
        expect(changed.update.revision).toBe(2);
        expect(changed.update.sequence).toBeGreaterThan(first.update.sequence);

        const { updates: page } = await updates.list({ userId: A });
        expect(page).toHaveLength(1);
        expect(page[0]).toMatchObject({ revision: 2, unseen: true, acknowledgedRevision: 1 });
    });

    test('acknowledging an older revision never clears a newer one', async () => {
        const { update } = await updates.publish(finding());
        await updates.publish(finding({ title: 'Frost expected Wednesday' }));
        const { results } = await updates.acknowledge({ userId: A, items: [{ id: update.id, revision: 1 }] });
        expect(results[0]).toMatchObject({ status: 'older_revision', acknowledgedRevision: 1, currentRevision: 2 });
        expect((await updates.list({ userId: A })).counts.unseen).toBe(1);
        // A revision from the future is capped at the current one.
        const capped = await updates.acknowledge({ userId: A, items: [{ id: update.id, revision: 9 }] });
        expect(capped.results[0]).toMatchObject({ status: 'acknowledged', acknowledgedRevision: 2 });
        expect((await updates.list({ userId: A })).counts.unseen).toBe(0);
    });

    test('an update in two components counts once overall and once per component', async () => {
        await updates.publish(finding());
        await updates.publish(finding({ identityKey: 'finding:other', components: ['research'] }));
        const { counts, components } = await updates.list({ userId: A });
        expect(counts).toMatchObject({ unseen: 2, needsAction: 0, complete: true });
        const byId = Object.fromEntries(components.map(c => [c.id, c.unseen]));
        expect(byId).toMatchObject({ research: 2, knowledge: 1, projects: 0 });
        const filtered = await updates.list({ userId: A, component: 'knowledge' });
        expect(filtered.updates).toHaveLength(1);
    });

    test('invalid input is refused with a code', async () => {
        await expect(updates.publish(finding({ components: ['nonsense'] }))).rejects.toMatchObject({ status: 400 });
        await expect(updates.publish(finding({ kind: 'nonsense' }))).rejects.toMatchObject({ status: 400 });
        await expect(updates.acknowledge({ userId: A, items: [] })).rejects.toMatchObject({ status: 400 });
    });
});

describe('visibility', () => {
    test('a private update is invisible to anyone else, and acknowledging it reports not_found', async () => {
        const { update } = await updates.publish(finding());
        expect((await updates.list({ userId: B })).updates).toEqual([]);
        const { results } = await updates.acknowledge({ userId: B, items: [{ id: update.id, revision: 1 }] });
        expect(results).toEqual([{ id: update.id, status: 'not_found' }]);
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_update_receipts', {})).toMatchObject({ n: 0 });
    });

    test('project updates follow current membership, with separate receipts per member', async () => {
        const projectId = await project(A);
        await db.run("INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@projectId, @B, @A)", { projectId, A, B });
        const { update } = await updates.publish(finding({
            audience: { projectId }, identityKey: 'plan:1', kind: 'progress', components: ['projects'], producerUserId: A
        }));
        expect((await updates.list({ userId: B })).updates.map(u => u.id)).toEqual([update.id]);
        expect((await updates.list({ userId: C })).updates).toEqual([]);

        await updates.acknowledge({ userId: B, items: [{ id: update.id, revision: 1 }] });
        expect((await updates.list({ userId: B })).updates[0].unseen).toBe(false);
        expect((await updates.list({ userId: A })).updates[0].unseen).toBe(true);

        await db.run('DELETE FROM project_members WHERE userId = @B', { B });
        expect((await updates.list({ userId: B })).updates).toEqual([]);
    });
});

describe('paging', () => {
    test('a cursor pages a stable snapshot and is bound to its reader', async () => {
        for (let i = 0; i < 5; i += 1) await updates.publish(finding({ identityKey: `finding:${i}`, title: `Finding ${i}` }));
        const first = await updates.list({ userId: A, limit: 2 });
        expect(first.updates.map(u => u.title)).toEqual(['Finding 4', 'Finding 3']);
        await updates.publish(finding({ identityKey: 'finding:new', title: 'Arrived later' }));
        const second = await updates.list({ userId: A, limit: 2, cursor: first.nextCursor });
        expect(second.updates.map(u => u.title)).toEqual(['Finding 2', 'Finding 1']);
        expect(second.counts).toBeUndefined();
        const third = await updates.list({ userId: A, limit: 2, cursor: second.nextCursor });
        expect(third.updates.map(u => u.title)).toEqual(['Finding 0']);
        expect(third.nextCursor).toBeNull();
        await expect(updates.list({ userId: B, cursor: first.nextCursor })).rejects.toMatchObject({ status: 400 });
    });
});

describe('gates', () => {
    test('an open gate needs action until resolved; snoozing hides it without resolving it', async () => {
        const { update } = await updates.publish(finding({ kind: 'question', gate: { kind: 'question', id: 'q1' } }));
        expect((await updates.list({ userId: A })).counts.needsAction).toBe(1);
        await updates.acknowledge({ userId: A, items: [{ id: update.id, revision: 1 }] });
        expect((await updates.list({ userId: A })).counts.needsAction).toBe(1);

        await updates.snooze({ userId: A, id: update.id, until: new Date(Date.now() + 3600000).toISOString() });
        expect((await updates.list({ userId: A })).counts.needsAction).toBe(0);
        expect((await updates.list({ userId: A, now: new Date(Date.now() + 7200000) })).counts.needsAction).toBe(1);

        expect(await updates.resolveGate({ audience: { userId: A }, identityKey: 'finding:garden-frost' })).toBe(true);
        const [row] = (await updates.list({ userId: A, now: new Date(Date.now() + 7200000) })).updates;
        expect(row.gate).toMatchObject({ kind: 'question', resolved: true });
        expect(row.needsAction).toBe(false);
    });

    test('retention keeps open gates', async () => {
        await updates.publish(finding({ gate: { kind: 'question', id: 'q1' } }));
        await updates.publish(finding({ identityKey: 'finding:plain' }));
        await db.run("UPDATE assistant_updates SET updatedAt = '2020-01-01 00:00:00'", {});
        expect(await updates.prune({ days: 180 })).toBe(1);
        expect((await db.all('SELECT identityKey FROM assistant_updates', {})).map(r => r.identityKey)).toEqual(['finding:garden-frost']);
    });
});

describe('the Inbox envelope', () => {
    test('one envelope per update, refreshed and unread again on a material change', async () => {
        const { update } = await updates.publish(finding({ deliver: true }));
        let items = await db.all('SELECT * FROM inbox_items WHERE userId = @A', { A });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ sourceType: 'assistant_update', sourceId: `${update.id}:1`, title: 'Frost expected Thursday' });
        expect((await updates.list({ userId: A })).updates[0]).toMatchObject({ inboxItemId: Number(items[0].id), deliveredRevision: 1 });

        await updates.publish(finding({ deliver: true }));
        expect(await db.all('SELECT * FROM inbox_items WHERE userId = @A', { A })).toHaveLength(1);

        await inbox.markRead({ userId: A, itemId: items[0].id });
        await updates.publish(finding({ deliver: true, title: 'Frost expected Wednesday' }));
        items = await db.all('SELECT * FROM inbox_items WHERE userId = @A', { A });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ sourceId: `${update.id}:2`, title: 'Frost expected Wednesday', readAt: null });
    });

    test('reading the envelope acknowledges exactly the revision it rendered', async () => {
        const { update } = await updates.publish(finding({ deliver: true }));
        const [item] = await db.all('SELECT * FROM inbox_items WHERE userId = @A', { A });
        // A newer revision is recorded but its envelope has not been refreshed yet.
        await updates.publish(finding({ deliver: true, deliverNow: false, title: 'Frost expected Wednesday' }));
        await inbox.markRead({ userId: A, itemId: item.id });
        const [row] = (await updates.list({ userId: A })).updates;
        expect(row).toMatchObject({ revision: 2, acknowledgedRevision: 1, unseen: true });

        await updates.deliverPending({ userId: A });
        await inbox.markAllRead({ userId: A });
        expect((await updates.list({ userId: A })).updates[0]).toMatchObject({ acknowledgedRevision: 2, unseen: false });
        expect(update.id).toBe(row.id);
    });

    test('acknowledging in the portal reads the envelope for the current revision only', async () => {
        const { update } = await updates.publish(finding({ deliver: true }));
        await updates.acknowledge({ userId: A, items: [{ id: update.id, revision: 1 }] });
        const [item] = await db.all('SELECT * FROM inbox_items WHERE userId = @A', { A });
        expect(item.readAt).not.toBeNull();
    });

    test('a project update files no personal envelope', async () => {
        const projectId = await project(A);
        await updates.publish(finding({ audience: { projectId }, identityKey: 'plan:1', components: ['projects'], deliver: true }));
        expect(await db.all('SELECT * FROM inbox_items', {})).toEqual([]);
    });
});
