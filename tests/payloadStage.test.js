/**
 * Verification, staging and activation of payloads (#328,
 * documentation/packaging.md): every refusal code, signatures and the
 * development-mode label, selections, an interrupted stage, and an
 * activation that never leaves a half-swapped `current`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const stage = require('../scripts/lib/payloadStage');

const { CODES } = stage;
const REPO_ROOT = path.resolve(__dirname, '..');
const SIGN_CLI = path.join(REPO_ROOT, 'scripts', 'package-sign.js');

const FILES = [
    ['runtime/bin/node', 'core', 'node-binary', { mode: 0o755 }],
    ['bin/goobster-api', 'core', '#!/bin/sh\n', { mode: 0o755 }],
    ['app/node_modules/@goobster/core/index.js', 'core', 'module.exports = {};\n'],
    ['app/node_modules/@goobster/core/services/privacyService.js', 'core', 'exports.forget = 1;\n'],
    ['app/node_modules/@goobster/core/services/voice/session.js', 'voice', 'exports.voice = 1;\n'],
    ['app/node_modules/@goobster/core/services/music/player.js', 'music', 'exports.music = 1;\n'],
    ['app/node_modules/@goobster/core/services/tavern/game.js', 'tavern', 'exports.tavern = 1;\n'],
    ['app/node_modules/discord.js/index.js', 'discord', 'exports.Client = 1;\n', { dependency: 'discord.js' }],
    ['app/node_modules/opusscript/index.js', 'core', 'exports.opus = 1;\n', { dependency: 'opusscript' }],
    ['app/node_modules/better-sqlite3/index.js', 'core', 'exports.db = 1;\n', { dependency: 'better-sqlite3' }],
    ['app/apps/web/dist/index.html', 'core', '<html></html>\n'],
    ['app/apps/web/dist/assets/feature-tavern-TavernRoom-abc123.js', 'tavern', 'export default 1;\n'],
    ['app/apps/web/dist/assets/feature-tavern-TavernRoom-abc123.js.map', 'tavern', '{}\n']
];

const GROUPS = {
    core: { files: [], dependencies: ['better-sqlite3'], system: [] },
    discord: { files: [], dependencies: ['discord.js', 'opusscript'], requires: [], frontend: [], system: [] },
    voice: { files: [], dependencies: ['opusscript'], requires: [], frontend: [], system: [{ name: 'ffmpeg', kind: 'binary' }] },
    music: { files: [], dependencies: ['opusscript'], requires: ['voice'], frontend: [], system: [{ name: 'ffmpeg', kind: 'binary' }] },
    tavern: { files: [], dependencies: [], requires: [], frontend: ['tavern'], system: [] }
};

const DEPENDENCIES = [
    { name: 'better-sqlite3', version: '12.0.0', path: 'app/node_modules/better-sqlite3', owners: ['core'], exclusive: false },
    { name: 'discord.js', version: '14.0.0', path: 'app/node_modules/discord.js', owners: ['discord'], exclusive: true },
    { name: 'opusscript', version: '0.1.0', path: 'app/node_modules/opusscript', owners: ['discord', 'music', 'voice'], exclusive: false }
];

const roots = [];
afterAll(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `goobster-stage-${label}-`));
    roots.push(dir);
    return dir;
}

function sha(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

/** A full release payload: every file on disk, the canonical manifest beside it, unsigned. */
function makeRelease({ core = '2.4.0', target = 'linux-x64', abi = '127', groups = GROUPS } = {}) {
    const dir = tempDir('release');
    const files = [];
    for (const [rel, owner, content, extra = {}] of FILES) {
        const full = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, { mode: extra.mode || 0o644 });
        files.push({ path: rel, size: Buffer.byteLength(content), sha256: sha(content), owner, ...(extra.dependency ? { dependency: extra.dependency } : {}) });
    }
    const filled = JSON.parse(JSON.stringify(groups));
    for (const file of files) if (!file.dependency) filled[file.owner].files.push(file.path);
    const manifest = {
        version: 1,
        release: { core, compatibleCore: `>=${core} <3.0.0` },
        target: { id: target, platform: target.split('-')[0], arch: target.split('-')[1] },
        node: { version: '22.23.3', abi },
        groups: filled,
        files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
        dependencies: DEPENDENCIES,
        frontend: { chunks: [{ file: 'assets/feature-tavern-TavernRoom-abc123.js', feature: 'tavern' }] },
        unreferenced: []
    };
    stage.writeManifest(dir, manifest);
    return { dir, manifest };
}

