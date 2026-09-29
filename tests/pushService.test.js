/**
 * Web Push for the installed portal (documentation/pwa.md): subscriptions
 * are per device and per person, every new Inbox item is echoed as a push
 * that points at the row, failures prune or count against a device and
 * land on the work ledger without content, and the whole table is on the
 * erasure, audit and transparency paths. The sender is a fake - nothing
 * leaves the process.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-push-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;
process.env.GOOBSTER_UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-push-uploads-'));

const db = require('@goobster/core/db');
const eventBus = require('@goobster/core/services/eventBusService');
const pushConfig = require('@goobster/core/config/pushConfig');
const pushService = require('@goobster/core/services/pushService');
const { PushService, MAX_DEVICES, MAX_FAILURES } = pushService;
const inboxService = require('@goobster/core/services/inboxService');
const privacyService = require('@goobster/core/services/privacyService');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');

const USER = '700000000000000001';
const OTHER = '700000000000000002';
const KEYS = {
    enabled: true,
    reason: null,
    publicKey: 'BIPUL12DLfytvTajnryr2PRdAgXS3HGKiLqndGcJGabyhHheJPFbo0gxnXrbZw4mE0-lrGvJ60YaHKY5aCcB4Ho',
    privateKey: 'kU0z4tWfbfKvGwb1cQ8M9Cn0jbDYpR0yYQpCwjvSb1k',
    subject: 'mailto:test@example.com'
};

/** A web-push-shaped sender whose outcome is scripted per endpoint. */
function fakeSender() {
    const outcomes = new Map();
    const calls = [];
    return {
        outcomes,
        calls,
        async sendNotification(subscription, payload, options) {
            calls.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
            const status = outcomes.get(subscription.endpoint);
            if (status) {
                const error = new Error(`push failed ${status}`);
                error.statusCode = status;
                throw error;
            }
            return { statusCode: 201 };
        }
    };
}

function subscription(n) {
    return {
        endpoint: `https://push.example.test/send/${n}`,
        keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }
    };
}

let sender;
let service;

beforeEach(async () => {
    await db.run('DELETE FROM push_subscriptions');
    await db.run('DELETE FROM inbox_items');
    await db.run('DELETE FROM work_failures');
    await db.run('DELETE FROM web_rate_events');
    pushConfig._setForTests({ ...KEYS });
    sender = fakeSender();
    service = new PushService({ config: pushConfig, sender, logger: { warn: () => {} } });
    // The singleton is what inboxService / parlorService / privacyService reach for.
    pushService._sender = sender;
});

afterAll(async () => {
    pushConfig._setForTests(null);
    await eventBus.close();
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* isolated PG or already gone */ }
    }
});

