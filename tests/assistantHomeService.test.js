/**
 * The assistant-first Home projection, the Inbox's Needs-you filter and the
 * adoption of project gates (DA-2), against a throwaway database.
 *
 * The properties under test: reading Home changes nothing; Needs you is the
 * Inbox's own filter (one item, however many surfaces show it); reading an
 * item does not resolve its request and resolving it clears every view;
 * snooze hides without resolving; informational updates never become
 * obligations; What changed does not repeat Needs you; unknown is never a
 * reassuring zero; and one account never sees another's.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-home-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const home = require('@goobster/core/services/assistantHomeService');
const gates = require('@goobster/core/services/assistantGateService');
const updates = require('@goobster/core/services/assistantUpdateService');
const inbox = require('@goobster/core/services/inboxService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const policies = require('@goobster/core/services/attentionPolicyService');
const steward = require('@goobster/core/services/assistantStewardService');
const instanceState = require('@goobster/core/services/instanceStateService');
const missions = require('@goobster/core/services/projectMissionService');
const { useState } = require('./helpers/featureFixtures');

const A = '740000000000000001';
const B = '740000000000000002';
const KG_ADD = { operation: 'kg.generated.add', resource: { kind: 'knowledge', ids: ['personal'] } };

const TABLES = [
    'assistant_update_receipts', 'assistant_updates', 'assistant_process_observations', 'assistant_initiatives',
    'assistant_responsibility_revisions', 'assistant_responsibilities', 'attention_policies', 'inbox_items',
    'friendships', 'instance_state'
];

afterAll(async () => {
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`, {});
});

async function active(userId = A, title = 'Keep my garden notes current') {
    await policies.enroll({ userId, initiative: 'assist' });
    const { responsibility } = await responsibilities.create({ userId, body: { title, operations: [KG_ADD] } });
    return (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
}

const beat = (date = new Date()) => instanceState.set(steward.HEARTBEAT_KEY, { at: date.toISOString() });

const finding = (overrides = {}) => updates.publish({
    audience: { userId: A }, identityKey: 'finding:frost', kind: 'finding', title: 'Frost expected Thursday',
    summary: 'Cover the seedlings.', components: ['research', 'knowledge'], deliver: true, ...overrides
});

const gate = (overrides = {}) => finding({
    identityKey: 'repair:import', kind: 'question', title: 'Nightly import: review the repair',
    components: ['processes'], gate: { kind: 'process_repair', id: 'automation:5' }, ...overrides
});

async function snapshot() {
    const out = {};
    for (const table of ['assistant_updates', 'assistant_update_receipts', 'inbox_items', 'assistant_responsibilities', 'assistant_initiatives']) {
        out[table] = await db.all(`SELECT * FROM ${table} ORDER BY 1`, {});
    }
    return JSON.stringify(out);
}

describe('the Home projection', () => {
    test('a fresh account has nothing delegated, says so, and reading changes nothing', async () => {
        const before = await snapshot();
        const view = await home.project({ userId: A });
        expect(view).toMatchObject({
            schemaVersion: 1, availability: 'attention_off',
            counts: { unseen: 0, needsAction: 0, running: 0 }, needsYou: [], brief: [], partial: []
        });
        expect(view.responsibilities.counts).toEqual({ active: 0, paused: 0, needsReview: 0, draft: 0 });
        expect(view.components.map(c => c.id)).toEqual(['knowledge', 'research', 'projects', 'processes', 'conversations']);
        expect(await snapshot()).toBe(before);
        // Visiting Home never enrolls anyone in Attention.
        expect(await policies.get(A)).toBeNull();

        await policies.enroll({ userId: A, initiative: 'assist' });
        expect((await home.project({ userId: A })).availability).toBe('none_delegated');
    });

    test('status comes from records: active, paused, and a draft is not delegation', async () => {
        const grant = await active();
        await responsibilities.create({ userId: A, body: { title: 'A draft', operations: [KG_ADD] } });
        let view = await home.project({ userId: A });
        expect(view.availability).toBe('ready');
        expect(view.responsibilities.counts).toEqual({ active: 1, paused: 0, needsReview: 0, draft: 1 });
        expect(view.responsibilities.items).toHaveLength(1);
        expect(view.responsibilities.items[0]).toMatchObject({ id: grant.id, status: 'ACTIVE', title: 'Keep my garden notes current' });

        await responsibilities.act({ userId: A, id: grant.id, action: 'pause', expectedRevision: grant.revision });
        view = await home.project({ userId: A });
        expect(view.availability).toBe('paused');
        expect(view.responsibilities.counts).toMatchObject({ active: 0, paused: 1 });
    });

    test('one finding is one briefing item and one unseen count, on every component it touches', async () => {
        await active();
        await beat();
        const { update } = await finding();
        const view = await home.project({ userId: A });
        expect(view.counts).toMatchObject({ unseen: 1, needsAction: 0 });
        expect(view.brief).toHaveLength(1);
        expect(view.brief[0]).toMatchObject({ id: update.id, revision: 1, componentIds: ['knowledge', 'research'] });
        const by = Object.fromEntries(view.components.map(c => [c.id, c]));
        expect(by.knowledge).toMatchObject({ unseen: 1, state: 'updates' });
        expect(by.research).toMatchObject({ unseen: 1, state: 'updates' });
        expect(by.projects).toMatchObject({ unseen: 0, state: 'quiet' });
        // An informational update is never an obligation.
        expect(view.needsYou).toEqual([]);

        // Acknowledging it clears every highlight; a new revision is unseen again.
        await updates.acknowledge({ userId: A, items: [{ id: update.id, revision: 1 }] });
        let after = await home.project({ userId: A });
        expect(after.counts.unseen).toBe(0);
        expect(after.brief).toEqual([]);
        expect(after.components.every(c => c.state === 'quiet')).toBe(true);
        await finding({ summary: 'Cover the seedlings and the beans.' });
        after = await home.project({ userId: A });
        expect(after.counts.unseen).toBe(1);
        expect(after.brief[0].revision).toBe(2);
    });

    test('a request shows under Needs you, not again under What changed, and reading does not resolve it', async () => {
        await active();
        await beat();
        const { update } = await gate();
        let view = await home.project({ userId: A });
        expect(view.counts).toMatchObject({ needsAction: 1, unseen: 1 });
        expect(view.needsYou).toHaveLength(1);
        expect(view.needsYou[0]).toMatchObject({ title: 'Nightly import: review the repair', request: 'process_repair', read: false });
        expect(view.needsYou[0].update).toMatchObject({ id: update.id, gateOpen: true });
        expect(view.brief).toEqual([]);
        expect(view.components.find(c => c.id === 'processes')).toMatchObject({ state: 'needs_you', needsAction: 1 });

        // Read: the highlight clears, the request stays.
        await inbox.markRead({ userId: A, itemId: view.needsYou[0].inboxItemId });
        view = await home.project({ userId: A });
        expect(view.counts).toMatchObject({ needsAction: 1, unseen: 0 });
        expect(view.needsYou[0].read).toBe(true);

        // Mark all read resolves nothing either.
        await inbox.markAllRead({ userId: A });
        expect((await home.project({ userId: A })).counts.needsAction).toBe(1);

        // The domain resolves it: gone from Needs you everywhere, kept in history.
        await updates.resolveGate({ audience: { userId: A }, identityKey: 'repair:import' });
        view = await home.project({ userId: A });
        expect(view.counts.needsAction).toBe(0);
        expect(view.needsYou).toEqual([]);
        expect((await inbox.list({ userId: A })).items).toHaveLength(1);
    });

    test('running work and a blocked process are separate signals from updates', async () => {
        const grant = await active();
        await beat();
        const later = new Date(Date.now() + 5 * 60000).toISOString().slice(0, 19).replace('T', ' ');
        await db.run(
            `INSERT INTO assistant_initiatives
                (responsibilityId, responsibilityRevision, ownerUserId, actingUserId, sourceKind, sourceId, sourceRevision,
                 dedupeKey, title, status, leaseToken, leaseExpiresAt)
             VALUES (@rid, @rev, @owner, @owner, 'project_plan', '1', 'a', 'k1', 'Advance the plan', 'RUNNING', 't', @later)`,
            { rid: grant.id, rev: grant.revision, owner: A, later }
        );
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        for (const [key, outcome, at] of [['fire:1', 'ok', '2000-01-01 00:00:00'], ['fire:2', 'failed', now]]) {
            await db.run(
                `INSERT INTO assistant_process_observations (ownerUserId, processKind, processId, occurrenceKey, phase, outcome, observedAt)
                 VALUES (@owner, 'automation', '5', @key, 'outcome', @outcome, @at)`,
                { owner: A, key, outcome, at }
            );
        }
        const view = await home.project({ userId: A });
        expect(view.counts).toMatchObject({ running: 1, unseen: 0, needsAction: 0 });
        const by = Object.fromEntries(view.components.map(c => [c.id, c]));
        expect(by.projects).toMatchObject({ state: 'working', running: 1, unseen: 0 });
        expect(by.processes).toMatchObject({ state: 'blocked', blocked: 1 });
        expect(view.responsibilities.items[0].initiatives).toMatchObject({ running: 1 });
        // A lapsed lease is not "working".
        await db.run("UPDATE assistant_initiatives SET leaseExpiresAt = '2000-01-01 00:00:00'", {});
        expect((await home.project({ userId: A })).counts.running).toBe(0);
    });

    test('freshness comes from the steward\'s last pass; stale or unknown is never shown as quiet', async () => {
        await active();
        let view = await home.project({ userId: A });
        expect(view.freshness).toEqual({ state: 'unknown', lastPassAt: null });
        expect(view.components.find(c => c.id === 'knowledge').state).toBe('unknown');
        await beat(new Date(Date.now() - 3600000));
        view = await home.project({ userId: A });
        expect(view.freshness.state).toBe('stale');
        expect(view.components.find(c => c.id === 'knowledge').state).toBe('unknown');
        await beat();
        view = await home.project({ userId: A });
        expect(view.freshness.state).toBe('current');
        expect(view.components.find(c => c.id === 'knowledge').state).toBe('quiet');
    });

    test('a section that cannot be read is reported as partial with null counts, not zero', async () => {
        await active();
        jest.spyOn(updates, 'summary').mockRejectedValue(new Error('boom'));
        const view = await home.project({ userId: A });
        expect(view.partial).toContain('updates');
        expect(view.counts.unseen).toBeNull();
        expect(view.components.find(c => c.id === 'knowledge')).toMatchObject({ state: 'unknown', unseen: null });
        // The rest stays usable.
        expect(view.responsibilities.counts.active).toBe(1);
    });

    test('feature off: unavailable, but the Inbox\'s own requests still preview', async () => {
        await db.run(
            "INSERT INTO friendships (id, lowId, highId, requesterId, addresseeId, status) VALUES (9, @a, @b, @b, @a, 'pending')", { a: A, b: B }
        );
        await inbox.deliver({ userId: A, kind: 'invite', title: 'B wants to be friends', source: { type: 'friend_request', id: '9' }, discord: false });
        useState({ inactive: ['assistant'] });
        const view = await home.project({ userId: A });
        expect(view).toMatchObject({ availability: 'unavailable', unavailable: { feature: 'assistant' } });
        expect(view.counts).toEqual({ unseen: null, needsAction: 1, running: null });
        expect(view.needsYou[0]).toMatchObject({ request: 'friend_request' });
        expect(view.components.every(c => c.state === 'unknown' || c.state === 'unavailable')).toBe(true);
    });

    test('one account never sees another account\'s overview', async () => {
        await active(A);
        await gate();
        await finding();
        const other = await home.project({ userId: B });
        expect(other.counts).toMatchObject({ unseen: 0, needsAction: 0 });
        expect(other.needsYou).toEqual([]);
        expect(other.brief).toEqual([]);
        expect(other.responsibilities.items).toEqual([]);
    });
});

describe('the Inbox filters', () => {
    test('All, Needs you and Updates are views of the same items', async () => {
        await finding();
        await gate();
        await inbox.deliver({ userId: A, kind: 'reminder', title: 'Water the beans', discord: false });
        const all = await inbox.list({ userId: A });
        expect(all.items).toHaveLength(3);
        expect(all).toMatchObject({ view: 'all', unread: 3, needsYou: 1 });
        const needs = await inbox.list({ userId: A, view: 'needs_you' });
        expect(needs.items.map(i => i.title)).toEqual(['Nightly import: review the repair']);
        expect(needs.items[0]).toMatchObject({ needsAction: true });
        const informational = await inbox.list({ userId: A, view: 'updates' });
        expect(informational.items.map(i => i.title).sort()).toEqual(['Frost expected Thursday', 'Water the beans']);
        expect(informational.items.every(i => i.needsAction === false)).toBe(true);
        await expect(inbox.list({ userId: A, view: 'nope' })).rejects.toMatchObject({ code: 'BAD_VIEW' });
    });

    test('a resolved request stays in All with its outcome and does not move to Updates', async () => {
        await gate();
        await updates.resolveGate({ audience: { userId: A }, identityKey: 'repair:import' });
        expect((await inbox.list({ userId: A, view: 'needs_you' })).items).toEqual([]);
        expect((await inbox.list({ userId: A, view: 'updates' })).items).toEqual([]);
        const [item] = (await inbox.list({ userId: A })).items;
        expect(item).toMatchObject({ needsAction: false });
        expect(item.update.gate).toMatchObject({ resolved: true });
    });

    test('snooze hides a request from Needs you without resolving it; archive cannot hide one', async () => {
        const { update } = await gate();
        const until = new Date(Date.now() + 3600000).toISOString();
        await updates.snooze({ userId: A, id: update.id, until });
        expect((await inbox.list({ userId: A, view: 'needs_you' })).items).toEqual([]);
        expect((await inbox.needsYouCount(A))).toBe(0);
        const snoozed = await inbox.list({ userId: A, view: 'snoozed' });
        expect(snoozed.items).toHaveLength(1);
        expect(snoozed.items[0].update).toMatchObject({ gateOpen: true });
        expect(snoozed.items[0].update.snoozedUntil).toBeTruthy();
        // Still open in the domain.
        expect((await db.get('SELECT gateResolvedAt FROM assistant_updates WHERE id = @id', { id: update.id })).gateResolvedAt).toBeNull();

        await db.run('DELETE FROM assistant_update_receipts', {});
        const [item] = (await inbox.list({ userId: A, view: 'needs_you' })).items;
        await inbox.archive({ userId: A, itemId: item.id });
        expect((await inbox.list({ userId: A })).items).toEqual([]);
        expect((await inbox.list({ userId: A, view: 'needs_you' })).items).toHaveLength(1);
    });

    test('a friend request needs the addressee, not the requester', async () => {
        await db.run("INSERT INTO friendships (id, lowId, highId, requesterId, addresseeId, status) VALUES (9, @a, @b, @b, @a, 'pending')", { a: A, b: B });
        for (const userId of [A, B]) {
            await inbox.deliver({ userId, kind: 'invite', title: 'Friend request', source: { type: 'friend_request', id: '9' }, discord: false });
        }
        expect(await inbox.needsYouCount(A)).toBe(1);
        expect(await inbox.needsYouCount(B)).toBe(0);
        await db.run("UPDATE friendships SET status = 'accepted' WHERE id = 9", {});
        expect(await inbox.needsYouCount(A)).toBe(0);
    });
});

describe('adopting project gates', () => {
    const card = (overrides = {}) => ({
        projectSlug: 'garden', projectName: 'Garden', ownerId: A, missionId: 3, missionTitle: 'Plant', missionStatus: 'DRAFT',
        column: 'approve', id: 'approve:3', title: 'Approve mission plan', detail: 'Plant the beds', ...overrides
    });
    const board = (cards) => jest.spyOn(missions, 'listNeedsYou').mockResolvedValue({ cards, text: '' });

    test('one gate is one Inbox item however often it is reconciled, and it closes with the gate', async () => {
        board([card()]);
        expect(await gates.adoptProjectGates({ userId: A })).toEqual({ adopted: 1, resolved: 0 });
        expect(await gates.adoptProjectGates({ userId: A })).toEqual({ adopted: 0, resolved: 0 });
        const needs = await inbox.list({ userId: A, view: 'needs_you' });
        expect(needs.items).toHaveLength(1);
        expect(needs.items[0]).toMatchObject({ title: 'Garden: Approve mission plan', needsAction: true });
        expect(needs.items[0].update).toMatchObject({ componentIds: ['projects'], gate: { kind: 'project_approve', id: 'approve:3', occurrence: 1 } });
        // Adoption never echoes to Discord.
        expect((await db.get('SELECT discordStatus FROM inbox_items', {})).discordStatus).toBe('skipped');

        jest.restoreAllMocks();
        board([]);
        expect(await gates.adoptProjectGates({ userId: A })).toEqual({ adopted: 0, resolved: 1 });
        expect((await inbox.list({ userId: A, view: 'needs_you' })).items).toEqual([]);
        expect((await inbox.list({ userId: A })).items).toHaveLength(1);
    });

    test('a gate that opens again is a new occurrence on the same item', async () => {
        board([card({ column: 'unblock', id: 'blocked:3', title: 'Mission blocked' })]);
        await gates.adoptProjectGates({ userId: A });
        jest.restoreAllMocks();
        board([]);
        await gates.adoptProjectGates({ userId: A });
        jest.restoreAllMocks();
        board([card({ column: 'unblock', id: 'blocked:3', title: 'Mission blocked' })]);
        expect(await gates.adoptProjectGates({ userId: A })).toMatchObject({ adopted: 1 });
        const needs = await inbox.list({ userId: A, view: 'needs_you' });
        expect(needs.items).toHaveLength(1);
        expect(needs.items[0].update.gate).toMatchObject({ occurrence: 2, resolved: false });
        expect(await db.get('SELECT COUNT(*) AS n FROM inbox_items', {})).toMatchObject({ n: 1 });
    });

    test('setup findings and another owner\'s gates are not personal requests', async () => {
        board([card({ column: 'setup', id: 'setup:garden' }), card({ ownerId: B, id: 'approve:4' })]);
        expect(await gates.adoptProjectGates({ userId: A })).toEqual({ adopted: 0, resolved: 0 });
        expect(await inbox.needsYouCount(A)).toBe(0);
    });

    test('nothing is adopted while the feature is off', async () => {
        const spy = board([card()]);
        useState({ inactive: ['assistant'] });
        expect(await gates.adoptProjectGates({ userId: A })).toEqual({ adopted: 0, resolved: 0 });
        expect(spy).not.toHaveBeenCalled();
    });
});
