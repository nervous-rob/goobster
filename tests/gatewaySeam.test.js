/**
 * Phase 3 seam tests: LocalGateway, the bot's /internal/gateway/* API,
 * RemoteGateway (including its membership cache rules), bot-down
 * degradation, the in-process event bus, and createApiApp (health, /me
 * with the bot unreachable, GET /api/app/events).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-gateway-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const { LocalGateway, RemoteGateway, toGateway, GatewayUnavailableError } = require('../packages/core/gateway');
const { createInternalGatewayApi } = require('../apps/bot/web/internalGatewayApi');
const { createApiApp } = require('../apps/api/server');
const webGuildAccess = require('../packages/core/utils/webGuildAccess');
const webDashboardService = require('../packages/core/services/webDashboardService');
const eventBusService = require('../packages/core/services/eventBusService');
const { dmScopeId } = require('../packages/core/utils/dmScope');
const db = require('../packages/core/db');

const USER = '100000000000000001';
const GUILD = '200000000000000001';
const TOKEN = 'test-internal-token';

function fakeClient(overrides = {}) {
    return {
        user: { id: 'bot-1', username: 'Goobster' },
        guilds: {
            cache: {
                get() { return null; },
                values() { return []; }
            }
        },
        users: { fetch: async () => null },
        channels: { fetch: async () => null },
        ...overrides
    };
}

function guildWithMember({
    guildId = GUILD,
    userId = USER,
    name = 'Alpha',
    perms = new Set(['ViewChannel'])
} = {}) {
    const member = {
        id: userId,
        user: {
            id: userId,
            username: 'alice',
            bot: false,
            displayAvatarURL: () => null
        },
        displayName: 'Alice',
        permissions: {
            has: (flag) => perms.has(flag),
            toArray: () => [...perms]
        }
    };
    const guild = {
        id: guildId,
        name,
        iconURL: () => null,
        memberCount: 3,
        members: {
            fetch: jest.fn(async (id) => {
                if (id === userId) return member;
                throw new Error('Unknown Member');
            }),
            cache: {
                values() { return [member]; }
            }
        }
    };
    return { guild, member };
}

describe('LocalGateway', () => {
    test('botUser and available', async () => {
        const gateway = new LocalGateway(fakeClient());
        await expect(gateway.available()).resolves.toBe(true);
        await expect(gateway.botUser()).resolves.toEqual({ id: 'bot-1', username: 'Goobster' });
    });

    test('available is false when the client is logged out', async () => {
        const gateway = new LocalGateway(fakeClient({ user: null }));
        await expect(gateway.available()).resolves.toBe(false);
        await expect(gateway.botUser()).resolves.toBeNull();
    });

    test('getGuildMember and memberHasPermission', async () => {
        const { guild } = guildWithMember({ perms: new Set(['ManageGuild']) });
        const client = fakeClient({
            guilds: {
                cache: {
                    get: (id) => (id === GUILD ? guild : null),
                    values() { return [guild]; }
                }
            }
        });
        const gateway = new LocalGateway(client);
        const result = await gateway.getGuildMember(GUILD, USER);
        expect(result.guild).toMatchObject({ id: GUILD, name: 'Alpha' });
        expect(result.member).toMatchObject({ id: USER, displayName: 'Alice' });
        await expect(gateway.memberHasPermission(GUILD, USER, 'ManageGuild')).resolves.toBe(true);
        await expect(gateway.memberHasPermission(GUILD, USER, 'Administrator')).resolves.toBe(false);
    });

    test('listMutualGuilds filters to membership', async () => {
        const { guild: g1 } = guildWithMember({ guildId: 'g1', userId: USER, name: 'Alpha' });
        const { guild: g2 } = guildWithMember({ guildId: 'g2', userId: 'other', name: 'Beta' });
        const client = fakeClient({
            guilds: {
                cache: {
                    get: (id) => ({ g1, g2 }[id] || null),
                    values() { return [g1, g2]; }
                }
            }
        });
        const gateway = new LocalGateway(client);
        await expect(gateway.listMutualGuilds(USER)).resolves.toEqual([
            { id: 'g1', name: 'Alpha', icon: null, memberCount: 3, manageGuild: false }
        ]);
    });

    test('sendDm reports success without throwing', async () => {
        const send = jest.fn(async () => ({ id: 'm1', channelId: 'dm-1' }));
        const client = fakeClient({
            users: { fetch: async () => ({ id: USER, send }) }
        });
        const gateway = new LocalGateway(client);
        await expect(gateway.sendDm(USER, { content: 'hi' })).resolves.toEqual({
            ok: true, channelId: 'dm-1', messageId: 'm1'
        });
        expect(send).toHaveBeenCalledWith({ content: 'hi' });
    });

    test('toGateway wraps a client once and passes a gateway through', () => {
        const client = fakeClient();
        const a = toGateway(client);
        const b = toGateway(client);
        expect(a).toBe(b);
        expect(a).toBeInstanceOf(LocalGateway);
        expect(toGateway(a)).toBe(a);
        expect(toGateway(null)).toBeNull();
    });
});

describe('internal gateway API + RemoteGateway', () => {
    const previousToken = process.env.GOOBSTER_INTERNAL_TOKEN;

    beforeAll(() => {
        process.env.GOOBSTER_INTERNAL_TOKEN = TOKEN;
    });

    afterAll(() => {
        if (previousToken === undefined) delete process.env.GOOBSTER_INTERNAL_TOKEN;
        else process.env.GOOBSTER_INTERNAL_TOKEN = previousToken;
    });

    async function withServer(client, fn) {
        const app = express();
        app.use(createInternalGatewayApi({ client }));
        const server = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        const { port } = server.address();
        try {
            return await fn(port);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }

    test('rejects missing and wrong tokens', async () => {
        await withServer(fakeClient(), async (port) => {
            const missing = await httpJson(port, { reqPath: '/internal/gateway/bot-user' });
            expect(missing.status).toBe(401);
            const wrong = await httpJson(port, {
                reqPath: '/internal/gateway/bot-user',
                headers: { 'x-goobster-internal-token': 'nope' }
            });
            expect(wrong.status).toBe(401);
        });
    });

    test('health answers when the bot is not ready; other reads are 503', async () => {
        await withServer(fakeClient({ user: null }), async (port) => {
            const health = await httpJson(port, {
                reqPath: '/internal/gateway/health',
                headers: { 'x-goobster-internal-token': TOKEN }
            });
            expect(health.status).toBe(200);
            expect(health.json).toEqual({ ok: true, available: false });

            const res = await httpJson(port, {
                reqPath: '/internal/gateway/bot-user',
                headers: { 'x-goobster-internal-token': TOKEN }
            });
            expect(res.status).toBe(503);
            expect(res.json.error.code).toBe('GATEWAY_UNAVAILABLE');
        });
    });

    test('RemoteGateway talks to the internal API', async () => {
        const { guild } = guildWithMember({ perms: new Set(['ManageGuild']) });
        const client = fakeClient({
            guilds: {
                cache: {
                    get: (id) => (id === GUILD ? guild : null),
                    values() { return [guild]; }
                }
            }
        });
        await withServer(client, async (port) => {
            const gateway = new RemoteGateway({
                baseUrl: `http://127.0.0.1:${port}`,
                token: TOKEN
            });
            expect(await gateway.available()).toBe(true);
            expect(await gateway.botUser()).toEqual({ id: 'bot-1', username: 'Goobster' });
            const membership = await gateway.getGuildMember(GUILD, USER);
            expect(membership.member).toMatchObject({ id: USER, displayName: 'Alice' });
            expect(await gateway.memberHasPermission(GUILD, USER, 'ManageGuild')).toBe(true);
            expect(await gateway.listMutualGuilds(USER)).toEqual([
                { id: GUILD, name: 'Alpha', icon: null, memberCount: 3, manageGuild: true }
            ]);
        });
    });

    test('RemoteGateway caches membership but not permissions', async () => {
        const { guild, member } = guildWithMember({ perms: new Set() });
        const client = fakeClient({
            guilds: {
                cache: {
                    get: (id) => (id === GUILD ? guild : null),
                    values() { return [guild]; }
                }
            }
        });
        await withServer(client, async (port) => {
            const gateway = new RemoteGateway({
                baseUrl: `http://127.0.0.1:${port}`,
                token: TOKEN
            });
            await gateway.getGuildMember(GUILD, USER);
            await gateway.getGuildMember(GUILD, USER);
            expect(guild.members.fetch).toHaveBeenCalledTimes(1);

            await gateway.memberHasPermission(GUILD, USER, 'ManageGuild');
            member.permissions.has = (flag) => flag === 'ManageGuild';
            await expect(gateway.memberHasPermission(GUILD, USER, 'ManageGuild')).resolves.toBe(true);
            expect(guild.members.fetch).toHaveBeenCalledTimes(3);
        });
    });

    test('RemoteGateway surfaces GatewayUnavailableError when the bot is down', async () => {
        await withServer(fakeClient({ user: null }), async (port) => {
            const gateway = new RemoteGateway({
                baseUrl: `http://127.0.0.1:${port}`,
                token: TOKEN,
                fallbackBotUserId: 'bot-fallback'
            });
            expect(await gateway.available()).toBe(false);
            await expect(gateway.getGuildMember(GUILD, USER)).rejects.toBeInstanceOf(GatewayUnavailableError);
            expect(await gateway.botUser()).toEqual({ id: 'bot-fallback', username: 'Goobster' });
        });
    });
});

describe('degraded guild access', () => {
    test('requireGuildMember maps GatewayUnavailableError to 503 BOT_OFFLINE', async () => {
        const gateway = {
            isGoobsterGateway: true,
            getGuildMember: async () => { throw new GatewayUnavailableError(); }
        };
        await expect(webGuildAccess.requireGuildMember({
            gateway,
            guildId: GUILD,
            userId: USER
        })).rejects.toMatchObject({ status: 503, code: 'BOT_OFFLINE' });
    });

    test('listScopes keeps the DM scope when the bot is unreachable', async () => {
        const gateway = {
            isGoobsterGateway: true,
            listMutualGuilds: async () => { throw new GatewayUnavailableError(); }
        };
        const scopes = await webDashboardService.listScopes({ gateway, userId: USER });
        expect(scopes).toEqual([
            expect.objectContaining({ id: dmScopeId(USER), kind: 'dm' })
        ]);
    });
});

describe('event bus', () => {
    afterAll(async () => {
        await eventBusService.close();
    });

    test('publish delivers locally with invalidation hints', async () => {
        const seen = [];
        const unsubscribe = eventBusService.subscribe((event) => seen.push(event));
        eventBusService.publish('followup-delivered', { userId: USER, followupId: 9 });
        unsubscribe();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            kind: 'followup-delivered',
            payload: { userId: USER, followupId: 9 }
        });
        expect(eventBusService.invalidationHints('followup-delivered')).toEqual(['tasks', 'home']);
        expect(eventBusService.invalidationHints('automation-ran')).toEqual(['tasks', 'home']);
        expect(eventBusService.invalidationHints('agent-run-updated')).toEqual(['home']);
        expect(eventBusService.invalidationHints('unknown')).toEqual([]);
    });

    test('a throwing subscriber does not break publish', () => {
        const unsubscribe = eventBusService.subscribe(() => { throw new Error('subscriber boom'); });
        expect(() => eventBusService.publish('automation-ran', { userId: USER })).not.toThrow();
        unsubscribe();
    });
});

describe('createApiApp', () => {
    const quietLogger = { error() {}, warn() {}, info() {}, debug() {} };
    const config = { clientId: '900000000000000001', webapp: { enabled: true, devMode: true } };

    afterAll(async () => {
        await eventBusService.close();
        await db.closeConnection();
        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
        }
    });

    test('health reports split mode and gateway availability', async () => {
        const gateway = {
            isGoobsterGateway: true,
            available: async () => true,
            botUser: async () => ({ id: 'bot-1', username: 'Goobster' })
        };
        const { app } = createApiApp({ gateway, config, logger: quietLogger });
        const server = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        try {
            const res = await httpJson(server.address().port, { reqPath: '/health' });
            expect(res.status).toBe(200);
            expect(res.json).toMatchObject({
                status: 'healthy',
                service: 'api',
                gateway: 'connected'
            });
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('health reports unreachable when the bot is down', async () => {
        const gateway = {
            isGoobsterGateway: true,
            available: async () => false,
            botUser: async () => ({ id: 'bot-fallback', username: 'Goobster' })
        };
        const { app } = createApiApp({ gateway, config, logger: quietLogger });
        const server = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        try {
            const res = await httpJson(server.address().port, { reqPath: '/health' });
            expect(res.status).toBe(200);
            expect(res.json.gateway).toBe('unreachable');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('/me stays up with the bot down: DM scope only, fallback bot id', async () => {
        const gateway = {
            isGoobsterGateway: true,
            available: async () => false,
            botUser: async () => ({ id: 'bot-fallback', username: 'Goobster' }),
            listMutualGuilds: async () => { throw new GatewayUnavailableError(); }
        };
        const { app } = createApiApp({ gateway, config, logger: quietLogger });
        const server = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        const { port } = server.address();
        try {
            const login = await httpJson(port, {
                method: 'POST',
                reqPath: '/api/app/auth/dev-session',
                body: { userId: USER, name: 'rob' }
            });
            expect(login.status).toBe(200);
            const cookie = login.headers['set-cookie']
                .find(c => c.startsWith('goobster_web_session='))
                .split(';')[0];
            const me = await httpJson(port, {
                reqPath: '/api/app/me',
                headers: { Cookie: cookie }
            });
            expect(me.status).toBe(200);
            expect(me.json.user).toEqual(expect.objectContaining({ id: USER, name: 'rob' }));
            expect(me.json.bot).toEqual({ id: 'bot-fallback', name: 'Goobster' });
            expect(me.json.scopes.map(s => s.id)).toEqual([dmScopeId(USER)]);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('GET /api/app/events is user-scoped and carries invalidation hints', async () => {
        const gateway = {
            isGoobsterGateway: true,
            available: async () => true,
            botUser: async () => ({ id: 'bot-1', username: 'Goobster' }),
            listMutualGuilds: async () => []
        };
        const { app } = createApiApp({ gateway, config, logger: quietLogger });
        const server = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        const { port } = server.address();
        try {
            const login = await httpJson(port, {
                method: 'POST',
                reqPath: '/api/app/auth/dev-session',
                body: { userId: USER, name: 'rob' }
            });
            const cookie = login.headers['set-cookie']
                .find(c => c.startsWith('goobster_web_session='))
                .split(';')[0];

            const sse = await openSse(port, '/api/app/events', { Cookie: cookie });
            const helloBuf = await readSseUntil(sse, (buf) => buf.includes('event: hello'));
            expect(helloBuf).toContain(`"userId":"${USER}"`);

            eventBusService.publish('followup-delivered', { userId: 'someone-else', followupId: 1 });
            eventBusService.publish('followup-delivered', { userId: USER, followupId: 42 });
            const delivered = await readSseUntil(sse, (buf) => buf.includes('event: followup-delivered'));
            expect(delivered).toContain('"followupId":42');
            expect(delivered).toContain('"invalidate":["tasks","home"]');
            expect(delivered).not.toContain('someone-else');
            sse.destroy();
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

function httpJson(port, { method = 'GET', reqPath = '/', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: reqPath,
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

function openSse(port, reqPath, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            method: 'GET',
            path: reqPath,
            headers
        }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`SSE status ${res.statusCode}`));
                return;
            }
            resolve(res);
        });
        req.on('error', reject);
        req.end();
    });
}

function readSseUntil(res, predicate, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error(`sse timeout: ${buf}`)), timeoutMs);
        const onData = (chunk) => {
            buf += chunk.toString();
            if (predicate(buf)) {
                clearTimeout(timer);
                res.removeListener('data', onData);
                resolve(buf);
            }
        };
        res.on('data', onData);
        res.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