function keypair() {
    return crypto.generateKeyPairSync('ed25519');
}

function signRelease(release, privateKey) {
    const signed = stage.signManifest(release.manifest, privateKey);
    stage.writeManifest(release.dir, signed.manifest, signed.signature);
    release.manifest = signed.manifest;
    return release;
}

function codeOf(fn) {
    try {
        fn();
    } catch (error) {
        if (error instanceof stage.PayloadError) return error.code;
        throw error;
    }
    return 'OK';
}

function treeDigest(dir) {
    const { files } = stage.walkTree(dir);
    return [...files.keys()].sort().map(rel => `${rel}:${stage.sha256File(files.get(rel).full)}`).join('\n');
}

const DEV = { devMode: true };

describe('verifyPayload: signatures and development mode', () => {
    test('an unsigned payload passes only in development mode, and says so', () => {
        const { dir } = makeRelease();
        expect(codeOf(() => stage.verifyPayload(dir, { devMode: false }))).toBe(CODES.UNSIGNED_DEV_ONLY);
        const result = stage.verifyPayload(dir, DEV);
        expect(result).toMatchObject({ ok: true, signed: false, devMode: true, keyId: null, target: 'linux-x64', abi: '127', core: '2.4.0' });
        expect(result.features).toEqual(['core', 'discord', 'music', 'tavern', 'voice']);
        expect(result.files).toBe(FILES.length);
        expect(result.releaseId).toMatch(/^2\.4\.0-linux-x64-[0-9a-f]{12}$/);
    });

    test('GOOBSTER_PAYLOAD_DEV_UNSIGNED=1 is the default for devMode', () => {
        const { dir } = makeRelease();
        const before = process.env.GOOBSTER_PAYLOAD_DEV_UNSIGNED;
        try {
            delete process.env.GOOBSTER_PAYLOAD_DEV_UNSIGNED;
            expect(codeOf(() => stage.verifyPayload(dir))).toBe(CODES.UNSIGNED_DEV_ONLY);
            process.env.GOOBSTER_PAYLOAD_DEV_UNSIGNED = '1';
            expect(stage.verifyPayload(dir)).toMatchObject({ signed: false, devMode: true });
        } finally {
            if (before === undefined) delete process.env.GOOBSTER_PAYLOAD_DEV_UNSIGNED;
            else process.env.GOOBSTER_PAYLOAD_DEV_UNSIGNED = before;
        }
    });

    test('an Ed25519 signature over the canonical bytes verifies against the pinned key', () => {
        const { privateKey, publicKey } = keypair();
        const release = signRelease(makeRelease(), privateKey);
        const pem = publicKey.export({ type: 'spki', format: 'pem' });
        const result = stage.verifyPayload(release.dir, { publicKey: pem });
        expect(result).toMatchObject({ signed: true, devMode: false, keyId: stage.keyIdOf(publicKey) });
        const other = keypair().publicKey;
        expect(stage.verifyPayload(release.dir, { publicKey: [other, pem] }).signed).toBe(true);

        const sig = fs.readFileSync(path.join(release.dir, stage.SIGNATURE_FILE), 'utf8').trim();
        expect(crypto.verify(null, Buffer.from(stage.canonicalJson(release.manifest)), publicKey, Buffer.from(sig, 'base64'))).toBe(true);
        expect(fs.readFileSync(path.join(release.dir, stage.MANIFEST_FILE), 'utf8')).toBe(stage.canonicalJson(release.manifest));
    });

    test('a wrong, absent or unpinned key, a changed manifest and a garbled signature are refused, even in development mode', () => {
        const { privateKey, publicKey } = keypair();
        const release = signRelease(makeRelease(), privateKey);
        expect(codeOf(() => stage.verifyPayload(release.dir, { publicKey: keypair().publicKey }))).toBe(CODES.SIGNATURE_INVALID);
        expect(codeOf(() => stage.verifyPayload(release.dir, { devMode: false }))).toBe(CODES.SIGNATURE_INVALID);
        expect(stage.verifyPayload(release.dir, DEV)).toMatchObject({ signed: false, devMode: true, keyId: stage.keyIdOf(publicKey) });

        const manifestPath = path.join(release.dir, stage.MANIFEST_FILE);
        const original = fs.readFileSync(manifestPath, 'utf8');
        const edited = JSON.parse(original);
        edited.release.compatibleCore = '>=0.0.0';
        fs.writeFileSync(manifestPath, JSON.stringify(edited));
        expect(codeOf(() => stage.verifyPayload(release.dir, { publicKey }))).toBe(CODES.SIGNATURE_INVALID);
        expect(codeOf(() => stage.verifyPayload(release.dir, { publicKey, devMode: true }))).toBe(CODES.SIGNATURE_INVALID);

        fs.writeFileSync(manifestPath, JSON.stringify(JSON.parse(original)));
        expect(stage.verifyPayload(release.dir, { publicKey }).signed).toBe(true);

        const sigPath = path.join(release.dir, stage.SIGNATURE_FILE);
        fs.writeFileSync(sigPath, 'not base64 !!\n');
        expect(codeOf(() => stage.verifyPayload(release.dir, { publicKey }))).toBe(CODES.SIGNATURE_INVALID);
        fs.rmSync(sigPath);
        expect(codeOf(() => stage.verifyPayload(release.dir, { publicKey }))).toBe(CODES.SIGNATURE_MISSING);
    });
});