describe('subscriptions', () => {
    test('a device subscribes once per endpoint; re-subscribing updates, not duplicates', async () => {
        const first = await service.subscribe({ userId: USER, subscription: subscription(1), userAgent: 'Test/1' });
        expect(first).toEqual({ ok: true, devices: 1 });
        const again = await service.subscribe({ userId: USER, subscription: { ...subscription(1), keys: { ...subscription(1).keys, auth: 'newauthnewauthnewauth' } } });
        expect(again.devices).toBe(1);
        const row = await db.get('SELECT * FROM push_subscriptions WHERE endpoint = @e', { e: subscription(1).endpoint });
        expect(row.auth).toBe('newauthnewauthnewauth');
        expect(row.userAgent).toBe('Test/1');
        expect(row.lastSeenAt).toBeTruthy();
        // Another account signing in on the same browser takes the device over.
        await service.subscribe({ userId: OTHER, subscription: subscription(1) });
        expect(await service.countForUser(USER)).toBe(0);
        expect(await service.countForUser(OTHER)).toBe(1);
        expect(await service.hasEndpoint({ userId: OTHER, endpoint: subscription(1).endpoint })).toBe(true);
        expect(await service.hasEndpoint({ userId: USER, endpoint: subscription(1).endpoint })).toBe(false);
    });

    test('malformed subscriptions are refused before anything is stored', async () => {
        await expect(service.subscribe({ userId: USER, subscription: { endpoint: 'http://plain.example/x', keys: subscription(1).keys } }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_ENDPOINT' });
        await expect(service.subscribe({ userId: USER, subscription: { endpoint: subscription(2).endpoint, keys: { p256dh: 'ok_key', auth: 'has spaces' } } }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_KEYS' });
        await expect(service.subscribe({ userId: USER, subscription: { endpoint: subscription(2).endpoint } }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_KEYS' });
        await expect(service.subscribe({ userId: '', subscription: subscription(2) }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_USER' });
        expect(await service.countForUser(USER)).toBe(0);
    });

    test('a person keeps at most MAX_DEVICES devices; the oldest goes first', async () => {
        for (let n = 1; n <= MAX_DEVICES + 2; n++) {
            await service.subscribe({ userId: USER, subscription: subscription(n) });
            await db.run('UPDATE push_subscriptions SET lastSeenAt = @seen WHERE endpoint = @e',
                { seen: `2026-01-${String(n).padStart(2, '0')} 00:00:00`, e: subscription(n).endpoint });
        }
        expect(await service.countForUser(USER)).toBe(MAX_DEVICES);
        expect(await service.hasEndpoint({ userId: USER, endpoint: subscription(1).endpoint })).toBe(false);
        expect(await service.hasEndpoint({ userId: USER, endpoint: subscription(2).endpoint })).toBe(false);
        expect(await service.hasEndpoint({ userId: USER, endpoint: subscription(MAX_DEVICES + 2).endpoint })).toBe(true);
    });

    test('unsubscribe drops one device or all of them, and only the caller\'s', async () => {
        await service.subscribe({ userId: USER, subscription: subscription(1) });
        await service.subscribe({ userId: USER, subscription: subscription(2) });
        await service.subscribe({ userId: OTHER, subscription: subscription(3) });
        expect(await service.unsubscribe({ userId: OTHER, endpoint: subscription(1).endpoint })).toEqual({ removed: 0, devices: 1 });
        expect(await service.unsubscribe({ userId: USER, endpoint: subscription(1).endpoint })).toEqual({ removed: 1, devices: 1 });
        expect(await service.unsubscribe({ userId: USER, all: true })).toEqual({ removed: 1, devices: 0 });
        await expect(service.unsubscribe({ userId: USER })).rejects.toMatchObject({ code: 'BAD_ENDPOINT' });
        expect(await service.countForUser(OTHER)).toBe(1);
    });

    test('with no keys the feature is off: describe says so, subscribe refuses, notify skips', async () => {
        pushConfig._setForTests({ enabled: false, reason: 'no-keys', publicKey: null, privateKey: null, subject: 'mailto:x@y' });
        expect(await service.describe(USER)).toEqual({ enabled: false, reason: 'no-keys', publicKey: null, devices: 0 });
        await expect(service.subscribe({ userId: USER, subscription: subscription(1) })).rejects.toMatchObject({ status: 503, code: 'PUSH_DISABLED' });
        expect(await service.notify({ userId: USER, title: 'x' })).toEqual({ sent: 0, failed: 0, pruned: 0, skipped: true });
        expect(sender.calls).toHaveLength(0);
    });

    test('describe reports the public key and device count when enabled', async () => {
        await service.subscribe({ userId: USER, subscription: subscription(1) });
        expect(await service.describe(USER)).toEqual({ enabled: true, reason: null, publicKey: KEYS.publicKey, devices: 1 });
    });
});

describe('the Inbox echo', () => {
    test('every new item is pushed to every device as a pointer at the row, never the body', async () => {
        await service.subscribe({ userId: USER, subscription: subscription(1) });
        await service.subscribe({ userId: USER, subscription: subscription(2) });
        await service.subscribe({ userId: OTHER, subscription: subscription(3) });
        const result = await inboxService.deliver({
            userId: USER, kind: 'reminder', title: 'Call the vet', body: 'Secret details about the appointment', link: '/activity/scheduled', dedupeKey: 'vet-1'
        });
        expect(result.push).toEqual({ sent: 2, failed: 0, pruned: 0, skipped: false });
        expect(sender.calls).toHaveLength(2);
        expect(new Set(sender.calls.map(c => c.endpoint))).toEqual(new Set([subscription(1).endpoint, subscription(2).endpoint]));
        for (const call of sender.calls) {
            expect(call.payload).toEqual({
                title: 'Call the vet', body: 'Reminder', link: '/activity/scheduled', tag: `inbox-${result.item.id}`, kind: 'inbox'
            });
            expect(JSON.stringify(call.payload)).not.toContain('Secret details');
            expect(call.options.vapidDetails).toEqual({ subject: KEYS.subject, publicKey: KEYS.publicKey, privateKey: KEYS.privateKey });
            expect(call.options.urgency).toBe('high');
        }
        const row = await db.get('SELECT lastSentAt FROM push_subscriptions WHERE endpoint = @e', { e: subscription(1).endpoint });
        expect(row.lastSentAt).toBeTruthy();

        // The same dedupe key is the same item: no second push.
        const repeat = await inboxService.deliver({ userId: USER, kind: 'reminder', title: 'Call the vet', dedupeKey: 'vet-1' });
        expect(repeat.created).toBe(false);
        expect(repeat.push.skipped).toBe(true);
        expect(sender.calls).toHaveLength(2);
    });

    test('a person with no devices is a skip, not a failure', async () => {
        const result = await inboxService.deliver({ userId: USER, kind: 'task', title: 'Done' });
        expect(result.created).toBe(true);
        expect(result.push).toEqual({ sent: 0, failed: 0, pruned: 0, skipped: true });
        expect(await db.get('SELECT COUNT(*) AS c FROM work_failures')).toMatchObject({ c: 0 });
    });

    test('404/410 prunes the device; other errors count against it and land on the ledger without content', async () => {
        await service.subscribe({ userId: USER, subscription: subscription(1) });
        await service.subscribe({ userId: USER, subscription: subscription(2) });
        sender.outcomes.set(subscription(1).endpoint, 410);
        sender.outcomes.set(subscription(2).endpoint, 500);
        const item = await inboxService.deliver({ userId: USER, kind: 'task', title: 'Nightly digest ready', body: 'private text' });
        expect(item.push).toEqual({ sent: 0, failed: 1, pruned: 1, skipped: false });
        expect(await service.hasEndpoint({ userId: USER, endpoint: subscription(1).endpoint })).toBe(false);
        const survivor = await db.get('SELECT failCount FROM push_subscriptions WHERE endpoint = @e', { e: subscription(2).endpoint });
        expect(Number(survivor.failCount)).toBe(1);

        const failures = await db.all('SELECT * FROM work_failures');
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ kind: 'delivery', phase: 'web_push', code: 'PUSH_FAILED', reason: 'HTTP 500', actor: USER });
        expect(String(failures[0].workId)).toBe(String(item.item.id));
        expect(JSON.stringify(failures[0])).not.toContain('Nightly digest');
        expect(JSON.stringify(failures[0])).not.toContain('private text');
        expect(JSON.stringify(failures[0])).not.toContain('push.example.test');

        // Repeated failures drop the device.
        for (let i = 1; i < MAX_FAILURES; i++) {
            await service.notify({ userId: USER, title: 'again' });
        }
        expect(await service.countForUser(USER)).toBe(0);
    });

    test('a sender that throws without a status still never breaks delivery', async () => {
        await service.subscribe({ userId: USER, subscription: subscription(1) });
        sender.sendNotification = async () => { throw new Error('ECONNRESET'); };
        const item = await inboxService.deliver({ userId: USER, kind: 'system', title: 'Hello' });
        expect(item.created).toBe(true);
        expect(item.push).toEqual({ sent: 0, failed: 1, pruned: 0, skipped: false });
        const failure = await db.get('SELECT reason FROM work_failures');
        expect(failure.reason).toBe('ECONNRESET');
    });
});

describe('mentions and direct messages', () => {
    test('a mention carries who and where, never the message', async () => {
        await service.subscribe({ userId: USER, subscription: subscription(1) });
        const summary = await service.notifyMention({ userId: USER, fromName: 'Alex', title: 'Plan the trip', conversationId: 42, messageId: 7 });
        expect(summary.sent).toBe(1);
        expect(sender.calls[0].payload).toEqual({
            title: 'Alex mentioned you', body: 'in “Plan the trip”', link: '/discussions/42', tag: 'mention-42-7', kind: 'mention'
        });
    });

    test('a direct message names the sender and the thread only', async () => {
        await service.subscribe({ userId: USER, subscription: subscription(1) });
        await service.notifyDirectMessage({ userId: USER, fromName: 'Sam', threadId: 9 });
        expect(sender.calls[0].payload).toEqual({
            title: 'New message from Sam', body: null, link: '/people/messages/9', tag: 'dm-9', kind: 'dm'
        });
    });
});

describe('privacy', () => {
    test('push devices are counted by the report and the audit, and erased by forget-me', async () => {
        await pushService.subscribe({ userId: USER, subscription: subscription(1) });
        await pushService.subscribe({ userId: USER, subscription: subscription(2) });
        await pushService.subscribe({ userId: OTHER, subscription: subscription(3) });
        const report = await privacyService.buildUserReport({ guildId: `dm:${USER}`, userId: USER });
        expect(report.pushDevices).toBe(2);
        expect(JSON.stringify(report)).not.toContain('push.example.test');

        const before = await privacyService.auditUser({ userId: USER });
        expect(before.byTable.push_subscriptions).toBe(2);

        const counts = await privacyService.forgetUser({ userId: USER, extraNames: [] });
        expect(counts.pushSubscriptions).toBe(2);
        const after = await privacyService.auditUser({ userId: USER });
        expect(after.byTable.push_subscriptions).toBe(0);
        expect(await pushService.countForUser(OTHER)).toBe(1);
    });
});

describe('routes', () => {
    let server;
    let port;
    const DIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-push-dist-'));

    function request({ method = 'GET', reqPath = '/', headers = {}, body = null }) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
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
                    resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    async function login(userId = USER) {
        const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name: 'rob' } });
        expect(res.status).toBe(200);
        return res.headers['set-cookie'].find(c => c.startsWith('goobster_web_session=')).split(';')[0];
    }

    beforeAll((done) => {
        fs.writeFileSync(path.join(DIST_DIR, 'index.html'), '<!doctype html><title>fixture</title>');
        const ctx = createWebAppContext({
            client: { user: { id: '900000000000000001', username: 'Goobster' }, guilds: { cache: new Map() } },
            config: { clientId: '123', webapp: { enabled: true, devMode: true } },
            logger: { error: () => {}, warn: () => {}, info: () => {} },
            deps: { chat: { maxInputLength: 20000 }, webDistDir: DIST_DIR }
        });
        const app = express();
        app.use(createWebAppApp(ctx));
        server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
    });

    test('the routes need a session', async () => {
        expect((await request({ reqPath: '/api/app/push' })).status).toBe(401);
        expect((await request({ method: 'POST', reqPath: '/api/app/push/subscriptions', body: { subscription: subscription(1) } })).status).toBe(401);
    });

    test('subscribe, inspect this device, test, and remove through the API', async () => {
        const cookie = await login();
        const empty = await request({ reqPath: '/api/app/push', headers: { Cookie: cookie } });
        expect(empty.json).toEqual({ enabled: true, reason: null, publicKey: KEYS.publicKey, devices: 0, thisDevice: false });

        const sub = await request({ method: 'POST', reqPath: '/api/app/push/subscriptions', headers: { Cookie: cookie, 'User-Agent': 'Test/2' }, body: { subscription: subscription(1) } });
        expect(sub.status).toBe(200);
        expect(sub.json).toEqual({ ok: true, devices: 1 });

        const mine = await request({ reqPath: `/api/app/push?endpoint=${encodeURIComponent(subscription(1).endpoint)}`, headers: { Cookie: cookie } });
        expect(mine.json.thisDevice).toBe(true);
        expect(mine.json.devices).toBe(1);
        expect(JSON.stringify(mine.json)).not.toContain('push.example.test');
        const theirs = await request({ reqPath: `/api/app/push?endpoint=${encodeURIComponent(subscription(1).endpoint)}`, headers: { Cookie: await login(OTHER) } });
        expect(theirs.json.thisDevice).toBe(false);

        const test = await request({ method: 'POST', reqPath: '/api/app/push/test', headers: { Cookie: cookie } });
        expect(test.status).toBe(200);
        expect(test.json).toEqual({ sent: 1, failed: 0, pruned: 0, skipped: false });
        expect(sender.calls[0].payload).toMatchObject({ kind: 'test', link: '/settings/initiative' });

        const bad = await request({ method: 'POST', reqPath: '/api/app/push/subscriptions', headers: { Cookie: cookie }, body: { subscription: { endpoint: 'nope' } } });
        expect(bad.status).toBe(400);
        expect(bad.json.error.code).toBe('BAD_ENDPOINT');

        const removed = await request({ method: 'DELETE', reqPath: '/api/app/push/subscriptions', headers: { Cookie: cookie }, body: { endpoint: subscription(1).endpoint } });
        expect(removed.json).toEqual({ removed: 1, devices: 0 });
    });

    test('the test button is rate limited', async () => {
        const cookie = await login();
        await request({ method: 'POST', reqPath: '/api/app/push/subscriptions', headers: { Cookie: cookie }, body: { subscription: subscription(1) } });
        let limited = null;
        for (let i = 0; i < 6; i++) {
            const res = await request({ method: 'POST', reqPath: '/api/app/push/test', headers: { Cookie: cookie } });
            if (res.status === 429) { limited = res; break; }
        }
        expect(limited).not.toBeNull();
        expect(limited.json.error.code).toBe('RATE_LIMITED');
    });

    test('a disabled installation answers PUSH_DISABLED to a subscribe', async () => {
        pushConfig._setForTests({ enabled: false, reason: 'disabled', publicKey: null, privateKey: null, subject: 'mailto:x@y' });
        const cookie = await login();
        const status = await request({ reqPath: '/api/app/push', headers: { Cookie: cookie } });
        expect(status.json).toEqual({ enabled: false, reason: 'disabled', publicKey: null, devices: 0, thisDevice: false });
        const sub = await request({ method: 'POST', reqPath: '/api/app/push/subscriptions', headers: { Cookie: cookie }, body: { subscription: subscription(1) } });
        expect(sub.status).toBe(503);
        expect(sub.json.error.code).toBe('PUSH_DISABLED');
    });
});
