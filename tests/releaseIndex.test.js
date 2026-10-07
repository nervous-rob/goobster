/**
 * The release index and its verification policy (#341, documentation/release.md): channels from tags,
 * the schema, signing with the payload manifest's key rules, every verification code under both
 * policies, the trusted key list, per-artifact signing decisions, the release-index command line and
 * the stable-build block when no active key exists. Keys are generated here, into a temp directory.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const stage = require('../scripts/lib/payloadStage');
const index = require('../scripts/lib/releaseIndex');
const cli = require('../scripts/release-index');

const { CODES } = index;
const REPO_ROOT = path.resolve(__dirname, '..');
const roots = [];

afterAll(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `goobster-rel-${label}-`));
    roots.push(dir);
    return dir;
}

function newKey(label = 'key') {
    const made = stage.generateDevKeyPair(path.join(tempDir(label), 'k'));
    return { ...made, privatePem: fs.readFileSync(made.privateKeyPath, 'utf8'), publicPem: fs.readFileSync(made.publicKeyPath, 'utf8') };
}

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const SOURCE = 'a'.repeat(40);
const LOCK = 'b'.repeat(64);

/** Write artifact files for `specs` into a fresh release directory and return their entries. */
function makeRelease(specs) {
    const dir = tempDir('release');
    const artifacts = specs.map((spec, i) => {
        const content = Buffer.from(`artifact ${i} ${spec.file}\n`);
        fs.writeFileSync(path.join(dir, spec.file), content);
        return {
            target: spec.target || 'linux-x64',
            kind: spec.kind || 'bootstrap',
            file: spec.file,
            sha256: sha(content),
            size: content.length,
            signing: spec.signing || { status: 'signed', method: 'ed25519-only', identity: '0123456789abcdef' }
        };
    });
    return { dir, artifacts };
}

function indexInput(artifacts, overrides = {}) {
    return {
        release: { core: '1.4.0', manager: '1.4.0', channel: 'stable', tag: 'v1.4.0', sourceRevision: SOURCE, lockfileSha256: LOCK, builtAt: '2026-10-01T00:00:00Z', ...(overrides.release || {}) },
        node: { version: '22.23.3', abi: 127, ...(overrides.node || {}) },
        compatibility: { minUpgradeFrom: '1.0.0', compatibleCore: '>=1.4.0 <2.0.0', ...(overrides.compatibility || {}) },
        artifacts,
        ...(overrides.extra || {})
    };
}

function signedRelease(specs, overrides = {}, key = newKey('signer')) {
    const made = makeRelease(specs);
    const built = index.buildIndex(indexInput(made.artifacts, overrides));
    const signed = index.signIndex(built, key.privatePem);
    index.writeIndex(made.dir, signed.index, signed.signature);
    return { ...made, key, index: signed.index, signature: signed.signature };
}

const SIGNED_SPECS = [{ file: 'goobster-1.4.0-linux-x64.run' }, { file: 'goobster-payload-1.4.0-linux-x64.tar.gz', kind: 'payload' }];

function expectCode(fn, code) {
    let error;
    try {
        fn();
    } catch (caught) {
        error = caught;
    }
    expect(error).toBeInstanceOf(index.ReleaseIndexError);
    expect(error.code).toBe(code);
    return error;
}