describe('verifyPayload: the manifest and its paths', () => {
    test('a missing, unparseable or wrong-version manifest is refused', () => {
        const { dir, manifest } = makeRelease();
        const manifestPath = path.join(dir, stage.MANIFEST_FILE);
        fs.writeFileSync(manifestPath, '{ not json');
        expect(codeOf(() => stage.verifyPayload(dir, DEV))).toBe(CODES.MANIFEST_INVALID);
        fs.writeFileSync(manifestPath, stage.canonicalJson({ ...manifest, version: 2 }));
        expect(codeOf(() => stage.verifyPayload(dir, DEV))).toBe(CODES.MANIFEST_INVALID);
        fs.rmSync(manifestPath);
        expect(codeOf(() => stage.verifyPayload(dir, DEV))).toBe(CODES.MANIFEST_MISSING);
        expect(codeOf(() => stage.verifyPayload(path.join(dir, 'nope'), DEV))).toBe(CODES.MANIFEST_MISSING);
    });

    test.each([
        ['parent segment', '../outside.js'],
        ['nested parent segment', 'app/../../outside.js'],
        ['absolute', '/etc/passwd'],
        ['drive letter', 'C:/Windows/system.ini'],
        ['NUL', 'app/a\0b.js'],
        ['backslash', 'app\\..\\..\\outside.js'],
        ['dot segment', 'app/./x.js']
    ])('a manifest path with a %s is PATH_TRAVERSAL, before any signature work', (_label, bad) => {
        const { dir, manifest } = makeRelease();
        const edited = { ...manifest, files: [...manifest.files, { path: bad, size: 1, sha256: sha('x'), owner: 'core' }] };
        stage.writeManifest(dir, edited);
        expect(codeOf(() => stage.verifyPayload(dir, { devMode: false }))).toBe(CODES.PATH_TRAVERSAL);
        expect(stage.unsafePathReason(bad)).not.toBeNull();
    });

    test('a link leaving the payload root is LINK_ESCAPES_ROOT; one inside it is an EXTRA_FILE', () => {
        const outside = tempDir('outside');
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
        const { dir } = makeRelease();
        fs.symlinkSync(outside, path.join(dir, 'app', 'escape'));
        expect(codeOf(() => stage.verifyPayload(dir, DEV))).toBe(CODES.LINK_ESCAPES_ROOT);
        fs.rmSync(path.join(dir, 'app', 'escape'));
        fs.symlinkSync('../../../../../../../../../../etc/hostname', path.join(dir, 'app', 'relative-escape'));
        expect(codeOf(() => stage.verifyPayload(dir, DEV))).toBe(CODES.LINK_ESCAPES_ROOT);
        fs.rmSync(path.join(dir, 'app', 'relative-escape'));
        fs.symlinkSync('index.html', path.join(dir, 'app', 'apps', 'web', 'dist', 'alias.html'));
        expect(codeOf(() => stage.verifyPayload(dir, DEV))).toBe(CODES.EXTRA_FILE);
    });

    test('a payload for another target or Node ABI is refused', () => {
        const { dir } = makeRelease();
        expect(codeOf(() => stage.verifyPayload(dir, { ...DEV, expectedTarget: 'win32-x64' }))).toBe(CODES.TARGET_MISMATCH);
        expect(codeOf(() => stage.verifyPayload(dir, { ...DEV, nodeAbi: '115' }))).toBe(CODES.ABI_MISMATCH);
        expect(stage.verifyPayload(dir, { ...DEV, expectedTarget: 'linux-x64', nodeAbi: 127 }).ok).toBe(true);
    });

    test('incompatible core and feature versions are VERSION_INCOMPATIBLE', () => {
        const { dir } = makeRelease();
        expect(codeOf(() => stage.verifyPayload(dir, { ...DEV, coreVersion: '3.0.0' }))).toBe(CODES.VERSION_INCOMPATIBLE);
        expect(codeOf(() => stage.verifyPayload(dir, { ...DEV, coreVersion: '2.3.9' }))).toBe(CODES.VERSION_INCOMPATIBLE);
        expect(stage.verifyPayload(dir, { ...DEV, coreVersion: '2.9.1' }).ok).toBe(true);

        const groups = JSON.parse(JSON.stringify(GROUPS));
        groups.tavern.compatibleCore = '>=2.5.0';
        const narrow = makeRelease({ groups });
        expect(codeOf(() => stage.verifyPayload(narrow.dir, DEV))).toBe(CODES.VERSION_INCOMPATIBLE);
        fs.writeFileSync(path.join(narrow.dir, stage.SELECTION_FILE), JSON.stringify({ version: 1, features: ['voice'] }));
        for (const rel of ['app/node_modules/@goobster/core/services/tavern/game.js', 'app/apps/web/dist/assets/feature-tavern-TavernRoom-abc123.js',
            'app/apps/web/dist/assets/feature-tavern-TavernRoom-abc123.js.map', 'app/node_modules/@goobster/core/services/music/player.js',
            'app/node_modules/discord.js/index.js']) fs.rmSync(path.join(narrow.dir, rel));
        expect(stage.verifyPayload(narrow.dir, DEV).features).toEqual(['core', 'voice']);

        const broken = makeRelease();
        stage.writeManifest(broken.dir, { ...broken.manifest, release: { core: '2.4.0', compatibleCore: '>=2.5.0' } });
        expect(codeOf(() => stage.verifyPayload(broken.dir, DEV))).toBe(CODES.VERSION_INCOMPATIBLE);
    });
});

