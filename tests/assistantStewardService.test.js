/**
 * The assistant steward and the DA-1 seams that tie responsibilities,
 * initiatives and updates together (ADR 0017), plus the portal routes,
 * against a throwaway database.
 *
 * The properties under test: a periodic pass recovers what a missed event
 * would have delivered, expiry ends work and files one update, a review
 * opens a gate that resuming resolves, the steward never runs twice at
 * once, the routes act only as the signed-in person, and erasure reaches
 * every DA-1 table including the work on someone else's grant.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-steward-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const steward = require('@goobster/core/services/assistantStewardService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const updates = require('@goobster/core/services/assistantUpdateService');
const policies = require('@goobster/core/services/attentionPolicyService');
const privacyService = require('@goobster/core/services/privacyService');
const { useState } = require('./helpers/featureFixtures');

const A = '750000000000000001';
const B = '750000000000000002';
const KG_ADD = { operation: 'kg.generated.add', resource: { kind: 'knowledge', ids: ['personal'] } };

afterAll(async () => {
    await steward.stop();
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    useState();
    for (const table of [
        'assistant_initiatives', 'assistant_source_cursors', 'assistant_update_receipts', 'assistant_updates',
        'assistant_process_observations', 'assistant_process_contracts',
        'assistant_responsibility_revisions', 'assistant_responsibilities', 'attention_policies', 'attention_items', 'inbox_items',
        'observatory_projects'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
});

async function goal(userId = A) {
    return db.insert(
        `INSERT INTO attention_items (guildId, userId, kind, subject, goal, state)
         VALUES (@guildId, @userId, 'goal', 'garden', 'v1', 'active')`,
        { guildId: `dm:${userId}`, userId }
    );
}

async function activeGrant(userId = A, body = {}) {
    await policies.enroll({ userId, initiative: 'assist' });
    const { responsibility } = await responsibilities.create({
        userId, body: { title: 'Keep the garden plan moving', operations: [KG_ADD], ...body }
    });
    return (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
}

describe('the periodic pass', () => {
    test('a change nobody announced is found by the next sweep, once', async () => {
        const item = await goal();
        const grant = await activeGrant(A, { attentionItemId: item });
        await db.run("UPDATE attention_items SET goal = 'v2' WHERE id = @item", { item });
        const first = await steward.sweep({ retention: false });
        expect(first).toMatchObject({ skipped: false, reconcile: { proposed: 1 } });
        expect((await steward.sweep({ retention: false })).reconcile.proposed).toBe(0);
        expect((await initiatives.list({ userId: A, responsibilityId: grant.id })).initiatives).toHaveLength(1);
    });

    test('concurrent sweeps share one pass', async () => {
        const [one, two] = await Promise.all([steward.sweep({ retention: false }), steward.sweep({ retention: false })]);
        expect(one).toBe(two);
    });

    test('expiry cancels open work and files one update with an Inbox envelope', async () => {
        const item = await goal();
        const grant = await activeGrant(A, { attentionItemId: item, expiresAt: new Date(Date.now() + 3600000).toISOString() });
        await db.run("UPDATE attention_items SET goal = 'v2' WHERE id = @item", { item });
        await initiatives.reconcileResponsibility(grant.id);
        const later = new Date(Date.now() + 2 * 3600000);
        const result = await steward.sweep({ now: later, retention: false });
        expect(result.expired).toBe(1);
        expect((await initiatives.list({ userId: A })).initiatives[0]).toMatchObject({ status: 'CANCELLED', stopCode: 'RESPONSIBILITY_EXPIRED' });
        const { updates: page } = await updates.list({ userId: A });
        expect(page).toEqual([expect.objectContaining({ kind: 'responsibility', responsibilityId: grant.id, componentIds: ['responsibilities'] })]);
        const envelopes = await db.all("SELECT * FROM inbox_items WHERE userId = @A AND sourceType = 'assistant_update'", { A });
        expect(envelopes).toHaveLength(1);
        await steward.sweep({ now: later, retention: false });
        expect(await db.all("SELECT * FROM inbox_items WHERE userId = @A AND sourceType = 'assistant_update'", { A })).toHaveLength(1);
    });

    test('a review opens a gate that resuming resolves', async () => {
        const grant = await activeGrant();
        await responsibilities.requestReview({ id: grant.id, expectedRevision: grant.revision });
        expect(await db.all("SELECT * FROM inbox_items WHERE userId = @A AND sourceType = 'assistant_update'", { A })).toHaveLength(1);
        let summary = (await updates.list({ userId: A })).counts;
        expect(summary.needsAction).toBe(1);
        const reviewed = await responsibilities.get({ userId: A, id: grant.id });
        await responsibilities.act({ userId: A, id: grant.id, action: 'resume', expectedRevision: reviewed.revision });
        summary = (await updates.list({ userId: A })).counts;
        expect(summary.needsAction).toBe(0);
    });

    test('nothing runs while the feature is off', async () => {
        useState({ inactive: ['assistant'] });
        expect(await steward.sweep()).toEqual({ skipped: true, reason: 'feature' });
    });
});

describe('portal routes', () => {
    let server;
    let base;
    beforeAll(async () => {
        const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
        const { DisabledGateway } = require('@goobster/core/gateway');
        const app = require('express')();
        app.use(createWebAppApp(createWebAppContext({ gateway: new DisabledGateway(), config: { webapp: { enabled: true, devMode: true } } })));
        server = require('node:http').createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    async function cookie(userId) {
        const login = await fetch(`${base}/api/app/auth/dev-session`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, name: userId })
        });
        return login.headers.get('set-cookie').split(';')[0];
    }
    const send = (method, url, session, body) => fetch(`${base}${url}`, {
        method,
        headers: { Cookie: session, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    test('initiatives, updates and processes as the signed-in person only', async () => {
        for (const url of ['/api/app/assistant/initiatives', '/api/app/assistant/updates', '/api/app/assistant/processes']) {
            expect((await fetch(`${base}${url}`)).status).toBe(401);
        }
        const own = await cookie(A);
        const other = await cookie(B);

        const item = await goal();
        const grant = await activeGrant(A, { attentionItemId: item });
        await db.run("UPDATE attention_items SET goal = 'v2' WHERE id = @item", { item });
        await initiatives.reconcileResponsibility(grant.id);
        const list = await (await send('GET', '/api/app/assistant/initiatives', own)).json();
        expect(list.initiatives).toHaveLength(1);
        const initiative = list.initiatives[0];
        expect((await send('GET', `/api/app/assistant/initiatives/${initiative.id}`, other)).status).toBe(404);
        const stale = await send('POST', `/api/app/assistant/initiatives/${initiative.id}/actions`, own, { action: 'queue', expectedRevision: 99 });
        expect(stale.status).toBe(409);
        const queued = await (await send('POST', `/api/app/assistant/initiatives/${initiative.id}/actions`, own,
            { action: 'queue', expectedRevision: initiative.revision })).json();
        expect(queued.initiative.status).toBe('QUEUED');

        const { update } = await updates.publish({
            audience: { userId: A }, identityKey: 'finding:1', kind: 'finding', title: 'Frost', components: ['research'], deliver: false
        });
        const page = await (await send('GET', '/api/app/assistant/updates?component=research', own)).json();
        expect(page.updates.map(u => u.id)).toEqual([update.id]);
        expect(page.counts.unseen).toBe(1);
        expect((await (await send('GET', '/api/app/assistant/updates', other)).json()).updates).toEqual([]);
        const theirAck = await (await send('POST', '/api/app/assistant/updates/acknowledge', other, { items: [{ id: update.id, revision: 1 }] })).json();
        expect(theirAck.results[0].status).toBe('not_found');
        const ack = await (await send('POST', '/api/app/assistant/updates/acknowledge', own, { items: [{ id: update.id, revision: 1 }] })).json();
        expect(ack.results[0].status).toBe('acknowledged');
        expect((await send('GET', '/api/app/assistant/updates?component=nonsense', own)).status).toBe(400);

        const automationId = await db.insert(
            "INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule) VALUES (@A, 'g', 'c', 'nightly', 'p', '0 3 * * *')",
            { A }
        );
        const processes = await (await send('GET', '/api/app/assistant/processes', own)).json();
        expect(processes.processes.map(p => p.ref)).toContain(`automation:${automationId}`);
        const url = `/api/app/assistant/processes/automation/${automationId}`;
        expect((await send('GET', url, other)).status).toBe(404);
        const put = await send('PUT', `${url}/contract`, own, { purpose: 'Overnight summary' });
        expect(put.status).toBe(200);
        expect((await (await send('GET', url, own)).json()).contract).toMatchObject({ purpose: 'Overnight summary', revision: 1 });
        expect((await send('PUT', `${url}/contract`, other, { purpose: 'mine' })).status).toBe(404);
        expect(await (await send('DELETE', `${url}/contract`, own)).json()).toEqual({ deleted: true });
        await db.run('DELETE FROM automations WHERE id = @automationId', { automationId });
    });

    test('the routes are gated by the assistant feature', async () => {
        const own = await cookie(A);
        useState({ inactive: ['assistant'] });
        const response = await send('GET', '/api/app/assistant/updates', own);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(await response.json()).toMatchObject({ error: { code: 'FEATURE_UNAVAILABLE' } });
    });
});

describe('erasure', () => {
    test('forget-me reaches every DA-1 table and ends work on someone else\'s grant that names the person', async () => {
        const item = await goal(A);
        const grant = await activeGrant(A, { attentionItemId: item });
        await db.run("UPDATE attention_items SET goal = 'v2' WHERE id = @item", { item });
        await initiatives.reconcileResponsibility(grant.id);
        await updates.publish({ audience: { userId: A }, identityKey: 'finding:1', kind: 'finding', title: 'Frost', components: ['research'], deliver: true });
        const projectId = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@B, 'shared', 'Shared')", { B });
        const [mine] = (await initiatives.list({ userId: A })).initiatives;
        const { update: shared } = await updates.publish({
            audience: { projectId }, identityKey: 'plan:shared', kind: 'progress', title: 'Plan moved', components: ['projects'],
            producerUserId: A, responsibilityId: grant.id, initiativeId: mine.id
        });

        const theirItem = await goal(B);
        const theirs = await activeGrant(B, { attentionItemId: theirItem });
        await db.run("UPDATE attention_items SET goal = 'v2' WHERE id = @theirItem", { theirItem });
        await initiatives.reconcileResponsibility(theirs.id);
        await db.run('UPDATE assistant_responsibilities SET payerUserId = @A WHERE id = @id', { A, id: theirs.id });
        await db.run('UPDATE assistant_initiatives SET actingUserId = @A WHERE responsibilityId = @id', { A, id: theirs.id });

        const before = await privacyService.auditUser({ userId: A });
        for (const table of ['assistant_initiatives', 'assistant_source_cursors', 'assistant_updates']) {
            expect(before.byTable[table]).toBeGreaterThan(0);
        }
        const report = await privacyService.forgetUser({ userId: A });
        expect(report).toMatchObject({ initiatives: 1, sourceCursors: 1, assistantUpdates: 1 });
        const after = await privacyService.auditUser({ userId: A });
        for (const table of ['assistant_initiatives', 'assistant_source_cursors', 'assistant_updates', 'assistant_update_receipts']) {
            expect(after.byTable[table]).toBe(0);
        }
        expect(await db.get('SELECT producerUserId, responsibilityId, initiativeId FROM assistant_updates WHERE id = @id', { id: shared.id }))
            .toEqual({ producerUserId: null, responsibilityId: null, initiativeId: null });
        const kept = await db.get('SELECT * FROM assistant_initiatives WHERE responsibilityId = @id', { id: theirs.id });
        expect(kept).toMatchObject({ ownerUserId: B, actingUserId: null, status: 'CANCELLED', stopCode: 'PRINCIPAL_ERASED' });
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_source_cursors WHERE responsibilityId = @id', { id: theirs.id })).toMatchObject({ n: 1 });
    });
});