describe('channels and versions', () => {
    test.each([
        ['v1.2.3', 'stable', '1.2.3'],
        ['v1.2.3-rc.1', 'prerelease', '1.2.3-rc.1'],
        ['v1.2.3-beta.12', 'prerelease', '1.2.3-beta.12'],
        ['v1.2.3-alpha.2', 'prerelease', '1.2.3-alpha.2']
    ])('%s is %s', (tag, channel, version) => {
        expect(index.deriveChannel(tag)).toEqual({ channel, version });
    });

    test.each(['1.2.3', 'v1.2', 'v1.2.3-foo', 'v1.2.3-rc', 'v1.2.3-rc.x', 'v1.2.3+meta', 'companion-v1.2.3', '', undefined])('%p is not a release tag', (tag) => {
        expectCode(() => index.deriveChannel(tag), CODES.TAG_INVALID);
    });

    test('a workflow_dispatch build is always prerelease, even when its tag looks stable', () => {
        expect(index.deriveChannel('v1.2.3', { dispatch: true }).channel).toBe('prerelease');
        expect(index.deriveChannel('v1.2.3-dev.7', { dispatch: true }).channel).toBe('prerelease');
        expectCode(() => index.deriveChannel('main', { dispatch: true }), CODES.TAG_INVALID);
    });

    test('versions compare by semver precedence, prerelease identifiers numerically', () => {
        expect(index.compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
        expect(index.compareVersions('1.0.0-rc.10', '1.0.0')).toBe(-1);
        expect(index.compareVersions('1.0.0', '1.0.0')).toBe(0);
        expect(index.compareVersions('1.10.0', '1.9.9')).toBe(1);
        expect(index.compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
        expect(index.compareVersions('nope', '1.0.0')).toBeNull();
    });
});

describe('the index schema', () => {
    test('builds the same canonical bytes whatever order the artifacts arrive in', () => {
        const { artifacts } = makeRelease([{ file: 'b.run' }, { file: 'a.run' }, { file: 'c.pkg', target: 'darwin-arm64', kind: 'pkg' }]);
        const one = stage.canonicalJson(index.buildIndex(indexInput(artifacts)));
        const two = stage.canonicalJson(index.buildIndex(indexInput([...artifacts].reverse())));
        expect(one).toBe(two);
        expect(JSON.parse(one).artifacts.map(item => item.file)).toEqual(['c.pkg', 'a.run', 'b.run']);
    });

    test.each([
        ['an unknown target', (i) => { i.artifacts[0].target = 'linux-riscv'; }],
        ['an unknown kind', (i) => { i.artifacts[0].kind = 'dmg'; }],
        ['a file name with a directory part', (i) => { i.artifacts[0].file = '../x.run'; }],
        ['a file name with a backslash', (i) => { i.artifacts[0].file = 'a\\b.run'; }],
        ['a short digest', (i) => { i.artifacts[0].sha256 = 'abc'; }],
        ['a negative size', (i) => { i.artifacts[0].size = -1; }],
        ['a signed artifact without a method', (i) => { i.artifacts[0].signing = { status: 'signed' }; }],
        ['an unsigned artifact claiming a method', (i) => { i.artifacts[0].signing = { status: 'unsigned-dev', method: 'authenticode' }; }],
        ['an identity that is not an identifier', (i) => { i.artifacts[0].signing.identity = 'a b c'; }],
        ['no artifacts', (i) => { i.artifacts = []; }],
        ['a stable release with a prerelease tag', (i) => { i.release.tag = 'v1.4.0-rc.1'; }],
        ['a tag that does not carry the core version', (i) => { i.release.tag = 'v9.9.9'; }],
        ['a core outside its compatible range', (i) => { i.compatibility.compatibleCore = '>=2.0.0 <3.0.0'; }],
        ['an oldest upgrade newer than the release', (i) => { i.compatibility.minUpgradeFrom = '2.0.0'; }],
        ['a short source revision', (i) => { i.release.sourceRevision = 'abc'; }],
        ['an unparseable build time', (i) => { i.release.builtAt = 'yesterday'; }],
        ['a missing node abi', (i) => { delete i.node.abi; }]
    ])('refuses %s with INDEX_INVALID', (_label, mutate) => {
        const { artifacts } = makeRelease([{ file: 'a.run' }]);
        const input = JSON.parse(JSON.stringify(indexInput(artifacts)));
        mutate(input);
        const error = expectCode(() => index.buildIndex(input), CODES.INDEX_INVALID);
        expect(error.details.problems.length).toBeGreaterThan(0);
    });

    test('refuses two artifacts with one file name', () => {
        const { artifacts } = makeRelease([{ file: 'a.run' }]);
        expectCode(() => index.buildIndex(indexInput([artifacts[0], { ...artifacts[0], target: 'linux-arm64' }])), CODES.INDEX_INVALID);
    });

    test('refuses a key or certificate block anywhere in it: the index is public', () => {
        const key = newKey('leak');
        const { artifacts } = makeRelease([{ file: 'a.run' }]);
        const input = indexInput(artifacts);
        input.provenance = { note: key.privatePem };
        expectCode(() => index.buildIndex(input), CODES.INDEX_INVALID);
        input.provenance = { note: key.publicPem };
        expectCode(() => index.buildIndex(input), CODES.INDEX_INVALID);
    });

    test('a prerelease core version is allowed on the prerelease channel', () => {
        const { artifacts } = makeRelease([{ file: 'a.run' }]);
        const built = index.buildIndex(indexInput(artifacts, { release: { core: '1.4.0-rc.1', manager: '1.4.0-rc.1', channel: 'prerelease', tag: 'v1.4.0-rc.1' }, compatibility: { compatibleCore: '>=1.4.0-rc.1 <2.0.0' } }));
        expect(built.release.channel).toBe('prerelease');
    });
});

describe('signing', () => {
    test('uses the payload manifest rule: Ed25519 over the canonical bytes, key id from keyIdOf', () => {
        const key = newKey('rule');
        const release = signedRelease(SIGNED_SPECS, {}, key);
        expect(release.index.signing).toEqual({ algorithm: 'ed25519', keyId: key.keyId });
        expect(key.keyId).toBe(stage.keyIdOf(key.publicPem));
        const ok = crypto.verify(null, stage.canonicalBytes(release.index), crypto.createPublicKey(key.publicPem), Buffer.from(release.signature, 'base64'));
        expect(ok).toBe(true);
        expect(fs.readFileSync(path.join(release.dir, index.INDEX_FILE), 'utf8')).toBe(stage.canonicalJson(release.index));
    });

    test('refuses a key that is not Ed25519', () => {
        const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const { artifacts } = makeRelease([{ file: 'a.run' }]);
        expect(() => index.signIndex(index.buildIndex(indexInput(artifacts)), rsa.privateKey)).toThrow(/Ed25519/);
    });

    test('re-signing replaces the earlier signing block', () => {
        const first = signedRelease(SIGNED_SPECS);
        const second = newKey('second');
        const again = index.signIndex(first.index, second.privatePem);
        expect(again.index.signing.keyId).toBe(second.keyId);
    });
});

describe('verifyIndex: production policy', () => {
    test('accepts a signed index from a trusted key, checks every file and says nothing is unsigned', () => {
        const release = signedRelease(SIGNED_SPECS);
        const result = index.verifyIndex(release.dir, { policy: 'production', publicKey: release.key.publicPem, expectedTarget: 'linux-x64', nodeAbi: '127', currentVersion: '1.3.0' });
        expect(result).toMatchObject({ ok: true, policy: 'production', signed: true, devMode: false, label: 'release', keyId: release.key.keyId, keyStatus: 'active', channel: 'stable', core: '1.4.0', checked: 2, unsigned: [] });
    });

    test('is the default policy', () => {
        const release = signedRelease(SIGNED_SPECS);
        expectCode(() => index.verifyIndex(release.dir, {}), CODES.UNTRUSTED_KEY);
    });

    test('INDEX_UNSIGNED: no signature file', () => {
        const release = signedRelease(SIGNED_SPECS);
        fs.rmSync(path.join(release.dir, index.SIGNATURE_FILE));
        expectCode(() => index.verifyIndex(release.dir, { policy: 'production', publicKey: release.key.publicPem }), CODES.INDEX_UNSIGNED);
    });

    test('UNTRUSTED_KEY: no trusted key supplied, a different key, and a key list with nothing usable', () => {
        const release = signedRelease(SIGNED_SPECS);
        expectCode(() => index.verifyIndex(release.dir, { policy: 'production' }), CODES.UNTRUSTED_KEY);
        expectCode(() => index.verifyIndex(release.dir, { policy: 'production', publicKey: newKey('other').publicPem }), CODES.UNTRUSTED_KEY);
        expectCode(() => index.verifyIndex(release.dir, { policy: 'production', keyList: { version: 1, keys: [] } }), CODES.UNTRUSTED_KEY);
    });

    test('INDEX_BAD_SIGNATURE: a changed byte in the index, a changed signature, a signature that is not base64', () => {
        const release = signedRelease(SIGNED_SPECS);
        const file = path.join(release.dir, index.INDEX_FILE);
        const original = fs.readFileSync(file, 'utf8');
        const at = original.indexOf(release.artifacts[0].sha256);
        const flipped = `${original.slice(0, at)}${original[at] === '0' ? '1' : '0'}${original.slice(at + 1)}`;
        fs.writeFileSync(file, flipped);
        expectCode(() => index.verifyIndex(release.dir, { policy: 'production', publicKey: release.key.publicPem }), CODES.INDEX_BAD_SIGNATURE);
        fs.writeFileSync(file, original);
        const signature = Buffer.from(release.signature, 'base64');
        signature[0] ^= 0xff;
        fs.writeFileSync(path.join(release.dir, index.SIGNATURE_FILE), `${signature.toString('base64')}\n`);
        expectCode(() => index.verifyIndex(release.dir, { policy: 'production', publicKey: release.key.publicPem }), CODES.INDEX_BAD_SIGNATURE);
        fs.writeFileSync(path.join(release.dir, index.SIGNATURE_FILE), '!!not base64!!\n');
        expectCode(() => index.verifyIndex(release.dir, { policy: 'production', publicKey: release.key.publicPem }), CODES.INDEX_BAD_SIGNATURE);
    });

    test('INDEX_BAD_SIGNATURE: a signature file beside an index that names no signing key', () => {
        const release = signedRelease(SIGNED_SPECS);
        const stripped = { ...release.index };
        delete stripped.signing;
        expectCode(() => index.verifyIndex({ index: stripped, signature: release.signature }, { policy: 'production', publicKey: release.key.publicPem }), CODES.INDEX_BAD_SIGNATURE);
    });

    test('ARTIFACT_UNSIGNED: an unsigned development artifact is refused even under a valid signature', () => {
        const release = signedRelease([...SIGNED_SPECS, { file: 'dev.run', signing: { status: 'unsigned-dev', reason: 'DEV_PAYLOAD' } }]);
        const error = expectCode(() => index.verifyIndex(release.dir, { policy: 'production', publicKey: release.key.publicPem }), CODES.ARTIFACT_UNSIGNED);
        expect(error.details.files).toEqual(['dev.run']);
    });

    test('TARGET_MISMATCH: the release has no artifact for the asked-for target', () => {
        const release = signedRelease(SIGNED_SPECS);
        expectCode(() => index.verifyIndex(release.dir, { policy: 'production', publicKey: release.key.publicPem, expectedTarget: 'darwin-arm64' }), CODES.TARGET_MISMATCH);
        expectCode(() => index.verifyIndex(release.dir, { policy: 'production', publicKey: release.key.publicPem, expectedTarget: 'beos-x86' }), CODES.TARGET_MISMATCH);
    });

    test('an unsigned artifact of another target does not block the target that was asked for', () => {
        const release = signedRelease([...SIGNED_SPECS, { file: 'goobster.exe', target: 'win32-x64', kind: 'exe', signing: { status: 'unsigned-dev', reason: 'NO_AUTHENTICODE' } }]);
        const options = { policy: 'production', publicKey: release.key.publicPem };
        expectCode(() => index.verifyIndex(release.dir, options), CODES.ARTIFACT_UNSIGNED);
        expect(index.verifyIndex(release.dir, { ...options, expectedTarget: 'linux-x64' }).ok).toBe(true);
        expectCode(() => index.verifyIndex(release.dir, { ...options, expectedTarget: 'win32-x64' }), CODES.ARTIFACT_UNSIGNED);
    });

    test('ABI_MISMATCH', () => {
        const release = signedRelease(SIGNED_SPECS);
        expectCode(() => index.verifyIndex(release.dir, { policy: 'production', publicKey: release.key.publicPem, nodeAbi: 115 }), CODES.ABI_MISMATCH);
        expect(index.verifyIndex(release.dir, { policy: 'production', publicKey: release.key.publicPem, nodeAbi: 127 }).abi).toBe('127');
    });

    test('DOWNGRADE: an older release than the installed one, unless allowDowngrade is passed explicitly', () => {
        const release = signedRelease(SIGNED_SPECS);
        const options = { policy: 'production', publicKey: release.key.publicPem };
        expectCode(() => index.verifyIndex(release.dir, { ...options, currentVersion: '1.5.0' }), CODES.DOWNGRADE);
        expectCode(() => index.verifyIndex(release.dir, { ...options, currentVersion: '1.5.0', allowDowngrade: 'yes' }), CODES.DOWNGRADE);
        expect(index.verifyIndex(release.dir, { ...options, currentVersion: '1.5.0', allowDowngrade: true }).ok).toBe(true);
        expect(index.verifyIndex(release.dir, { ...options, currentVersion: '1.4.0' }).ok).toBe(true);
    });

    test('a prerelease of the same version is older than the stable release and a stable one is not a downgrade from it', () => {
        const release = signedRelease(SIGNED_SPECS, { release: { core: '1.4.0-rc.2', manager: '1.4.0-rc.2', channel: 'prerelease', tag: 'v1.4.0-rc.2' }, compatibility: { compatibleCore: '>=1.4.0-rc.2 <2.0.0' } });
        const options = { policy: 'production', publicKey: release.key.publicPem };
        expectCode(() => index.verifyIndex(release.dir, { ...options, currentVersion: '1.4.0' }), CODES.DOWNGRADE);
        expect(index.verifyIndex(release.dir, { ...options, currentVersion: '1.4.0-rc.1' }).ok).toBe(true);
    });

    test('VERSION_INCOMPATIBLE: an installed version older than the oldest the release upgrades', () => {
        const release = signedRelease(SIGNED_SPECS, { compatibility: { minUpgradeFrom: '1.2.0' } });
        const options = { policy: 'production', publicKey: release.key.publicPem };
        expectCode(() => index.verifyIndex(release.dir, { ...options, currentVersion: '1.1.9' }), CODES.VERSION_INCOMPATIBLE);
        expect(index.verifyIndex(release.dir, { ...options, currentVersion: '1.2.0' }).ok).toBe(true);
    });

    test('ARTIFACT_DIGEST_MISMATCH: a flipped byte, a truncated file, a link in its place', () => {
        const release = signedRelease(SIGNED_SPECS);
        const options = { policy: 'production', publicKey: release.key.publicPem };
        const victim = path.join(release.dir, SIGNED_SPECS[0].file);
        const original = fs.readFileSync(victim);
        const flipped = Buffer.from(original);
        flipped[0] ^= 0xff;
        fs.writeFileSync(victim, flipped);
        const error = expectCode(() => index.verifyIndex(release.dir, options), CODES.ARTIFACT_DIGEST_MISMATCH);
        expect(error.details.file).toBe(SIGNED_SPECS[0].file);
        fs.writeFileSync(victim, original.subarray(0, original.length - 1));
        expectCode(() => index.verifyIndex(release.dir, options), CODES.ARTIFACT_DIGEST_MISMATCH);
        fs.rmSync(victim);
        const decoy = path.join(release.dir, 'decoy');
        fs.writeFileSync(decoy, original);
        fs.symlinkSync(decoy, victim);
        expectCode(() => index.verifyIndex(release.dir, options), CODES.ARTIFACT_DIGEST_MISMATCH);
    });

    test('a file that is not beside the index is skipped, unless requireFiles asks for it (ARTIFACT_MISSING)', () => {
        const release = signedRelease(SIGNED_SPECS);
        fs.rmSync(path.join(release.dir, SIGNED_SPECS[1].file));
        const options = { policy: 'production', publicKey: release.key.publicPem };
        expect(index.verifyIndex(release.dir, options)).toMatchObject({ checked: 1, missing: [SIGNED_SPECS[1].file] });
        expectCode(() => index.verifyIndex(release.dir, { ...options, requireFiles: true }), CODES.ARTIFACT_MISSING);
    });

    test('INDEX_INVALID: not JSON, not an object, wrong version, missing file', () => {
        const dir = tempDir('broken');
        expectCode(() => index.verifyIndex(dir, { policy: 'development' }), CODES.INDEX_INVALID);
        fs.writeFileSync(path.join(dir, index.INDEX_FILE), '{not json');
        expectCode(() => index.verifyIndex(dir, { policy: 'development' }), CODES.INDEX_INVALID);
        fs.writeFileSync(path.join(dir, index.INDEX_FILE), '[]');
        expectCode(() => index.verifyIndex(dir, { policy: 'development' }), CODES.INDEX_INVALID);
        fs.writeFileSync(path.join(dir, index.INDEX_FILE), JSON.stringify({ version: 2 }));
        expectCode(() => index.verifyIndex(dir, { policy: 'development' }), CODES.INDEX_INVALID);
    });

    test('a bad policy or version option is a programming error, not a verdict', () => {
        const release = signedRelease(SIGNED_SPECS);
        expectCode(() => index.verifyIndex(release.dir, { policy: 'lenient' }), CODES.BAD_OPTION);
        expectCode(() => index.verifyIndex(release.dir, { policy: 'production', publicKey: release.key.publicPem, currentVersion: 'latest' }), CODES.BAD_OPTION);
    });
});

describe('verifyIndex: development policy', () => {
    test('accepts an unsigned index of unsigned-dev artifacts and labels it, as verifyPayload does', () => {
        const made = makeRelease([{ file: 'goobster-1.4.0-linux-x64-dev.run', signing: { status: 'unsigned-dev', reason: 'DEV_PAYLOAD' } }]);
        index.writeIndex(made.dir, index.buildIndex(indexInput(made.artifacts)));
        const result = index.verifyIndex(made.dir, { policy: 'development' });
        expect(result).toMatchObject({ ok: true, policy: 'development', signed: false, devMode: true, label: 'UNSIGNED DEVELOPMENT BUILD', keyId: null, unsigned: ['goobster-1.4.0-linux-x64-dev.run'] });
        expectCode(() => index.verifyIndex(made.dir, { policy: 'production' }), CODES.INDEX_UNSIGNED);
    });

    test('a signed index with no key to check it is accepted as unverified and labelled so', () => {
        const release = signedRelease(SIGNED_SPECS);
        const result = index.verifyIndex(release.dir, { policy: 'development' });
        expect(result).toMatchObject({ signed: false, devMode: true, keyId: release.key.keyId });
    });

    test('a signed index that verifies is still signed under development, with every artifact signed', () => {
        const release = signedRelease(SIGNED_SPECS);
        expect(index.verifyIndex(release.dir, { policy: 'development', publicKey: release.key.publicPem })).toMatchObject({ signed: true, devMode: false });
    });

    test('an INVALID signature with a key present is refused under development too', () => {
        const release = signedRelease(SIGNED_SPECS);
        const file = path.join(release.dir, index.INDEX_FILE);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"core": "1.4.0"', '"core": "1.4.1"').replace('"tag": "v1.4.0"', '"tag": "v1.4.1"'));
        expectCode(() => index.verifyIndex(release.dir, { policy: 'development', publicKey: release.key.publicPem }), CODES.INDEX_BAD_SIGNATURE);
    });

    test('a key that is present but is not the signer is refused under development too', () => {
        const release = signedRelease(SIGNED_SPECS);
        expectCode(() => index.verifyIndex(release.dir, { policy: 'development', publicKey: newKey('wrong').publicPem }), CODES.UNTRUSTED_KEY);
    });

    test('target, ABI, downgrade and digests are enforced in development as well', () => {
        const made = makeRelease([{ file: 'a.run', signing: { status: 'unsigned-dev' } }]);
        index.writeIndex(made.dir, index.buildIndex(indexInput(made.artifacts)));
        expectCode(() => index.verifyIndex(made.dir, { policy: 'development', expectedTarget: 'darwin-x64' }), CODES.TARGET_MISMATCH);
        expectCode(() => index.verifyIndex(made.dir, { policy: 'development', nodeAbi: 1 }), CODES.ABI_MISMATCH);
        expectCode(() => index.verifyIndex(made.dir, { policy: 'development', currentVersion: '2.0.0' }), CODES.DOWNGRADE);
        fs.appendFileSync(path.join(made.dir, 'a.run'), 'x');
        expectCode(() => index.verifyIndex(made.dir, { policy: 'development' }), CODES.ARTIFACT_DIGEST_MISMATCH);
    });
});

describe('the trusted key list', () => {
    function listWith(entries) {
        return { version: 1, keys: entries.map(({ key, status }) => ({ keyId: key.keyId, publicKeyPem: key.publicPem, status, since: '2026-10-01', note: 'test' })) };
    }

    test('the key list that ships has no active key and no private key (nothing is signed for production yet)', () => {
        const shipped = index.loadKeyList();
        expect(shipped.version).toBe(1);
        expect(shipped.keys.filter(entry => entry.status === 'active')).toEqual([]);
        expect(index.signingKeys(shipped)).toEqual([]);
        const text = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'release-keys.json'), 'utf8');
        expect(text).not.toMatch(/PRIVATE KEY/);
        expect(text).not.toMatch(/"status":\s*"active"/);
    });

    test('an active key verifies; a retired key still verifies releases it signed but is not a signing key', () => {
        const release = signedRelease(SIGNED_SPECS);
        const active = listWith([{ key: release.key, status: 'active' }]);
        expect(index.verifyIndex(release.dir, { keyList: active })).toMatchObject({ signed: true, keyStatus: 'active' });
        const retired = listWith([{ key: release.key, status: 'retired' }]);
        expect(index.verifyIndex(release.dir, { keyList: retired })).toMatchObject({ signed: true, keyStatus: 'retired' });
        expect(index.signingKeys(retired)).toEqual([]);
        expect(index.signingKeys(active).map(entry => entry.keyId)).toEqual([release.key.keyId]);
    });

    test('a revoked key is untrusted even for an old release, even when the caller also passes its public key, and under development', () => {
        const release = signedRelease(SIGNED_SPECS);
        const revoked = listWith([{ key: release.key, status: 'revoked' }]);
        const error = expectCode(() => index.verifyIndex(release.dir, { keyList: revoked }), CODES.UNTRUSTED_KEY);
        expect(error.details.revoked).toBe(true);
        expectCode(() => index.verifyIndex(release.dir, { keyList: revoked, publicKey: release.key.publicPem }), CODES.UNTRUSTED_KEY);
        expectCode(() => index.verifyIndex(release.dir, { keyList: revoked, publicKey: release.key.publicPem, policy: 'development' }), CODES.UNTRUSTED_KEY);
    });

    test('re-signing the release with a new key after a revocation verifies under the new key', () => {
        const release = signedRelease(SIGNED_SPECS);
        const replacement = newKey('replacement');
        const resigned = index.signIndex(release.index, replacement.privatePem);
        index.writeIndex(release.dir, resigned.index, resigned.signature);
        const list = listWith([{ key: release.key, status: 'revoked' }, { key: replacement, status: 'active' }]);
        expect(index.verifyIndex(release.dir, { keyList: list })).toMatchObject({ signed: true, keyId: replacement.keyId });
    });

    test.each([
        ['an entry whose keyId is not its key', (doc) => { doc.keys[0].keyId = '0000000000000000'; }],
        ['an unknown status', (doc) => { doc.keys[0].status = 'maybe'; }],
        ['a key that is not Ed25519', (doc) => { doc.keys[0].publicKeyPem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }); }],
        ['a duplicate key id', (doc) => { doc.keys.push({ ...doc.keys[0] }); }],
        ['a private key block', (doc) => { doc.keys[0].note = '-----BEGIN PRIVATE KEY-----'; }],
        ['an unreadable key', (doc) => { doc.keys[0].publicKeyPem = 'nope'; }],
        ['a wrong version', (doc) => { doc.version = 2; }]
    ])('refuses %s (KEY_LIST_INVALID)', (_label, mutate) => {
        const doc = listWith([{ key: newKey('list'), status: 'active' }]);
        mutate(doc);
        expectCode(() => index.validateKeyList(doc), CODES.KEY_LIST_INVALID);
    });
});