describe('verifyPayload: the files', () => {
    test('a missing file, a flipped byte and a truncated file are INCOMPLETE', () => {
        const flip = makeRelease();
        const target = path.join(flip.dir, 'app', 'node_modules', '@goobster', 'core', 'index.js');
        const bytes = fs.readFileSync(target);
        bytes[3] ^= 0x01;
        fs.writeFileSync(target, bytes);
        expect(codeOf(() => stage.verifyPayload(flip.dir, DEV))).toBe(CODES.INCOMPLETE);
        expect(stage.verifyPayload(flip.dir, { ...DEV, hash: false }).ok).toBe(true);

        const truncate = makeRelease();
        fs.truncateSync(path.join(truncate.dir, 'runtime', 'bin', 'node'), 4);
        expect(codeOf(() => stage.verifyPayload(truncate.dir, DEV))).toBe(CODES.INCOMPLETE);

        const missing = makeRelease();
        fs.rmSync(path.join(missing.dir, 'app', 'node_modules', 'opusscript', 'index.js'));
        let error;
        try { stage.verifyPayload(missing.dir, DEV); } catch (caught) { error = caught; }
        expect(error.code).toBe(CODES.INCOMPLETE);
        expect(error.details).toMatchObject({ missing: ['app/node_modules/opusscript/index.js'], missingCount: 1, changedCount: 0 });
    });

    test('a file the manifest does not list, or one from a feature this copy does not carry, is an EXTRA_FILE', () => {
        const added = makeRelease();
        fs.writeFileSync(path.join(added.dir, 'app', 'node_modules', '@goobster', 'core', 'injected.js'), 'x');
        expect(codeOf(() => stage.verifyPayload(added.dir, DEV))).toBe(CODES.EXTRA_FILE);

        const reduced = makeRelease();
        fs.writeFileSync(path.join(reduced.dir, stage.SELECTION_FILE), JSON.stringify({ version: 1, features: [] }));
        let error;
        try { stage.verifyPayload(reduced.dir, DEV); } catch (caught) { error = caught; }
        expect(error.code).toBe(CODES.EXTRA_FILE);
        expect(error.message).toMatch(/belong to features this copy does not carry/);
    });

    test('a selection naming an unknown feature is MANIFEST_INVALID; a selection pulls in what it requires', () => {
        const { dir, manifest } = makeRelease();
        fs.writeFileSync(path.join(dir, stage.SELECTION_FILE), JSON.stringify({ version: 1, features: ['warp-drive'] }));
        expect(codeOf(() => stage.verifyPayload(dir, DEV))).toBe(CODES.MANIFEST_INVALID);
        const music = stage.selectPayload(manifest, { features: ['music'] });
        expect(music.features).toEqual(['core', 'music', 'voice']);
        expect(music.dependencies).toEqual(['app/node_modules/better-sqlite3', 'app/node_modules/opusscript']);
        expect(music.excluded.dependencies).toEqual(['app/node_modules/discord.js']);
        expect(music.excluded.chunks).toEqual(['assets/feature-tavern-TavernRoom-abc123.js']);
    });
});

