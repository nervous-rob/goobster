/**
 * Email-backed authentication (shared-instance Increment B.1): the mail
 * seam, a verified address per account, signing in by email, self-service
 * password recovery, open sign-up with verification before anything is an
 * account, the neutral-response and throttling posture, the operator's
 * installation panel, and the privacy paths for the new tables.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-email-auth-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const identityService = require('@goobster/core/services/identityService');
const identityConfig = require('@goobster/core/config/identityConfig');
const nativeAuthService = require('@goobster/core/services/nativeAuthService');
const mailService = require('@goobster/core/services/mailService');
const { MailService, MailError, normalizeEmail } = mailService;
const privacyService = require('@goobster/core/services/privacyService');
const eventBusService = require('@goobster/core/services/eventBusService');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');

const ROB = '100000000000000001';
const SAM = '100000000000000002';
const GOOD = 'a long enough passphrase 42';
const PUBLIC_URL = 'http://portal.test';
const TABLES = ['web_sessions', 'web_rate_events', 'password_credentials', 'recovery_tokens', 'oauth_link_states',
    'account_invites', 'email_tokens', 'account_emails', 'pending_registrations', 'auth_identities', 'app_accounts',
    'principals', 'users'];

let server;
let port;
/** Every message the fake transport accepted, oldest first. */
let outbox = [];

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

/** A legacy Discord member with an account and a live session. */
async function member(id = SAM) {
    await identityService.ensureLegacyPrincipal({ discordId: id, displayName: 'sam' });
    await identityService.grantAccount({ principalId: id, entitlement: 'migration' });
    const { cookie } = await devSession(id, 'sam');
    return cookie;
}

async function login(loginName, password, headers = {}) {
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/native-login', headers, body: { loginName, password } });
    return { res, cookie: sessionCookie(res) };
}

async function signup(body, headers = {}) {
    return request({ method: 'POST', reqPath: '/api/app/auth/signup', headers, body: { password: GOOD, ...body } });
}

