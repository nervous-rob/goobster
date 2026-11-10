/**
 * Delegated responsibilities (DA-1a, ADR 0016): the grant lifecycle, the
 * expectedRevision compare-and-swap, the dispatch-time authority check, the
 * portal routes and the privacy paths, against a throwaway database.
 *
 * The properties under test are the ones that keep a responsibility from
 * becoming ambient authority: nothing activates on its own, an active grant
 * cannot be widened in place, every refusal names one reason, and erasure
 * reaches every row that names the person.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-responsibility-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const service = require('@goobster/core/services/assistantResponsibilityService');
const policies = require('@goobster/core/services/attentionPolicyService');
const privacyService = require('@goobster/core/services/privacyService');
const identityService = require('@goobster/core/services/identityService');
const { useState } = require('./helpers/featureFixtures');

const A = '710000000000000001';
const B = '710000000000000002';

const KG_ADD = { operation: 'kg.generated.add', resource: { kind: 'knowledge', ids: ['personal'] } };

afterAll(async () => {
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    useState();
    for (const table of [
        'assistant_responsibility_revisions', 'assistant_responsibilities', 'attention_policies',
        'project_repos', 'project_members', 'project_missions', 'observatory_projects', 'automations'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
});

async function enroll(userId = A, initiative = 'assist') {
    await policies.enroll({ userId, initiative });
}

async function project(userId = A, slug = 'garden') {
    return db.insert(
        'INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, @slug, @slug)',
        { userId, slug }
    );
}

async function draft(body = {}, userId = A) {
    const { responsibility } = await service.create({
        userId, body: { title: 'Keep my garden notes current', operations: [KG_ADD], ...body }
    });
    return responsibility;
}

async function active(body = {}, userId = A) {
    await enroll(userId);
    const created = await draft(body, userId);
    return (await service.act({ userId, id: created.id, action: 'activate', expectedRevision: created.revision })).responsibility;
}

/**
 * Repository and connector operations are the owner's alone until the pilot
 * decision is recorded (tests/assistantControlService.test.js covers the
 * refusal); these cases exercise the grant itself, as the owner.
 */
async function asOwner(userId = A) {
    await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: 'owner' });
    await identityService.grantAccount({ principalId: userId, entitlement: 'bootstrap', role: 'operator' });
}

async function revisionRows(id) {
    return db.all('SELECT * FROM assistant_responsibility_revisions WHERE responsibilityId = @id ORDER BY revision', { id });
}

const check = (grant, overrides = {}) => service.authorize({
    responsibilityId: grant.id,
    revision: grant.revision,
    operation: 'kg.generated.add',
    resource: { kind: 'knowledge', id: 'personal' },
    actorUserId: A,
    ...overrides
});