describe('stageSelection', () => {
    test('stages only the selected files into <releaseId>-<random>/, keeps the signature, and writes the selection', () => {
        const { privateKey, publicKey } = keypair();
        const release = signRelease(makeRelease(), privateKey);
        const stagingRoot = tempDir('staging');
        const staged = stage.stageSelection(release.dir, stagingRoot, { features: ['voice'], profile: 'custom' }, { publicKey });
        const releaseId = stage.releaseIdOf(release.manifest);
        expect(path.basename(staged.stagingDir)).toMatch(new RegExp(`^${releaseId.replace(/\./g, '\\.')}-[0-9a-f]{8}$`));
        expect(staged.features).toEqual(['core', 'voice']);
        expect(staged.verified).toMatchObject({ signed: true, devMode: false, profile: 'custom' });

        const present = (rel) => fs.existsSync(path.join(staged.stagingDir, ...rel.split('/')));
        expect(present('app/node_modules/@goobster/core/services/voice/session.js')).toBe(true);
        expect(present('app/node_modules/opusscript/index.js')).toBe(true);
        expect(present('app/node_modules/@goobster/core/services/music/player.js')).toBe(false);
        expect(present('app/node_modules/@goobster/core/services/tavern/game.js')).toBe(false);
        expect(present('app/node_modules/discord.js')).toBe(false);
        expect(present('app/apps/web/dist/assets/feature-tavern-TavernRoom-abc123.js')).toBe(false);
        expect(present('app/apps/web/dist/assets/feature-tavern-TavernRoom-abc123.js.map')).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(staged.stagingDir, ...stage.INSTALLED_FEATURES_FILE.split('/')), 'utf8'))).toEqual({ version: 1, features: ['voice'] });
        expect(JSON.parse(fs.readFileSync(path.join(staged.stagingDir, stage.SELECTION_FILE), 'utf8'))).toEqual({ version: 1, profile: 'custom', features: ['core', 'voice'] });
        expect(fs.statSync(path.join(staged.stagingDir, 'runtime', 'bin', 'node')).mode & 0o777).toBe(0o755);
        expect(stage.listStaging(stagingRoot)).toEqual({ ready: [staged.stagingDir], partial: [] });
    });

    test('a selection the sources do not carry is SELECTION_UNAVAILABLE; a second source fills it in', () => {
        const full = makeRelease();
        const stagingRoot = tempDir('staging');
        const minimal = stage.stageSelection(full.dir, stagingRoot, { features: [] }, DEV);
        expect(codeOf(() => stage.stageSelection(minimal.stagingDir, stagingRoot, { features: ['tavern'] }, DEV))).toBe(CODES.SELECTION_UNAVAILABLE);
        const both = stage.stageSelection([minimal.stagingDir, full.dir], stagingRoot, { features: ['tavern'] }, DEV);
        expect(both.features).toEqual(['core', 'tavern']);
        expect(fs.existsSync(path.join(both.stagingDir, 'app', 'apps', 'web', 'dist', 'assets', 'feature-tavern-TavernRoom-abc123.js'))).toBe(true);
    });

    test('a tampered source never stages', () => {
        const full = makeRelease();
        fs.appendFileSync(path.join(full.dir, 'app', 'node_modules', '@goobster', 'core', 'index.js'), '// changed\n');
        const stagingRoot = tempDir('staging');
        expect(codeOf(() => stage.stageSelection(full.dir, stagingRoot, { features: [] }, DEV))).toBe(CODES.INCOMPLETE);
        expect(stage.listStaging(stagingRoot)).toEqual({ ready: [], partial: [] });
    });

    test('an interrupted stage leaves current untouched and a recognisable, removable .partial directory', () => {
        const release = makeRelease();
        const stagingRoot = tempDir('staging');
        const installRoot = tempDir('install');
        const first = stage.stageSelection(release.dir, stagingRoot, { features: ['tavern'] }, DEV);
        stage.activate(first.stagingDir, installRoot, DEV);
        const current = path.join(installRoot, 'current');
        const before = treeDigest(current);

        let error;
        try {
            stage.stageSelection(release.dir, stagingRoot, { features: ['voice'] }, {
                ...DEV,
                onFile: (_rel, index) => { if (index === 3) throw new Error('simulated power cut'); }
            });
        } catch (caught) { error = caught; }
        expect(error.message).toBe('simulated power cut');
        const { ready, partial } = stage.listStaging(stagingRoot);
        expect(ready).toEqual([]);
        expect(partial).toHaveLength(1);
        expect(error.stagingDir).toBe(partial[0]);
        expect(path.basename(partial[0])).toMatch(new RegExp(`^${stage.releaseIdOf(release.manifest).replace(/\./g, '\\.')}-[0-9a-f]{8}\\.partial$`));
        expect(codeOf(() => stage.activate(partial[0], installRoot, DEV))).toBe(CODES.ACTIVATE_FAILED);
        expect(treeDigest(current)).toBe(before);
        expect(stage.verifyPayload(current, DEV).features).toEqual(['core', 'tavern']);

        expect(stage.cleanStaging(stagingRoot)).toEqual(partial);
        expect(stage.listStaging(stagingRoot)).toEqual({ ready: [], partial: [] });
    });
});