/** Pull the ?token= out of the last message sent to `to`. */
function tokenMailedTo(to, pathPart) {
    const message = [...outbox].reverse().find(m => m.to.toLowerCase() === to.toLowerCase() && m.text.includes(pathPart));
    if (!message) return null;
    const match = message.text.match(/https?:\/\/\S+\?token=([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
}

async function verify(token) {
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/verify-email', body: { token } });
    return { res, cookie: sessionCookie(res) };
}

/** Run a complete open sign-up and return the session and principal id. */
async function openSignup(loginName, email, extra = {}) {
    const res = await signup({ loginName, email, ...extra });
    expect(res.status).toBe(200);
    const token = tokenMailedTo(email, '/app/verify-email');
    expect(token).toBeTruthy();
    const verified = await verify(token);
    expect(verified.res.status).toBe(200);
    return { cookie: verified.cookie, principalId: verified.res.json.user.id, token };
}

beforeAll((done) => {
    const ctx = createWebAppContext({
        client: { user: { id: '9', username: 'Goobster' }, guilds: { cache: new Map() } },
        config: { clientId: '123', webapp: { enabled: true, devMode: true, publicUrl: PUBLIC_URL } },
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
    mailService.setTransport(null);
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
    identityConfig.registration = 'open';
    // Cheap scrypt (4 MiB) so this suite does not starve its Jest neighbours.
    identityConfig.passwordCostLog2 = 12;
    identityConfig.passwordMinLength = 15;
    outbox = [];
    mailService.setTransport(async (message) => { outbox.push(message); });
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`);
});

describe('mail seam', () => {
    test('addresses normalise to a lower-cased lookup form and junk is refused', () => {
        expect(normalizeEmail('  Nat.Person+tag@Example.ORG ')).toBe('nat.person+tag@example.org');
        expect(normalizeEmail('nobody')).toBeNull();
        expect(normalizeEmail('two@@example.org')).toBeNull();
        expect(normalizeEmail('spaced out@example.org')).toBeNull();
        expect(normalizeEmail(`${'a'.repeat(250)}@x.org`)).toBeNull();
        expect(normalizeEmail(null)).toBeNull();
    });

    test('with nothing configured mail is off and says why; a bad address is refused first', async () => {
        const off = new MailService({ config: { enabled: false, disabledReason: 'No mail provider is configured.', resolvedProvider: null, from: '' } });
        expect(off.enabled).toBe(false);
        expect(off.describe()).toEqual({ enabled: false, provider: null, from: null, reason: 'No mail provider is configured.' });
        await expect(off.send({ to: 'not-an-address', subject: 'x', text: 'y' }))
            .rejects.toMatchObject({ code: 'BAD_EMAIL', status: 400 });
        await expect(off.send({ to: 'a@b.co', subject: 'x', text: 'y' }))
            .rejects.toMatchObject({ code: 'MAIL_DISABLED', status: 503 });
    });

    test('the Resend adapter posts one message with the bearer key; failures are wrapped without leaking the body', async () => {
        const calls = [];
        const logs = [];
        const config = {
            enabled: true, disabledReason: null, resolvedProvider: 'resend',
            from: 'Goobster <bot@example.org>', replyTo: 'host@example.org', timeoutMs: 1234,
            resend: { apiKey: 're_secret' }
        };
        const svc = new MailService({
            config,
            logger: { warn: (line) => logs.push(line) },
            post: async (url, body, opts) => { calls.push({ url, body, opts }); }
        });
        expect(svc.describe()).toEqual({ enabled: true, provider: 'resend', from: 'Goobster <bot@example.org>', reason: null });
        await svc.send({ to: 'Nat@example.org', subject: 'Hello', text: 'SECRET-LINK' });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://api.resend.com/emails');
        expect(calls[0].body).toEqual({
            from: 'Goobster <bot@example.org>', to: ['Nat@example.org'], subject: 'Hello', text: 'SECRET-LINK', reply_to: 'host@example.org'
        });
        expect(calls[0].opts.headers.Authorization).toBe('Bearer re_secret');
        expect(calls[0].opts.timeout).toBe(1234);

        const failing = new MailService({
            config,
            logger: { warn: (line) => logs.push(line) },
            post: async () => { const e = new Error('nope'); e.response = { status: 422, data: { message: 'invalid from' } }; throw e; }
        });
        await expect(failing.send({ to: 'nat@example.org', subject: 'x', text: 'SECRET-LINK' }))
            .rejects.toMatchObject({ code: 'MAIL_FAILED', status: 502 });
        expect(logs.some(line => line.includes('resend') && line.includes('422') && line.includes('invalid from'))).toBe(true);
        expect(logs.some(line => line.includes('SECRET-LINK') || line.includes('nat@example.org'))).toBe(false);
    });

    test('the SMTP adapter builds one transport from the URL or the discrete fields and reuses it', async () => {
        const built = [];
        const sent = [];
        const createSmtp = (config) => {
            built.push(config.smtp);
            return { sendMail: async (message) => { sent.push(message); } };
        };
        const svc = new MailService({
            config: {
                enabled: true, disabledReason: null, resolvedProvider: 'smtp', from: 'bot@example.org', replyTo: '', timeoutMs: 5000,
                smtp: { url: 'smtp://user:pass@mail.example.org:587', host: '', port: 587, secure: false, user: '', pass: '' }
            },
            createSmtp
        });
        await svc.send({ to: 'a@example.org', subject: 'one', text: 'first' });
        await svc.send({ to: 'b@example.org', subject: 'two', text: 'second' });
        expect(built).toHaveLength(1);
        expect(sent.map(m => [m.to, m.subject, m.from, m.replyTo])).toEqual([
            ['a@example.org', 'one', 'bot@example.org', undefined],
            ['b@example.org', 'two', 'bot@example.org', undefined]
        ]);
        expect(sent[0]).not.toHaveProperty('html');
    });

    test('a custom transport counts as enabled and is reported as such', () => {
        expect(mailService.enabled).toBe(true);
        expect(mailService.describe()).toMatchObject({ enabled: true, provider: 'custom', reason: null });
        mailService.setTransport(null);
        expect(mailService.enabled).toBe(false);
        expect(mailService.describe().reason).toBeTruthy();
    });

    test('MailError carries the status and code the routes need', () => {
        const error = new MailError(502, 'MAIL_FAILED', 'x');
        expect(error).toMatchObject({ name: 'MailError', status: 502, code: 'MAIL_FAILED', message: 'x' });
        expect(error instanceof Error).toBe(true);
    });
});

describe('what the client is told', () => {
    test('config and /me expose the effective registration mode and whether email flows exist', async () => {
        let config = await request({ reqPath: '/api/app/config' });
        expect(config.json).toMatchObject({ nativeLogin: true, registration: 'open', emailRecovery: true });

        identityConfig.registration = 'invite';
        config = await request({ reqPath: '/api/app/config' });
        expect(config.json).toMatchObject({ registration: 'invite', emailRecovery: true });

        // Open sign-up is requested but nothing can send the verification:
        // the effective mode falls back to invitations.
        identityConfig.registration = 'open';
        mailService.setTransport(null);
        config = await request({ reqPath: '/api/app/config' });
        expect(config.json).toMatchObject({ registration: 'invite', emailRecovery: false });
        expect(nativeAuthService.emailDisabledReason(PUBLIC_URL)).toMatch(/mail provider/i);

        mailService.setTransport(async () => {});
        expect(nativeAuthService.emailDisabledReason(null)).toMatch(/publicUrl/);
        expect(nativeAuthService.registrationMode(null)).toBe('invite');
        const host = await operator();
        const me = await request({ reqPath: '/api/app/me', headers: { cookie: host } });
        expect(me.json.identity).toMatchObject({ registration: 'open', mail: true, operator: true });
    });

    test('the release gate closes everything email-backed too', async () => {
        identityConfig.nativeLogin = false;
        expect((await signup({ loginName: 'someone', email: 'someone@example.org' })).status).toBe(503);
        expect((await request({ method: 'POST', reqPath: '/api/app/auth/forgot', body: { email: 'someone@example.org' } })).status).toBe(503);
        expect((await verify('anything')).res.status).toBe(503);
        expect((await request({ reqPath: '/api/app/config' })).json).toMatchObject({ registration: 'invite', emailRecovery: false });
    });
});

describe('open sign-up', () => {
    test('nothing is an account until the link is followed; then it is, with the open entitlement and a session', async () => {
        const res = await signup({ loginName: 'Newcomer', email: 'New.Comer@Example.org', displayName: 'Newt' });
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ ok: true });
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({ to: 'New.Comer@Example.org' });
        expect(outbox[0].subject).toMatch(/finish creating your account/);
        expect(outbox[0].text).toContain(`${PUBLIC_URL}/app/verify-email?token=`);
        expect(outbox[0].text).toContain('login name: newcomer');

        expect(await db.get('SELECT COUNT(*) AS c FROM principals')).toEqual({ c: 0 });
        expect(await db.get('SELECT COUNT(*) AS c FROM app_accounts')).toEqual({ c: 0 });
        expect(await db.get('SELECT loginName, displayName, emailNormalized FROM pending_registrations'))
            .toEqual({ loginName: 'newcomer', displayName: 'Newt', emailNormalized: 'new.comer@example.org' });
        // The password can be set before the address is proven, but not used.
        expect((await login('newcomer', GOOD)).res.status).toBe(401);
        expect((await login('new.comer@example.org', GOOD)).res.status).toBe(401);

        const token = tokenMailedTo('New.Comer@Example.org', '/app/verify-email');
        const verified = await verify(token);
        expect(verified.res.status).toBe(200);
        expect(verified.res.json).toMatchObject({ kind: 'registration', user: { name: 'Newt', loginName: 'newcomer' } });
        expect(verified.cookie).toBeTruthy();
        const principalId = verified.res.json.user.id;
        expect(identityService.isNativeId(principalId)).toBe(true);

        const me = await request({ reqPath: '/api/app/me', headers: { cookie: verified.cookie } });
        expect(me.status).toBe(200);
        expect(me.json.identity.account).toEqual({ role: 'member', status: 'active', entitlement: 'open' });
        expect(await db.get('SELECT COUNT(*) AS c FROM pending_registrations')).toEqual({ c: 0 });
        expect(await nativeAuthService.getEmail(principalId)).toMatchObject({ address: 'New.Comer@Example.org', normalized: 'new.comer@example.org' });
        expect((await nativeAuthService.getEmail(principalId)).verifiedAt).toBeTruthy();

        // The link is dead; both identifiers now sign in.
        expect((await verify(token)).res.status).toBe(404);
        expect((await login('newcomer', GOOD)).res.status).toBe(200);
        expect((await login('  NEW.comer@example.ORG ', GOOD)).res.status).toBe(200);
        expect((await login('new.comer@example.org', 'wrong wrong wrong wrong')).res.status).toBe(401);
    });

    test('policy applies before anything is parked: login name, password, address, and closed registration', async () => {
        expect((await signup({ loginName: 'ab', email: 'x@example.org' })).json.error.code).toBe('BAD_LOGIN_NAME');
        expect((await signup({ loginName: 'fine', email: 'x@example.org', password: 'short' })).json.error.code).toBe('WEAK_PASSWORD');
        expect((await signup({ loginName: 'fine', email: 'not-mail' })).json.error.code).toBe('BAD_EMAIL');
        expect(outbox).toHaveLength(0);
        expect(await db.get('SELECT COUNT(*) AS c FROM pending_registrations')).toEqual({ c: 0 });

        identityConfig.registration = 'invite';
        const closed = await signup({ loginName: 'fine', email: 'x@example.org' });
        expect(closed.status).toBe(403);
        expect(closed.json.error.code).toBe('REGISTRATION_CLOSED');
    });

    test('a taken login name is refused openly; a taken address is not revealed but the owner is told', async () => {
        const { principalId } = await openSignup('first', 'first@example.org');
        outbox = [];

        const taken = await signup({ loginName: 'first', email: 'other@example.org' });
        expect(taken.status).toBe(409);
        expect(taken.json.error.code).toBe('LOGIN_NAME_TAKEN');

        // Same address, different name: same 200 as a fresh sign-up, but
        // the mail goes to the existing owner and nothing is parked.
        const dup = await signup({ loginName: 'second', email: 'FIRST@example.org' });
        expect(dup.status).toBe(200);
        expect(dup.json).toEqual({ ok: true });
        expect(outbox).toHaveLength(1);
        expect(outbox[0].subject).toMatch(/already have an account/);
        expect(outbox[0].text).toContain('login name: first');
        expect(outbox[0].text).toContain(`${PUBLIC_URL}/app/forgot`);
        expect(await db.get('SELECT COUNT(*) AS c FROM pending_registrations')).toEqual({ c: 0 });
        expect(await identityService.getAccount(principalId)).toMatchObject({ loginName: 'first' });
    });

    test('signing up again with the same address replaces the earlier attempt; a pending name is reserved', async () => {
        await signup({ loginName: 'draft1', email: 'nat@example.org' });
        const firstToken = tokenMailedTo('nat@example.org', '/app/verify-email');
        await signup({ loginName: 'draft2', email: 'nat@example.org' });
        const secondToken = tokenMailedTo('nat@example.org', '/app/verify-email');
        expect(secondToken).not.toBe(firstToken);
        expect(await db.get('SELECT COUNT(*) AS c FROM pending_registrations')).toEqual({ c: 1 });

        // Somebody else cannot grab the name that is waiting on nat.
        const reserved = await signup({ loginName: 'draft2', email: 'else@example.org' });
        expect(reserved.status).toBe(409);
        expect(reserved.json.error.code).toBe('LOGIN_NAME_TAKEN');
        // ...but nat's own re-submission freed 'draft1'.
        expect((await signup({ loginName: 'draft1', email: 'else@example.org' })).status).toBe(200);

        expect((await verify(firstToken)).res.status).toBe(404);
        const done = await verify(secondToken);
        expect(done.res.status).toBe(200);
        expect(done.res.json.user.loginName).toBe('draft2');
    });

    test('an expired sign-up is pruned and its link is dead', async () => {
        await signup({ loginName: 'slowpoke', email: 'slow@example.org' });
        const token = tokenMailedTo('slow@example.org', '/app/verify-email');
        await db.run(`UPDATE pending_registrations SET expiresAt = '2000-01-01 00:00:00'`);
        expect((await verify(token)).res.status).toBe(404);
        // The next sign-up sweeps it.
        await signup({ loginName: 'fresh', email: 'fresh@example.org' });
        expect(await db.all('SELECT loginName FROM pending_registrations')).toEqual([{ loginName: 'fresh' }]);
    });

    test('a race for one verification link creates exactly one account', async () => {
        await signup({ loginName: 'racer', email: 'racer@example.org' });
        const token = tokenMailedTo('racer@example.org', '/app/verify-email');
        const results = await Promise.all([1, 2, 3, 4].map(() => verify(token)));
        const statuses = results.map(r => r.res.status).sort();
        expect(statuses).toEqual([200, 404, 404, 404]);
        expect(await db.get('SELECT COUNT(*) AS c FROM app_accounts')).toEqual({ c: 1 });
    });

    test('open sign-up reclaims an unverified address and invalidates the displaced claim', async () => {
        const cookie = await member();
        expect((await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie }, body: { email: 'claimed@example.org' } })).status).toBe(200);
        const displacedToken = tokenMailedTo('claimed@example.org', '/app/verify-email');
        const { principalId } = await openSignup('rightful', 'claimed@example.org');
        expect(await nativeAuthService.getEmail(SAM)).toBeNull();
        expect(await nativeAuthService.findAccountByEmail('claimed@example.org')).toMatchObject({ principalId });
        expect((await verify(displacedToken)).res.json.error.code).toBe('VERIFY_INVALID');
        expect((await login('claimed@example.org', GOOD)).res.json.user.id).toBe(principalId);
    });

    test('signup reclamation racing verification preserves exactly one verified owner', async () => {
        const cookie = await member();
        await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie }, body: { email: 'contested@example.org' } });
        const existingToken = tokenMailedTo('contested@example.org', '/app/verify-email');
        await signup({ loginName: 'contender', email: 'contested@example.org' });
        const signupToken = tokenMailedTo('contested@example.org', '/app/verify-email');
        const results = await Promise.all([verify(existingToken), verify(signupToken)]);
        expect(results.filter(result => result.res.status === 200)).toHaveLength(1);
        expect(results.filter(result => result.res.status !== 200)[0].res.json.error.code)
            .toMatch(/^(VERIFY_INVALID|EMAIL_TAKEN)$/);
        const rows = await db.all('SELECT principalId, verifiedAt FROM account_emails WHERE normalized = @email', { email: 'contested@example.org' });
        expect(rows).toHaveLength(1);
        expect(rows[0].verifiedAt).toBeTruthy();
    });

    test('the mail failing rolls the sign-up back so it can be retried at once', async () => {
        mailService.setTransport(async () => { throw new Error('smtp down'); });
        const res = await signup({ loginName: 'unlucky', email: 'unlucky@example.org' });
        expect(res.status).toBe(502);
        expect(res.json.error.code).toBe('MAIL_FAILED');
        expect(await db.get('SELECT COUNT(*) AS c FROM pending_registrations')).toEqual({ c: 0 });
    });
});

describe('an address on an existing account', () => {
    test('a Discord-only account adds an address, proves it, and can then sign in by email', async () => {
        const cookie = await member();
        // Enrol a password first so email login has something to check.
        const enrol = await request({ method: 'PUT', reqPath: '/api/app/account/credentials', headers: { cookie }, body: { loginName: 'sammy', newPassword: GOOD } });
        expect(enrol.status).toBe(200);

        let account = await request({ reqPath: '/api/app/account', headers: { cookie } });
        expect(account.json.email).toBeNull();
        expect(account.json.mail).toEqual({ enabled: true, reason: null });

        const set = await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie }, body: { email: 'Sam@Example.org' } });
        expect(set.status).toBe(200);
        expect(set.json).toEqual({ address: 'Sam@Example.org', verified: false, sent: true });
        expect(outbox).toHaveLength(1);
        expect(outbox[0].subject).toMatch(/confirm your email address/);
        expect(outbox[0].text).toContain(`${PUBLIC_URL}/app/verify-email?token=`);

        account = await request({ reqPath: '/api/app/account', headers: { cookie } });
        expect(account.json.email).toMatchObject({ address: 'Sam@Example.org', verified: false, pendingVerification: true });
        // Unverified: not a login identifier, not a recovery channel.
        expect((await login('sam@example.org', GOOD)).res.status).toBe(401);
        await request({ method: 'POST', reqPath: '/api/app/auth/forgot', body: { email: 'sam@example.org' } });
        expect(outbox).toHaveLength(1);

        const token = tokenMailedTo('Sam@Example.org', '/app/verify-email');
        const verified = await verify(token);
        expect(verified.res.status).toBe(200);
        expect(verified.res.json).toEqual({ kind: 'verified', address: 'Sam@Example.org' });
        // Proving an inbox is not a login: no cookie is minted here.
        expect(verified.cookie).toBeNull();

        account = await request({ reqPath: '/api/app/account', headers: { cookie } });
        expect(account.json.email).toMatchObject({ verified: true, pendingVerification: false });
        expect((await login('SAM@example.org', GOOD)).res.status).toBe(200);
        expect((await verify(token)).res.status).toBe(404);
    });

    test('changing the address kills links sent to the old one and starts unverified again', async () => {
        const { cookie, principalId } = await openSignup('changer', 'old@example.org');
        outbox = [];
        // Ask for a fresh link to the *old* address, then move on before using it.
        await db.run(`UPDATE account_emails SET verifiedAt = NULL WHERE principalId = @id`, { id: principalId });
        expect((await request({ method: 'POST', reqPath: '/api/app/account/email/resend', headers: { cookie } })).status).toBe(200);
        const staleToken = tokenMailedTo('old@example.org', '/app/verify-email');

        const set = await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie }, body: { email: 'new@example.org' } });
        expect(set.status).toBe(200);
        expect((await verify(staleToken)).res.status).toBe(404);
        expect(await nativeAuthService.getEmail(principalId)).toMatchObject({ normalized: 'new@example.org', verifiedAt: null });
        expect((await login('new@example.org', GOOD)).res.status).toBe(401);
        expect((await login('old@example.org', GOOD)).res.status).toBe(401);

        const token = tokenMailedTo('new@example.org', '/app/verify-email');
        expect((await verify(token)).res.status).toBe(200);
        expect((await login('new@example.org', GOOD)).res.status).toBe(200);

        // Setting the already-verified address again is a no-op.
        const same = await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie }, body: { email: 'NEW@example.org' } });
        expect(same.json).toEqual({ address: 'new@example.org', verified: true, sent: false });
    });

    test('a verified address is exclusive; an unproven claim on it is taken over, not honoured', async () => {
        const { cookie: firstCookie } = await openSignup('holder', 'shared@example.org');
        const secondCookie = await member();

        const refused = await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie: secondCookie }, body: { email: 'shared@example.org' } });
        expect(refused.status).toBe(409);
        expect(refused.json.error.code).toBe('EMAIL_TAKEN');

        // The holder moves to a new address but never verifies it...
        await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie: firstCookie }, body: { email: 'squat@example.org' } });
        // ...so someone else may claim it, which drops the holder's unproven row.
        const claim = await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie: secondCookie }, body: { email: 'squat@example.org' } });
        expect(claim.status).toBe(200);
        const rows = await db.all('SELECT principalId, normalized FROM account_emails ORDER BY normalized');
        expect(rows).toEqual([{ principalId: SAM, normalized: 'squat@example.org' }]);
    });

    test('setting or removing the address needs recent authentication; resend does not, but is throttled', async () => {
        const { cookie } = await openSignup('careful', 'careful@example.org');
        const crypto = require('node:crypto');
        const tokenHash = crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex');
        await db.run(`UPDATE web_sessions SET authenticatedAt = '2000-01-01 00:00:00' WHERE tokenHash = @tokenHash`, { tokenHash });

        const stale = await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie }, body: { email: 'x@example.org' } });
        expect(stale.status).toBe(403);
        expect(stale.json.error.code).toBe('REAUTH_REQUIRED');
        expect((await request({ method: 'DELETE', reqPath: '/api/app/account/email', headers: { cookie } })).status).toBe(403);

        // Already verified: resend is a no-op, not a mail.
        const noop = await request({ method: 'POST', reqPath: '/api/app/account/email/resend', headers: { cookie } });
        expect(noop.json).toMatchObject({ verified: true, sent: false });

        const reauth = await request({ method: 'POST', reqPath: '/api/app/auth/reauth', headers: { cookie }, body: { password: GOOD } });
        expect(reauth.status).toBe(200);
        expect((await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie }, body: { email: 'x@example.org' } })).status).toBe(200);
        outbox = [];
        for (let i = 0; i < 4; i += 1) {
            expect((await request({ method: 'POST', reqPath: '/api/app/account/email/resend', headers: { cookie } })).status).toBe(200);
        }
        const throttled = await request({ method: 'POST', reqPath: '/api/app/account/email/resend', headers: { cookie } });
        expect(throttled.status).toBe(429);
        expect(outbox).toHaveLength(4);

        expect((await request({ method: 'DELETE', reqPath: '/api/app/account/email', headers: { cookie } })).json).toEqual({ removed: true });
        expect((await request({ reqPath: '/api/app/account', headers: { cookie } })).json.email).toBeNull();
        expect(await db.get('SELECT COUNT(*) AS c FROM email_tokens')).toEqual({ c: 0 });
        expect((await request({ method: 'DELETE', reqPath: '/api/app/account/email', headers: { cookie } })).status).toBe(404);
    });

    test('with mail off the address routes are 503 and the summary says why', async () => {
        const cookie = await member();
        mailService.setTransport(null);
        const set = await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie }, body: { email: 'sam@example.org' } });
        expect(set.status).toBe(503);
        expect(set.json.error.code).toBe('MAIL_DISABLED');
        const account = await request({ reqPath: '/api/app/account', headers: { cookie } });
        expect(account.json.mail.enabled).toBe(false);
        expect(account.json.mail.reason).toMatch(/mail provider/i);
    });
});

describe('forgot password', () => {
    test.each(['replace', 'remove'])('%s email invalidates old recovery links', async (operation) => {
        const { cookie, principalId } = await openSignup('moving', 'old@example.org');
        await request({ method: 'POST', reqPath: '/api/app/auth/forgot', body: { email: 'old@example.org' } });
        const token = tokenMailedTo('old@example.org', '/app/recover');
        const change = await request({
            method: operation === 'replace' ? 'PUT' : 'DELETE', reqPath: '/api/app/account/email',
            headers: { cookie }, body: operation === 'replace' ? { email: 'new@example.org' } : null
        });
        expect(change.status).toBe(200);
        const reset = await request({ method: 'POST', reqPath: '/api/app/auth/recover', body: { token, password: `${GOOD} stolen` } });
        expect(reset.json.error.code).toBe('RECOVERY_INVALID');
        expect(await nativeAuthService.checkPassword(principalId, GOOD)).toBe(true);
    });

    test('recovery rechecks email ownership after a concurrent address removal', async () => {
        const { principalId } = await openSignup('moving', 'old@example.org');
        const lookup = nativeAuthService.findAccountByEmail.bind(nativeAuthService);
        const spy = jest.spyOn(nativeAuthService, 'findAccountByEmail').mockImplementationOnce(async (email) => {
            const account = await lookup(email);
            await nativeAuthService.removeEmail(principalId);
            return account;
        });
        outbox = [];
        try {
            expect(await nativeAuthService.requestRecovery({ email: 'old@example.org', baseUrl: PUBLIC_URL })).toEqual({ ok: true });
            expect(outbox).toHaveLength(0);
            expect(await db.get('SELECT COUNT(*) AS c FROM recovery_tokens')).toEqual({ c: 0 });
        } finally { spy.mockRestore(); }
    });

    test('the reset link goes to the verified address; using it rotates the credential and every other session', async () => {
        const { cookie: firstDevice, principalId } = await openSignup('forgetful', 'forget@example.org');
        const secondDevice = (await login('forgetful', GOOD)).cookie;
        outbox = [];

        const res = await request({ method: 'POST', reqPath: '/api/app/auth/forgot', body: { email: 'Forget@example.org' } });
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ ok: true });
        expect(outbox).toHaveLength(1);
        expect(outbox[0].subject).toMatch(/reset your password/);
        const token = tokenMailedTo('forget@example.org', '/app/recover');
        expect(token).toBeTruthy();
        // Self-service resets are recorded as issued by the person themselves.
        expect(await db.get('SELECT issuedBy FROM recovery_tokens')).toEqual({ issuedBy: principalId });

        const NEW = 'a brand new passphrase 99';
        const reset = await request({ method: 'POST', reqPath: '/api/app/auth/recover', body: { token, password: NEW } });
        expect(reset.status).toBe(200);
        expect((await request({ reqPath: '/api/app/me', headers: { cookie: firstDevice } })).status).toBe(401);
        expect((await request({ reqPath: '/api/app/me', headers: { cookie: secondDevice } })).status).toBe(401);
        expect((await request({ reqPath: '/api/app/me', headers: { cookie: sessionCookie(reset) } })).status).toBe(200);
        expect((await login('forget@example.org', GOOD)).res.status).toBe(401);
        expect((await login('forget@example.org', NEW)).res.status).toBe(200);
        expect((await request({ method: 'POST', reqPath: '/api/app/auth/recover', body: { token, password: NEW } })).status).toBe(404);
    });

    test('an unknown, unverified, or disabled address gets the same answer and no mail', async () => {
        const { principalId } = await openSignup('quiet', 'quiet@example.org');
        const cookie = await member();
        await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie }, body: { email: 'unproven@example.org' } });
        await identityService.setAccountStatus(principalId, 'disabled');
        outbox = [];

        for (const email of ['nobody@example.org', 'unproven@example.org', 'quiet@example.org']) {
            const res = await request({ method: 'POST', reqPath: '/api/app/auth/forgot', body: { email } });
            expect(res.status).toBe(200);
            expect(res.json).toEqual({ ok: true });
        }
        expect(outbox).toHaveLength(0);
        expect(await db.get('SELECT COUNT(*) AS c FROM recovery_tokens')).toEqual({ c: 0 });

        expect((await request({ method: 'POST', reqPath: '/api/app/auth/forgot', body: { email: 'junk' } })).json.error.code).toBe('BAD_EMAIL');
        mailService.setTransport(null);
        expect((await request({ method: 'POST', reqPath: '/api/app/auth/forgot', body: { email: 'quiet@example.org' } })).status).toBe(503);
    });

    test('the mail failing withdraws the token it would have carried', async () => {
        await openSignup('dropped', 'dropped@example.org');
        mailService.setTransport(async () => { throw new Error('down'); });
        const res = await request({ method: 'POST', reqPath: '/api/app/auth/forgot', body: { email: 'dropped@example.org' } });
        expect(res.status).toBe(502);
        expect(await db.get('SELECT COUNT(*) AS c FROM recovery_tokens')).toEqual({ c: 0 });
    });
});

describe('throttles', () => {
    test('spoofed X-Forwarded-For prefixes share the real client signup budget', async () => {
        for (let i = 0; i < 5; i += 1) {
            const result = await signup({ loginName: `proxied${i}`, email: `proxied${i}@example.org` },
                { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.8` });
            expect(result.status).toBe(200);
        }
        const blocked = await signup({ loginName: 'proxiedlast', email: 'proxiedlast@example.org' },
            { 'x-forwarded-for': '203.0.113.99, 198.51.100.8' });
        expect(blocked.json.error.code).toBe('TOO_MANY_ATTEMPTS');
    });

    test('sign-ups are limited per client address and mail per recipient', async () => {
        const from = { 'x-forwarded-for': '203.0.113.9' };
        for (let i = 0; i < 5; i += 1) {
            expect((await signup({ loginName: `person${i}`, email: `person${i}@example.org` }, from)).status).toBe(200);
        }
        const sixth = await signup({ loginName: 'person5', email: 'person5@example.org' }, from);
        expect(sixth.status).toBe(429);
        expect(sixth.json.error.code).toBe('TOO_MANY_ATTEMPTS');
        // A different address is a different bucket.
        expect((await signup({ loginName: 'person6', email: 'person6@example.org' }, { 'x-forwarded-for': '203.0.113.10' })).status).toBe(200);

        outbox = [];
        for (let i = 0; i < 3; i += 1) {
            expect((await request({ method: 'POST', reqPath: '/api/app/auth/forgot', body: { email: 'target@example.org' }, headers: { 'x-forwarded-for': `198.51.100.${i}` } })).status).toBe(200);
        }
        const fourth = await request({ method: 'POST', reqPath: '/api/app/auth/forgot', body: { email: 'target@example.org' }, headers: { 'x-forwarded-for': '198.51.100.9' } });
        expect(fourth.status).toBe(429);
    });

    test('a cross-origin POST is refused before it reaches the handler', async () => {
        const res = await signup({ loginName: 'evil', email: 'evil@example.org' }, { origin: 'https://evil.example' });
        expect(res.status).toBe(403);
        expect(res.json.error.code).toBe('BAD_ORIGIN');
        expect(outbox).toHaveLength(0);
    });
});

