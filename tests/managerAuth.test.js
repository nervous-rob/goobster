/**
 * Manager setup and recovery authentication (#323), over real HTTP on
 * loopback: the one-time bootstrap credential (expiry, replay), the local
 * recovery credential (single use, loopback only), Host/Origin checks,
 * forged actor ids, non-operators, session nonces, the mutation lock under
 * two concurrent conflicting operations, bounded bodies, redacted errors,
 * and the privileged-operation boundary.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createManagerApp } = require('@goobster/manager/server');
const { createTransportGuards } = require('@goobster/manager/auth/transport');
const { createEngine } = require('@goobster/manager/engine');
const { main } = require('@goobster/manager');
const coreBridge = require('@goobster/core/web/managerBridge');

const OPERATOR = { actorId: '100000000000000001', account: { role: 'operator', status: 'active' } };
const silent = { info() {}, warn() {}, error() {} };
const roots = [];
const servers = [];

function tempRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-323-auth-'));
    roots.push(dir);
    return dir;
}

function envFor(root, extra = {}) {
    return {
        GOOBSTER_DATA_DIR: path.join(root, 'data'),
        GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0',
        ...extra
    };
}

function sinkStream() {
    const chunks = [];
    return { write: (text) => { chunks.push(String(text)); }, text: () => chunks.join(''), isTTY: false };
}

async function harness({ root = tempRoot(), clock = null, hooks = {} } = {}) {
    const env = envFor(root);
    const settings = resolveSettings(env);
    const now = clock ? () => new Date(clock.t) : () => new Date();
    const manager = createManager({ settings, now, hooks, logger: silent });
    const booted = await manager.init();
    const app = createManagerApp(manager, { now, logger: silent });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const port = server.address().port;

    function request({ method = 'GET', reqPath, body, rawBody, headers = {}, contentType = 'application/json' }) {
        const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : null;
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port,
                method,
                path: reqPath,
                headers: {
                    host: `127.0.0.1:${port}`,
                    ...(payload !== null ? { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) } : {}),
                    ...headers
                }
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch { }
                    resolve({ status: res.statusCode, body: json, text: data, headers: res.headers });
                });
            });
            req.on('error', reject);
            if (payload !== null) req.write(payload);
            req.end();
        });
    }

    const minter = () => coreBridge.createManagerBridge({ keyFile: manager.store.paths.bridgeKey, now });
    const asOperator = (method, reqPath, actor = OPERATOR) => ({
        [coreBridge.ASSERTION_HEADER]: minter().mint({ actor, method, path: reqPath })
    });
    const withSession = (token) => ({ authorization: `Bearer ${token}`, 'x-goobster-nonce': crypto.randomBytes(12).toString('base64url') });

    async function claim(label = 'Rob') {
        const res = await request({ method: 'POST', reqPath: '/manager/api/claim', body: { credential: booted.bootstrap.credential, label } });
        return res;
    }

    return { root, env, settings, manager, booted, port, request, asOperator, withSession, claim };
}

function plantedRecovery(env) {
    const stdout = sinkStream();
    return main(['--mint-recovery'], { env, stdout, logger: silent }).then((outcome) => {
        expect(outcome.code).toBe(0);
        return /Recovery credential: (\S+)/.exec(stdout.text())[1];
    });
}

afterAll(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(() => resolve()))));
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('first-time setup (bootstrap credential)', () => {
    test('claim with the credential creates the owner claim and invalidates the credential', async () => {
        const h = await harness();
        expect(h.booted.state.state).toBe('unclaimed');
        expect(h.booted.bootstrap.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const status = await h.request({ reqPath: '/manager/api/status' });
        expect(status.body.state).toBe('unclaimed');
        expect(status.body.setup.bootstrapPending).toBe(true);
        expect(status.text).not.toContain(h.booted.bootstrap.credential);

        const res = await h.claim('Rob');
        expect(res.status).toBe(200);
        expect(res.body.installationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.body.session.kind).toBe('setup');
        expect(fs.existsSync(h.manager.store.paths.bootstrap)).toBe(false);
        expect(fs.existsSync(h.manager.store.paths.bootstrapCredential)).toBe(false);

        const installation = JSON.parse(fs.readFileSync(h.manager.store.paths.installation, 'utf8'));
        expect(installation).toMatchObject({ version: 1, installationId: res.body.installationId, ownerLabel: 'Rob', origin: 'claim', revision: 1 });
        expect(typeof installation.claimedAt).toBe('string');
        expect((await h.request({ reqPath: '/manager/api/status' })).body.state).toBe('claimed');
    });

    test('a replayed bootstrap credential is refused with BOOTSTRAP_INVALID', async () => {
        const h = await harness();
        expect((await h.claim()).status).toBe(200);
        const replay = await h.claim();
        expect(replay.status).toBe(401);
        expect(replay.body.error.code).toBe('BOOTSTRAP_INVALID');
    });

    test('two concurrent claims with one credential: exactly one wins', async () => {
        const h = await harness();
        const results = await Promise.all([h.claim('A'), h.claim('B')]);
        expect(results.map(r => r.status).sort()).toEqual([200, 401]);
    });

    test('a wrong credential is refused and attempts are throttled', async () => {
        const h = await harness();
        const wrong = crypto.randomBytes(32).toString('base64url');
        const first = await h.request({ method: 'POST', reqPath: '/manager/api/claim', body: { credential: wrong, label: 'X' } });
        expect(first.status).toBe(401);
        expect(first.body.error.code).toBe('BOOTSTRAP_INVALID');
        for (let i = 0; i < 10; i++) {
            await h.request({ method: 'POST', reqPath: '/manager/api/claim', body: { credential: wrong, label: 'X' } });
        }
        const limited = await h.claim();
        expect(limited.status).toBe(429);
    });

    test('a stale (expired) credential is refused; a new one is minted only on restart or --mint-bootstrap', async () => {
        const clock = { t: Date.parse('2026-10-07T03:00:00.000Z') };
        const h = await harness({ clock });
        clock.t += 16 * 60 * 1000;
        const expired = await h.claim();
        expect(expired.status).toBe(401);
        expect(expired.body.error.code).toBe('BOOTSTRAP_EXPIRED');
        const status = await h.request({ reqPath: '/manager/api/status' });
        expect(status.body.setup).toMatchObject({ bootstrapPending: false, expired: true });

        const stdout = sinkStream();
        const minted = await main(['--mint-bootstrap'], { env: h.env, stdout, logger: silent });
        expect(minted.code).toBe(0);
        const fresh = /Setup credential: (\S+)/.exec(stdout.text())[1];
        clock.t = Date.now();
        const res = await h.request({ method: 'POST', reqPath: '/manager/api/claim', body: { credential: fresh, label: 'Rob' } });
        expect(res.status).toBe(200);
        const again = await main(['--mint-bootstrap'], { env: h.env, stdout: sinkStream(), logger: silent });
        expect(again.code).toBe(1);
    });

    test('a label that would be refused does not burn the credential', async () => {
        const h = await harness();
        const bad = await h.request({ method: 'POST', reqPath: '/manager/api/claim', body: { credential: h.booted.bootstrap.credential, label: '<script>' } });
        expect(bad.status).toBe(400);
        expect((await h.claim()).status).toBe(200);
    });
});

describe('transport checks', () => {
    test('a cross-origin write is refused and does not consume the credential', async () => {
        const h = await harness();
        const evil = await h.request({
            method: 'POST', reqPath: '/manager/api/claim',
            body: { credential: h.booted.bootstrap.credential, label: 'Rob' },
            headers: { origin: 'https://evil.example' }
        });
        expect(evil.status).toBe(403);
        expect(evil.body.error.code).toBe('BAD_ORIGIN');
        const fetchMeta = await h.request({
            method: 'POST', reqPath: '/manager/api/claim',
            body: { credential: h.booted.bootstrap.credential, label: 'Rob' },
            headers: { 'sec-fetch-site': 'cross-site' }
        });
        expect(fetchMeta.status).toBe(403);
        const nullOrigin = await h.request({
            method: 'POST', reqPath: '/manager/api/claim',
            body: { credential: h.booted.bootstrap.credential, label: 'Rob' },
            headers: { origin: 'null' }
        });
        expect(nullOrigin.status).toBe(403);
        const sameOrigin = await h.request({
            method: 'POST', reqPath: '/manager/api/claim',
            body: { credential: h.booted.bootstrap.credential, label: 'Rob' },
            headers: { origin: `http://127.0.0.1:${h.port}` }
        });
        expect(sameOrigin.status).toBe(200);
    });

    test('a request not addressed to the manager (DNS rebinding) is refused, reads included', async () => {
        const h = await harness();
        for (const host of ['evil.example', `evil.example:${h.port}`, '127.0.0.1:1']) {
            const res = await h.request({ reqPath: '/manager/api/status', headers: { host } });
            expect(res.status).toBe(421);
            expect(res.body.error.code).toBe('BAD_HOST');
        }
        expect((await h.request({ reqPath: '/manager/api/status', headers: { host: `localhost:${h.port}` } })).status).toBe(200);
    });

    test('isLocalRequest: loopback peer, loopback Host and no proxy headers only', () => {
        const guards = createTransportGuards({ lan: false });
        const req = (remoteAddress, headers = {}, kind = 'loopback') => ({ managerHostKind: kind, socket: { remoteAddress }, headers });
        expect(guards.isLocalRequest(req('127.0.0.1'))).toBe(true);
        expect(guards.isLocalRequest(req('::1'))).toBe(true);
        expect(guards.isLocalRequest(req('10.0.0.5'))).toBe(false);
        expect(guards.isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '10.0.0.5' }))).toBe(false);
        expect(guards.isLocalRequest(req('127.0.0.1', {}, 'lan'))).toBe(false);
    });

    test('bodies are bounded, JSON only, and errors are redacted', async () => {
        const h = await harness();
        const big = await h.request({ method: 'POST', reqPath: '/manager/api/claim', rawBody: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) });
        expect(big.status).toBe(413);
        expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
        const bad = await h.request({ method: 'POST', reqPath: '/manager/api/claim', rawBody: '{"credential":' });
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('BAD_JSON');
        const text = await h.request({ method: 'POST', reqPath: '/manager/api/claim', rawBody: 'credential=x', contentType: 'text/plain' });
        expect(text.status).toBe(415);
        const missing = await h.request({ reqPath: '/manager/api/nope' });
        expect(missing.status).toBe(404);
        for (const res of [big, bad, text, missing]) {
            expect(Object.keys(res.body)).toEqual(['error']);
            expect(res.text).not.toMatch(/at .+\.js:\d+|\/tmp\/|node_modules/);
        }
        expect(big.headers['cache-control']).toBe('no-store');
    });
});

describe('recovery (local only)', () => {
    test('mint, unlock once, replay refused, remote refused', async () => {
        const h = await harness();
        expect((await h.claim()).status).toBe(200);
        const credential = await plantedRecovery(h.env);
        expect(fs.statSync(h.manager.store.paths.recoveryCredential).mode & 0o777).toBe(0o600);

        const proxied = await h.request({
            method: 'POST', reqPath: '/manager/api/recovery/unlock', body: { credential },
            headers: { 'x-forwarded-for': '203.0.113.9' }
        });
        expect(proxied.status).toBe(403);
        expect(proxied.body.error.code).toBe('LOCAL_ONLY');

        const unlocked = await h.request({ method: 'POST', reqPath: '/manager/api/recovery/unlock', body: { credential } });
        expect(unlocked.status).toBe(200);
        expect(unlocked.body.session.kind).toBe('recovery');
        expect(fs.existsSync(h.manager.store.paths.recoveryCredential)).toBe(false);

        const replay = await h.request({ method: 'POST', reqPath: '/manager/api/recovery/unlock', body: { credential } });
        expect(replay.status).toBe(401);
        expect(replay.body.error.code).toBe('RECOVERY_INVALID');

        const session = unlocked.body.session.token;
        const remoteUse = await h.request({
            method: 'POST', reqPath: '/manager/api/operations',
            body: { kind: 'features.set', input: { changes: { gba: true } } },
            headers: { ...h.withSession(session), 'x-forwarded-for': '203.0.113.9' }
        });
        expect(remoteUse.status).toBe(403);
        const planned = await h.request({
            method: 'POST', reqPath: '/manager/api/operations',
            body: { kind: 'features.set', input: { changes: { gba: true } } },
            headers: h.withSession(session)
        });
        expect(planned.status).toBe(200);
        expect(planned.body.operation.via).toBe('recovery');
    });

    test('an expired recovery credential is refused', async () => {
        const clock = { t: Date.now() };
        const h = await harness({ clock });
        expect((await h.claim()).status).toBe(200);
        const credential = await plantedRecovery(h.env);
        clock.t += 16 * 60 * 1000;
        const res = await h.request({ method: 'POST', reqPath: '/manager/api/recovery/unlock', body: { credential } });
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('RECOVERY_EXPIRED');
    });

    test('--mint-recovery is refused while unclaimed', async () => {
        const root = tempRoot();
        const outcome = await main(['--mint-recovery'], { env: envFor(root), stdout: sinkStream(), logger: silent });
        expect(outcome.code).toBe(1);
    });
});

describe('operator authentication', () => {
    test('no credentials, a non-operator, a forged actor id and a replayed assertion are all refused', async () => {
        const h = await harness();
        expect((await h.claim()).status).toBe(200);
        const ops = '/manager/api/operations';
        const body = { kind: 'features.set', input: { changes: { gba: true } } };

        const anonymous = await h.request({ method: 'POST', reqPath: ops, body });
        expect(anonymous.status).toBe(401);
        expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

        expect(() => h.asOperator('POST', ops, { actorId: '2', account: { role: 'member', status: 'active' } })).toThrow(/Only the host/);
        const { key, installationId } = coreBridge.readBridgeKey(h.manager.store.paths.bridgeKey);
        const iat = Math.floor(Date.now() / 1000);
        const memberPayload = Buffer.from(JSON.stringify({
            v: 1, purpose: 'manager', principalId: '2', role: 'member', installationId,
            req: `POST ${ops}`, iat, exp: iat + 60, nonce: crypto.randomBytes(16).toString('base64url')
        })).toString('base64url');
        const memberSig = crypto.createHmac('sha256', key).update(coreBridge.signingInput(memberPayload)).digest('base64url');
        const member = await h.request({ method: 'POST', reqPath: ops, body, headers: { [coreBridge.ASSERTION_HEADER]: `gma1.${memberPayload}.${memberSig}` } });
        expect(member.status).toBe(403);
        expect(member.body.error.code).toBe('FORBIDDEN');

        const forged = await h.request({ method: 'POST', reqPath: ops, body: { ...body, actor: '999' }, headers: h.asOperator('POST', ops) });
        expect(forged.status).toBe(403);
        expect(forged.body.error.code).toBe('ACTOR_MISMATCH');
        const forgedPrincipal = await h.request({ method: 'POST', reqPath: ops, body: { ...body, principalId: '999' }, headers: h.asOperator('POST', ops) });
        expect(forgedPrincipal.body.error.code).toBe('ACTOR_MISMATCH');

        const headers = h.asOperator('POST', ops);
        const ok = await h.request({ method: 'POST', reqPath: ops, body: { ...body, actor: OPERATOR.actorId }, headers });
        expect(ok.status).toBe(200);
        expect(ok.body.operation.actor).toBe(OPERATOR.actorId);
        const replay = await h.request({ method: 'POST', reqPath: ops, body, headers });
        expect(replay.status).toBe(401);
        expect(replay.body.error.code).toBe('ASSERTION_REPLAYED');

        const otherPath = await h.request({ method: 'POST', reqPath: ops, body, headers: h.asOperator('POST', `${ops}/x/apply`) });
        expect(otherPath.body.error.code).toBe('ASSERTION_REQUEST');

        const forgedSession = await h.request({ method: 'POST', reqPath: ops, body, headers: h.withSession('x'.repeat(43)) });
        expect(forgedSession.status).toBe(401);
        expect(forgedSession.body.error.code).toBe('SESSION_INVALID');
    });

    test('another operator cannot validate or apply an operation they did not plan', async () => {
        const h = await harness();
        expect((await h.claim()).status).toBe(200);
        const planned = await h.request({
            method: 'POST', reqPath: '/manager/api/operations',
            body: { kind: 'features.set', input: { changes: { gba: true } } }, headers: h.asOperator('POST', '/manager/api/operations')
        });
        const id = planned.body.operation.id;
        const other = { actorId: '100000000000000002', account: { role: 'operator', status: 'active' } };
        const res = await h.request({ method: 'POST', reqPath: `/manager/api/operations/${id}/validate`, body: {}, headers: h.asOperator('POST', `/manager/api/operations/${id}/validate`, other) });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('OPERATION_NOT_OWNED');
    });

    test('session mutations need a fresh nonce', async () => {
        const h = await harness();
        const { session } = (await h.claim()).body;
        const body = { kind: 'features.set', input: { changes: { gba: true } } };
        const none = await h.request({ method: 'POST', reqPath: '/manager/api/operations', body, headers: { authorization: `Bearer ${session.token}` } });
        expect(none.status).toBe(400);
        expect(none.body.error.code).toBe('NONCE_REQUIRED');
        const headers = h.withSession(session.token);
        expect((await h.request({ method: 'POST', reqPath: '/manager/api/operations', body, headers })).status).toBe(200);
        const reused = await h.request({ method: 'POST', reqPath: '/manager/api/operations', body, headers });
        expect(reused.status).toBe(401);
        expect(reused.body.error.code).toBe('NONCE_REPLAYED');
    });
});

describe('the mutation lock', () => {
    test('two concurrent conflicting features.set: the second gets 409 OPERATION_IN_PROGRESS, then REVISION_CONFLICT', async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        let entered;
        let blocked = false;
        const inside = new Promise((resolve) => { entered = resolve; });
        const hooks = {
            beforeStep: async ({ step }) => {
                if (step === 'write-features' && !blocked) {
                    blocked = true;
                    entered();
                    await gate;
                }
            }
        };
        const h = await harness({ hooks });
        const { session } = (await h.claim()).body;
        const plan = async (changes) => {
            const res = await h.request({ method: 'POST', reqPath: '/manager/api/operations', body: { kind: 'features.set', input: { changes } }, headers: h.withSession(session.token) });
            const id = res.body.operation.id;
            const validated = await h.request({ method: 'POST', reqPath: `/manager/api/operations/${id}/validate`, body: {}, headers: h.withSession(session.token) });
            expect(validated.body.operation.status).toBe('validated');
            return validated.body.operation;
        };
        const a = await plan({ gba: true });
        const b = await plan({ gba: false, screenVision: true });
        expect(a.revision).toBe(0);
        expect(b.revision).toBe(0);

        const applyA = h.request({ method: 'POST', reqPath: `/manager/api/operations/${a.id}/apply`, body: { revision: 0 }, headers: h.withSession(session.token) });
        await inside;
        const status = await h.request({ reqPath: '/manager/api/status' });
        expect(status.body.lock).toMatchObject({ held: true, operationId: a.id });
        const applyB = await h.request({ method: 'POST', reqPath: `/manager/api/operations/${b.id}/apply`, body: { revision: 0 }, headers: h.withSession(session.token) });
        expect(applyB.status).toBe(409);
        expect(applyB.body.error.code).toBe('OPERATION_IN_PROGRESS');
        release();
        const doneA = await applyA;
        expect(doneA.status).toBe(200);
        expect(doneA.body.operation.status).toBe('applied');
        expect(doneA.body.result).toEqual({ revision: 1, pending: ['gba'] });

        const retryB = await h.request({ method: 'POST', reqPath: `/manager/api/operations/${b.id}/apply`, body: { revision: 0 }, headers: h.withSession(session.token) });
        expect(retryB.status).toBe(409);
        expect(retryB.body.error.code).toBe('REVISION_CONFLICT');
        expect(retryB.body.operation.status).toBe('failed');
        expect(fs.existsSync(h.manager.store.paths.lock)).toBe(false);
    });
});

describe('privilege boundary', () => {
    test('privileged operations are declared, authenticated and not implemented', async () => {
        const h = await harness();
        const { session } = (await h.claim()).body;
        const unauth = await h.request({ method: 'POST', reqPath: '/manager/api/privileged/service.register', body: {} });
        expect(unauth.status).toBe(401);
        for (const name of ['service.register', 'service.unregister', 'package.install']) {
            const res = await h.request({ method: 'POST', reqPath: `/manager/api/privileged/${name}`, body: {}, headers: h.withSession(session.token) });
            expect(res.status).toBe(501);
            expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
        }
        const unknown = await h.request({ method: 'POST', reqPath: '/manager/api/privileged/shell.exec', body: {}, headers: h.withSession(session.token) });
        expect(unknown.status).toBe(404);
        const asKind = await h.request({ method: 'POST', reqPath: '/manager/api/operations', body: { kind: 'package.install', input: {} }, headers: h.withSession(session.token) });
        expect(asKind.status).toBe(400);
        expect(asKind.body.error.code).toBe('PRIVILEGED_OPERATION');
        const internalKind = await h.request({ method: 'POST', reqPath: '/manager/api/operations', body: { kind: 'claim', input: { label: 'x' } }, headers: h.withSession(session.token) });
        expect(internalKind.body.error.code).toBe('UNKNOWN_KIND');
    });

    test('the engine refuses to register a kind named like a privileged operation', () => {
        expect(() => createEngine({
            journal: {}, lock: {}, currentState: () => ({}),
            kinds: { 'package.install': { kind: 'package.install', public: true, allowed: () => true, plan: () => ({}), steps: [] } }
        })).toThrow(/privileged/);
    });
});