describe('activate', () => {
    test('swaps current to previous and the stage into current; the one before previous is dropped', () => {
        const release = makeRelease();
        const stagingRoot = tempDir('staging');
        const installRoot = tempDir('install');
        const a = stage.stageSelection(release.dir, stagingRoot, { features: [] }, DEV);
        const first = stage.activate(a.stagingDir, installRoot, DEV);
        expect(first.previous).toBeNull();
        const b = stage.stageSelection(release.dir, stagingRoot, { features: ['voice'] }, DEV);
        const second = stage.activate(b.stagingDir, installRoot, DEV);
        expect(stage.verifyPayload(second.current, DEV).features).toEqual(['core', 'voice']);
        expect(stage.verifyPayload(second.previous, DEV).features).toEqual(['core']);
        const c = stage.stageSelection(release.dir, stagingRoot, { features: ['tavern'] }, DEV);
        stage.activate(c.stagingDir, installRoot, DEV);
        expect(stage.verifyPayload(path.join(installRoot, 'previous'), DEV).features).toEqual(['core', 'voice']);
        expect(fs.readdirSync(installRoot).sort()).toEqual(['current', 'previous']);
        expect(fs.readdirSync(stagingRoot)).toEqual([]);
    });

    test('a staged copy tampered after staging, or for another target, never becomes current', () => {
        const release = makeRelease();
        const stagingRoot = tempDir('staging');
        const installRoot = tempDir('install');
        stage.activate(stage.stageSelection(release.dir, stagingRoot, { features: [] }, DEV).stagingDir, installRoot, DEV);
        const current = path.join(installRoot, 'current');
        const before = treeDigest(current);

        const tampered = stage.stageSelection(release.dir, stagingRoot, { features: ['voice'] }, DEV);
        fs.writeFileSync(path.join(tampered.stagingDir, 'app', 'node_modules', '@goobster', 'core', 'services', 'voice', 'session.js'), 'exports.voice = 2;\n');
        expect(codeOf(() => stage.activate(tampered.stagingDir, installRoot, DEV))).toBe(CODES.INCOMPLETE);
        expect(codeOf(() => stage.activate(stage.stageSelection(release.dir, stagingRoot, { features: [] }, DEV).stagingDir, installRoot, { ...DEV, expectedTarget: 'darwin-arm64' })))
            .toBe(CODES.TARGET_MISMATCH);
        expect(treeDigest(current)).toBe(before);
        expect(fs.existsSync(path.join(installRoot, 'previous'))).toBe(false);
    });

    test('a failed final rename puts the old current back', () => {
        const release = makeRelease();
        const stagingRoot = tempDir('staging');
        const installRoot = tempDir('install');
        stage.activate(stage.stageSelection(release.dir, stagingRoot, { features: [] }, DEV).stagingDir, installRoot, DEV);
        const before = treeDigest(path.join(installRoot, 'current'));
        expect(codeOf(() => stage.activate(path.join(stagingRoot, 'vanished'), installRoot, { verify: false }))).toBe(CODES.ACTIVATE_FAILED);
        expect(treeDigest(path.join(installRoot, 'current'))).toBe(before);
        expect(fs.existsSync(path.join(installRoot, 'previous'))).toBe(false);
    });

    test('recoverInstall brings previous back when a crash left no current', () => {
        const release = makeRelease();
        const stagingRoot = tempDir('staging');
        const installRoot = tempDir('install');
        stage.activate(stage.stageSelection(release.dir, stagingRoot, { features: [] }, DEV).stagingDir, installRoot, DEV);
        stage.activate(stage.stageSelection(release.dir, stagingRoot, { features: ['voice'] }, DEV).stagingDir, installRoot, DEV);
        fs.rmSync(path.join(installRoot, 'current'), { recursive: true });
        expect(stage.recoverInstall(installRoot)).toBe('restored-previous');
        expect(stage.verifyPayload(path.join(installRoot, 'current'), DEV).features).toEqual(['core']);
        expect(stage.recoverInstall(installRoot)).toBe('ok');
        expect(stage.recoverInstall(tempDir('empty'))).toBe('empty');
    });
});