describe('the host panel', () => {
    test('the installation view shows the policy, the mail status, and the reason when they disagree', async () => {
        const host = await operator();
        let view = await request({ reqPath: '/api/app/admin/installation', headers: { cookie: host } });
        expect(view.status).toBe(200);
        expect(view.json).toMatchObject({
            publicUrl: PUBLIC_URL,
            nativeLogin: true,
            registration: { configured: 'open', effective: 'open' },
            mail: { enabled: true, provider: 'custom', linksEnabled: true, reason: null }
        });

        mailService.setTransport(null);
        view = await request({ reqPath: '/api/app/admin/installation', headers: { cookie: host } });
        expect(view.json.registration).toEqual({ configured: 'open', effective: 'invite' });
        expect(view.json.mail.enabled).toBe(false);
        expect(view.json.mail.reason).toMatch(/mail provider/i);

        const memberCookie = await member();
        expect((await request({ reqPath: '/api/app/admin/installation', headers: { cookie: memberCookie } })).status).toBe(403);
    });

    test('a test message goes where the operator says, a few times an hour', async () => {
        const host = await operator();
        const res = await request({ method: 'POST', reqPath: '/api/app/admin/mail/test', headers: { cookie: host }, body: { to: 'host@example.org' } });
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ ok: true, provider: 'custom' });
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({ to: 'host@example.org' });
        expect(outbox[0].subject).toMatch(/test message/);
        expect((await request({ method: 'POST', reqPath: '/api/app/admin/mail/test', headers: { cookie: host }, body: { to: 'junk' } })).status).toBe(400);
        await request({ method: 'POST', reqPath: '/api/app/admin/mail/test', headers: { cookie: host }, body: { to: 'host@example.org' } });
        await request({ method: 'POST', reqPath: '/api/app/admin/mail/test', headers: { cookie: host }, body: { to: 'host@example.org' } });
        expect((await request({ method: 'POST', reqPath: '/api/app/admin/mail/test', headers: { cookie: host }, body: { to: 'host@example.org' } })).status).toBe(429);

        const memberCookie = await member();
        expect((await request({ method: 'POST', reqPath: '/api/app/admin/mail/test', headers: { cookie: memberCookie }, body: { to: 'x@example.org' } })).status).toBe(403);
    });

    test('the roster shows each account\'s address and whether it is verified', async () => {
        const host = await operator();
        const { principalId } = await openSignup('listed', 'listed@example.org');
        const memberCookie = await member();
        await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie: memberCookie }, body: { email: 'sam@example.org' } });

        const roster = await request({ reqPath: '/api/app/admin/accounts', headers: { cookie: host } });
        const byId = Object.fromEntries(roster.json.accounts.map(a => [a.principalId, a]));
        expect(byId[principalId]).toMatchObject({ entitlement: 'open', email: { address: 'listed@example.org', verified: true } });
        expect(byId[SAM]).toMatchObject({ email: { address: 'sam@example.org', verified: false } });
        expect(byId[ROB].email).toBeNull();
    });
});

