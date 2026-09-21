/**
 * Native authentication (shared-instance Increment B): invitations,
 * username + password registration and login, throttles, re-auth and
 * credential enrollment, operator-issued recovery, session revocation,
 * Discord link intents and disconnect rules, the operator admin routes,
 * the release gate, CSRF posture, and the privacy erasure path.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-native-auth-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const identityService = require('@goobster/core/services/identityService');
const identityConfig = require('@goobster/core/config/identityConfig');
const nativeAuthService = require('@goobster/core/services/nativeAuthService');
const webSessionService = require('@goobster/core/services/webSessionService');
const privacyService = require('@goobster/core/services/privacyService');
const eventBusService = require('@goobster/core/services/eventBusService');
const { hashPassword, verifyPassword, needsRehash } = require('@goobster/core/utils/passwordHashing');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');

const ROB = '100000000000000001';
const SAM = '100000000000000002';
const GOOD = 'a long enough passphrase 42';
const TABLES = ['web_sessions', 'web_rate_events', 'password_credentials', 'recovery_tokens', 'oauth_link_states',
    'account_invites', 'auth_identities', 'app_accounts', 'principals', 'users'];

let server;
let port;

function request({ method = 'GET', reqPath, headers = {}, body = null }) {
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
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
    if (!setCookie) return null;
    const value = setCookie.split(';')[0];
    return value === 'goobster_web_session=' ? '' : value;
}

async function devSession(userId, name = 'someone') {
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
    return { res, cookie: sessionCookie(res) };
}

/** A legacy Discord operator with a live session (the host). */
async function operator(id = ROB) {
    await identityService.ensureLegacyPrincipal({ discordId: id, displayName: 'host' });
    await identityService.grantAccount({ principalId: id, entitlement: 'bootstrap', role: 'operator' });
    const { cookie } = await devSession(id, 'host');
    return cookie;
}

async function invite(cookie, body = {}) {
    const res = await request({ method: 'POST', reqPath: '/api/app/admin/invites', headers: { cookie }, body });
    expect(res.status).toBe(200);
    const token = new URL(res.json.url, 'http://x').searchParams.get('token');
    return { token, invite: res.json.invite, url: res.json.url };
}

async function register(token, loginName, password = GOOD, extra = {}) {
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/register', body: { token, loginName, password, ...extra } });
    return { res, cookie: sessionCookie(res) };
}

async function login(loginName, password, headers = {}) {
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/native-login', headers, body: { loginName, password } });
    return { res, cookie: sessionCookie(res) };
}

