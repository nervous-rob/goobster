/**
 * The manager bridge (#323): the core API mints a short-lived, signed,
 * single-purpose assertion for an operator who passed requireOperator; the
 * manager verifies it. Round trip, wrong key, expiry, nonce replay, purpose,
 * installation and request binding, non-operators, and the core/app boundary.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const coreBridge = require('@goobster/core/web/managerBridge');
const { createBridgeVerifier, requireStrongAuth } = require('@goobster/manager/auth/bridge');
const { createStore } = require('@goobster/manager/store/installation');

const OPERATOR = { actorId: '100000000000000001', account: { role: 'operator', status: 'active' } };
const INSTALLATION = '2b9f1c3e-8d7a-4f60-9e21-5a4b3c2d1e0f';
const OPS_PATH = '/manager/api/operations';

let root;
let clock;
const now = () => new Date(clock);

function setup() {
    const store = createStore({ root: path.join(root, `store-${crypto.randomBytes(3).toString('hex')}`) });
    store.init();
    const verifier = createBridgeVerifier({ store, now });
    verifier.ensureKey(INSTALLATION);
    const minter = coreBridge.createManagerBridge({ keyFile: store.paths.bridgeKey, now });
    return { store, verifier, minter };
}

function forge(store, payloadPatch) {
    const { key, installationId } = coreBridge.readBridgeKey(store.paths.bridgeKey);
    const iat = Math.floor(clock / 1000);
    const payload = {
        v: 1, purpose: 'manager', principalId: OPERATOR.actorId, role: 'operator', installationId,
        req: `POST ${OPS_PATH}`, iat, exp: iat + 60, nonce: crypto.randomBytes(16).toString('base64url'),
        ...payloadPatch
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', key).update(coreBridge.signingInput(encoded)).digest('base64url');
    return `${coreBridge.ASSERTION_PREFIX}.${encoded}.${sig}`;
}

const request = { method: 'POST', path: OPS_PATH, installationId: INSTALLATION };

function codeOf(fn) {
    try {
        fn();
    } catch (error) {
        return error.code;
    }
    return null;
}

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-323-bridge-'));
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
    clock = Date.parse('2026-10-07T03:00:00.000Z');
});

describe('manager bridge', () => {
    test('round trip: an operator assertion verifies and names the principal', () => {
        const { verifier, minter } = setup();
        const token = minter.mint({ actor: OPERATOR, method: 'post', path: OPS_PATH });
        expect(token.startsWith('gma1.')).toBe(true);
        const verified = verifier.verify(token, request);
        expect(verified.principalId).toBe(OPERATOR.actorId);
        expect(verified.role).toBe('operator');
        expect(minter.headers({ actor: OPERATOR, method: 'GET', path: OPS_PATH })).toHaveProperty(coreBridge.ASSERTION_HEADER);
    });

    test('the key file is owner-only and carries the installation id', () => {
        const { store } = setup();
        if (process.platform !== 'win32') {
            expect(fs.statSync(store.paths.bridgeKey).mode & 0o777).toBe(0o600);
        }
        expect(coreBridge.readBridgeKey(store.paths.bridgeKey).installationId).toBe(INSTALLATION);
    });

    test('an assertion signed with another key is refused', () => {
        const a = setup();
        const b = setup();
        const token = b.minter.mint({ actor: OPERATOR, method: 'POST', path: OPS_PATH });
        expect(codeOf(() => a.verifier.verify(token, request))).toBe('ASSERTION_INVALID');
    });

    test('a tampered payload is refused', () => {
        const { verifier, minter } = setup();
        const [prefix, payload, sig] = minter.mint({ actor: OPERATOR, method: 'POST', path: OPS_PATH }).split('.');
        const changed = JSON.parse(Buffer.from(payload, 'base64url').toString());
        changed.principalId = '999';
        const tampered = `${prefix}.${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${sig}`;
        expect(codeOf(() => verifier.verify(tampered, request))).toBe('ASSERTION_INVALID');
        expect(codeOf(() => verifier.verify('not-an-assertion', request))).toBe('ASSERTION_INVALID');
    });

    test('an expired assertion is refused; the lifetime is capped at five minutes', () => {
        const { verifier, minter, store } = setup();
        const token = minter.mint({ actor: OPERATOR, method: 'POST', path: OPS_PATH, ttlSeconds: 3600 });
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        expect(payload.exp - payload.iat).toBe(coreBridge.MAX_TTL_SECONDS);
        clock += 301 * 1000;
        expect(codeOf(() => verifier.verify(token, request))).toBe('ASSERTION_EXPIRED');
        const tooLong = forge(store, { exp: Math.floor(clock / 1000) + 3600 });
        expect(codeOf(() => verifier.verify(tooLong, request))).toBe('ASSERTION_INVALID');
    });

    test('a nonce is accepted once', () => {
        const { verifier, minter } = setup();
        const token = minter.mint({ actor: OPERATOR, method: 'POST', path: OPS_PATH });
        verifier.verify(token, request);
        expect(codeOf(() => verifier.verify(token, request))).toBe('ASSERTION_REPLAYED');
    });

    test('purpose, installation and request binding must match', () => {
        const { verifier, store } = setup();
        expect(codeOf(() => verifier.verify(forge(store, { purpose: 'portal' }), request))).toBe('ASSERTION_PURPOSE');
        expect(codeOf(() => verifier.verify(forge(store, { installationId: crypto.randomUUID() }), request))).toBe('ASSERTION_INSTALLATION');
        expect(codeOf(() => verifier.verify(forge(store, {}), { ...request, installationId: crypto.randomUUID() }))).toBe('ASSERTION_INSTALLATION');
        expect(codeOf(() => verifier.verify(forge(store, { req: 'POST /manager/api/operations/x/apply' }), request))).toBe('ASSERTION_REQUEST');
        expect(codeOf(() => verifier.verify(forge(store, {}), { ...request, method: 'GET' }))).toBe('ASSERTION_REQUEST');
    });

    test('non-operators: the minter refuses, and a signed non-operator role is refused by the manager', () => {
        const { verifier, minter, store } = setup();
        for (const actor of [
            { actorId: '2', account: { role: 'member', status: 'active' } },
            { actorId: '3', account: { role: 'operator', status: 'disabled' } },
            { actorId: '4', account: null },
            null
        ]) {
            expect(codeOf(() => minter.mint({ actor, method: 'POST', path: OPS_PATH }))).toBe('FORBIDDEN');
        }
        expect(codeOf(() => verifier.verify(forge(store, { role: 'member' }), request))).toBe('FORBIDDEN');
        expect(codeOf(() => minter.mint({ actor: OPERATOR, method: 'POST', path: '/api/app/anything' }))).toBe('BAD_REQUEST');
    });

    test('a missing key file makes the bridge unavailable rather than open', () => {
        const minter = coreBridge.createManagerBridge({ keyFile: path.join(root, 'absent', 'bridge-key') });
        expect(minter.available()).toBe(false);
        expect(codeOf(() => minter.mint({ actor: OPERATOR, method: 'POST', path: OPS_PATH }))).toBe('MANAGER_BRIDGE_UNAVAILABLE');
    });

    test('a new installation id rotates the key; old assertions stop verifying', () => {
        const { verifier, minter } = setup();
        const token = minter.mint({ actor: OPERATOR, method: 'POST', path: OPS_PATH });
        const other = crypto.randomUUID();
        expect(verifier.ensureKey(other).created).toBe(true);
        expect(verifier.ensureKey(other).created).toBe(false);
        expect(codeOf(() => verifier.verify(token, { ...request, installationId: other }))).toBe('ASSERTION_INVALID');
    });

    test('key file location follows the documented environment', () => {
        expect(coreBridge.defaultKeyFile({ GOOBSTER_MANAGER_BRIDGE_KEY_FILE: '/k/file' })).toBe('/k/file');
        expect(coreBridge.defaultKeyFile({ GOOBSTER_MANAGER_STATE_DIR: '/s' })).toBe(path.join('/s', 'bridge-key'));
        expect(coreBridge.defaultKeyFile({ GOOBSTER_DATA_DIR: '/d' })).toBe(path.join('/d', 'manager', 'bridge-key'));
    });

    test('stronger authentication (#255) is a seam that is off', () => {
        expect(requireStrongAuth()).toBe(false);
    });

    test('the core minter imports nothing from apps', () => {
        const source = fs.readFileSync(require.resolve('@goobster/core/web/managerBridge'), 'utf8');
        const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
        expect(requires.every(name => name.startsWith('node:') || name.startsWith('../'))).toBe(true);
        expect(requires.some(name => name.includes('apps/') || name.startsWith('@goobster/'))).toBe(false);
    });
});