describe('privacy', () => {
    test('the report shows the address; /forget-me removes it, its links, and a sign-up parked under it', async () => {
        const { cookie, principalId } = await openSignup('leaver', 'leaver@example.org');
        await request({ method: 'PUT', reqPath: '/api/app/account/email', headers: { cookie }, body: { email: 'leaver2@example.org' } });
        // A stranger's sign-up under the same address the leaver now holds.
        await db.run(
            `INSERT INTO pending_registrations (tokenHash, loginName, emailAddress, emailNormalized, passwordHash, paramsJson, expiresAt)
             VALUES ('h', 'stranger', 'leaver2@example.org', 'leaver2@example.org', 'x', '{}', '2999-01-01 00:00:00')`
        );

        const report = await privacyService.buildUserReport({ userId: principalId, guildId: `dm:${principalId}` });
        expect(report.identity.email).toMatchObject({ address: 'leaver2@example.org', verified: false, openVerificationLinks: 1 });
        expect(report.identity.account).toMatchObject({ entitlement: 'open' });
        const before = await privacyService.auditUser({ userId: principalId });
        expect(before.byTable).toMatchObject({ account_emails: 1, email_tokens: 1, password_credentials: 1, app_accounts: 1 });

        const result = await privacyService.forgetUser({ userId: principalId });
        expect(result).toMatchObject({ accountEmails: 1, emailTokens: 1, passwordCredentials: 1, principals: 1 });
        const after = await privacyService.auditUser({ userId: principalId });
        expect(after.total).toBe(0);
        expect(await db.get('SELECT COUNT(*) AS c FROM pending_registrations')).toEqual({ c: 0 });
        expect((await login('leaver', GOOD)).res.status).toBe(401);
        expect((await request({ reqPath: '/api/app/me', headers: { cookie } })).status).toBe(401);
        // The address is free again.
        expect((await signup({ loginName: 'leaver', email: 'leaver@example.org' })).status).toBe(200);
    });
});