describe('creating and validating', () => {
    test('a new responsibility is an inert draft owned, authorized, acted and paid for by its creator', async () => {
        const grant = await draft({ ownerUserId: B, actingUserId: B });
        expect(grant).toMatchObject({
            status: 'DRAFT', revision: 1, authorityRevision: 1,
            ownerUserId: A, authorizedBy: A, actingUserId: A, payerUserId: A,
            operations: [KG_ADD]
        });
        expect(await revisionRows(grant.id)).toEqual([expect.objectContaining({ revision: 1, changeKind: 'create', changedBy: A })]);
    });

    test('it never activates without an explicit request, even with Attention enabled', async () => {
        await enroll();
        const grant = await draft();
        expect(grant.status).toBe('DRAFT');
        expect(await check(grant)).toEqual({ ok: false, code: 'RESPONSIBILITY_INACTIVE', status: 'DRAFT' });
    });

    test('unknown operations, wildcard resources and unknown fields are rejected', async () => {
        await expect(draft({ operations: [{ operation: 'write', resource: { kind: 'web' } }] }))
            .rejects.toMatchObject({ code: 'INVALID_OPERATION' });
        await expect(draft({ operations: [{ operation: 'file.edit', resource: { kind: 'project', ids: [] } }] }))
            .rejects.toMatchObject({ code: 'INVALID_RESOURCE' });
        await expect(draft({ operations: [{ operation: 'file.edit', resource: { kind: 'knowledge' } }] }))
            .rejects.toMatchObject({ code: 'INVALID_RESOURCE' });
        await expect(draft({ operations: [{ operation: 'file.edit', resource: { kind: 'project', ids: ['1'], paths: ['../etc'] } }] }))
            .rejects.toMatchObject({ code: 'INVALID_RESOURCE' });
        // A repository write that reaches GitHub must name its branches: no
        // branches would match every branch, the default one included.
        for (const operation of ['repo.push', 'pr.create']) {
            await expect(draft({ operations: [{ operation, resource: { kind: 'repository', projectId: '1', ids: ['owner/site'] } }] }))
                .rejects.toMatchObject({ code: 'INVALID_RESOURCE' });
        }
        await expect(draft({ budgets: { dollars: 5 } })).rejects.toMatchObject({ code: 'INVALID_RESPONSIBILITY' });
        await expect(draft({ title: '  ' })).rejects.toMatchObject({ code: 'INVALID_RESPONSIBILITY' });
    });

    test('links must point at records the owner can reach', async () => {
        const theirs = await project(B, 'theirs');
        await expect(draft({ projectId: theirs })).rejects.toMatchObject({ code: 'INVALID_LINK' });
        await expect(draft({ planId: 5 })).rejects.toMatchObject({ code: 'INVALID_LINK' });
        await expect(draft({ scopes: { audience: 'project' } })).rejects.toMatchObject({ code: 'INVALID_LINK' });
        const mine = await project(A, 'mine');
        // Sharing findings with a project is a pilot capability (documentation/delegated_project_findings.md).
        await require('@goobster/core/services/assistantAccessService').recordDecision({ scope: 'everyone' });
        try {
            expect((await draft({ projectId: mine, scopes: { audience: 'project' } })).projectId).toBe(mine);
        } finally {
            await db.run("DELETE FROM instance_state WHERE key = 'assistantPilot'", {});
        }
    });

    test('an idempotency key replays the first create', async () => {
        const first = await service.create({ userId: A, body: { title: 'Once' }, idempotencyKey: 'k-1' });
        const second = await service.create({ userId: A, body: { title: 'Twice' }, idempotencyKey: 'k-1' });
        expect(first.created).toBe(true);
        expect(second).toEqual({ responsibility: first.responsibility, created: false });
        const other = await service.create({ userId: B, body: { title: 'Theirs' }, idempotencyKey: 'k-1' });
        expect(other.created).toBe(true);
        expect((await db.all('SELECT id FROM assistant_responsibilities')).length).toBe(2);
    });

    test('create-and-activate fails as a whole when Attention is off', async () => {
        await expect(service.create({ userId: A, body: { title: 'Now', operations: [KG_ADD] }, activate: true }))
            .rejects.toMatchObject({ code: 'ATTENTION_NOT_ENROLLED' });
        expect(await db.all('SELECT id FROM assistant_responsibilities')).toEqual([]);
        await enroll();
        const { responsibility } = await service.create({ userId: A, body: { title: 'Now', operations: [KG_ADD] }, activate: true });
        expect(responsibility).toMatchObject({ status: 'ACTIVE', revision: 2 });
    });
});

