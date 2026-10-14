/**
 * Capability gaps (documentation/capability_gaps.md): what Goobster was
 * asked to do and had no tool for, recorded through noteCapabilityGap as an
 * anonymous, counted backlog and triaged by the operator in the Host room.
 * Runs on both engines.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-capability-gaps-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const gaps = require('@goobster/core/services/capabilityGapService');
const operatorAudit = require('@goobster/core/services/operatorAuditService');
const identityService = require('@goobster/core/services/identityService');
const identityConfig = require('@goobster/core/config/identityConfig');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const { buildNativeToolGuidance } = require('@goobster/core/utils/toolPromptBuilder');
const { DisabledGateway } = require('@goobster/core/gateway');

const HOST = '100000000000000301';
const MEMBER = '100000000000000302';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
    await db.run('DELETE FROM capability_gaps');
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

describe('the backlog', () => {
    beforeEach(async () => {
        await db.run('DELETE FROM capability_gaps');
    });

    test('the same capability, phrased the same way, is counted on one row; links and control characters never land', async () => {
        const first = await gaps.note({ capability: 'Rebase a project clone onto another branch', area: 'repositories' });
        expect(first).toMatchObject({ ok: true, hits: 1, status: 'open' });
        const again = await gaps.note({ capability: '  rebase a project-clone onto another branch! ', area: 'chat' });
        expect(again).toMatchObject({ ok: true, id: first.id, hits: 2 });
        await gaps.note({ capability: 'Attach a PDF from https://example.com/secret.pdf to\u0007 a calendar event' });

        const { gaps: rows, counts } = await gaps.list();
        expect(counts).toEqual({ open: 2 });
        expect(rows.map(row => [row.capability, row.hits, row.area])).toEqual([
            ['Rebase a project clone onto another branch', 2, 'repositories'],
            ['Attach a PDF from to a calendar event', 1, null]
        ]);
        const text = JSON.stringify(await db.all('SELECT * FROM capability_gaps'));
        expect(text).not.toContain('example.com');
        expect(text).not.toContain('\u0007');
        // No column can hold who asked.
        const columns = Object.keys((await db.all('SELECT * FROM capability_gaps'))[0]);
        expect(columns.sort()).toEqual(['area', 'capability', 'firstSeenAt', 'gapKey', 'hits', 'id', 'lastSeenAt', 'status']);
    });

    test('too short is refused, the cap is enforced, and triage moves rows between statuses', async () => {
        expect(await gaps.note({ capability: 'x' })).toEqual({ ok: false, code: 'TOO_SHORT' });
        expect(await gaps.note({ capability: '!!!!!!!!!!' })).toEqual({ ok: false, code: 'TOO_SHORT' });
        const long = await gaps.note({ capability: 'a'.repeat(400) });
        expect((await gaps.list()).gaps[0].capability).toHaveLength(160);

        const planned = await gaps.setStatus(long.id, 'planned');
        expect(planned.status).toBe('planned');
        expect((await gaps.list({ status: 'planned' })).gaps).toHaveLength(1);
        expect((await gaps.list()).gaps).toHaveLength(0);
        // A dismissed gap keeps counting but stays dismissed.
        await gaps.setStatus(long.id, 'dismissed');
        expect(await gaps.note({ capability: 'a'.repeat(400) })).toMatchObject({ hits: 2, status: 'dismissed' });
        await expect(gaps.setStatus(long.id, 'shipped')).rejects.toMatchObject({ status: 400, code: 'BAD_STATUS' });
        await expect(gaps.setStatus(999999, 'open')).rejects.toMatchObject({ status: 404 });
        await expect(gaps.list({ status: 'nope' })).rejects.toMatchObject({ code: 'BAD_STATUS' });
        expect(await gaps.remove(long.id)).toMatchObject({ id: long.id });
        expect((await gaps.list({ status: 'all' })).gaps).toHaveLength(0);

        for (let i = 0; i < gaps.MAX_ROWS; i++) {
            await db.run('INSERT INTO capability_gaps (gapKey, capability) VALUES (@k, @k)', { k: `filler capability ${i}` });
        }
        expect(await gaps.note({ capability: 'one more new capability' })).toEqual({ ok: false, code: 'FULL' });
        // An existing gap still counts when the backlog is full.
        expect(await gaps.note({ capability: 'filler capability 7' })).toMatchObject({ ok: true, hits: 2 });
    }, 60_000);
});

describe('the tool', () => {
    beforeEach(async () => {
        await db.run('DELETE FROM capability_gaps');
    });

    test('is offered with guidance, records the gap, and tells the model what to say next', async () => {
        const offered = (await toolsRegistry.getDefinitions(undefined, { isWeb: true })).map(def => def.name);
        expect(offered).toContain('noteCapabilityGap');
        expect(buildNativeToolGuidance()).toContain('noteCapabilityGap');

        const reply = await toolsRegistry.execute('noteCapabilityGap', { capability: 'Merge a pull request from chat', area: 'repositories' });
        expect(reply).toMatch(/Recorded as a missing capability/);
        expect(await toolsRegistry.execute('noteCapabilityGap', { capability: 'Merge a pull request from chat' }))
            .toMatch(/reported 2 times/);
        expect(await toolsRegistry.execute('noteCapabilityGap', { capability: 'no' })).toMatch(/Not recorded/);
    });
});

describe('the Host room', () => {
    let server;
    let port;

    function request({ method = 'GET', reqPath, headers = {}, body = null }) {
        const payload = body ? JSON.stringify(body) : null;
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, method, path: reqPath,
                headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers }
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
        return (res.headers['set-cookie'] || []).find(c => c.startsWith('goobster_web_session=')).split(';')[0];
    }

    beforeAll(async () => {
        await db.run('DELETE FROM capability_gaps');
        identityConfig.nativeLogin = true;
        identityConfig.requireAccount = false;
        await identityService.ensureLegacyPrincipal({ discordId: HOST, displayName: 'host' });
        await identityService.grantAccount({ principalId: HOST, entitlement: 'bootstrap', role: 'operator' });
        await identityService.ensureLegacyPrincipal({ discordId: MEMBER, displayName: 'member' });
        await identityService.grantAccount({ principalId: MEMBER, entitlement: 'migration' });
        const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
        const ctx = createWebAppContext({ gateway: new DisabledGateway(), config: { webapp: { enabled: true, devMode: true } }, logger: quiet });
        const app = express();
        app.use(createWebAppApp(ctx));
        await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
        port = server.address().port;
    });

    afterAll(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
    });

    test('only operators read and triage; every change writes one audit row', async () => {
        const host = await cookieFor(HOST, 'host');
        const member = await cookieFor(MEMBER, 'member');
        const { id } = await gaps.note({ capability: 'Stream run logs into chat', area: 'projects' });

        expect((await request({ reqPath: '/api/app/admin/capability-gaps', headers: { cookie: member } })).status).toBe(403);
        const listing = await request({ reqPath: '/api/app/admin/capability-gaps', headers: { cookie: host } });
        expect(listing.status).toBe(200);
        expect(listing.json.gaps.map(gap => gap.capability)).toEqual(['Stream run logs into chat']);

        expect((await request({ method: 'PATCH', reqPath: `/api/app/admin/capability-gaps/${id}`, headers: { cookie: member }, body: { status: 'planned' } })).status).toBe(403);
        const planned = await request({ method: 'PATCH', reqPath: `/api/app/admin/capability-gaps/${id}`, headers: { cookie: host }, body: { status: 'planned' } });
        expect(planned.json).toMatchObject({ id, status: 'planned' });
        expect((await request({ method: 'PATCH', reqPath: `/api/app/admin/capability-gaps/${id}`, headers: { cookie: host }, body: { status: 'bogus' } })).status).toBe(400);
        expect((await request({ method: 'DELETE', reqPath: `/api/app/admin/capability-gaps/${id}`, headers: { cookie: host } })).json).toEqual({ deleted: true, id });
        expect((await request({ method: 'DELETE', reqPath: `/api/app/admin/capability-gaps/${id}`, headers: { cookie: host } })).status).toBe(404);

        const audit = (await operatorAudit.list({ limit: 50 })).entries.filter(entry => entry.action.startsWith('capability-gap.'));
        expect(audit.map(entry => [entry.action, entry.actor, entry.detail])).toEqual([
            ['capability-gap.delete', HOST, { id }],
            ['capability-gap.status', HOST, { id, status: 'planned' }]
        ]);
    });
});