/** Make a session look old for the recent-auth window. */
async function ageSession(cookie) {
    const token = cookie.split('=')[1];
    const crypto = require('node:crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.run(`UPDATE web_sessions SET authenticatedAt = '2000-01-01 00:00:00' WHERE tokenHash = @tokenHash`, { tokenHash });
}

beforeAll((done) => {
    const ctx = createWebAppContext({
        client: { user: { id: '9', username: 'Goobster' }, guilds: { cache: new Map() } },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} }
    });
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
    identityConfig.requireAccount = false;
    identityConfig.nativeLogin = true;
    // Cheap scrypt (4 MiB) so this suite does not starve its Jest neighbours
    // of CPU on a small CI runner; the hashing primitives are covered below.
    identityConfig.passwordCostLog2 = 12;
    identityConfig.passwordMinLength = 15;
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`);
});

describe('password hashing', () => {
    test('scrypt hashes verify, differ per salt, and report when the cost has risen', async () => {
        const a = await hashPassword(GOOD, { logN: 14 });
        const b = await hashPassword(GOOD, { logN: 14 });
        expect(a.hash).toMatch(/^scrypt\$14\$8\$1\$/);
        expect(a.hash).not.toBe(b.hash);
        expect(a.params).toEqual({ algorithm: 'scrypt', logN: 14, r: 8, p: 1, keyLen: 32 });
        expect(await verifyPassword(GOOD, a.hash)).toBe(true);
        expect(await verifyPassword(`${GOOD}!`, a.hash)).toBe(false);
        expect(await verifyPassword(GOOD, 'garbage')).toBe(false);
        expect(needsRehash(a.hash, { logN: 14 })).toBe(false);
        expect(needsRehash(a.hash, { logN: 15 })).toBe(true);
    });
});

describe('policy', () => {
    test('login names are normalised and never look like principal ids', () => {
        expect(nativeAuthService.normalizeLoginName('  Rob.Smith-1 ')).toBe('rob.smith-1');
        expect(() => nativeAuthService.normalizeLoginName('ab')).toThrow(expect.objectContaining({ code: 'BAD_LOGIN_NAME' }));
        expect(() => nativeAuthService.normalizeLoginName('.dot')).toThrow(expect.objectContaining({ code: 'BAD_LOGIN_NAME' }));
        expect(() => nativeAuthService.normalizeLoginName('has space')).toThrow(expect.objectContaining({ code: 'BAD_LOGIN_NAME' }));
        expect(() => nativeAuthService.normalizeLoginName('123456789012')).toThrow(expect.objectContaining({ code: 'BAD_LOGIN_NAME' }));
        expect(() => nativeAuthService.normalizeLoginName('usr_abc')).toThrow(expect.objectContaining({ code: 'BAD_LOGIN_NAME' }));
    });

    test('passwords: length floor, no composition rules, deny list, not the login name', () => {
        const weak = (pw, ctx) => expect(() => nativeAuthService.validatePassword(pw, ctx)).toThrow(expect.objectContaining({ code: 'WEAK_PASSWORD' }));
        weak('short but ok?');
        weak('a'.repeat(300));
        weak('correcthorsebatterystaple');
        weak('Correct Horse Battery Staple');
        weak('xxxxxxxxxxxxxxxxxxxx');
        weak('rob.smith is my login', { loginName: 'rob.smith' });
        expect(() => nativeAuthService.validatePassword('all lowercase words are fine')).not.toThrow();
        identityConfig.passwordMinLength = 20;
        weak('nineteen characters');
    });
});

describe('release gate', () => {
    test('everything native is 503 while identity.nativeLogin is off; Discord linking is not', async () => {
        identityConfig.nativeLogin = false;
        const cookie = await operator();
        const config = await request({ reqPath: '/api/app/config' });
        expect(config.json.nativeLogin).toBe(false);
        expect((await request({ reqPath: '/api/app/auth/invite/anything' })).json.error.code).toBe('NATIVE_LOGIN_DISABLED');
        expect((await request({ method: 'POST', reqPath: '/api/app/auth/register', body: {} })).status).toBe(503);
        expect((await request({ method: 'POST', reqPath: '/api/app/auth/native-login', body: {} })).status).toBe(503);
        expect((await request({ method: 'POST', reqPath: '/api/app/auth/recover', body: {} })).status).toBe(503);
        expect((await request({ method: 'POST', reqPath: '/api/app/admin/invites', headers: { cookie }, body: {} })).status).toBe(503);
        const creds = await request({ method: 'PUT', reqPath: '/api/app/account/credentials', headers: { cookie }, body: { loginName: 'host', newPassword: GOOD } });
        expect(creds.json.error.code).toBe('NATIVE_LOGIN_DISABLED');
        // Account summary still answers, and says the gate is closed.
        const account = await request({ reqPath: '/api/app/account', headers: { cookie } });
        expect(account.status).toBe(200);
        expect(account.json.nativeLogin).toBe(false);
        expect(account.json.kind).toBe('legacy');
        // Link intents are independent of the gate (service level; the route needs Discord config).
        const nat = await identityService.createNativePrincipal({ displayName: 'Nat' });
        await expect(nativeAuthService.beginLink({ principalId: nat.id, sessionId: 1 })).resolves.toHaveProperty('state');
    });
});

describe('operator gating', () => {
    test('admin routes need an active operator; the role comes from the actor', async () => {
        expect((await request({ reqPath: '/api/app/admin/invites' })).status).toBe(401);
        await identityService.ensureLegacyPrincipal({ discordId: SAM });
        await identityService.grantAccount({ principalId: SAM, entitlement: 'migration' });
        const member = (await devSession(SAM, 'sam')).cookie;
        const denied = await request({ reqPath: '/api/app/admin/invites', headers: { cookie: member } });
        expect(denied.status).toBe(403);
        expect(denied.json.error.code).toBe('FORBIDDEN');
        // No account at all (gate off) is also not an operator.
        const nobody = (await devSession('100000000000000009', 'nobody')).cookie;
        expect((await request({ reqPath: '/api/app/admin/accounts', headers: { cookie: nobody } })).status).toBe(403);
        const host = await operator();
        expect((await request({ reqPath: '/api/app/admin/invites', headers: { cookie: host } })).status).toBe(200);
        expect((await request({ reqPath: '/api/app/admin/identity/report', headers: { cookie: host } })).json).toHaveProperty('tables');
    });
});

describe('invitations', () => {
    test('issue, inspect, redeem once, then the link is dead and the roster shows the redemption', async () => {
        const host = await operator();
        const { token, invite: issued, url } = await invite(host, { role: 'member', note: 'for nat', ttlHours: 2 });
        expect(url).toMatch(/^\/app\/invite\?token=/);
        expect(issued).toMatchObject({ role: 'member', note: 'for nat', state: 'open', issuedBy: ROB });
        expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        // Only a hash is stored.
        const row = await db.get('SELECT tokenHash FROM account_invites WHERE id = @id', { id: issued.id });
        expect(row.tokenHash).not.toContain(token);

        const peek = await request({ reqPath: `/api/app/auth/invite/${token}` });
        expect(peek.status).toBe(200);
        expect(peek.json).toMatchObject({ role: 'member', installation: { id: identityConfig.installationId, name: identityConfig.installationName }, passwordMinLength: 15 });

        const { res, cookie } = await register(token, 'Nat', GOOD, { displayName: 'Nat Native' });
        expect(res.status).toBe(200);
        expect(res.json.user).toMatchObject({ loginName: 'nat', name: 'Nat Native' });
        expect(res.json.user.id).toMatch(/^usr_/);
        expect(cookie).toBeTruthy();

        const me = await request({ reqPath: '/api/app/me', headers: { cookie } });
        expect(me.status).toBe(200);
        expect(me.json.identity).toMatchObject({ account: { role: 'member', status: 'active', entitlement: 'invite' }, discordLinked: false, operator: false });
        expect(me.json.scopes.map(s => s.id)).toEqual([`dm:${res.json.user.id}`]);

        // Replay: dead link, no second account.
        expect((await request({ reqPath: `/api/app/auth/invite/${token}` })).json.error.code).toBe('INVITE_INVALID');
        const replay = await register(token, 'nat2');
        expect(replay.status ?? replay.res.status).toBe(404);
        expect(replay.res.json.error.code).toBe('INVITE_INVALID');
        expect((await identityService.listAccounts()).filter(a => a.entitlement === 'invite')).toHaveLength(1);

        const list = await request({ reqPath: '/api/app/admin/invites', headers: { cookie: host } });
        expect(list.json.invites[0]).toMatchObject({ id: issued.id, state: 'redeemed', consumedBy: res.json.user.id });
        // A redeemed invite cannot be revoked; an open one can, and then it is dead too.
        expect((await request({ method: 'DELETE', reqPath: `/api/app/admin/invites/${issued.id}`, headers: { cookie: host } })).json.error.code).toBe('INVITE_NOT_FOUND');
        const second = await invite(host);
        const revoked = await request({ method: 'DELETE', reqPath: `/api/app/admin/invites/${second.invite.id}`, headers: { cookie: host } });
        expect(revoked.json.invite.state).toBe('revoked');
        expect((await register(second.token, 'late')).res.json.error.code).toBe('INVITE_INVALID');
    });

    test('a race for one token admits exactly one person', async () => {
        const host = await operator();
        const { token } = await invite(host);
        const results = await Promise.all(
            ['racer1', 'racer2', 'racer3', 'racer4', 'racer5'].map(name => register(token, name))
        );
        const statuses = results.map(r => r.res.status).sort();
        expect(statuses).toEqual([200, 404, 404, 404, 404]);
        expect((await db.get('SELECT COUNT(*) AS c FROM app_accounts')).c).toBe(2); // host + one winner
        expect((await db.get('SELECT COUNT(*) AS c FROM password_credentials')).c).toBe(1);
    });

    test('a taken login name or weak password leaves the invitation open; operator invites carry the role', async () => {
        const host = await operator();
        const first = await invite(host);
        expect((await register(first.token, 'nat')).res.status).toBe(200);
        const second = await invite(host, { role: 'operator' });
        const taken = await register(second.token, 'NAT');
        expect(taken.res.status).toBe(409);
        expect(taken.res.json.error.code).toBe('LOGIN_NAME_TAKEN');
        const weak = await register(second.token, 'other', 'too short');
        expect(weak.res.json.error.code).toBe('WEAK_PASSWORD');
        expect((await nativeAuthService.inspectInvite(second.token)).role).toBe('operator');
        const ok = await register(second.token, 'other');
        expect(ok.res.status).toBe(200);
        const me = await request({ reqPath: '/api/app/me', headers: { cookie: ok.cookie } });
        expect(me.json.identity.operator).toBe(true);
        expect((await request({ reqPath: '/api/app/admin/invites', headers: { cookie: ok.cookie } })).status).toBe(200);
    });

    test('expired invitations are invalid for inspect and redeem alike', async () => {
        const host = await operator();
        const { token, invite: issued } = await invite(host);
        await db.run(`UPDATE account_invites SET expiresAt = '2000-01-01 00:00:00' WHERE id = @id`, { id: issued.id });
        expect((await request({ reqPath: `/api/app/auth/invite/${token}` })).json.error.code).toBe('INVITE_INVALID');
        expect((await register(token, 'late')).res.json.error.code).toBe('INVITE_INVALID');
        expect((await nativeAuthService.listInvites())[0].state).toBe('expired');
    });
});

describe('login', () => {
    test('neutral errors, disabled only after a correct password, and a fresh session on success', async () => {
        const host = await operator();
        const { token } = await invite(host);
        const { res } = await register(token, 'nat');
        const principalId = res.json.user.id;

        const wrong = await login('nat', 'not the password at all');
        const unknown = await login('nobody', GOOD);
        expect(wrong.res.status).toBe(401);
        expect(unknown.res.status).toBe(401);
        expect(wrong.res.json.error).toEqual(unknown.res.json.error);
        expect(wrong.cookie).toBeNull();

        const ok = await login('NAT', GOOD);
        expect(ok.res.status).toBe(200);
        expect(ok.res.json.user).toMatchObject({ id: principalId, loginName: 'nat' });
        const me = await request({ reqPath: '/api/app/me', headers: { cookie: ok.cookie } });
        expect(me.json.user.id).toBe(principalId);
        const account = await request({ reqPath: '/api/app/account', headers: { cookie: ok.cookie } });
        expect(account.json).toMatchObject({ kind: 'native', hasPassword: true, recentAuth: true, account: { loginName: 'nat' }, discord: { linked: false, canConnect: true, canDisconnect: false } });

        await identityService.setAccountStatus(principalId, 'disabled');
        const disabled = await login('nat', GOOD);
        expect(disabled.res.json.error.code).toBe('ACCOUNT_DISABLED');
        // Disabling also killed the earlier session.
        expect((await request({ reqPath: '/api/app/me', headers: { cookie: ok.cookie } })).status).toBe(401);
    });

    test('ten failures throttle a login name for the window; a success clears it', async () => {
        const host = await operator();
        const { token } = await invite(host);
        await register(token, 'nat');
        for (let i = 0; i < 10; i += 1) {
            expect((await login('nat', `wrong ${i} wrong wrong wrong`)).res.status).toBe(401);
        }
        const blocked = await login('nat', GOOD);
        expect(blocked.res.status).toBe(429);
        expect(blocked.res.json.error.code).toBe('TOO_MANY_ATTEMPTS');
        await db.run(`DELETE FROM web_rate_events WHERE scope = 'native_login_name'`);
        expect((await login('nat', GOOD)).res.status).toBe(200);
        // The correct password cleared the name's bucket: further attempts start fresh.
        expect((await db.get(`SELECT COUNT(*) AS c FROM web_rate_events WHERE scope = 'native_login_name'`)).c).toBe(0);
        // Per-address throttle is tracked separately.
        expect((await db.get(`SELECT COUNT(*) AS c FROM web_rate_events WHERE scope = 'native_login_addr'`)).c).toBeGreaterThan(0);
    });

    test('a cross-origin POST is refused before it reaches the handler', async () => {
        const res = await request({ method: 'POST', reqPath: '/api/app/auth/native-login', headers: { origin: 'https://evil.example' }, body: { loginName: 'x', password: 'y' } });
        expect(res.status).toBe(403);
        expect(res.json.error.code).toBe('BAD_ORIGIN');
        const ok = await request({ method: 'POST', reqPath: '/api/app/auth/native-login', headers: { origin: `http://127.0.0.1:${port}` }, body: { loginName: 'x', password: 'y' } });
        expect(ok.status).toBe(401);
    });
});

