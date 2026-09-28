/**
 * Access requests: a Discord member the release gate keeps out asks the
 * host to let them in from the "Almost in" page. The request reaches every
 * operator's Inbox and their Discord DMs with Approve / Decline buttons;
 * approval is the migration grant, audited whichever surface it came from;
 * the person is told the outcome in their own Inbox (and DM). The cap gate
 * still applies at approval and leaves the request open when it refuses.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-access-requests-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const identityService = require('@goobster/core/services/identityService');
const identityConfig = require('@goobster/core/config/identityConfig');
const accessRequests = require('@goobster/core/services/accessRequestService');
const usageBudgetService = require('@goobster/core/services/usageBudgetService');
const instanceState = require('@goobster/core/services/instanceStateService');
const privacyService = require('@goobster/core/services/privacyService');
const eventBusService = require('@goobster/core/services/eventBusService');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');

const ROB = '100000000000000001';
const SAM = '100000000000000002';
const KIM = '100000000000000003';
const TABLES = ['inbox_items', 'access_requests', 'operator_audit', 'web_sessions', 'web_rate_events',
    'usage_reservations', 'auth_identities', 'app_accounts', 'principals', 'users'];

let server;
let port;
let ctx;
/** Every DM the fake gateway accepted: { userId, payload }. */
let dms = [];

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

function sessionCookie(res) {
    const setCookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('goobster_web_session='));
    return setCookie ? setCookie.split(';')[0] : null;
}

async function devSession(userId, name) {
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
    return sessionCookie(res);
}

/** The host: a legacy Discord operator with a live session. */
async function host(id = ROB) {
    await identityService.ensureLegacyPrincipal({ discordId: id, displayName: 'host' });
    await identityService.grantAccount({ principalId: id, entitlement: 'bootstrap', role: 'operator' });
    return devSession(id, 'host');
}

/** A Discord member who used the bot before the gate went on: principal, no account. */
async function keptOut(id = SAM, name = 'sam') {
    await identityService.ensureLegacyPrincipal({ discordId: id, displayName: name });
    return devSession(id, name);
}

const get = (reqPath, cookie) => request({ reqPath, headers: { cookie } });
const post = (reqPath, cookie, body = null) => request({ method: 'POST', reqPath, headers: { cookie }, body: body || {} });

async function inboxOf(cookie) {
    const res = await get('/api/app/inbox', cookie);
    expect(res.status).toBe(200);
    return res.json.items;
}

function fakeInteraction(userId) {
    const followUps = [];
    return {
        user: { id: userId },
        client: ctx.client,
        followUp: async (message) => { followUps.push(message); },
        followUps
    };
}

