/**
 * What the manager does with the release trust contract (#341, documentation/release.md): the verification
 * policy an install runs under, release-index verification mapped to ManagerError codes, what an installed
 * payload says about itself, and the `signed` / `keyId` / `channel` fields on GET /install/record. Keys are
 * generated here, into a temp directory; nothing is downloaded and nothing is applied.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { ManagerError } = require('@goobster/manager/errors');
const { createManagerApp } = require('@goobster/manager/server');
const extensions = require('@goobster/manager/extensions');
const release = require('@goobster/manager/install/release');
const stage = require('../scripts/lib/payloadStage');
const index = require('../scripts/lib/releaseIndex');
const { makeRelease, newHarness, drive, tempDir, silent } = require('./helpers/installFixture');

const cleanup = [];
const servers = [];

afterAll(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

const scratch = (label) => tempDir(cleanup, label);

function newKey(label) {
    const made = stage.generateDevKeyPair(path.join(scratch(label), 'k'));
    return { ...made, privatePem: fs.readFileSync(made.privateKeyPath, 'utf8') };
}

function indexDir(key, { channel = 'stable', core = '1.4.0', target = 'linux-x64' } = {}) {
    const dir = scratch('index');
    const body = Buffer.from('bootstrapper\n');
    fs.writeFileSync(path.join(dir, `goobster-${core}-${target}.run`), body);
    const built = index.buildIndex({
        release: { core, manager: core, channel, tag: `v${core}`, sourceRevision: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64), builtAt: '2026-10-01T00:00:00Z' },
        node: { version: '22.23.3', abi: 127 },
        compatibility: { minUpgradeFrom: '1.0.0', compatibleCore: '>=1.4.0 <2.0.0' },
        artifacts: [{
            target,
            kind: 'bootstrap',
            file: `goobster-${core}-${target}.run`,
            sha256: require('node:crypto').createHash('sha256').update(body).digest('hex'),
            size: body.length,
            signing: { status: 'signed', method: 'ed25519-only', identity: key.keyId }
        }]
    });
    const signed = index.signIndex(built, key.privatePem);
    index.writeIndex(dir, signed.index, signed.signature);
    return dir;
}

describe('trustPolicy', () => {
    test.each([
        ['no input and no environment', undefined, {}, 'production'],
        ['an empty input', {}, {}, 'production'],
        ['allowUnsigned true', { allowUnsigned: true }, {}, 'development'],
        ['allowUnsigned false', { allowUnsigned: false }, {}, 'production'],
        ['the development environment switch', {}, { GOOBSTER_PAYLOAD_DEV_UNSIGNED: '1' }, 'development'],
        ['the switch set to something other than 1', {}, { GOOBSTER_PAYLOAD_DEV_UNSIGNED: 'true' }, 'production'],
        ['an explicit allowUnsigned false over the switch', { allowUnsigned: false }, { GOOBSTER_PAYLOAD_DEV_UNSIGNED: '1' }, 'production'],
        ['an explicit allowUnsigned true without the switch', { allowUnsigned: true }, {}, 'development']
    ])('%s is %s', (_label, input, env, expected) => {
        expect(release.trustPolicy(input, env)).toBe(expected);
    });
});

describe('verifyReleaseIndex', () => {
    test('accepts a release signed by a trusted key under the production policy', () => {
        const key = newKey('trusted');
        const dir = indexDir(key);
        const result = release.verifyReleaseIndex(dir, { release: { publicKeyFiles: [key.publicKeyPath] }, env: {}, expectedTarget: 'linux-x64' });
        expect(result.signed).toBe(true);
        expect(result.devMode).toBeFalsy();
    });

    test('refuses an index nobody can verify, with the index code on a ManagerError', () => {
        const key = newKey('signer');
        const dir = indexDir(key);
        let error;
        try {
            release.verifyReleaseIndex(dir, { env: {}, expectedTarget: 'linux-x64' });
        } catch (thrown) {
            error = thrown;
        }
        expect(error).toBeInstanceOf(ManagerError);
        expect(error.status).toBe(409);
        expect(Object.values(index.CODES)).toContain(error.code);
    });

    test('refuses an index signed by a key that is not trusted', () => {
        const key = newKey('signer');
        const other = newKey('other');
        const dir = indexDir(key);
        expect(() => release.verifyReleaseIndex(dir, { release: { publicKeyFiles: [other.publicKeyPath] }, env: {} }))
            .toThrow(expect.objectContaining({ code: index.CODES.UNTRUSTED_KEY, status: 409 }));
    });

    test('refuses a bad signature under both policies', () => {
        const key = newKey('signer');
        const dir = indexDir(key);
        const file = path.join(dir, index.INDEX_FILE);
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        doc.release.builtAt = '2026-10-02T00:00:00Z';
        fs.writeFileSync(file, JSON.stringify(doc));
        for (const policy of [{ allowUnsigned: false }, { allowUnsigned: true }]) {
            expect(() => release.verifyReleaseIndex(dir, { release: { ...policy, publicKeyFiles: [key.publicKeyPath] }, env: {} }))
                .toThrow(expect.objectContaining({ code: index.CODES.INDEX_BAD_SIGNATURE }));
        }
    });

    test('refuses a target the index does not carry and a downgrade', () => {
        const key = newKey('signer');
        const dir = indexDir(key);
        const options = { release: { publicKeyFiles: [key.publicKeyPath] }, env: {} };
        expect(() => release.verifyReleaseIndex(dir, { ...options, expectedTarget: 'darwin-arm64' }))
            .toThrow(expect.objectContaining({ code: index.CODES.TARGET_MISMATCH }));
        expect(() => release.verifyReleaseIndex(dir, { ...options, expectedTarget: 'linux-x64', currentVersion: '1.9.0' }))
            .toThrow(expect.objectContaining({ code: index.CODES.DOWNGRADE }));
    });

    test('names an artifact by its bare file name only, never a directory', () => {
        const key = newKey('signer');
        const dir = indexDir(key);
        fs.rmSync(path.join(dir, 'goobster-1.4.0-linux-x64.run'));
        let error;
        try {
            release.verifyReleaseIndex(dir, { release: { publicKeyFiles: [key.publicKeyPath] }, env: {}, requireFiles: true });
        } catch (thrown) {
            error = thrown;
        }
        expect(error.code).toBe(index.CODES.ARTIFACT_MISSING);
        expect(error.message).toContain('goobster-1.4.0-linux-x64.run');
        expect(error.message).not.toContain(dir);
    });

    test('mapIndexError leaves an error that is not the index\'s own alone', () => {
        const plain = new Error('boom');
        expect(release.mapIndexError(plain)).toBe(plain);
    });
});

describe('installedTrust', () => {
    function codeRootWith(manifest, signature) {
        const root = scratch('code');
        const current = path.join(root, 'current');
        fs.mkdirSync(current, { recursive: true });
        if (manifest) fs.writeFileSync(path.join(current, stage.MANIFEST_FILE), JSON.stringify(manifest));
        if (signature) fs.writeFileSync(path.join(current, stage.SIGNATURE_FILE), `${signature}\n`);
        return root;
    }

    test('reports nothing when there is no code root or no readable manifest', () => {
        const none = { signed: null, keyId: null, channel: null };
        expect(release.installedTrust(null)).toEqual(none);
        expect(release.installedTrust(scratch('empty'))).toEqual(none);
        expect(release.installedTrust(codeRootWith(null))).toEqual(none);
        const corrupt = scratch('corrupt');
        fs.mkdirSync(path.join(corrupt, 'current'));
        fs.writeFileSync(path.join(corrupt, 'current', stage.MANIFEST_FILE), '{not json');
        expect(release.installedTrust(corrupt)).toEqual(none);
    });

    test('an unsigned payload is signed:false with no key', () => {
        const root = codeRootWith({ release: { core: '1.4.0' } });
        expect(release.installedTrust(root)).toEqual({ signed: false, keyId: null, channel: 'stable' });
    });

    test('a signed payload names its key; a signing block without the signature file is not signed', () => {
        const manifest = { release: { core: '1.5.0-rc.1' }, signing: { algorithm: 'ed25519', keyId: '0123456789abcdef' } };
        expect(release.installedTrust(codeRootWith(manifest, 'c2ln'))).toEqual({ signed: true, keyId: '0123456789abcdef', channel: 'prerelease' });
        expect(release.installedTrust(codeRootWith(manifest))).toMatchObject({ signed: false, keyId: '0123456789abcdef' });
    });

    test('a core version that is not a version has no channel', () => {
        expect(release.installedTrust(codeRootWith({ release: { core: 'latest' } })).channel).toBeNull();
    });
});

describe('GET /install/record carries the installed payload trust', () => {
    async function installed(signingKey) {
        const root = scratch('trust-root');
        const source = makeRelease(scratch('trust-src'));
        let input = { source: source.dir, features: ['tavern'], release: { allowUnsigned: true } };
        if (signingKey) {
            const signed = stage.signManifest(source.manifest, signingKey.privatePem);
            stage.writeManifest(source.dir, signed.manifest, signed.signature);
            input = { source: source.dir, features: ['tavern'], release: { publicKeyFiles: [signingKey.publicKeyPath] } };
        }
        const harness = await newHarness({ root, installDeps: { sourceCandidates: [source.dir] } });
        const claim = await harness.manager.engine.run('claim', { label: 'Operator' }, { principal: null, via: 'bootstrap' });
        const app = createManagerApp(harness.manager, { logger: silent, mounts: extensions.routes });
        const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        servers.push(server);
        await drive(harness, 'install.new', input);
        const get = () => new Promise((resolve, reject) => {
            const req = http.request({
                agent: false,
                host: '127.0.0.1',
                port: server.address().port,
                path: '/manager/api/install/record',
                headers: { host: `127.0.0.1:${server.address().port}`, authorization: `Bearer ${claim.result.session.token}` }
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data), text: data }));
            });
            req.on('error', reject);
            req.end();
        });
        return { get, harness };
    }

    test('an unsigned development install says signed:false and no key', async () => {
        const { get } = await installed(null);
        const res = await get();
        expect(res.status).toBe(200);
        expect(res.body.record.release).toMatchObject({ version: '2.4.0', signed: false, keyId: null, channel: 'stable' });
    });

    test('a signed install says signed:true with the key id and nothing secret', async () => {
        const key = newKey('record-key');
        const { get } = await installed(key);
        const res = await get();
        expect(res.status).toBe(200);
        expect(res.body.record.release).toMatchObject({ signed: true, keyId: key.keyId, channel: 'stable' });
        expect(res.text).not.toContain('PRIVATE KEY');
        expect(res.text).not.toContain(key.privateKeyPath);
    });
});