describe('credentials and re-auth', () => {
    test('a Discord-only account enrols a login name and password with a recent authentication', async () => {
        await identityService.ensureLegacyPrincipal({ discordId: SAM, displayName: 'Sam' });
        const noAccount = (await devSession(SAM, 'sam')).cookie;
        const refused = await request({ method: 'PUT', reqPath: '/api/app/account/credentials', headers: { cookie: noAccount }, body: { loginName: 'sam', newPassword: GOOD } });
        expect(refused.json.error.code).toBe('NO_ACCOUNT');

        await identityService.grantAccount({ principalId: SAM, entitlement: 'migration' });
        const cookie = (await devSession(SAM, 'sam')).cookie;
        await ageSession(cookie);
        const stale = await request({ method: 'PUT', reqPath: '/api/app/account/credentials', headers: { cookie }, body: { loginName: 'sam', newPassword: GOOD } });
        expect(stale.status).toBe(403);
        expect(stale.json.error.code).toBe('REAUTH_REQUIRED');
        // No password yet, so re-auth by password is impossible: sign in again.
        expect((await request({ method: 'POST', reqPath: '/api/app/auth/reauth', headers: { cookie }, body: { password: GOOD } })).json.error.code).toBe('BAD_CREDENTIALS');

        const fresh = (await devSession(SAM, 'sam')).cookie;
        expect((await request({ method: 'PUT', reqPath: '/api/app/account/credentials', headers: { cookie: fresh }, body: { newPassword: GOOD } })).json.error.code).toBe('LOGIN_NAME_REQUIRED');
        const ok = await request({ method: 'PUT', reqPath: '/api/app/account/credentials', headers: { cookie: fresh }, body: { loginName: 'Sam', newPassword: GOOD } });
        expect(ok.status).toBe(200);
        expect(ok.json.loginName).toBe('sam');

        const summary = await request({ reqPath: '/api/app/account', headers: { cookie: fresh } });
        expect(summary.json).toMatchObject({ kind: 'legacy', hasPassword: true, account: { loginName: 'sam' }, discord: { linked: true, subject: SAM, canDisconnect: false, canConnect: false } });
        // ...and now signs in natively as the same principal.
        const native = await login('sam', GOOD);
        expect(native.res.json.user.id).toBe(SAM);
        expect((await request({ reqPath: '/api/app/me', headers: { cookie: native.cookie } })).json.identity.discordLinked).toBe(true);
    });

    test('changing a password needs the current one; re-auth reopens the window on a stale session', async () => {
        const host = await operator();
        const { token } = await invite(host);
        const { cookie } = await register(token, 'nat');
        const wrong = await request({ method: 'PUT', reqPath: '/api/app/account/credentials', headers: { cookie }, body: { currentPassword: 'nope nope nope nope', newPassword: `${GOOD} v2` } });
        expect(wrong.json.error.code).toBe('BAD_CREDENTIALS');
        const missing = await request({ method: 'PUT', reqPath: '/api/app/account/credentials', headers: { cookie }, body: { newPassword: `${GOOD} v2` } });
        expect(missing.json.error.code).toBe('BAD_CREDENTIALS');
        const ok = await request({ method: 'PUT', reqPath: '/api/app/account/credentials', headers: { cookie }, body: { currentPassword: GOOD, newPassword: `${GOOD} v2`, loginName: 'nat.renamed' } });
        expect(ok.status).toBe(200);
        expect((await login('nat', GOOD)).res.status).toBe(401);
        expect((await login('nat.renamed', `${GOOD} v2`)).res.status).toBe(200);

        await ageSession(cookie);
        expect((await request({ reqPath: '/api/app/account', headers: { cookie } })).json.recentAuth).toBe(false);
        const denied = await request({ method: 'DELETE', reqPath: '/api/app/account/identities/discord', headers: { cookie } });
        expect(denied.json.error.code).toBe('REAUTH_REQUIRED');
        const reauth = await request({ method: 'POST', reqPath: '/api/app/auth/reauth', headers: { cookie }, body: { password: `${GOOD} v2` } });
        expect(reauth.status).toBe(200);
        expect((await request({ reqPath: '/api/app/account', headers: { cookie } })).json.recentAuth).toBe(true);
        expect((await request({ method: 'DELETE', reqPath: '/api/app/account/identities/discord', headers: { cookie } })).json.error.code).toBe('NOT_LINKED');
    });

    test('the login-name uniqueness holds across enrollment and rename', async () => {
        const host = await operator();
        const { token } = await invite(host);
        await register(token, 'nat');
        const hostRename = await request({ method: 'PUT', reqPath: '/api/app/account/credentials', headers: { cookie: host }, body: { loginName: 'nat', newPassword: GOOD } });
        expect(hostRename.json.error.code).toBe('LOGIN_NAME_TAKEN');
    });
});