beforeAll((done) => {
    ctx = createWebAppContext({
        client: { user: { id: '9', username: 'Goobster' }, guilds: { cache: new Map() } },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} }
    });
    // The wrapped fake client is the gateway the service sees from the
    // routes and from `interaction.client`; capture its DMs.
    ctx.gateway.sendDm = async (userId, payload) => { dms.push({ userId, payload }); return { ok: true }; };
    const app = express();
    app.use(createWebAppApp(ctx));
    server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        done();
    });
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await eventBusService.close();
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(async () => {
    identityConfig.requireAccount = true;
    dms = [];
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`);
    // A shared installation needs a cap before a second account; most of
    // these tests are about the request, not the gate.
    await usageBudgetService.setPolicy({ dailyTokens: 10000 });
});

describe('asking to join', () => {
    test('a kept-out member is refused by /me, asks once, and every operator hears it in the Inbox and by DM', async () => {
        const hostCookie = await host();
        const secondHost = await host(KIM);
        const sam = await keptOut();

        const me = await get('/api/app/me', sam);
        expect(me.status).toBe(403);
        expect(me.json.error.code).toBe('NO_ACCOUNT');

        const before = await get('/api/app/auth/access-request', sam);
        expect(before.status).toBe(200);
        expect(before.json).toMatchObject({ request: null, pending: false, member: false, canRequest: true, retryAt: null, requireAccount: true });

        const asked = await post('/api/app/auth/access-request', sam, { note: '  It is Sam from the Tuesday game  ' });
        expect(asked.status).toBe(200);
        expect(asked.json).toMatchObject({ created: true, notified: 2 });
        expect(asked.json.request).toMatchObject({
            principalId: SAM, displayName: 'sam', discordId: SAM, status: 'pending', note: 'It is Sam from the Tuesday game'
        });
        const id = asked.json.request.id;

        for (const cookie of [hostCookie, secondHost]) {
            const items = await inboxOf(cookie);
            expect(items).toHaveLength(1);
            expect(items[0]).toMatchObject({
                kind: 'system', title: 'sam is asking to join', link: '/host', read: false,
                source: { type: 'access_request', id: String(id) },
                access: { id, status: 'pending', principalId: SAM, displayName: 'sam', actionable: true, resolvedByName: null },
                discord: { status: 'sent' }
            });
            expect(items[0].body).toContain('It is Sam from the Tuesday game');
        }
        expect(dms.map(dm => dm.userId).sort()).toEqual([ROB, KIM].sort());
        const dm = dms[0].payload;
        expect(dm.embeds[0].data.title).toContain('sam is asking to join');
        expect(dm.components[0].components.map(button => button.data.custom_id))
            .toEqual([`approve_accessreq_${id}`, `decline_accessreq_${id}`]);

        // Asking again while it is open changes nothing and tells nobody twice.
        const again = await post('/api/app/auth/access-request', sam, { note: 'still here' });
        expect(again.status).toBe(200);
        expect(again.json).toMatchObject({ created: false, notified: 0 });
        expect(again.json.request.id).toBe(id);
        expect(await inboxOf(hostCookie)).toHaveLength(1);
        expect(dms).toHaveLength(2);

        const status = await get('/api/app/auth/access-request', sam);
        expect(status.json).toMatchObject({ pending: true, canRequest: false });
        expect(await db.get('SELECT COUNT(*) AS c FROM access_requests')).toEqual({ c: 1 });

        // The host sees it on the roster side too.
        const pending = await get('/api/app/admin/access-requests', hostCookie);
        expect(pending.status).toBe(200);
        expect(pending.json.requests.map(r => r.id)).toEqual([id]);
    });

    test('approving from the Inbox grants the migration account, audits it, and tells the person in their Inbox and DM', async () => {
        const hostCookie = await host();
        const sam = await keptOut();
        const { json: { request: req } } = await post('/api/app/auth/access-request', sam);

        const approved = await post(`/api/app/admin/access-requests/${req.id}/approve`, hostCookie, { via: 'inbox' });
        expect(approved.status).toBe(200);
        expect(approved.json.request).toMatchObject({ id: req.id, status: 'approved', resolvedBy: ROB, resolvedByName: 'host' });
        expect(approved.json.request.resolvedAt).toBeTruthy();

        expect(await identityService.getAccount(SAM)).toMatchObject({ role: 'member', status: 'active', entitlement: 'migration' });
        expect((await get('/api/app/me', sam)).status).toBe(200);

        const audit = await db.all('SELECT action, actor, target, detailJson FROM operator_audit ORDER BY id');
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ action: 'access.approve', actor: ROB, target: SAM });
        expect(JSON.parse(audit[0].detailJson)).toMatchObject({ requestId: req.id, role: 'member', entitlement: 'migration', created: true, via: 'inbox' });

        // The person: an Inbox item and its DM echo.
        const samItems = await inboxOf(sam);
        expect(samItems).toHaveLength(1);
        expect(samItems[0]).toMatchObject({
            kind: 'system', title: "You're in - welcome to Goobster", link: '/',
            access: { id: req.id, status: 'approved', actionable: false },
            discord: { status: 'sent' }
        });
        expect(dms.filter(dm => dm.userId === SAM)).toHaveLength(1);
        expect(dms.find(dm => dm.userId === SAM).payload.content).toContain("You're in");

        // The host's copy shows the outcome and offers nothing more.
        const hostItems = await inboxOf(hostCookie);
        expect(hostItems[0].access).toMatchObject({ status: 'approved', actionable: false, resolvedByName: 'host' });
        expect((await get('/api/app/admin/access-requests', hostCookie)).json.requests).toEqual([]);

        // Nothing to approve twice; a stranger to the request is told so.
        const twice = await post(`/api/app/admin/access-requests/${req.id}/approve`, hostCookie);
        expect(twice.status).toBe(409);
        expect(twice.json.error.code).toBe('ALREADY_RESOLVED');
        expect((await post('/api/app/admin/access-requests/999/approve', hostCookie)).status).toBe(404);

        // Now a member: asking again is refused as such.
        const asMember = await post('/api/app/auth/access-request', sam);
        expect(asMember.status).toBe(409);
        expect(asMember.json.error.code).toBe('ALREADY_MEMBER');
    });

    test('declining tells the person neutrally and starts a day-long cooldown', async () => {
        const hostCookie = await host();
        const sam = await keptOut();
        const { json: { request: req } } = await post('/api/app/auth/access-request', sam);

        const declined = await post(`/api/app/admin/access-requests/${req.id}/decline`, hostCookie);
        expect(declined.status).toBe(200);
        expect(declined.json.request).toMatchObject({ status: 'declined', resolvedBy: ROB });
        expect(await identityService.getAccount(SAM)).toBeNull();
        expect((await get('/api/app/me', sam)).status).toBe(403);

        expect(await db.all('SELECT action, actor, target FROM operator_audit')).toEqual([{ action: 'access.decline', actor: ROB, target: SAM }]);
        // Still kept out, so the Inbox item waits for later; the DM and the
        // status endpoint carry the news now.
        expect(await db.get('SELECT title, link FROM inbox_items WHERE userId = @userId', { userId: SAM }))
            .toEqual({ title: 'The host did not grant access this time', link: null });
        expect(dms.find(dm => dm.userId === SAM).payload.content).toContain('did not grant access');

        const status = await get('/api/app/auth/access-request', sam);
        expect(status.json).toMatchObject({ pending: false, canRequest: false, request: { status: 'declined' } });
        expect(status.json.retryAt).toBeTruthy();
        const again = await post('/api/app/auth/access-request', sam);
        expect(again.status).toBe(429);
        expect(again.json.error.code).toBe('REQUEST_COOLDOWN');

        // Yesterday's decline no longer stands in the way.
        await db.run(`UPDATE access_requests SET resolvedAt = '2000-01-01 00:00:00' WHERE id = @id`, { id: req.id });
        const later = await post('/api/app/auth/access-request', sam);
        expect(later.status).toBe(200);
        expect(later.json.created).toBe(true);
    });

    test('the Discord buttons resolve a request for an operator only', async () => {
        await host();
        await keptOut();
        await keptOut(KIM, 'kim');
        const { request: first } = await accessRequests.request({ principalId: SAM, gateway: ctx.gateway });
        const { request: second } = await accessRequests.request({ principalId: KIM, gateway: ctx.gateway });

        // Someone who is not the host leaves the buttons in place.
        const stranger = fakeInteraction(KIM);
        expect(await accessRequests.handleButton('approve', first.id, stranger)).toBeNull();
        expect(stranger.followUps[0]).toMatchObject({ ephemeral: true });
        expect(stranger.followUps[0].content).toContain('Only the host');
        expect(await identityService.getAccount(SAM)).toBeNull();

        const operator = fakeInteraction(ROB);
        const edit = await accessRequests.handleButton('approve', first.id, operator);
        expect(edit).toMatchObject({ embeds: [], components: [] });
        expect(edit.content).toContain(`Approved by <@${ROB}>`);
        expect(await identityService.getAccount(SAM)).toMatchObject({ entitlement: 'migration' });
        expect(await db.all('SELECT action, detailJson FROM operator_audit')).toHaveLength(1);
        expect(JSON.parse((await db.get('SELECT detailJson FROM operator_audit')).detailJson)).toMatchObject({ via: 'discord' });
        expect(dms.some(dm => dm.userId === SAM && dm.payload.content.includes("You're in"))).toBe(true);

        // A second press on a stale DM says who already did it.
        const stale = await accessRequests.handleButton('approve', first.id, fakeInteraction(ROB));
        expect(stale.content).toContain('Already approved by host');

        const declined = await accessRequests.handleButton('decline', second.id, fakeInteraction(ROB));
        expect(declined.content).toContain(`Declined by <@${ROB}>`);
        expect(await identityService.getAccount(KIM)).toBeNull();
        expect(await accessRequests.handleButton('approve', 4242, fakeInteraction(ROB)))
            .toMatchObject({ content: expect.stringContaining('no longer exists'), components: [] });
    });

    test('the cap gate refuses the approval but keeps the request open until the host sets a cap', async () => {
        const hostCookie = await host();
        const sam = await keptOut();
        const { json: { request: req } } = await post('/api/app/auth/access-request', sam);
        await instanceState.remove('limits');

        const blocked = await post(`/api/app/admin/access-requests/${req.id}/approve`, hostCookie);
        expect(blocked.status).toBe(409);
        expect(blocked.json.error.code).toBe('DAILY_CAP_REQUIRED');
        expect((await get('/api/app/admin/access-requests', hostCookie)).json.requests.map(r => r.status)).toEqual(['pending']);
        expect(await identityService.getAccount(SAM)).toBeNull();
        expect(await db.all('SELECT action FROM operator_audit')).toEqual([]);

        const button = fakeInteraction(ROB);
        expect(await accessRequests.handleButton('approve', req.id, button)).toBeNull();
        expect(button.followUps[0].content).toContain('Host → Limits');

        await usageBudgetService.setPolicy({ dailyTokens: 5000 });
        const edit = await accessRequests.handleButton('approve', req.id, fakeInteraction(ROB));
        expect(edit.content).toContain('Approved');
        expect(await identityService.getAccount(SAM)).toMatchObject({ entitlement: 'migration' });
        expect((await get('/api/app/me', sam)).status).toBe(200);
    });

    test('a direct grant from Host -> Accounts settles the open request and tells the person', async () => {
        const hostCookie = await host();
        const sam = await keptOut();
        const { json: { request: req } } = await post('/api/app/auth/access-request', sam);

        const granted = await post('/api/app/admin/accounts', hostCookie, { principalId: SAM });
        expect(granted.status).toBe(200);
        expect(granted.json.created).toBe(true);
        expect(await accessRequests.get(req.id)).toMatchObject({ status: 'approved', resolvedBy: ROB });
        expect((await inboxOf(sam))[0].title).toContain("You're in");
        // The grant route's own audit row is the record; nothing is written twice.
        expect(await db.all('SELECT action FROM operator_audit')).toEqual([{ action: 'account.grant' }]);
    });

    test('who may ask and who may resolve', async () => {
        const hostCookie = await host();
        const sam = await keptOut();

        // A route without a session is a plain 401, not a request.
        expect((await request({ method: 'POST', reqPath: '/api/app/auth/access-request', body: {} })).status).toBe(401);
        // Only the host resolves; a kept-out member never reaches the admin routes.
        expect((await get('/api/app/admin/access-requests', sam)).status).toBe(403);
        // A bad note shape is refused before anything is written.
        const bad = await post('/api/app/auth/access-request', sam, { note: { nested: true } });
        expect(bad.status).toBe(400);
        expect(bad.json.error.code).toBe('BAD_NOTE');
        // A very long note is kept to its first characters.
        const long = await post('/api/app/auth/access-request', sam, { note: 'x'.repeat(1000) });
        expect(long.json.request.note).toHaveLength(accessRequests.MAX_NOTE);

        // With the gate off nobody is kept out, so there is nothing to ask.
        identityConfig.requireAccount = false;
        const kim = await keptOut(KIM, 'kim');
        const notNeeded = await post('/api/app/auth/access-request', kim);
        expect(notNeeded.status).toBe(409);
        expect(notNeeded.json.error.code).toBe('NOT_NEEDED');
        expect((await get('/api/app/auth/access-request', kim)).json).toMatchObject({ canRequest: false, requireAccount: false });

        // A member already in never needs to ask.
        identityConfig.requireAccount = true;
        expect((await post('/api/app/auth/access-request', hostCookie)).json.error.code).toBe('ALREADY_MEMBER');
    });

    test('erasure removes the requests and the host copies that name the person; auditUser counts them', async () => {
        const hostCookie = await host();
        const sam = await keptOut();
        await post('/api/app/auth/access-request', sam, { note: 'hello' });
        expect(await inboxOf(hostCookie)).toHaveLength(1);

        const before = await privacyService.auditUser({ userId: SAM });
        expect(before.byTable).toMatchObject({ access_requests: 1 });

        const result = await privacyService.forgetUser({ userId: SAM });
        expect(result).toMatchObject({ accessRequests: 1, principals: 1 });
        expect((await privacyService.auditUser({ userId: SAM })).byTable.access_requests).toBe(0);
        expect(await inboxOf(hostCookie)).toEqual([]);
        expect(await db.get('SELECT COUNT(*) AS c FROM access_requests')).toEqual({ c: 0 });

        // An operator who resolved a request can be forgotten without
        // taking the request with them - only who resolved it goes.
        const kim = await keptOut(KIM, 'kim');
        const { json: { request: req } } = await post('/api/app/auth/access-request', kim);
        await post(`/api/app/admin/access-requests/${req.id}/decline`, hostCookie);
        await privacyService.forgetUser({ userId: ROB });
        expect(await db.get('SELECT status, resolvedBy FROM access_requests WHERE id = @id', { id: req.id }))
            .toEqual({ status: 'declined', resolvedBy: null });
        expect((await accessRequests.get(req.id)).resolvedByName).toBeNull();
    });
});