describe('scripts/package-sign.js', () => {
    test('--gen-dev-key writes a 0600 private key outside the repository and prints no key material', () => {
        const dir = path.join(tempDir('keys'), 'dev');
        const made = childProcess.spawnSync(process.execPath, [SIGN_CLI, '--gen-dev-key', dir], { encoding: 'utf8' });
        expect(made.status).toBe(0);
        expect(made.stdout + made.stderr).not.toMatch(/PRIVATE KEY|BEGIN/);
        const privatePath = path.join(dir, 'payload-dev-key.pem');
        if (process.platform !== 'win32') expect(fs.statSync(privatePath).mode & 0o777).toBe(0o600);
        expect(crypto.createPrivateKey(fs.readFileSync(privatePath)).asymmetricKeyType).toBe('ed25519');

        const again = childProcess.spawnSync(process.execPath, [SIGN_CLI, '--gen-dev-key', dir], { encoding: 'utf8' });
        expect(again.status).toBe(1);
        expect(again.stderr).toMatch(/refusing to overwrite/);
        const inRepo = childProcess.spawnSync(process.execPath, [SIGN_CLI, '--gen-dev-key', path.join(REPO_ROOT, 'tmp-keys-must-not-exist')], { encoding: 'utf8' });
        expect(inRepo.status).toBe(1);
        expect(inRepo.stderr).toMatch(/inside the repository/);
        expect(fs.existsSync(path.join(REPO_ROOT, 'tmp-keys-must-not-exist'))).toBe(false);
    });

    test('--key signs a payload so that verifyPayload accepts it with the public key, and re-signing replaces the key id', () => {
        const dir = path.join(tempDir('keys'), 'dev');
        childProcess.spawnSync(process.execPath, [SIGN_CLI, '--gen-dev-key', dir]);
        const release = makeRelease();
        const signed = childProcess.spawnSync(process.execPath, [SIGN_CLI, '--key', path.join(dir, 'payload-dev-key.pem'), release.dir], { encoding: 'utf8' });
        expect(signed.status).toBe(0);
        expect(signed.stdout).not.toMatch(/PRIVATE KEY|BEGIN/);
        const publicKey = fs.readFileSync(path.join(dir, 'payload-dev-key.pub.pem'), 'utf8');
        expect(stage.verifyPayload(release.dir, { publicKey })).toMatchObject({ signed: true, keyId: stage.keyIdOf(publicKey) });

        const second = path.join(tempDir('keys'), 'dev2');
        childProcess.spawnSync(process.execPath, [SIGN_CLI, '--gen-dev-key', second]);
        childProcess.spawnSync(process.execPath, [SIGN_CLI, '--key', path.join(second, 'payload-dev-key.pem'), release.dir]);
        expect(codeOf(() => stage.verifyPayload(release.dir, { publicKey }))).toBe(CODES.SIGNATURE_INVALID);
        expect(stage.verifyPayload(release.dir, { publicKey: fs.readFileSync(path.join(second, 'payload-dev-key.pub.pem'), 'utf8') }).signed).toBe(true);
    });
});