describe('recovery and revocation', () => {
    test('an operator-issued reset is single-use, revokes every session, and rotates the credential', async () => {
        const host = await operator();
        const { token } = await invite(host);
        const { res, cookie: oldCookie } = await register(token, 'nat');
        const principalId = res.json.user.id;
        const other = await login('nat', GOOD);

        const denied = await request({ method: 'POST', reqPath: `/api/app/admin/accounts/${principalId}/recovery`, headers: { cookie: other.cookie } });
        expect(denied.status).toBe(403);
        const issued = await request({ method: 'POST', reqPath: `/api/app/admin/accounts/${principalId}/recovery`, headers: { cookie: host } });
        expect(issued.status).toBe(200);
        expect(issued.json.loginName).toBe('nat');
        const reset = new URL(issued.json.url, 'http://x').searchParams.get('token');
        const audit = await db.get('SELECT issuedBy, purpose FROM recovery_tokens');
        expect(audit).toEqual({ issuedBy: ROB, purpose: 'password_reset' });

        const weak = await request({ method: 'POST', reqPath: '/api/app/auth/recover', body: { token: reset, password: 'short' } });
        expect(weak.json.error.code).toBe('WEAK_PASSWORD');
        const done = await request({ method: 'POST', reqPath: '/api/app/auth/recover', body: { token: reset, password: `${GOOD} reset` } });
        expect(done.status).toBe(200);
        const newCookie = sessionCookie(done);
        expect(newCookie).toBeTruthy();

        // Old sessions are gone; the old password is gone; the token is spent.
        expect((await request({ reqPath: '/api/app/me', headers: { cookie: oldCookie } })).status).toBe(401);
        expect((await request({ reqPath: '/api/app/me', headers: { cookie: other.cookie } })).status).toBe(401);
        expect((await request({ reqPath: '/api/app/me', headers: { cookie: newCookie } })).status).toBe(200);
        expect((await login('nat', GOOD)).res.status).toBe(401);
        expect((await login('nat', `${GOOD} reset`)).res.status).toBe(200);
        const replay = await request({ method: 'POST', reqPath: '/api/app/auth/recover', body: { token: reset, password: `${GOOD} again` } });
        expect(replay.json.error.code).toBe('RECOVERY_INVALID');
        expect((await identityService.getAccount(principalId))).toMatchObject({ credentialVersion: 2, sessionVersion: 2 });
    });

    test('a session minted before a version bump is refused and its cookie cleared', async () => {
        const host = await operator();
        const { token } = await invite(host);
        const { res, cookie } = await register(token, 'nat');
        const session = await webSessionService.get(cookie.split('=')[1]);
        expect(session.sessionVersion).toBe(1);
        expect(session.authenticatedAt).toBeTruthy();
        await db.run('UPDATE app_accounts SET sessionVersion = sessionVersion + 1 WHERE principalId = @id', { id: res.json.user.id });
        const revoked = await request({ reqPath: '/api/app/me', headers: { cookie } });
        expect(revoked.status).toBe(401);
        expect(revoked.json.error.code).toBe('SESSION_REVOKED');
        expect(sessionCookie(revoked)).toBe('');
        expect((await request({ reqPath: '/api/app/me', headers: { cookie } })).json.error.code).toBe('UNAUTHENTICATED');
        // Logging in again snapshots the new version.
        const again = await login('nat', GOOD);
        expect((await webSessionService.get(again.cookie.split('=')[1])).sessionVersion).toBe(2);
    });

    test('recovery for a Discord-only account also lets the person pick a login name', async () => {
        const host = await operator();
        await identityService.ensureLegacyPrincipal({ discordId: SAM, displayName: 'Sam' });
        await identityService.grantAccount({ principalId: SAM, entitlement: 'migration' });
        const issued = await request({ method: 'POST', reqPath: `/api/app/admin/accounts/${SAM}/recovery`, headers: { cookie: host } });
        expect(issued.json.loginName).toBeNull();
        const reset = new URL(issued.json.url, 'http://x').searchParams.get('token');
        expect((await request({ method: 'POST', reqPath: '/api/app/auth/recover', body: { token: reset, password: GOOD } })).json.error.code).toBe('LOGIN_NAME_REQUIRED');
        const done = await request({ method: 'POST', reqPath: '/api/app/auth/recover', body: { token: reset, password: GOOD, loginName: 'sam' } });
        expect(done.status).toBe(200);
        expect(done.json.user.id).toBe(SAM);
        expect((await login('sam', GOOD)).res.json.user.id).toBe(SAM);
        // No account -> no recovery.
        await identityService.ensureLegacyPrincipal({ discordId: '100000000000000003' });
        expect((await request({ method: 'POST', reqPath: '/api/app/admin/accounts/100000000000000003/recovery', headers: { cookie: host } })).json.error.code).toBe('ACCOUNT_NOT_FOUND');
    });
});