describe('what makes an artifact signed', () => {
    test.each([
        ['linux run with a signed payload', { target: 'linux-x64', kind: 'bootstrap', payloadSigned: true, payloadKeyId: 'abcdef0123456789' }, { status: 'signed', method: 'ed25519-only', identity: 'abcdef0123456789' }],
        ['linux payload archive', { target: 'linux-arm64', kind: 'payload', payloadSigned: true, payloadKeyId: 'abcdef0123456789' }, { status: 'signed', method: 'ed25519-only', identity: 'abcdef0123456789' }],
        ['any artifact with a development payload', { target: 'linux-x64', kind: 'bootstrap', payloadSigned: false }, { status: 'unsigned-dev', reason: 'DEV_PAYLOAD' }],
        ['windows exe without Authenticode', { target: 'win32-x64', kind: 'exe', payloadSigned: true, payloadKeyId: 'abcdef0123456789' }, { status: 'unsigned-dev', reason: 'NO_AUTHENTICODE' }],
        ['windows exe with Authenticode', { target: 'win32-x64', kind: 'exe', payloadSigned: true, platform: { method: 'authenticode', identity: 'A'.repeat(40) } }, { status: 'signed', method: 'authenticode', identity: 'A'.repeat(40) }],
        ['windows exe with the wrong platform method', { target: 'win32-x64', kind: 'exe', payloadSigned: true, platform: { method: 'apple-notarized' } }, { status: 'unsigned-dev', reason: 'NO_AUTHENTICODE' }],
        ['macos pkg that was not notarized', { target: 'darwin-arm64', kind: 'pkg', payloadSigned: true }, { status: 'unsigned-dev', reason: 'NOT_NOTARIZED' }],
        ['macos pkg notarized', { target: 'darwin-arm64', kind: 'pkg', payloadSigned: true, platform: { method: 'apple-notarized', identity: 'TEAM123456' } }, { status: 'signed', method: 'apple-notarized', identity: 'TEAM123456' }],
        ['macos per-user archive', { target: 'darwin-x64', kind: 'tarball', payloadSigned: true, payloadKeyId: 'abcdef0123456789' }, { status: 'signed', method: 'ed25519-only', identity: 'abcdef0123456789' }],
        ['a notarized pkg around a development payload', { target: 'darwin-x64', kind: 'pkg', payloadSigned: false, platform: { method: 'apple-notarized' } }, { status: 'unsigned-dev', reason: 'DEV_PAYLOAD' }]
    ])('%s', (_label, facts, expected) => {
        expect(index.decideSigning(facts)).toEqual(expected);
    });
});

