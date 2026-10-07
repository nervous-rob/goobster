/**
 * The manager's browser session (#330): `POST /claim` and `POST /recovery/unlock`
 * also set the HttpOnly `goobster-manager-session` cookie, `authenticate()`
 * accepts it when there is no Authorization header (never both), a cross-site
 * request that carries it is refused, `POST /session/logout` clears it, and a
 * manager restart ends the session (the registry is in memory).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createManagerApp } = require('@goobster/manager/server');
const sessions = require('@goobster/manager/auth/sessions');

const silent = { info() {}, warn() {}, error() {} };
const roots = [];
const servers = [];

afterAll(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

async function start(root) {
    const settings = resolveSettings({
        GOOBSTER_DATA_DIR: path.join(root, 'data'),
        GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0'
    });
    const manager = createManager({ settings, logger: silent });
    const booted = await manager.init();
    const app = createManagerApp(manager, { logger: silent });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const port = server.address().port;

    function request({ method = 'GET', reqPath, body, headers = {} }) {
        const payload = body !== undefined ? JSON.stringify(body) : null;
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port,
                method,
                path: reqPath,
                headers: {
                    host: `127.0.0.1:${port}`,
                    ...(payload !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                    ...headers
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch { }
                    resolve({ status: res.statusCode, body: json, headers: res.headers });
                });
            });
            req.on('error', reject);
            if (payload !== null) req.write(payload);
            req.end();
        });
    }
    return { settings, manager, booted, port, request, close: () => new Promise(resolve => server.close(resolve)) };
}

const nonce = () => crypto.randomBytes(24).toString('base64url');
const cookieHeader = (res) => (res.headers['set-cookie'] || []).find(line => line.startsWith(`${sessions.COOKIE_NAME}=`));
const cookiePair = (line) => line.split(';')[0];

async function claimed() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-330-server-'));
    roots.push(root);
    const h = await start(root);
    const res = await h.request({ method: 'POST', reqPath: '/manager/api/claim', body: { credential: h.booted.bootstrap.credential, label: 'Rob' } });
    return { ...h, root, claim: res };
}

describe('claim sets the session cookie', () => {
    test('HttpOnly, SameSite=Strict, Path=/manager, bounded lifetime, no Secure on loopback, and the body still carries the token', async () => {
        const h = await claimed();
        expect(h.claim.status).toBe(200);
        const line = cookieHeader(h.claim);
        expect(line).toBeTruthy();
        expect(line).toContain('HttpOnly');
        expect(line).toContain('SameSite=Strict');
        expect(line).toContain('Path=/manager');
        expect(line).not.toContain('Secure');
        const maxAge = Number(/Max-Age=(\d+)/.exec(line)[1]);
        expect(maxAge).toBeGreaterThan(0);
        expect(maxAge).toBeLessThanOrEqual(15 * 60);
        expect(cookiePair(line)).toBe(`${sessions.COOKIE_NAME}=${h.claim.body.session.token}`);
    });

    test('LAN mode adds Secure', () => {
        const line = sessions.sessionCookie('a'.repeat(30), { expiresAt: new Date(Date.now() + 60_000).toISOString(), secure: true });
        expect(line).toContain('; Secure');
        expect(sessions.clearedSessionCookie({ secure: true })).toContain('; Secure');
    });

    test('recovery unlock sets it too', async () => {
        const h = await claimed();
        const minted = h.manager.credentials.recovery.mint();
        const res = await h.request({ method: 'POST', reqPath: '/manager/api/recovery/unlock', body: { credential: minted.credential } });
        expect(res.status).toBe(200);
        const line = cookieHeader(res);
        expect(line).toContain('HttpOnly');
        expect(cookiePair(line)).toBe(`${sessions.COOKIE_NAME}=${res.body.session.token}`);
    });

    test('a failed claim sets no cookie', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-330-server-'));
        roots.push(root);
        const h = await start(root);
        const res = await h.request({ method: 'POST', reqPath: '/manager/api/claim', body: { credential: 'wrong-wrong-wrong-wrong-wrong', label: 'Rob' } });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(cookieHeader(res)).toBeUndefined();
    });
});

describe('the cookie authenticates', () => {
    test('a read with only the cookie works', async () => {
        const h = await claimed();
        const res = await h.request({ reqPath: '/manager/api/operations', headers: { cookie: cookiePair(cookieHeader(h.claim)) } });
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.operations)).toBe(true);
    });

    test('a mutation needs a fresh nonce header and then reaches the engine', async () => {
        const h = await claimed();
        const cookie = cookiePair(cookieHeader(h.claim));
        const without = await h.request({ method: 'POST', reqPath: '/manager/api/operations', body: { kind: 'no.such.kind' }, headers: { cookie } });
        expect(without.status).toBe(400);
        expect(without.body.error.code).toBe('NONCE_REQUIRED');
        const one = nonce();
        const first = await h.request({ method: 'POST', reqPath: '/manager/api/operations', body: { kind: 'no.such.kind' }, headers: { cookie, 'x-goobster-nonce': one } });
        expect(first.body.error.code).toBe('UNKNOWN_KIND');
        const replay = await h.request({ method: 'POST', reqPath: '/manager/api/operations', body: { kind: 'no.such.kind' }, headers: { cookie, 'x-goobster-nonce': one } });
        expect(replay.status).toBe(401);
        expect(replay.body.error.code).toBe('NONCE_REPLAYED');
    });

    test('the Authorization header alone still works (curl and the CLI)', async () => {
        const h = await claimed();
        const res = await h.request({ reqPath: '/manager/api/operations', headers: { authorization: `Bearer ${h.claim.body.session.token}` } });
        expect(res.status).toBe(200);
    });

    test('the header and the cookie together are refused, even when they are the same session', async () => {
        const h = await claimed();
        const res = await h.request({
            reqPath: '/manager/api/operations',
            headers: { authorization: `Bearer ${h.claim.body.session.token}`, cookie: cookiePair(cookieHeader(h.claim)) }
        });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('AMBIGUOUS_AUTH');
    });

    test('an assertion with a cookie is refused too', async () => {
        const h = await claimed();
        const res = await h.request({
            reqPath: '/manager/api/operations',
            headers: { 'x-goobster-manager-assertion': 'x.y', cookie: cookiePair(cookieHeader(h.claim)) }
        });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('AMBIGUOUS_AUTH');
    });

    test('a cookie that is not a session, or is another cookie, is unauthenticated', async () => {
        const h = await claimed();
        const bogus = await h.request({ reqPath: '/manager/api/operations', headers: { cookie: `${sessions.COOKIE_NAME}=${'z'.repeat(40)}` } });
        expect(bogus.status).toBe(401);
        expect(bogus.body.error.code).toBe('SESSION_INVALID');
        const other = await h.request({ reqPath: '/manager/api/operations', headers: { cookie: `other=${h.claim.body.session.token}` } });
        expect(other.status).toBe(401);
        expect(other.body.error.code).toBe('UNAUTHENTICATED');
        const twice = await h.request({ reqPath: '/manager/api/operations', headers: { cookie: `${cookiePair(cookieHeader(h.claim))}; ${cookiePair(cookieHeader(h.claim))}` } });
        expect(twice.status).toBe(401);
    });
});

describe('a cross-site request that carries the cookie is refused', () => {
    test('fetch metadata saying cross-site', async () => {
        const h = await claimed();
        const res = await h.request({ reqPath: '/manager/api/operations', headers: { cookie: cookiePair(cookieHeader(h.claim)), 'sec-fetch-site': 'cross-site' } });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('BAD_ORIGIN');
    });

    test('a foreign Origin on a read and on a mutation', async () => {
        const h = await claimed();
        const cookie = cookiePair(cookieHeader(h.claim));
        const read = await h.request({ reqPath: '/manager/api/operations', headers: { cookie, origin: 'http://evil.example' } });
        expect(read.status).toBe(403);
        const write = await h.request({ method: 'POST', reqPath: '/manager/api/operations', body: { kind: 'no.such.kind' }, headers: { cookie, origin: 'http://evil.example', 'x-goobster-nonce': nonce() } });
        expect(write.status).toBe(403);
    });

    test('the manager\'s own Origin is fine', async () => {
        const h = await claimed();
        const res = await h.request({ reqPath: '/manager/api/operations', headers: { cookie: cookiePair(cookieHeader(h.claim)), origin: `http://127.0.0.1:${h.port}`, 'sec-fetch-site': 'same-origin' } });
        expect(res.status).toBe(200);
    });
});

describe('logout and restart', () => {
    test('logout clears the cookie and ends the session', async () => {
        const h = await claimed();
        const cookie = cookiePair(cookieHeader(h.claim));
        const out = await h.request({ method: 'POST', reqPath: '/manager/api/session/logout', body: {}, headers: { cookie } });
        expect(out.status).toBe(200);
        expect(out.body).toEqual({ loggedOut: true, ended: true });
        const cleared = cookieHeader(out);
        expect(cleared).toContain(`${sessions.COOKIE_NAME}=;`);
        expect(cleared).toContain('Max-Age=0');
        expect(cleared).toContain('HttpOnly');
        const after = await h.request({ reqPath: '/manager/api/operations', headers: { cookie } });
        expect(after.status).toBe(401);
        expect(after.body.error.code).toBe('SESSION_INVALID');
    });

    test('logout works with the bearer token and with no session at all', async () => {
        const h = await claimed();
        const bearer = await h.request({ method: 'POST', reqPath: '/manager/api/session/logout', body: {}, headers: { authorization: `Bearer ${h.claim.body.session.token}` } });
        expect(bearer.body.ended).toBe(true);
        const none = await h.request({ method: 'POST', reqPath: '/manager/api/session/logout', body: {} });
        expect(none.status).toBe(200);
        expect(none.body.ended).toBe(false);
        expect(cookieHeader(none)).toContain('Max-Age=0');
    });

    test('a manager restart ends the session', async () => {
        const h = await claimed();
        const cookie = cookiePair(cookieHeader(h.claim));
        await h.close();
        const again = await start(h.root);
        const res = await again.request({ reqPath: '/manager/api/operations', headers: { cookie } });
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('SESSION_INVALID');
    });
});