describe('Discord linking', () => {
    test('link intents are bound to the principal and session, single-use, and time-limited', async () => {
        const nat = await identityService.createNativePrincipal({ displayName: 'Nat' });
        const { state } = await nativeAuthService.beginLink({ principalId: nat.id, sessionId: 7 });
        expect(await nativeAuthService.takeLink({ state: 'not-a-state', principalId: nat.id, sessionId: 7 })).toBeNull();
        await expect(nativeAuthService.takeLink({ state, principalId: nat.id, sessionId: 8 })).rejects.toMatchObject({ code: 'LINK_SESSION_MISMATCH' });
        // Consumed by the failed attempt: replay is a plain login now.
        expect(await nativeAuthService.takeLink({ state, principalId: nat.id, sessionId: 7 })).toBeNull();

        const good = await nativeAuthService.beginLink({ principalId: nat.id, sessionId: 7 });
        expect(await nativeAuthService.takeLink({ state: good.state, principalId: nat.id, sessionId: 7 })).toEqual({ principalId: nat.id, provider: 'discord' });

        const late = await nativeAuthService.beginLink({ principalId: nat.id, sessionId: 7 });
        await db.run(`UPDATE oauth_link_states SET expiresAt = '2000-01-01 00:00:00'`);
        await expect(nativeAuthService.takeLink({ state: late.state, principalId: nat.id, sessionId: 7 })).rejects.toMatchObject({ code: 'LINK_EXPIRED' });

        await identityService.ensureLegacyPrincipal({ discordId: ROB });
        await expect(nativeAuthService.beginLink({ principalId: ROB, sessionId: 1 })).rejects.toMatchObject({ code: 'LEGACY_IDENTITY' });
    });

    test('linking refuses a Discord identity that belongs to someone else (no silent merges)', async () => {
        await identityService.ensureLegacyPrincipal({ discordId: ROB });
        const nat = await identityService.createNativePrincipal({ displayName: 'Nat' });
        await expect(identityService.linkExternal({ principalId: nat.id, provider: 'discord', subject: ROB }))
            .rejects.toMatchObject({ code: 'IDENTITY_CONFLICT', status: 409 });
        await identityService.linkExternal({ principalId: nat.id, provider: 'discord', subject: SAM });
        expect(await identityService.resolveExternal({ provider: 'discord', subject: SAM })).toBe(nat.id);
    });

    test('the connect route needs recent auth and a configured Discord login', async () => {
        const nat = await identityService.createNativePrincipal({ displayName: 'Nat' });
        const { cookie } = await devSession(nat.id, 'Nat');
        const res = await request({ reqPath: '/api/app/auth/link/discord', headers: { cookie } });
        expect(res.status).toBe(503);
        expect(res.json.error.code).toBe('LOGIN_UNAVAILABLE');
        await ageSession(cookie);
        expect((await request({ reqPath: '/api/app/auth/link/discord', headers: { cookie } })).json.error.code).toBe('REAUTH_REQUIRED');
    });

    test('disconnect requires a working native sign-in and is impossible for legacy principals', async () => {
        const host = await operator();
        const nat = await identityService.createNativePrincipal({ displayName: 'Nat' });
        await identityService.grantAccount({ principalId: nat.id, entitlement: 'invite' });
        await identityService.linkExternal({ principalId: nat.id, provider: 'discord', subject: SAM });
        const { cookie } = await devSession(nat.id, 'Nat');

        const summary = await request({ reqPath: '/api/app/account', headers: { cookie } });
        expect(summary.json.discord).toMatchObject({ linked: true, subject: SAM, canDisconnect: false, canConnect: false });
        const refused = await request({ method: 'DELETE', reqPath: '/api/app/account/identities/discord', headers: { cookie } });
        expect(refused.json.error.code).toBe('LAST_SIGN_IN_METHOD');

        await request({ method: 'PUT', reqPath: '/api/app/account/credentials', headers: { cookie }, body: { loginName: 'nat', newPassword: GOOD } });
        expect((await request({ reqPath: '/api/app/account', headers: { cookie } })).json.discord.canDisconnect).toBe(true);
        const ok = await request({ method: 'DELETE', reqPath: '/api/app/account/identities/discord', headers: { cookie } });
        expect(ok.status).toBe(200);
        expect((await request({ reqPath: '/api/app/account', headers: { cookie } })).json.discord).toMatchObject({ linked: false, canConnect: true });
        expect((await request({ reqPath: '/api/app/me', headers: { cookie } })).json.identity.discordLinked).toBe(false);
        expect(await identityService.resolveExternal({ provider: 'discord', subject: SAM })).toBeNull();
        expect((await request({ method: 'DELETE', reqPath: '/api/app/account/identities/github', headers: { cookie } })).json.error.code).toBe('BAD_PROVIDER');

        const legacy = await request({ method: 'DELETE', reqPath: '/api/app/account/identities/discord', headers: { cookie: host } });
        expect(legacy.status).toBe(409);
        expect(legacy.json.error.code).toBe('LAST_SIGN_IN_METHOD');
        await request({ method: 'PUT', reqPath: '/api/app/account/credentials', headers: { cookie: host }, body: { loginName: 'host', newPassword: GOOD } });
        expect((await request({ method: 'DELETE', reqPath: '/api/app/account/identities/discord', headers: { cookie: host } })).json.error.code).toBe('LEGACY_IDENTITY');
    });
});