describe('dependency inventory', () => {
    test('is the manifest dependencies block, sorted, with its licence summary and nothing scanned anew', () => {
        const manifest = {
            target: { id: 'linux-x64' },
            release: { core: '1.4.0' },
            node: { version: '22.23.3', abi: 127 },
            licenses: { total: 3, nonPermissive: [{ name: 'sharp', license: 'Apache-2.0' }] },
            dependencies: [
                { name: 'zod', version: '3.0.0', license: 'MIT', owners: ['core'], exclusive: false, path: 'app/node_modules/zod' },
                { name: 'discord.js', version: '14.0.0', license: 'Apache-2.0', owners: ['discord'], exclusive: true, path: 'app/node_modules/discord.js' }
            ]
        };
        const inventory = index.dependencyInventory(manifest);
        expect(inventory.dependencies.map(dep => dep.name)).toEqual(['discord.js', 'zod']);
        expect(inventory.dependencies[0]).toEqual({ name: 'discord.js', version: '14.0.0', license: 'Apache-2.0', exclusive: true, owners: ['discord'] });
        expect(inventory).toMatchObject({ target: 'linux-x64', release: '1.4.0', node: { abi: '127' }, licenses: { total: 3 } });
        expect(JSON.stringify(inventory)).not.toContain('app/node_modules');
    });
});