describe('payloadStage verify CLI', () => {
    function runCli(argv) {
        let out = '';
        const status = stage.verifyCli(argv, { stdout: { write: (chunk) => { out += chunk; } } });
        return { status, out };
    }

    test('prints ok with the summary, a refusal code with exit 2, and usage errors with exit 1', () => {
        const { publicKey, privateKey } = keypair();
        const release = signRelease(makeRelease(), privateKey);
        const keyFile = path.join(tempDir('cli'), 'key.pub.pem');
        fs.writeFileSync(keyFile, publicKey.export({ type: 'spki', format: 'pem' }));

        const passed = runCli(['verify', release.dir, '--target', 'linux-x64', '--abi', '127', '--public-key', keyFile]);
        expect(passed.status).toBe(0);
        expect(JSON.parse(passed.out)).toMatchObject({ ok: true, code: null, signed: true, target: 'linux-x64' });

        const wrongTarget = runCli(['verify', release.dir, '--target', 'win32-x64', '--public-key', keyFile]);
        expect(wrongTarget.status).toBe(2);
        expect(JSON.parse(wrongTarget.out)).toMatchObject({ ok: false, code: CODES.TARGET_MISMATCH });

        const unsigned = makeRelease();
        expect(JSON.parse(runCli(['verify', unsigned.dir]).out).code).toBe(CODES.UNSIGNED_DEV_ONLY);
        expect(JSON.parse(runCli(['verify', unsigned.dir, '--dev']).out)).toMatchObject({ ok: true, signed: false, devMode: true });

        expect(runCli(['verify']).status).toBe(1);
        expect(runCli(['verify', release.dir, '--bogus']).status).toBe(1);
    });
});

describe('satisfies', () => {
    test.each([
        ['2.4.0', '>=2.4.0 <3.0.0', true],
        ['3.0.0', '>=2.4.0 <3.0.0', false],
        ['2.3.9', '>=2.4.0 <3.0.0', false],
        ['2.4.0-rc.1', '>=2.4.0', false],
        ['1.2.3', '1.2.3', true],
        ['1.2.3', '>1.2.3 || =1.2.3', true],
        ['not-a-version', '>=0.0.0', false],
        ['1.0.0', '', false]
    ])('%s in %s is %s', (version, range, expected) => {
        expect(stage.satisfies(version, range)).toBe(expected);
    });
});
