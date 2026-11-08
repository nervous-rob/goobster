/**
 * Operator schedule panel (documentation/operator_schedules.md): the host
 * lists and manages any guild-facing automation or reminder - pause,
 * resume, run now, delete - while a person's private (DM / Inbox) tasks
 * stay out of reach. Every successful change is one operator_audit row
 * carrying ids only; a refusal writes nothing.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-operator-schedules-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const identityService = require('@goobster/core/services/identityService');
const identityConfig = require('@goobster/core/config/identityConfig');
const usageBudgetService = require('@goobster/core/services/usageBudgetService');
const followupService = require('@goobster/core/services/followupService');
const operatorSchedules = require('@goobster/core/services/operatorScheduleService');
const eventBusService = require('@goobster/core/services/eventBusService');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');

const HOST = '100000000000000001';
const MEMBER = '100000000000000002';
const OWNER = '100000000000000003';
const GUILD_A = '200000000000000001';
const GUILD_B = '200000000000000002';
const CHANNEL = '300000000000000001';
const TABLES = ['inbox_items', 'automations', 'followups', 'operator_audit', 'web_sessions', 'web_rate_events',
    'usage_reservations', 'auth_identities', 'app_accounts', 'principals', 'users'];

let server;
let port;
let ctx;

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

async function session(userId, name, role) {
    await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: name });
    await identityService.grantAccount({ principalId: userId, entitlement: role === 'operator' ? 'bootstrap' : 'migration', role });
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
    return (res.headers['set-cookie'] || []).find(c => c.startsWith('goobster_web_session=')).split(';')[0];
}

const get = (reqPath, cookie) => request({ reqPath, headers: { cookie } });
const post = (reqPath, cookie) => request({ method: 'POST', reqPath, headers: { cookie }, body: {} });
const del = (reqPath, cookie) => request({ method: 'DELETE', reqPath, headers: { cookie } });

function utc(msFromNow) {
    return new Date(Date.now() + msFromNow).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

async function addAutomation({ name, guildId = GUILD_A, channelId = CHANNEL, promptText = 'secret prompt text', schedule = '0 9 * * *', userId = OWNER, enabled = 1 }) {
    return db.insert(
        `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, isEnabled, nextRun)
         VALUES (@userId, @guildId, @channelId, @name, @promptText, @schedule, @enabled, @nextRun)`,
        { userId, guildId, channelId, name, promptText, schedule, enabled, nextRun: enabled ? utc(3_600_000) : null }
    );
}

async function addFollowup({ note, guildId = GUILD_A, channelId = CHANNEL, dueAt = utc(3_600_000), recurMinutes = 1440, userId = OWNER }) {
    return db.insert(
        `INSERT INTO followups (guildId, channelId, userId, note, dueAt, recurMinutes, recurrence)
         VALUES (@guildId, @channelId, @userId, @note, @dueAt, @recurMinutes, @recurrence)`,
        { guildId, channelId, userId, note, dueAt, recurMinutes, recurrence: recurMinutes ? 'every day' : null }
    );
}

async function auditRows() {
    return db.all('SELECT action, actor, target, detailJson FROM operator_audit ORDER BY id');
}

beforeAll((done) => {
    ctx = createWebAppContext({
        client: { user: { id: '9', username: 'Goobster' }, guilds: { cache: new Map() } },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} }
    });
    ctx.gateway.available = async () => true;
    ctx.gateway.guildMeta = async (id) => (id === GUILD_A ? { id, name: 'Tuesday Game' } : null);
    ctx.gateway.getUser = async (id) => (id === OWNER ? { id, username: 'rob', globalName: 'Rob' } : null);
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
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`);
    await usageBudgetService.setPolicy({ dailyTokens: 10000 });
});

describe('listing', () => {
    test('shows only guild-facing rows, with names and no prompt text', async () => {
        const cookie = await session(HOST, 'host', 'operator');
        const joke = await addAutomation({ name: 'Daily Gloat', promptText: '__GOBLIN_WHEEL__' });
        await addAutomation({ name: 'Private digest', guildId: `dm:${OWNER}`, channelId: `inbox:${OWNER}` });
        await addAutomation({ name: 'Portal task, old DM channel', guildId: `dm:${OWNER}`, channelId: '999' });
        await addAutomation({ name: 'Other server', guildId: GUILD_B, enabled: 0 });
        const reminder = await addFollowup({ note: 'Stand-up time everybody' });
        await addFollowup({ note: 'my dentist', guildId: `dm:${OWNER}`, channelId: `inbox:${OWNER}` });
        await addFollowup({ note: 'done already', recurMinutes: null });
        await db.run(`UPDATE followups SET status = 'DONE' WHERE note = 'done already'`);

        const res = await get('/api/app/admin/schedules', cookie);
        expect(res.status).toBe(200);
        expect(res.json.botOnline).toBe(true);
        const keys = res.json.schedules.map(row => row.key).sort();
        expect(keys).toEqual([`automation:${joke}`, `automation:${joke + 3}`, `followup:${reminder}`].sort());

        const automation = res.json.schedules.find(row => row.key === `automation:${joke}`);
        expect(automation).toMatchObject({
            kind: 'automation', name: 'Daily Gloat', label: 'wheel', guildName: 'Tuesday Game', ownerName: 'Rob',
            cadence: '0 9 * * *', paused: false, actions: ['pause', 'resume', 'trigger', 'delete']
        });
        expect(JSON.stringify(res.json)).not.toContain('secret prompt text');
        expect(JSON.stringify(res.json)).not.toContain('dentist');
        expect(res.json.guilds.map(g => g.id).sort()).toEqual([GUILD_A, GUILD_B]);

        const paused = await get('/api/app/admin/schedules?status=paused', cookie);
        expect(paused.json.schedules.map(row => row.name)).toEqual(['Other server']);
        const reminders = await get(`/api/app/admin/schedules?kind=followup&guildId=${GUILD_A}`, cookie);
        expect(reminders.json.schedules).toHaveLength(1);
        expect(reminders.json.schedules[0]).toMatchObject({ kind: 'followup', note: 'Stand-up time everybody', recurring: true });
        expect((await get('/api/app/admin/schedules?kind=bogus', cookie)).status).toBe(400);
    });

    test('degrades to ids when the bot is unreachable', async () => {
        const cookie = await session(HOST, 'host', 'operator');
        await addAutomation({ name: 'Daily Gloat' });
        const { guildMeta, available } = ctx.gateway;
        ctx.gateway.available = async () => { throw new Error('down'); };
        ctx.gateway.guildMeta = async () => { throw new Error('down'); };
        try {
            const res = await get('/api/app/admin/schedules', cookie);
            expect(res.status).toBe(200);
            expect(res.json.botOnline).toBe(false);
            expect(res.json.schedules[0]).toMatchObject({ name: 'Daily Gloat', guildName: null, guildId: GUILD_A });
        } finally {
            ctx.gateway.guildMeta = guildMeta;
            ctx.gateway.available = available;
        }
    });
});

describe('who may use it', () => {
    test('a member is refused every route and nothing changes', async () => {
        const member = await session(MEMBER, 'member', 'member');
        const id = await addAutomation({ name: 'Daily Gloat' });
        expect((await get('/api/app/admin/schedules', member)).status).toBe(403);
        expect((await post(`/api/app/admin/schedules/automation/${id}/pause`, member)).status).toBe(403);
        expect((await del(`/api/app/admin/schedules/automation/${id}`, member)).status).toBe(403);
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id })).isEnabled).toBe(1);
        expect(await auditRows()).toEqual([]);
    });

    test('private tasks are refused with NOT_GUILD_SCOPE and write no audit row', async () => {
        const cookie = await session(HOST, 'host', 'operator');
        const dm = await addAutomation({ name: 'Mine', guildId: `dm:${OWNER}`, channelId: `inbox:${OWNER}` });
        const dmReminder = await addFollowup({ note: 'mine too', guildId: `dm:${OWNER}`, channelId: `inbox:${OWNER}` });
        for (const [kind, id] of [['automation', dm], ['followup', dmReminder]]) {
            for (const action of ['pause', 'resume', 'trigger']) {
                const res = await post(`/api/app/admin/schedules/${kind}/${id}/${action}`, cookie);
                expect(res.status).toBe(403);
                expect(res.json.error.code).toBe('NOT_GUILD_SCOPE');
            }
            const removed = await del(`/api/app/admin/schedules/${kind}/${id}`, cookie);
            expect(removed.status).toBe(403);
        }
        expect(await db.get('SELECT COUNT(*) AS c FROM automations')).toMatchObject({ c: 1 });
        expect(await db.get(`SELECT COUNT(*) AS c FROM followups WHERE status = 'PENDING'`)).toMatchObject({ c: 1 });
        expect(await auditRows()).toEqual([]);
    });
});

describe('automations', () => {
    test('pause, resume, run now and delete - audited with ids only, and the owner is told', async () => {
        const cookie = await session(HOST, 'host', 'operator');
        const id = await addAutomation({ name: 'Daily Gloat' });
        const base = `/api/app/admin/schedules/automation/${id}`;

        const paused = await post(`${base}/pause`, cookie);
        expect(paused.status).toBe(200);
        expect(paused.json.schedule).toMatchObject({ paused: true, nextRunAt: null });
        expect(await db.get('SELECT isEnabled, nextRun FROM automations WHERE id = @id', { id })).toMatchObject({ isEnabled: 0, nextRun: null });
        expect((await post(`${base}/pause`, cookie)).json.error.code).toBe('ALREADY_PAUSED');
        expect((await post(`${base}/trigger`, cookie)).json.error.code).toBe('PAUSED');

        const resumed = await post(`${base}/resume`, cookie);
        expect(resumed.status).toBe(200);
        expect(resumed.json.schedule.paused).toBe(false);
        const afterResume = await db.get('SELECT nextRun FROM automations WHERE id = @id', { id });
        expect(afterResume.nextRun).toBeTruthy();
        expect((await post(`${base}/resume`, cookie)).json.error.code).toBe('NOT_PAUSED');

        const triggered = await post(`${base}/trigger`, cookie);
        expect(triggered.status).toBe(200);
        const due = await db.get(`SELECT id FROM automations WHERE id = @id AND nextRun <= CURRENT_TIMESTAMP`, { id });
        expect(due).toBeTruthy();

        const removed = await del(base, cookie);
        expect(removed.json).toMatchObject({ deleted: true, kind: 'automation', id });
        expect(await db.get('SELECT id FROM automations WHERE id = @id', { id })).toBeFalsy();
        expect((await del(base, cookie)).status).toBe(404);

        const audit = await auditRows();
        expect(audit.map(row => row.action)).toEqual(['schedule.pause', 'schedule.resume', 'schedule.trigger', 'schedule.delete']);
        expect(audit.every(row => row.actor === HOST && row.target === `automation:${id}`)).toBe(true);
        expect(audit.map(row => JSON.parse(row.detailJson))).toEqual(
            Array(4).fill({ kind: 'automation', guildId: GUILD_A })
        );
        expect(JSON.stringify(audit)).not.toContain('Daily Gloat');

        const notices = await db.all('SELECT title, body FROM inbox_items WHERE userId = @userId ORDER BY id', { userId: OWNER });
        expect(notices.map(n => n.title)).toEqual([
            'The host paused one of your scheduled tasks',
            'The host deleted one of your scheduled tasks'
        ]);
    });

    test('a corrupt cron cannot be resumed and nothing is audited', async () => {
        const cookie = await session(HOST, 'host', 'operator');
        const id = await addAutomation({ name: 'Broken', schedule: 'not a cron', enabled: 0 });
        const res = await post(`/api/app/admin/schedules/automation/${id}/resume`, cookie);
        expect(res.status).toBe(409);
        expect(res.json.error.code).toBe('BAD_SCHEDULE');
        expect(await auditRows()).toEqual([]);
    });
});

describe('reminders', () => {
    test('a paused recurring reminder is never delivered; resume skips what it missed', async () => {
        const cookie = await session(HOST, 'host', 'operator');
        const id = await addFollowup({ note: 'Stand-up', dueAt: utc(-3 * 86_400_000 - 3_600_000) });
        expect((await followupService.getDue()).map(row => row.id)).toContain(id);
        const base = `/api/app/admin/schedules/followup/${id}`;

        const paused = await post(`${base}/pause`, cookie);
        expect(paused.status).toBe(200);
        expect(paused.json.schedule).toMatchObject({ paused: true, nextRunAt: null });
        expect((await followupService.getDue()).map(row => row.id)).not.toContain(id);
        expect((await post(`${base}/trigger`, cookie)).json.error.code).toBe('PAUSED');

        const resumed = await post(`${base}/resume`, cookie);
        expect(resumed.status).toBe(200);
        const row = await db.get('SELECT dueAt, pausedAt FROM followups WHERE id = @id', { id });
        expect(row.pausedAt).toBeNull();
        expect(Date.parse(`${row.dueAt.replace(' ', 'T')}Z`)).toBeGreaterThan(Date.now());
        expect((await followupService.getDue()).map(r => r.id)).not.toContain(id);

        const triggered = await post(`${base}/trigger`, cookie);
        expect(triggered.status).toBe(200);
        expect((await followupService.getDue()).map(r => r.id)).toContain(id);

        const removed = await del(base, cookie);
        expect(removed.json.deleted).toBe(true);
        expect((await db.get('SELECT status FROM followups WHERE id = @id', { id })).status).toBe('CANCELLED');
        expect((await del(base, cookie)).status).toBe(404);

        const audit = await auditRows();
        expect(audit.map(r => r.action)).toEqual(['schedule.pause', 'schedule.resume', 'schedule.trigger', 'schedule.delete']);
        expect(JSON.stringify(audit)).not.toContain('Stand-up');
    });

    test('a still-future due time is kept on resume', async () => {
        const cookie = await session(HOST, 'host', 'operator');
        const dueAt = utc(2 * 3_600_000);
        const id = await addFollowup({ note: 'later', dueAt });
        await post(`/api/app/admin/schedules/followup/${id}/pause`, cookie);
        await post(`/api/app/admin/schedules/followup/${id}/resume`, cookie);
        expect((await db.get('SELECT dueAt FROM followups WHERE id = @id', { id })).dueAt).toBe(dueAt);
    });

    test('a one-time reminder can run now or be cancelled, but not paused', async () => {
        const cookie = await session(HOST, 'host', 'operator');
        const id = await addFollowup({ note: 'once', recurMinutes: null });
        const listed = await get('/api/app/admin/schedules?kind=followup', cookie);
        expect(listed.json.schedules[0].actions).toEqual(['trigger', 'delete']);
        const pause = await post(`/api/app/admin/schedules/followup/${id}/pause`, cookie);
        expect(pause.status).toBe(409);
        expect(pause.json.error.code).toBe('UNSUPPORTED');
        expect((await post(`/api/app/admin/schedules/followup/${id}/trigger`, cookie)).status).toBe(200);
        expect((await del(`/api/app/admin/schedules/followup/${id}`, cookie)).status).toBe(200);
    });

    test('the owner still sees the pause in their task list', async () => {
        const id = await addFollowup({ note: 'Stand-up' });
        await operatorSchedules.pause('followup', id);
        const tasks = await require('@goobster/core/services/webTaskService').listTasks({ gateway: ctx.gateway, userId: OWNER });
        expect(tasks.followups.find(task => task.id === id)).toMatchObject({ paused: true });
    });
});

describe('bad requests', () => {
    test('unknown action, kind and id are 400s', async () => {
        const cookie = await session(HOST, 'host', 'operator');
        expect((await post('/api/app/admin/schedules/automation/1/explode', cookie)).json.error.code).toBe('BAD_ACTION');
        expect((await post('/api/app/admin/schedules/widget/1/pause', cookie)).json.error.code).toBe('BAD_KIND');
        expect((await post('/api/app/admin/schedules/automation/abc/pause', cookie)).json.error.code).toBe('BAD_ID');
        expect((await post('/api/app/admin/schedules/automation/99999/pause', cookie)).status).toBe(404);
        expect(await auditRows()).toEqual([]);
    });
});