describe('operator roster', () => {
    test('list, grant migration, disable/enable, promote - never yourself out', async () => {
        const host = await operator();
        await identityService.ensureLegacyPrincipal({ discordId: SAM, displayName: 'Sam' });
        const granted = await request({ method: 'POST', reqPath: '/api/app/admin/accounts', headers: { cookie: host }, body: { principalId: SAM } });
        expect(granted.json).toMatchObject({ created: true, account: { entitlement: 'migration', role: 'member' } });
        expect((await request({ method: 'POST', reqPath: '/api/app/admin/accounts', headers: { cookie: host }, body: { principalId: 'bob' } })).json.error.code).toBe('BAD_PRINCIPAL');

        const roster = await request({ reqPath: '/api/app/admin/accounts', headers: { cookie: host } });
        expect(roster.json.accounts.map(a => [a.principalId, a.role, a.discordLinked, a.hasPassword])).toEqual([
            [ROB, 'operator', true, false],
            [SAM, 'member', true, false]
        ]);

        const sam = (await devSession(SAM, 'sam')).cookie;
        const disabled = await request({ method: 'PATCH', reqPath: `/api/app/admin/accounts/${SAM}`, headers: { cookie: host }, body: { status: 'disabled' } });
        expect(disabled.json.account.status).toBe('disabled');
        expect((await request({ reqPath: '/api/app/me', headers: { cookie: sam } })).status).toBe(401);
        expect((await devSession(SAM, 'sam')).res.status).toBe(200);
        expect((await request({ reqPath: '/api/app/me', headers: { cookie: (await devSession(SAM, 'sam')).cookie } })).json.error.code).toBe('ACCOUNT_DISABLED');
        await request({ method: 'PATCH', reqPath: `/api/app/admin/accounts/${SAM}`, headers: { cookie: host }, body: { status: 'active', role: 'operator' } });
        expect(await identityService.getAccount(SAM)).toMatchObject({ status: 'active', role: 'operator' });

        expect((await request({ method: 'PATCH', reqPath: `/api/app/admin/accounts/${ROB}`, headers: { cookie: host }, body: { status: 'disabled' } })).json.error.code).toBe('SELF_LOCKOUT');
        expect((await request({ method: 'PATCH', reqPath: `/api/app/admin/accounts/${ROB}`, headers: { cookie: host }, body: { role: 'member' } })).json.error.code).toBe('SELF_LOCKOUT');
        expect((await request({ method: 'PATCH', reqPath: `/api/app/admin/accounts/${ROB}`, headers: { cookie: host }, body: {} })).json.error.code).toBe('NOTHING_TO_CHANGE');
        expect((await request({ method: 'PATCH', reqPath: '/api/app/admin/accounts/usr_00000000-0000-4000-8000-000000000000', headers: { cookie: host }, body: { role: 'member' } })).json.error.code).toBe('ACCOUNT_NOT_FOUND');
    });
});

