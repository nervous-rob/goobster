/**
 * Add, remove and re-add features on an installed payload through the
 * manifest it came from (#328, documentation/packaging.md). Shared files and
 * dependencies, core, data/, config, the manager's store, logs/ and cache/
 * are never touched (a sentinel in each); system tools are audited, never
 * uninstalled; durable feature data survives remove and re-add on both
 * engines.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DB_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-apply-db-'));
process.env.GOOBSTER_DATA_DIR = DB_ROOT;
process.env.GOOBSTER_DB_PATH = path.join(DB_ROOT, 'test.sqlite');

const db = require('@goobster/core/db');
const stage = require('../scripts/lib/payloadStage');
const apply = require('../scripts/lib/payloadApply');
const { A, TABLES, createDormantSeed } = require('./helpers/dormantSeed');

const { CODES } = stage;
const { APPLY_CODES } = apply;

const CORE_DIR = 'app/node_modules/@goobster/core';
const FILES = [
    ['runtime/bin/node', 'core', 'node-binary', { mode: 0o755 }],
    [`${CORE_DIR}/index.js`, 'core', 'module.exports = {};\n'],
    [`${CORE_DIR}/services/privacyService.js`, 'core', 'exports.forget = 1;\n'],
    [`${CORE_DIR}/db/schema.sql`, 'core', 'CREATE TABLE tavern_characters (id INTEGER);\n'],
    [`${CORE_DIR}/services/voice/session.js`, 'voice', 'exports.voice = 1;\n'],
    [`${CORE_DIR}/services/music/player.js`, 'music', 'exports.music = 1;\n'],
    [`${CORE_DIR}/services/tavern/game.js`, 'tavern', 'exports.tavern = 1;\n'],
    [`${CORE_DIR}/services/exchange/market.js`, 'exchange', 'exports.market = 1;\n'],
    ['app/node_modules/opusscript/index.js', 'core', 'exports.opus = 1;\n', { dependency: 'opusscript' }],
    ['app/node_modules/tavern-dice/index.js', 'tavern', 'exports.roll = 1;\n', { dependency: 'tavern-dice' }],
    ['app/node_modules/sharp/index.js', 'core', 'exports.sharp = 1;\n', { dependency: 'sharp' }],
    ['app/node_modules/better-sqlite3/index.js', 'core', 'exports.db = 1;\n', { dependency: 'better-sqlite3' }],
    ['app/apps/web/dist/index.html', 'core', '<html></html>\n'],
    ['app/apps/web/dist/assets/feature-exchange-ExchangeRoom-1a2b.js', 'exchange', 'export default 1;\n']
];
const GROUPS = {
    core: { files: [], dependencies: ['better-sqlite3', 'sharp'], system: [] },
    voice: { files: [], dependencies: ['opusscript'], requires: [], frontend: [], system: [{ name: 'ffmpeg', kind: 'binary' }] },
    music: {
        files: [], dependencies: ['opusscript'], requires: ['voice'], frontend: [],
        system: [{ name: 'ffmpeg', kind: 'binary' }, { name: 'music-python-venv', kind: 'python-venv' }]
    },
    tavern: { files: [], dependencies: ['tavern-dice'], requires: [], frontend: [], system: [] },
    exchange: { files: [], dependencies: ['sharp'], requires: [], frontend: ['exchange'], system: [] }
};
const DEPENDENCIES = [
    { name: 'better-sqlite3', version: '12.0.0', path: 'app/node_modules/better-sqlite3', owners: ['core'], exclusive: false },
    { name: 'opusscript', version: '0.1.0', path: 'app/node_modules/opusscript', owners: ['music', 'voice'], exclusive: false },
    { name: 'sharp', version: '0.34.0', path: 'app/node_modules/sharp', owners: ['core', 'exchange'], exclusive: false },
    { name: 'tavern-dice', version: '1.0.0', path: 'app/node_modules/tavern-dice', owners: ['tavern'], exclusive: true }
];
const SENTINELS = {
    'data/goobster.sqlite': 'not really a database',
    'data/features.json': '{"version":1,"features":{}}',
    'data/manager/store.json': '{"operations":[]}',
    'config.json': '{"webapp":{"enabled":true}}',
    'config/config.json': '{"webapp":{"enabled":true}}',
    'logs/goobster.log': 'a log line\n',
    'cache/models/blob.bin': 'cached'
};

const roots = [DB_ROOT];
afterAll(async () => {
    await db.closeConnection();
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `goobster-apply-${label}-`));
    roots.push(dir);
    return dir;
}

const sha = content => crypto.createHash('sha256').update(content).digest('hex');

function makeRelease() {
    const dir = tempDir('release');
    const files = [];
    for (const [rel, owner, content, extra = {}] of FILES) {
        const full = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, { mode: extra.mode || 0o644 });
        files.push({ path: rel, size: Buffer.byteLength(content), sha256: sha(content), owner, ...(extra.dependency ? { dependency: extra.dependency } : {}) });
    }
    const groups = JSON.parse(JSON.stringify(GROUPS));
    for (const file of files) if (!file.dependency) groups[file.owner].files.push(file.path);
    const manifest = {
        version: 1,
        release: { core: '2.4.0', compatibleCore: '>=2.4.0 <3.0.0' },
        target: { id: 'linux-x64', platform: 'linux', arch: 'x64' },
        node: { version: '22.23.3', abi: '127' },
        groups,
        files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
        dependencies: DEPENDENCIES,
        frontend: { chunks: [{ file: 'assets/feature-exchange-ExchangeRoom-1a2b.js', feature: 'exchange' }] },
        unreferenced: []
    };
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const signed = stage.signManifest(manifest, privateKey);
    stage.writeManifest(dir, signed.manifest, signed.signature);
    return { dir, manifest: signed.manifest, publicKey };
}

/** An installation root with `current` = `features` from the release, and a sentinel in every protected place. */
function install(release, features) {
    const installRoot = tempDir('install');
    for (const [rel, content] of Object.entries(SENTINELS)) {
        fs.mkdirSync(path.dirname(path.join(installRoot, rel)), { recursive: true });
        fs.writeFileSync(path.join(installRoot, rel), content);
    }
    const options = { publicKey: release.publicKey };
    const staged = stage.stageSelection(release.dir, path.join(installRoot, 'staging'), { features, profile: 'custom' }, options);
    stage.activate(staged.stagingDir, installRoot, options);
    return { installRoot, options };
}