describe('lifecycle', () => {
    test('activation needs Attention, an operation and reachable resources', async () => {
        const empty = await draft({ operations: [] });
        await enroll();
        await expect(service.act({ userId: A, id: empty.id, action: 'activate', expectedRevision: 1 }))
            .rejects.toMatchObject({ code: 'INVALID_OPERATION' });

        const pid = await project(B, 'not-mine');
        const foreign = await draft({ operations: [{ operation: 'file.edit', resource: { kind: 'project', ids: [String(pid)] } }] });
        await expect(service.act({ userId: A, id: foreign.id, action: 'activate', expectedRevision: 1 }))
            .rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });

        await policies.disable(A);
        const grant = await draft();
        await expect(service.act({ userId: A, id: grant.id, action: 'activate', expectedRevision: 1 }))
            .rejects.toMatchObject({ code: 'ATTENTION_NOT_ENROLLED' });
    });

    test('the full path writes one snapshot per change and bumps authority on every status change', async () => {
        let grant = await active();
        expect(grant).toMatchObject({ status: 'ACTIVE', revision: 2, authorityRevision: 2 });
        grant = (await service.act({ userId: A, id: grant.id, action: 'pause', expectedRevision: 2 })).responsibility;
        grant = (await service.act({ userId: A, id: grant.id, action: 'resume', expectedRevision: 3 })).responsibility;
        grant = (await service.requestReview({ id: grant.id, expectedRevision: 4 })).responsibility;
        expect(grant.status).toBe('NEEDS_REVIEW');
        grant = (await service.act({ userId: A, id: grant.id, action: 'resume', expectedRevision: 5 })).responsibility;
        expect(grant.reviewedAt).toBeTruthy();
        grant = (await service.act({ userId: A, id: grant.id, action: 'complete', expectedRevision: 6 })).responsibility;
        grant = (await service.act({ userId: A, id: grant.id, action: 'archive', expectedRevision: 7 })).responsibility;
        expect(grant).toMatchObject({ status: 'ARCHIVED', finalStatus: 'COMPLETED', revision: 8, authorityRevision: 8 });
        expect((await revisionRows(grant.id)).map(row => row.changeKind))
            .toEqual(['create', 'activate', 'pause', 'resume', 'review', 'resume', 'complete', 'archive']);
    });

    test('forbidden transitions are refused and terminal records never come back', async () => {
        const grant = await draft();
        await expect(service.act({ userId: A, id: grant.id, action: 'pause', expectedRevision: 1 }))
            .rejects.toMatchObject({ code: 'INVALID_TRANSITION', status: 409 });
        await expect(service.act({ userId: A, id: grant.id, action: 'request_review', expectedRevision: 1 }))
            .rejects.toMatchObject({ code: 'INVALID_ACTION' });
        const revoked = (await service.act({ userId: A, id: grant.id, action: 'revoke', expectedRevision: 1 })).responsibility;
        expect(revoked.status).toBe('REVOKED');
        await enroll();
        for (const action of ['activate', 'resume', 'pause', 'complete']) {
            await expect(service.act({ userId: A, id: grant.id, action, expectedRevision: 2 }))
                .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
        }
        await expect(service.update({ userId: A, id: grant.id, expectedRevision: 2, body: { title: 'Again' } }))
            .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    });

    test('a stale expectedRevision is a conflict that changes nothing', async () => {
        const grant = await draft();
        await service.update({ userId: A, id: grant.id, expectedRevision: 1, body: { title: 'Renamed' } });
        const error = await service.update({ userId: A, id: grant.id, expectedRevision: 1, body: { title: 'Lost' } }).catch(e => e);
        expect(error).toMatchObject({ code: 'REVISION_CONFLICT', status: 409, details: { revision: 2 } });
        await expect(service.act({ userId: A, id: grant.id, action: 'revoke' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
        expect((await service.get({ userId: A, id: grant.id })).title).toBe('Renamed');
        expect((await revisionRows(grant.id)).length).toBe(2);
    });

    test('another person cannot read or change a responsibility', async () => {
        const grant = await draft();
        await expect(service.get({ userId: B, id: grant.id })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
        await expect(service.update({ userId: B, id: grant.id, expectedRevision: 1, body: { title: 'Mine now' } }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(service.act({ userId: B, id: grant.id, action: 'revoke', expectedRevision: 1 }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect((await service.list({ userId: B })).responsibilities).toEqual([]);
    });
});

describe('editing an active responsibility', () => {
    test('a title edit keeps it active and keeps work planned under it valid', async () => {
        const grant = await active();
        const { responsibility } = await service.update({ userId: A, id: grant.id, expectedRevision: 2, body: { title: 'Garden notes' } });
        expect(responsibility).toMatchObject({ status: 'ACTIVE', revision: 3, authorityRevision: 2, title: 'Garden notes' });
        expect(await check(grant)).toMatchObject({ ok: true, revision: 3 });
    });

    test('changing what it may do needs a pause, and resuming invalidates older plans', async () => {
        const grant = await active();
        await expect(service.update({ userId: A, id: grant.id, expectedRevision: 2, body: { budgets: { searches: 3 } } }))
            .rejects.toMatchObject({ code: 'PAUSE_REQUIRED' });
        const paused = (await service.act({ userId: A, id: grant.id, action: 'pause', expectedRevision: 2 })).responsibility;
        const edited = (await service.update({ userId: A, id: grant.id, expectedRevision: paused.revision, body: { budgets: { searches: 3 } } })).responsibility;
        expect(edited).toMatchObject({ status: 'PAUSED', budgets: { searches: 3 }, authorityRevision: 4 });
        const resumed = (await service.act({ userId: A, id: grant.id, action: 'resume', expectedRevision: 4 })).responsibility;
        expect(await check(grant)).toEqual({ ok: false, code: 'REVISION_CONFLICT', revision: 5 });
        expect(await check(resumed)).toMatchObject({ ok: true });
    });
});

describe('authorize', () => {
    afterEach(async () => {
        await db.run('DELETE FROM app_accounts WHERE principalId = @id', { id: A });
    });

    test('allows exactly the granted operation on the granted resource', async () => {
        const grant = await active();
        expect(await check(grant)).toEqual({ ok: true, responsibilityId: grant.id, revision: 2, operation: 'kg.generated.add' });
        expect(await check(grant, { operation: 'kg.saved.amend' })).toEqual({ ok: false, code: 'OPERATION_OUT_OF_SCOPE' });
        expect(await check(grant, { operation: 'delete-everything' })).toEqual({ ok: false, code: 'OPERATION_OUT_OF_SCOPE' });
        expect(await check(grant, { resource: { kind: 'knowledge', id: 'guild' } })).toEqual({ ok: false, code: 'OPERATION_OUT_OF_SCOPE' });
    });

    test('project paths and repository branches narrow the grant', async () => {
        await asOwner();
        const pid = await project();
        await db.insert(
            `INSERT INTO project_repos (projectId, userId, name, repo, branch)
             VALUES (@pid, @userId, 'site', 'Owner/Site', 'main')`,
            { pid, userId: A }
        );
        const grant = await active({
            operations: [
                { operation: 'file.edit', resource: { kind: 'project', ids: [String(pid)], paths: ['docs/'] } },
                { operation: 'repo.commit', resource: { kind: 'repository', projectId: String(pid), ids: ['Owner/Site'], branches: ['goobster/*'] } }
            ]
        });
        const file = (p) => check(grant, { operation: 'file.edit', resource: { kind: 'project', id: String(pid), path: p } });
        expect((await file('docs/a.md')).ok).toBe(true);
        expect((await file('src/a.js')).code).toBe('OPERATION_OUT_OF_SCOPE');
        expect((await file('docs/../src/a.js')).code).toBe('OPERATION_OUT_OF_SCOPE');
        const commit = (branch) => check(grant, { operation: 'repo.commit', resource: { kind: 'repository', projectId: String(pid), id: 'owner/site', branch } });
        expect((await commit('goobster/fix')).ok).toBe(true);
        expect((await commit('main')).code).toBe('OPERATION_OUT_OF_SCOPE');

        await db.run('DELETE FROM project_repos', {});
        expect((await commit('goobster/fix')).code).toBe('RESOURCE_UNAVAILABLE');
    });

    test('losing access to the resource refuses at dispatch', async () => {
        const pid = await project(B, 'shared');
        await db.run(
            `INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@pid, @userId, @invitedBy)`,
            { pid, userId: A, invitedBy: B }
        );
        const grant = await active({ operations: [{ operation: 'file.edit', resource: { kind: 'project', ids: [String(pid)] } }] });
        const edit = () => check(grant, { operation: 'file.edit', resource: { kind: 'project', id: String(pid), path: 'a.txt' } });
        expect((await edit()).ok).toBe(true);
        await db.run('DELETE FROM project_members', {});
        expect(await edit()).toEqual({ ok: false, code: 'RESOURCE_UNAVAILABLE' });
    });

    test('a feature turned off refuses, and the assistant feature itself gates everything', async () => {
        const grant = await active();
        useState({ inactive: ['knowledge'] });
        expect(await check(grant)).toMatchObject({ ok: false, code: 'FEATURE_UNAVAILABLE', feature: 'knowledge' });
        useState({ inactive: ['assistant'] });
        expect(await check(grant)).toMatchObject({ ok: false, code: 'FEATURE_UNAVAILABLE', feature: 'assistant' });
        useState();
        expect((await check(grant)).ok).toBe(true);
    });

    test('Attention must stay enabled and its boundaries apply', async () => {
        const grant = await active();
        await policies.setInitiative(A, 'nudge');
        expect(await check(grant)).toEqual({ ok: false, code: 'ATTENTION_BOUNDARY', category: 'knowledge', action: 'compute' });
        await policies.setInitiative(A, 'assist');
        await policies.setBoundary({ userId: A, category: 'knowledge', proactiveCompute: false });
        expect((await check(grant)).code).toBe('ATTENTION_BOUNDARY');
        await policies.disable(A);
        expect(await check(grant)).toEqual({ ok: false, code: 'ATTENTION_NOT_ENROLLED' });
    });

    test('a confirm boundary on an external write requires a human', async () => {
        await asOwner();
        const grant = await active({ operations: [{ operation: 'external.write', resource: { kind: 'external', ids: ['calendar'] } }] });
        await policies.setInitiative(A, 'delegate');
        const write = () => check(grant, { operation: 'external.write', resource: { kind: 'external', id: 'calendar' } });
        expect(await write()).toEqual({ ok: false, code: 'CONFIRMATION_REQUIRED' });
        await policies.setBoundary({ userId: A, category: 'general', externalWrite: true });
        expect((await write()).ok).toBe(true);
    });

    test('revoked, expired, paused, unknown and old-revision grants refuse', async () => {
        const grant = await active();
        expect(await check(grant, { responsibilityId: 999999 })).toEqual({ ok: false, code: 'RESPONSIBILITY_NOT_FOUND' });
        expect(await check(grant, { revision: 1 })).toEqual({ ok: false, code: 'REVISION_CONFLICT', revision: 2 });
        expect(await check(grant, { actorUserId: B })).toEqual({ ok: false, code: 'ACTOR_MISMATCH' });

        const later = new Date(Date.now() + 2 * 86400000);
        const expiring = await active({ title: 'Short', expiresAt: new Date(Date.now() + 86400000).toISOString() });
        expect(await check(expiring, { now: later })).toEqual({ ok: false, code: 'RESPONSIBILITY_EXPIRED' });
        expect(await service.get({ userId: A, id: expiring.id, now: later })).toMatchObject({ status: 'EXPIRED', storedStatus: 'ACTIVE' });

        await service.act({ userId: A, id: grant.id, action: 'pause', expectedRevision: 2 });
        expect(await check(grant, { revision: 3 })).toEqual({ ok: false, code: 'RESPONSIBILITY_INACTIVE', status: 'PAUSED' });
        await service.act({ userId: A, id: grant.id, action: 'revoke', expectedRevision: 3 });
        expect(await check(grant, { revision: 4 })).toEqual({ ok: false, code: 'RESPONSIBILITY_REVOKED' });
        await service.act({ userId: A, id: grant.id, action: 'archive', expectedRevision: 4 });
        expect(await check(grant, { revision: 5 })).toEqual({ ok: false, code: 'RESPONSIBILITY_REVOKED' });
    });

    test('expiry is persisted lazily and blocks resuming', async () => {
        const grant = await active({ expiresAt: '2000-01-01 00:00:00' });
        expect(grant.status).toBe('EXPIRED');
        await expect(service.act({ userId: A, id: grant.id, action: 'pause', expectedRevision: grant.revision }))
            .rejects.toMatchObject({ code: 'RESPONSIBILITY_EXPIRED' });
        expect(await service.expireDue()).toBe(1);
        expect(await service.expireDue()).toBe(0);
        const stored = await service.get({ userId: A, id: grant.id });
        expect(stored).toMatchObject({ status: 'EXPIRED', storedStatus: 'EXPIRED', revision: 3 });
        const archived = (await service.act({ userId: A, id: grant.id, action: 'archive', expectedRevision: 3 })).responsibility;
        expect(archived).toMatchObject({ status: 'ARCHIVED', finalStatus: 'EXPIRED' });
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
        expect(login.status).toBe(200);
        return login.headers.get('set-cookie').split(';')[0];
    }
    const send = (method, url, session, body, headers = {}) => fetch(`${base}${url}`, {
        method,
        headers: { Cookie: session, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    test('create, edit, act and read through the API as the signed-in person', async () => {
        expect((await fetch(`${base}/api/app/assistant/responsibilities`)).status).toBe(401);
        const own = await cookie(A);
        const other = await cookie(B);
        await enroll();

        const created = await send('POST', '/api/app/assistant/responsibilities', own,
            { title: 'Garden', ownerUserId: B, operations: [KG_ADD] }, { 'Idempotency-Key': 'route-1' });
        expect(created.status).toBe(200);
        const { responsibility } = await created.json();
        expect(responsibility).toMatchObject({ ownerUserId: A, status: 'DRAFT' });
        const replay = await (await send('POST', '/api/app/assistant/responsibilities', own,
            { title: 'Garden again' }, { 'Idempotency-Key': 'route-1' })).json();
        expect(replay.responsibility.id).toBe(responsibility.id);

        const url = `/api/app/assistant/responsibilities/${responsibility.id}`;
        expect((await send('GET', url, other)).status).toBe(404);
        expect((await send('POST', `${url}/actions`, other, { action: 'revoke', expectedRevision: 1 })).status).toBe(404);

        const stale = await send('PATCH', url, own, { expectedRevision: 7, title: 'x' });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT', details: { revision: 1 } } });

        const activated = await send('POST', `${url}/actions`, own, { action: 'activate', expectedRevision: 1 });
        expect(activated.status).toBe(200);
        expect((await activated.json()).responsibility.status).toBe('ACTIVE');
        const widen = await send('PATCH', url, own, { expectedRevision: 2, operations: [] });
        expect(widen.status).toBe(409);
        expect(await widen.json()).toMatchObject({ error: { code: 'PAUSE_REQUIRED' } });

        const detail = await (await send('GET', url, own)).json();
        expect(detail.responsibility.status).toBe('ACTIVE');
        expect(detail.revisions.map(r => r.changeKind)).toEqual(['create', 'activate']);
        const list = await (await send('GET', '/api/app/assistant/responsibilities', own)).json();
        expect(list.responsibilities.map(r => r.id)).toEqual([responsibility.id]);
        expect(list.vocabulary.operations.map(op => op.id)).toContain('kg.generated.add');
        expect((await (await send('GET', '/api/app/assistant/responsibilities', other)).json()).responsibilities).toEqual([]);
    });

    test('the routes refuse while the feature is off', async () => {
        const own = await cookie(A);
        useState({ inactive: ['assistant'] });
        const response = await send('GET', '/api/app/assistant/responsibilities', own);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(await response.json()).toMatchObject({ error: { code: 'FEATURE_UNAVAILABLE' }, feature: 'assistant' });
    });
});

describe('privacy', () => {
    test('the report counts, the audit sees, and erasure removes the person\'s responsibilities', async () => {
        const mine = await active();
        await draft({ title: 'Another' });
        await enroll(B);
        const theirs = await draft({ title: 'Theirs' }, B);
        await db.run('UPDATE assistant_responsibilities SET payerUserId = @A WHERE id = @id', { A, id: theirs.id });
        await db.run(
            `UPDATE assistant_responsibility_revisions SET snapshotJson = @snapshot WHERE responsibilityId = @id`,
            { id: theirs.id, snapshot: JSON.stringify({ payerUserId: A }) }
        );

        const report = await privacyService.buildUserReport({ guildId: `dm:${A}`, userId: A });
        expect(report.responsibilities).toMatchObject({ total: 2, drafts: 1, active: 1 });
        const before = await privacyService.auditUser({ userId: A });
        expect(before.byTable.assistant_responsibilities).toBeGreaterThan(0);

        const counts = await privacyService.forgetUser({ userId: A });
        expect(counts).toMatchObject({ responsibilities: 2, responsibilitiesAnonymized: 1 });
        expect(await db.all('SELECT id FROM assistant_responsibilities WHERE ownerUserId = @A', { A })).toEqual([]);
        expect(await revisionRows(mine.id)).toEqual([]);

        const kept = await db.get('SELECT * FROM assistant_responsibilities WHERE id = @id', { id: theirs.id });
        expect(kept).toMatchObject({ ownerUserId: B, payerUserId: null, status: 'REVOKED' });
        const history = await revisionRows(theirs.id);
        expect(JSON.stringify(history)).not.toContain(A);
        expect(history[history.length - 1]).toMatchObject({ changeKind: 'revoke', changedBy: null });

        const after = await privacyService.auditUser({ userId: A });
        expect(after.byTable.assistant_responsibilities).toBe(0);
        expect(after.byTable.assistant_responsibility_revisions).toBe(0);
    });
});