describe('plan: the signing mode of a run', () => {
    function listing(entries) {
        const file = path.join(tempDir('plan-keys'), 'release-keys.json');
        fs.writeFileSync(file, JSON.stringify({ version: 1, keys: entries.map(({ key, status }) => ({ keyId: key.keyId, publicKeyPem: key.publicPem, status, since: '2026-10-01', note: 't' })) }));
        return file;
    }
    const PEM_ENV = 'TEST_RELEASE_SIGNING_KEY';

    test('stable with no key is blocked (RELEASE_BLOCKED_UNSIGNED), against the shipped key list', () => {
        expect(cli.planSigning({ channel: 'stable', env: {}, keyEnv: PEM_ENV })).toMatchObject({ mode: 'blocked', keyId: null });
        expect(cli.planSigning({ channel: 'stable', env: { [PEM_ENV]: '   ' }, keyEnv: PEM_ENV }).mode).toBe('blocked');
    });

    test('stable with a key that the key list does not hold as active is blocked, and so is a retired or revoked one', () => {
        const key = newKey('plan');
        const env = { [PEM_ENV]: key.privatePem };
        expect(cli.planSigning({ channel: 'stable', env, keyEnv: PEM_ENV }).mode).toBe('blocked');
        for (const status of ['retired', 'revoked']) {
            expect(cli.planSigning({ channel: 'stable', env, keyEnv: PEM_ENV, keyListFile: listing([{ key, status }]) }).mode).toBe('blocked');
        }
    });

    test('stable with an active key signs for release', () => {
        const key = newKey('plan');
        const plan = cli.planSigning({ channel: 'stable', env: { [PEM_ENV]: key.privatePem }, keyEnv: PEM_ENV, keyListFile: listing([{ key, status: 'active' }]) });
        expect(plan).toEqual({ mode: 'release', keyId: key.keyId, reason: null });
    });

    test('prerelease proceeds as a development build without a key, and with a key the list does not hold', () => {
        expect(cli.planSigning({ channel: 'prerelease', env: {}, keyEnv: PEM_ENV })).toMatchObject({ mode: 'dev' });
        const key = newKey('plan');
        expect(cli.planSigning({ channel: 'prerelease', env: { [PEM_ENV]: key.privatePem }, keyEnv: PEM_ENV })).toMatchObject({ mode: 'dev', keyId: key.keyId });
    });

    test('a secret that is not a key is a reason, never echoed', () => {
        const garbage = 'this-is-not-a-key-but-it-is-secret-text';
        const plan = cli.planSigning({ channel: 'stable', env: { [PEM_ENV]: garbage }, keyEnv: PEM_ENV });
        expect(plan.mode).toBe('blocked');
        expect(JSON.stringify(plan)).not.toContain(garbage);
    });
});