function protectedState(installRoot) {
    return Object.keys(SENTINELS).map((rel) => {
        const full = path.join(installRoot, rel);
        const stat = fs.statSync(full);
        return `${rel}:${sha(fs.readFileSync(full))}:${stat.mtimeMs}`;
    }).join('\n');
}

function has(installRoot, rel) {
    return fs.existsSync(path.join(installRoot, 'current', ...rel.split('/')));
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

describe('planChange', () => {
    test('adding a feature lists its files, the shared dependency it needs, and the system tool to audit', () => {
        const release = makeRelease();
        const { installRoot } = install(release, []);
        const plan = apply.planChange(installRoot, release.manifest, { add: ['music'], source: release.dir });
        expect(plan.features).toEqual({ before: ['core'], after: ['core', 'music', 'voice'], add: ['music', 'voice'], remove: [] });
        expect(plan.files.add).toEqual(expect.arrayContaining([`${CORE_DIR}/services/music/player.js`, `${CORE_DIR}/services/voice/session.js`, 'app/node_modules/opusscript/index.js']));
        expect(plan.files.remove).toEqual([]);
        expect(plan.dependencies).toEqual({ add: ['app/node_modules/opusscript'], remove: [] });
        expect(plan.needsSource).toBe(true);
        expect(plan.system).toEqual([
            { name: 'ffmpeg', kind: 'binary', owners: ['music', 'voice'], stillNeededBy: ['music', 'voice'], status: 'needed', action: 'audit' },
            { name: 'music-python-venv', kind: 'python-venv', owners: ['music'], stillNeededBy: ['music'], status: 'needed', action: 'audit' }
        ]);
        expect(plan.protected).toEqual(['data', 'config.json', 'config', 'logs', 'cache']);
    });

    test('removing Music keeps the dependency Voice still needs and audits, rather than uninstalls, what Music used', () => {
        const release = makeRelease();
        const { installRoot } = install(release, ['music']);
        const plan = apply.planChange(installRoot, null, { remove: ['music'] });
        expect(plan.features.after).toEqual(['core', 'voice']);
        expect(plan.files.remove).toEqual([`${CORE_DIR}/services/music/player.js`]);
        expect(plan.dependencies.remove).toEqual([]);
        expect(plan.keeps).toEqual([{ kind: 'dependency', name: 'opusscript', path: 'app/node_modules/opusscript', owners: ['music', 'voice'], neededBy: ['voice'] }]);
        expect(plan.system).toEqual([
            { name: 'ffmpeg', kind: 'binary', owners: ['music', 'voice'], stillNeededBy: ['voice'], status: 'still-needed', action: 'audit' },
            { name: 'music-python-venv', kind: 'python-venv', owners: ['music'], stillNeededBy: [], status: 'no-longer-needed', action: 'audit' }
        ]);
        expect(plan.needsSource).toBe(false);
    });

    test('a dependency shared with core never goes; an exclusive one goes with its feature', () => {
        const release = makeRelease();
        const { installRoot } = install(release, ['exchange', 'tavern']);
        const plan = apply.planChange(installRoot, null, { remove: ['exchange', 'tavern'] });
        expect(plan.dependencies.remove).toEqual(['app/node_modules/tavern-dice']);
        expect(plan.files.remove.sort()).toEqual([
            `${CORE_DIR}/services/exchange/market.js`, `${CORE_DIR}/services/tavern/game.js`,
            'app/apps/web/dist/assets/feature-exchange-ExchangeRoom-1a2b.js', 'app/node_modules/tavern-dice/index.js'
        ].sort());
        expect(plan.chunks.remove).toEqual(['assets/feature-exchange-ExchangeRoom-1a2b.js']);
        expect(plan.keeps).toEqual([{ kind: 'dependency', name: 'sharp', path: 'app/node_modules/sharp', owners: ['core', 'exchange'], neededBy: ['core'] }]);
        for (const relPath of plan.files.remove) {
            const owner = release.manifest.files.find(file => file.path === relPath).owner;
            expect(['exchange', 'tavern']).toContain(owner);
        }
    });

    test('core, a required feature, an unknown feature and another release are refused', () => {
        const release = makeRelease();
        const { installRoot } = install(release, ['music']);
        expect(codeOf(() => apply.planChange(installRoot, null, { remove: ['core'] }))).toBe(APPLY_CODES.CORE_REQUIRED);
        expect(codeOf(() => apply.planChange(installRoot, null, { remove: ['voice'] }))).toBe(APPLY_CODES.REQUIRED_BY);
        expect(codeOf(() => apply.planChange(installRoot, null, { add: ['warp'] }))).toBe(APPLY_CODES.UNKNOWN_FEATURE);
        expect(apply.planChange(installRoot, null, { remove: ['voice', 'music'] }).dependencies.remove).toEqual(['app/node_modules/opusscript']);
        const other = makeRelease();
        expect(codeOf(() => apply.planChange(installRoot, other.manifest, { add: ['tavern'] }))).toBe(APPLY_CODES.RELEASE_MISMATCH);
        expect(codeOf(() => apply.planChange(tempDir('empty'), null, { add: ['tavern'] }))).toBe(APPLY_CODES.NOT_INSTALLED);
    });
});

describe('applyChange', () => {
    test('add, remove and re-add touch only the owned files; core, shared files and every protected place stay as they were', () => {
        const release = makeRelease();
        const { installRoot, options } = install(release, ['voice']);
        const protectedBefore = protectedState(installRoot);
        const corePath = path.join(installRoot, 'current', ...`${CORE_DIR}/services/privacyService.js`.split('/'));
        const coreBefore = sha(fs.readFileSync(corePath));

        const addPlan = apply.planChange(installRoot, null, { add: ['music', 'tavern'] });
        expect(codeOf(() => apply.applyChange(addPlan, options))).toBe(APPLY_CODES.SOURCE_REQUIRED);
        const added = apply.applyChange({ ...addPlan, source: release.dir }, options);
        expect(added.features).toEqual(['core', 'music', 'tavern', 'voice']);
        expect(has(installRoot, `${CORE_DIR}/services/music/player.js`)).toBe(true);
        expect(has(installRoot, 'app/node_modules/tavern-dice/index.js')).toBe(true);
        expect(stage.verifyPayload(path.join(installRoot, 'current'), options).signed).toBe(true);

        const removed = apply.applyChange(apply.planChange(installRoot, null, { remove: ['music', 'tavern'] }), options);
        expect(removed.features).toEqual(['core', 'voice']);
        expect(removed.audit.map(entry => [entry.name, entry.status])).toEqual([['ffmpeg', 'still-needed'], ['music-python-venv', 'no-longer-needed']]);
        expect(has(installRoot, `${CORE_DIR}/services/music/player.js`)).toBe(false);
        expect(has(installRoot, `${CORE_DIR}/services/tavern`)).toBe(false);
        expect(has(installRoot, 'app/node_modules/tavern-dice')).toBe(false);
        expect(has(installRoot, 'app/node_modules/opusscript/index.js')).toBe(true);
        expect(has(installRoot, 'app/node_modules/sharp/index.js')).toBe(true);
        expect(stage.verifyPayload(path.join(installRoot, 'current'), options).features).toEqual(['core', 'voice']);
        expect(stage.verifyPayload(path.join(installRoot, 'previous'), options).features).toEqual(['core', 'music', 'tavern', 'voice']);

        const readded = apply.applyChange(apply.planChange(installRoot, null, { add: ['tavern'], source: release.dir }), options);
        expect(readded.features).toEqual(['core', 'tavern', 'voice']);
        expect(has(installRoot, `${CORE_DIR}/services/tavern/game.js`)).toBe(true);

        expect(protectedState(installRoot)).toBe(protectedBefore);
        expect(sha(fs.readFileSync(path.join(installRoot, 'current', ...`${CORE_DIR}/services/privacyService.js`.split('/'))))).toBe(coreBefore);
        expect(fs.readdirSync(installRoot).sort()).toEqual(['cache', 'config', 'config.json', 'current', 'data', 'logs', 'previous', 'staging']);
        expect(stage.listStaging(path.join(installRoot, 'staging'))).toEqual({ ready: [], partial: [] });
    });

    test('a stale plan, a tampered source or a tampered install changes nothing', () => {
        const release = makeRelease();
        const { installRoot, options } = install(release, []);
        const current = path.join(installRoot, 'current');
        const snapshot = () => [...stage.walkTree(current).files.keys()].sort().join('\n');
        const before = snapshot();
        const protectedBefore = protectedState(installRoot);

        const plan = apply.planChange(installRoot, null, { add: ['tavern'], source: release.dir });
        apply.applyChange(apply.planChange(installRoot, null, { add: ['voice'], source: release.dir }), options);
        expect(codeOf(() => apply.applyChange(plan, options))).toBe(APPLY_CODES.PLAN_STALE);
        apply.applyChange(apply.planChange(installRoot, null, { remove: ['voice'] }), options);
        expect(snapshot()).toBe(before);

        const tamperedSource = makeRelease();
        fs.appendFileSync(path.join(tamperedSource.dir, ...`${CORE_DIR}/services/tavern/game.js`.split('/')), '// injected\n');
        const fromOtherRelease = apply.planChange(installRoot, null, { add: ['tavern'], source: tamperedSource.dir });
        expect(codeOf(() => apply.applyChange(fromOtherRelease, { ...options, publicKey: [release.publicKey, tamperedSource.publicKey] }))).toBe(CODES.INCOMPLETE);

        fs.appendFileSync(path.join(release.dir, ...`${CORE_DIR}/services/tavern/game.js`.split('/')), '// injected\n');
        expect(codeOf(() => apply.applyChange(apply.planChange(installRoot, null, { add: ['tavern'], source: release.dir }), options))).toBe(CODES.INCOMPLETE);
        expect(snapshot()).toBe(before);

        fs.writeFileSync(path.join(current, 'app', 'stray.js'), 'x');
        expect(codeOf(() => apply.applyChange(apply.planChange(installRoot, null, { remove: [] }), options))).toBe(CODES.EXTRA_FILE);
        fs.rmSync(path.join(current, 'app', 'stray.js'));
        expect(snapshot()).toBe(before);
        expect(protectedState(installRoot)).toBe(protectedBefore);
    });
});

describe('durable feature data survives remove and re-add', () => {
    const seed = createDormantSeed(db);
    const featureTables = TABLES.filter(entry => ['exchange', 'tavern'].includes(entry.feature));

    beforeAll(async () => {
        await db.getConnection();
        await seed.seedAccount(A, 'A');
    });

    test(`add, write rows, remove, re-add: the ${featureTables.length} exchange and tavern tables keep every row (${process.env.GOOBSTER_DB_URL ? 'postgres' : 'sqlite'})`, async () => {
        const release = makeRelease();
        const { installRoot, options } = install(release, ['exchange', 'tavern']);
        const rows = await seed.captureFor(A);
        for (const { table } of featureTables) expect(rows[table].length).toBeGreaterThan(0);

        apply.applyChange(apply.planChange(installRoot, null, { remove: ['exchange', 'tavern'] }), options);
        expect(has(installRoot, `${CORE_DIR}/services/exchange/market.js`)).toBe(false);
        expect(has(installRoot, `${CORE_DIR}/db/schema.sql`)).toBe(true);
        expect(await seed.captureFor(A)).toEqual(rows);

        apply.applyChange(apply.planChange(installRoot, null, { add: ['exchange', 'tavern'], source: release.dir }), options);
        expect(has(installRoot, `${CORE_DIR}/services/exchange/market.js`)).toBe(true);
        expect(await seed.captureFor(A)).toEqual(rows);
    });

    test('the apply and stage libraries load nothing but Node built-ins and each other', () => {
        for (const file of ['payloadApply.js', 'payloadStage.js']) {
            const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', file), 'utf8');
            const requires = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map(match => match[2]);
            expect(requires.filter(spec => !spec.startsWith('node:') && spec !== './payloadStage')).toEqual([]);
        }
    });
});