describe('privacy', () => {
    test('/forget-me removes credentials, tokens, link intents, and issued invitations; audits clean', async () => {
        const host = await operator();
        const { token } = await invite(host);
        const { res, cookie } = await register(token, 'nat');
        const principalId = res.json.user.id;
        // Nat becomes an operator, issues an invite, has a reset pending and a link intent open.
        await identityService.setAccountRole(principalId, 'operator');
        await invite(cookie);
        await nativeAuthService.issueRecovery({ principalId, issuedBy: ROB });
        await nativeAuthService.beginLink({ principalId, sessionId: 1 });

        const report = await privacyService.buildUserReport({ userId: principalId, guildId: `dm:${principalId}` });
        expect(report.identity.nativeSignIn).toMatchObject({ hasPassword: true, openRecoveryLinks: 1, invitesIssued: 1 });
        expect(report.identity.nativeSignIn.joinedByInviteAt).toBeTruthy();
        const before = await privacyService.auditUser({ userId: principalId });
        expect(before.byTable).toMatchObject({ password_credentials: 1, recovery_tokens: 1, oauth_link_states: 1, account_invites: 2, app_accounts: 1 });

        const result = await privacyService.forgetUser({ userId: principalId });
        expect(result).toMatchObject({ passwordCredentials: 1, recoveryTokens: 1, oauthLinkStates: 1, accountInvites: 1, principals: 1 });
        const after = await privacyService.auditUser({ userId: principalId });
        expect(after.total).toBe(0);
        // The host's redeemed invite survives as an audit row, minus the link to Nat.
        const hostInvite = await db.get('SELECT consumedAt, consumedBy FROM account_invites WHERE issuedBy = @host', { host: ROB });
        expect(hostInvite.consumedAt).toBeTruthy();
        expect(hostInvite.consumedBy).toBeNull();
        expect((await login('nat', GOOD)).res.status).toBe(401);
        expect((await request({ reqPath: '/api/app/me', headers: { cookie } })).status).toBe(401);
    });
});