describe('the release-index command line', () => {
    function run(args, env = {}) {
        const out = [];
        const err = [];
        const saved = {};
        for (const [name, value] of Object.entries(env)) {
            saved[name] = process.env[name];
            process.env[name] = value;
        }
        return cli.main(args, { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } }).then((status) => {
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            return { status, out: out.join(''), err: err.join('') };
        });
    }

    function stageRelease() {
        const dir = tempDir('cli');
        const entries = path.join(tempDir('cli-entries'), 'artifact-entry.json');
        const specs = [
            { file: 'goobster-1.0.0-linux-x64-dev.run', target: 'linux-x64', kind: 'bootstrap', signing: { status: 'unsigned-dev', reason: 'DEV_PAYLOAD' } },
            { file: 'goobster-payload-1.0.0-linux-x64-dev.tar.gz', target: 'linux-x64', kind: 'payload', signing: { status: 'unsigned-dev', reason: 'DEV_PAYLOAD' } }
        ];
        const made = specs.map((spec) => {
            const content = Buffer.from(`${spec.file}\n`);
            fs.writeFileSync(path.join(dir, spec.file), content);
            return { target: spec.target, kind: spec.kind, file: spec.file, sha256: sha(content), size: content.length, signing: spec.signing };
        });
        fs.writeFileSync(entries, JSON.stringify(made));
        fs.writeFileSync(path.join(dir, 'dependency-inventory-linux-x64.json'), '{"version":1}\n');
        return { dir, entries };
    }

    test('build, sign, verify and sums on a development prerelease, and the policy outcome each step claims', async () => {
        const key = newKey('cli');
        const { dir, entries } = stageRelease();
        const built = await run(['build', '--dir', dir, '--entries', entries, '--tag', 'v1.0.0-rc.1', '--source-revision', SOURCE, '--built-at', '2026-10-01T00:00:00Z']);
        expect(built.status).toBe(0);
        const document = JSON.parse(fs.readFileSync(path.join(dir, index.INDEX_FILE), 'utf8'));
        expect(document.release).toMatchObject({ channel: 'prerelease', tag: 'v1.0.0-rc.1', core: '1.0.0', sourceRevision: SOURCE });
        expect(document.release.lockfileSha256).toBe(sha(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'))));
        expect(document.node).toMatchObject({ version: expect.stringMatching(/^22\./), abi: '127' });
        expect(document.provenance.nodePin.version).toBe(document.node.version);
        expect(document.provenance.tools.winsw.version).toMatch(/\d/);
        expect(document.inventories).toEqual([{ target: 'linux-x64', file: 'dependency-inventory-linux-x64.json', sha256: sha(fs.readFileSync(path.join(dir, 'dependency-inventory-linux-x64.json'))) }]);

        const unsigned = await run(['verify', dir, '--policy', 'development']);
        expect(unsigned.status).toBe(0);
        expect(JSON.parse(unsigned.out)).toMatchObject({ ok: true, signed: false, devMode: true, label: 'UNSIGNED DEVELOPMENT BUILD' });
        const refused = await run(['verify', dir, '--policy', 'production']);
        expect(refused.status).toBe(2);
        expect(JSON.parse(refused.out)).toMatchObject({ ok: false, code: 'INDEX_UNSIGNED' });

        const signed = await run(['sign', '--dir', dir, '--key', key.privateKeyPath]);
        expect(signed.status).toBe(0);
        expect(signed.out).not.toContain('PRIVATE');
        const stillDev = await run(['verify', dir, '--policy', 'production', '--public-key', key.publicKeyPath, '--no-key-list']);
        expect(stillDev.status).toBe(2);
        expect(JSON.parse(stillDev.out).code).toBe('ARTIFACT_UNSIGNED');
        const noKey = await run(['verify', dir, '--policy', 'production']);
        expect(JSON.parse(noKey.out).code).toBe('UNTRUSTED_KEY');
        const wrongTarget = await run(['verify', dir, '--policy', 'development', '--target', 'win32-x64', '--public-key', key.publicKeyPath]);
        expect(JSON.parse(wrongTarget.out).code).toBe('TARGET_MISMATCH');
        const downgrade = await run(['verify', dir, '--policy', 'development', '--current-version', '1.1.0', '--public-key', key.publicKeyPath]);
        expect(JSON.parse(downgrade.out).code).toBe('DOWNGRADE');

        const sums = await run(['sums', '--dir', dir]);
        expect(sums.status).toBe(0);
        const lines = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
        expect(lines.map(line => line.split('  ')[1])).toEqual(['dependency-inventory-linux-x64.json', 'goobster-1.0.0-linux-x64-dev.run', 'goobster-payload-1.0.0-linux-x64-dev.tar.gz', 'release-index.json', 'release-index.sig']);
        for (const line of lines) {
            const [digest, name] = line.split('  ');
            expect(sha(fs.readFileSync(path.join(dir, name)))).toBe(digest);
        }
    });

    test('build refuses an artifact that changed after its entry was written, and a tag that is not a release tag', async () => {
        const { dir, entries } = stageRelease();
        fs.appendFileSync(path.join(dir, 'goobster-1.0.0-linux-x64-dev.run'), 'tampered');
        const changed = await run(['build', '--dir', dir, '--entries', entries, '--tag', 'v1.0.0-rc.1', '--source-revision', SOURCE]);
        expect(changed.status).toBe(2);
        expect(JSON.parse(changed.out).code).toBe('ARTIFACT_DIGEST_MISMATCH');
        const badTag = await run(['build', '--dir', dir, '--entries', entries, '--tag', 'v1.0.0-hotfix', '--source-revision', SOURCE]);
        expect(JSON.parse(badTag.out).code).toBe('TAG_INVALID');
    });

    test('build --drop-unsigned-targets withdraws a target with an unsigned artifact: entries, files and inventory', async () => {
        const dir = tempDir('drop');
        const entries = path.join(tempDir('drop-entries'), 'entries.json');
        const specs = [
            { file: 'goobster-1.0.0-linux-x64.run', target: 'linux-x64', kind: 'bootstrap', signing: { status: 'signed', method: 'ed25519-only' } },
            { file: 'goobster-1.0.0-win32-x64.exe', target: 'win32-x64', kind: 'exe', signing: { status: 'unsigned-dev', reason: 'NO_AUTHENTICODE' } },
            { file: 'goobster-payload-1.0.0-win32-x64.tar.gz', target: 'win32-x64', kind: 'payload', signing: { status: 'signed', method: 'ed25519-only' } }
        ];
        const made = specs.map((spec) => {
            const content = Buffer.from(`${spec.file}\n`);
            fs.writeFileSync(path.join(dir, spec.file), content);
            return { ...spec, sha256: sha(content), size: content.length };
        });
        fs.writeFileSync(entries, JSON.stringify(made));
        for (const target of ['linux-x64', 'win32-x64']) fs.writeFileSync(path.join(dir, `dependency-inventory-${target}.json`), '{"version":1}\n');

        const built = await run(['build', '--dir', dir, '--entries', entries, '--tag', 'v1.0.0', '--source-revision', SOURCE, '--drop-unsigned-targets']);
        expect(built.status).toBe(0);
        expect(JSON.parse(built.out)).toMatchObject({ targets: ['linux-x64'], artifacts: 1, dropped: [{ target: 'win32-x64', files: ['goobster-1.0.0-win32-x64.exe', 'goobster-payload-1.0.0-win32-x64.tar.gz'] }] });
        expect(fs.readdirSync(dir).sort()).toEqual(['dependency-inventory-linux-x64.json', 'goobster-1.0.0-linux-x64.run', 'release-index.json']);
        const document = JSON.parse(fs.readFileSync(path.join(dir, index.INDEX_FILE), 'utf8'));
        expect(document.inventories.map(item => item.target)).toEqual(['linux-x64']);
    });

    test('build without the flag keeps an unsigned target (a prerelease says so in its notes)', async () => {
        const dir = tempDir('keep');
        const entries = path.join(tempDir('keep-entries'), 'entries.json');
        const content = Buffer.from('x\n');
        fs.writeFileSync(path.join(dir, 'goobster-1.0.0-win32-x64.exe'), content);
        fs.writeFileSync(entries, JSON.stringify([{ file: 'goobster-1.0.0-win32-x64.exe', target: 'win32-x64', kind: 'exe', sha256: sha(content), size: 2, signing: { status: 'unsigned-dev', reason: 'NO_AUTHENTICODE' } }]));
        const built = await run(['build', '--dir', dir, '--entries', entries, '--tag', 'v1.0.0-rc.2', '--source-revision', SOURCE]);
        expect(JSON.parse(built.out)).toMatchObject({ artifacts: 1, dropped: [] });
    });

    test('plan: a stable tag with no key exits 2 with RELEASE_BLOCKED_UNSIGNED; a dispatch run is a prerelease development build', async () => {
        const blocked = await run(['plan', '--tag', 'v1.0.0'], { GOOBSTER_RELEASE_SIGNING_KEY_PEM: '' });
        expect(blocked.status).toBe(2);
        expect(JSON.parse(blocked.out)).toMatchObject({ channel: 'stable', mode: 'blocked', code: 'RELEASE_BLOCKED_UNSIGNED', tag: 'v1.0.0' });
        expect(blocked.err).toContain('RELEASE_BLOCKED_UNSIGNED');
        const dispatch = await run(['plan', '--tag', 'main', '--dispatch', '--run-number', '42'], { GOOBSTER_RELEASE_SIGNING_KEY_PEM: '' });
        expect(dispatch.status).toBe(0);
        expect(JSON.parse(dispatch.out)).toMatchObject({ channel: 'prerelease', mode: 'dev', tag: 'v1.0.0-dev.42', code: null });
        const output = path.join(tempDir('output'), 'out');
        await run(['plan', '--tag', 'x', '--dispatch', '--run-number', '3', '--github-output', output], { GOOBSTER_RELEASE_SIGNING_KEY_PEM: '' });
        expect(fs.readFileSync(output, 'utf8')).toBe('channel=prerelease\ntag=v1.0.0-dev.3\nversion=1.0.0\nmode=dev\nkey_id=\n');
    });

    test('plan refuses a tag whose version is not the repository version', async () => {
        const mismatch = await run(['plan', '--tag', 'v9.9.9'], { GOOBSTER_RELEASE_SIGNING_KEY_PEM: '' });
        expect(mismatch.status).toBe(2);
        expect(JSON.parse(mismatch.out).code).toBe('TAG_INVALID');
        const typo = await run(['plan', '--tag', 'v1.0.0-final'], { GOOBSTER_RELEASE_SIGNING_KEY_PEM: '' });
        expect(JSON.parse(typo.out).code).toBe('TAG_INVALID');
    });

    test('materialize-key writes the secret to a private file and prints no key material', async () => {
        const key = newKey('materialize');
        const target = path.join(tempDir('materialized'), 'release.pem');
        const result = await run(['materialize-key', '--env', 'TEST_MATERIALIZE_KEY', '--out', target], { TEST_MATERIALIZE_KEY: key.privatePem });
        expect(result.status).toBe(0);
        expect(result.out).not.toMatch(/PRIVATE|BEGIN/);
        expect(fs.readFileSync(target, 'utf8').trim()).toBe(key.privatePem.trim());
        if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o600);
        const empty = await run(['materialize-key', '--env', 'TEST_MATERIALIZE_EMPTY', '--out', target], { TEST_MATERIALIZE_EMPTY: '' });
        expect(empty.status).toBe(1);
        const exported = await run(['export-public', '--key', target, '--out', path.join(path.dirname(target), 'pub.pem')]);
        expect(JSON.parse(exported.out).keyId).toBe(key.keyId);
    });

    test('notes: a partial, unsigned prerelease says so, and a signed complete one does not', async () => {
        const { dir, entries } = stageRelease();
        await run(['build', '--dir', dir, '--entries', entries, '--tag', 'v1.0.0-rc.1', '--source-revision', SOURCE]);
        const notes = path.join(dir, 'notes.md');
        const partial = await run(['notes', '--dir', dir, '--expected', 'linux-x64,linux-arm64,win32-x64', '--out', notes]);
        expect(JSON.parse(partial.out)).toMatchObject({ partial: true, unsigned: true });
        const body = fs.readFileSync(notes, 'utf8');
        expect(body).toContain('UNSIGNED DEVELOPMENT BUILD');
        expect(body).toContain('PARTIAL RELEASE');
        expect(body).toContain('`linux-arm64`, `win32-x64`');
        expect(body).toMatch(/\| `linux-x64` \| `goobster-1\.0\.0-linux-x64-dev\.run` \| bootstrap \| unsigned development build \(DEV_PAYLOAD\) \|/);

        const complete = signedRelease([{ file: 'a.run' }], { release: { core: '1.0.0', manager: '1.0.0', tag: 'v1.0.0' }, compatibility: { compatibleCore: '>=1.0.0 <2.0.0' } });
        const clean = await run(['notes', '--dir', complete.dir, '--expected', 'linux-x64', '--out', notes]);
        expect(JSON.parse(clean.out)).toMatchObject({ partial: false, unsigned: false });
    });

    test('usage errors exit 1 and an unknown command prints the usage', async () => {
        expect((await run([])).status).toBe(0);
        expect((await run(['frobnicate'])).status).toBe(1);
        expect((await run(['verify'])).status).toBe(1);
        expect((await run(['sign', '--dir'])).status).toBe(1);
    });
});
