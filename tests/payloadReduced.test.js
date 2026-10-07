/**
 * Reduced payloads load (#328, documentation/packaging.md).
 *
 * For each profile a temp tree is built the way a payload selection leaves
 * one (tests/helpers/reducedTree.js): the files of every unselected feature
 * are not on disk and node_modules carries only the production packages a
 * selected owner imports. apps/api boots from that tree in standalone mode
 * (throwaway database, no keys, no Discord) under a `--require` preload that
 * records every module load and every failed resolution. The spec then
 * checks /health, the feature list, a selected route and an excluded route,
 * and after shutdown that nothing failed to load except what the selection
 * removed and nothing outside the selection was loaded.
 *
 * The core-only tree also runs the dormant-data probe: two accounts with rows
 * in every feature table, then the report, the audit, the account export and
 * erasure of one account with the feature modules absent. On the Postgres
 * matrix each child gets its own isolated schema.
 *
 * Linux only: the tree links the checkout's installed packages.
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { computeTreeOwnership, buildReducedTree, repoPathInTree } = require('./helpers/reducedTree');

const REPO = path.join(__dirname, '..');
const describeLinux = process.platform === 'linux' ? describe : describe.skip;
const USER = '610000000000000001';
const BOOT_TIMEOUT_MS = 40_000;

const GET = route => ({ method: 'GET', route });
const POST = route => ({ method: 'POST', route });

const ROUTES = {
    projects: GET('/api/app/observatory/projects'),
    voice: GET('/api/app/voice/capabilities'),
    music: GET('/api/app/studio/songs'),
    exchange: GET('/api/app/exchange/overview'),
    expeditions: GET('/api/app/spitball/expeditions'),
    mcp: POST('/mcp')
};

const PROFILES = [
    {
        name: 'core-only',
        features: [],
        selected: [],
        excluded: ['projects', 'voice', 'music', 'exchange', 'expeditions', 'mcp'],
        dormant: true
    },
    {
        name: 'core-only without a features.json (no Phase 1 gate in play)',
        features: [],
        writeState: false,
        selected: [],
        excluded: ['projects', 'voice', 'music', 'exchange', 'expeditions', 'mcp']
    },
    {
        name: 'voice without music',
        features: ['voice'],
        selected: ['voice'],
        excluded: ['music', 'projects']
    },
    {
        name: 'projects without mcp',
        features: ['projects'],
        selected: ['projects'],
        excluded: ['mcp', 'expeditions']
    },
    {
        name: 'full',
        features: null,
        selected: ['projects', 'voice', 'music', 'exchange', 'expeditions', 'mcp'],
        excluded: []
    }
];

let owned;
let base;

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function childEnv(dir, extra) {
    const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'production',
        GOOBSTER_WORKSPACE_ROOT: dir,
        GOOBSTER_DATA_DIR: path.join(dir, 'data'),
        GOOBSTER_UPLOADS_DIR: path.join(dir, 'data', 'uploads'),
        GOOBSTER_CACHE_DIR: path.join(dir, 'cache'),
        GOOBSTER_LOG_DIR: path.join(dir, 'logs'),
        GOOBSTER_CONFIG_PATH: path.join(dir, 'config.json'),
        ...extra
    };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    if (process.env.GOOBSTER_DB_URL) {
        env.GOOBSTER_DB_URL = process.env.GOOBSTER_DB_URL;
        env.GOOBSTER_PG_TEST_ISOLATE = '1';
    } else {
        env.GOOBSTER_DB_PATH = path.join(dir, 'data', `${extra.GOOBSTER_PROBE_OUT ? 'probe' : 'api'}.sqlite`);
    }
    return env;
}

function run(dir, script, env) {
    const child = spawn(process.execPath, ['--preserve-symlinks', '--require', path.join(dir, 'tests/helpers/loadRecorder.js'), script], {
        cwd: dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = { text: '' };
    child.stdout.on('data', chunk => { output.text += chunk; });
    child.stderr.on('data', chunk => { output.text += chunk; });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    return { child, output, exited };
}

async function waitForHealth(port, exited) {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let gone = null;
    exited.then((result) => { gone = result; });
    while (Date.now() < deadline) {
        if (gone) throw new Error(`api exited before it was healthy (${JSON.stringify(gone)})`);
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) return res.json();
        } catch { /* not listening yet */ }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('api did not become healthy in time');
}

async function signIn(port) {
    const res = await fetch(`http://127.0.0.1:${port}/api/app/auth/dev-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: USER, name: 'payload probe' })
    });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie').split(';')[0];
}

async function call(port, cookie, { method, route }) {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { cookie, 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
        body: method === 'GET' ? undefined : '{}'
    });
    await res.arrayBuffer();
    return res.status;
}

/**
 * Optional `require('../../../config.json')`-style reads from core config
 * modules (wrapped in try/catch). From an installed @goobster/core they look
 * in app/node_modules/, as they do in the #327 payload; the runtime reads the
 * real config through runtimePaths.configJsonPath.
 */
const LAYOUT_PROBES = /^(\.\.\/)+(config|package)\.json$/;

/** Repository-shaped path of a file in the tree, or null outside it. */
function inTree(dir, file) {
    return file && file.startsWith(`${dir}/`) ? repoPathInTree(file.slice(dir.length + 1)) : null;
}

/** The lockfile key whose directory holds `rel` (the deepest one), or null. */
function packageKeyOf(keys, rel) {
    let best = null;
    for (const key of keys) if (rel.startsWith(`${key}/`) && (!best || key.length > best.length)) best = key;
    return best;
}

function packageName(request) {
    return request.split('/').slice(0, request.startsWith('@') ? 2 : 1).join('/');
}

/** Whether Node's lookup from inside package `from` would reach a kept package called `name`. */
function resolvesToKept(tree, from, name) {
    const kept = new Set(tree.keptPackageKeys);
    let base = from;
    for (;;) {
        if (kept.has(`${base}/node_modules/${name}`)) return true;
        const cut = base.lastIndexOf('/node_modules/');
        if (cut === -1) break;
        base = base.slice(0, cut);
    }
    const workspace = /^((packages|apps)\/[^/]+)\//.exec(from)?.[1];
    return (workspace && kept.has(`${workspace}/node_modules/${name}`)) || kept.has(`node_modules/${name}`);
}

/**
 * A failed resolution is acceptable only when it is something the selection
 * removed (a feature file or an excluded package) asked for by tree source,
 * or an installed package's probe for an optional backend no payload carries.
 */
function classifyMisses(tree, missing) {
    const excludedFiles = new Set(tree.excludedFiles);
    const excludedPackages = new Set(tree.excludedPackages);
    const allKeys = [...tree.keptPackageKeys, ...tree.excludedPackageKeys];
    const unexpected = [];
    const removed = new Set();
    const probes = new Set();
    const removedFile = (target) => {
        const hit = [target, `${target}.js`, `${target}.json`, `${target}/index.js`].find(file => excludedFiles.has(file));
        if (hit) removed.add(hit);
        return Boolean(hit);
    };
    for (const { request, from } of missing) {
        const source = inTree(tree.dir, from);
        const bare = !request.startsWith('.') && !path.isAbsolute(request);
        const fromPackage = source ? packageKeyOf(allKeys, source) : null;
        if (source && !fromPackage) {
            if (bare) {
                const linked = repoPathInTree(`node_modules/${request}`);
                if (linked.startsWith('node_modules/') ? excludedPackages.has(packageName(request)) && removed.add(packageName(request)) : removedFile(linked)) continue;
            } else {
                const target = inTree(tree.dir, path.resolve(path.dirname(from), request));
                if (target && removedFile(target)) continue;
                if (LAYOUT_PROBES.test(request)) {
                    probes.add(`${source}:${request}`);
                    continue;
                }
            }
            unexpected.push({ request, from: source });
            continue;
        }
        if (fromPackage && (!bare || !resolvesToKept(tree, fromPackage, packageName(request)))) {
            probes.add(bare ? packageName(request) : `${fromPackage}:${path.basename(request)}`);
            continue;
        }
        unexpected.push({ request, from: source || from });
    }
    return { unexpected, removed: [...removed].sort(), probes: [...probes].sort() };
}

/** Loaded files that are excluded, or that no selected package or tree source accounts for. */
function strayLoads(tree, loaded) {
    const stray = [];
    const excludedFiles = new Set(tree.excludedFiles);
    for (const file of loaded) {
        if (!path.isAbsolute(file)) continue;
        const rel = inTree(tree.dir, file);
        if (rel === null) {
            stray.push({ file, why: 'outside the tree' });
            continue;
        }
        if (excludedFiles.has(rel)) {
            stray.push({ file: rel, why: 'excluded file' });
            continue;
        }
        if (!rel.includes('node_modules/')) continue;
        const excluded = packageKeyOf(tree.excludedPackageKeys, rel);
        const kept = packageKeyOf(tree.keptPackageKeys, rel);
        if (excluded && (!kept || excluded.length > kept.length)) stray.push({ file: rel, why: 'excluded package' });
        else if (!kept) stray.push({ file: rel, why: 'outside the selection' });
    }
    return stray;
}

beforeAll(() => {
    if (process.platform !== 'linux') return;
    owned = computeTreeOwnership(REPO);
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-reduced-'));
}, 60_000);

afterAll(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
});

describeLinux.each(PROFILES)('reduced payload: $name', (profile) => {
    let tree;
    let boot;

    beforeAll(async () => {
        const features = profile.features || owned.catalog.FEATURE_IDS.filter(id => id !== 'core');
        const dir = fs.mkdtempSync(path.join(base, 'tree-'));
        tree = buildReducedTree({ root: REPO, dir, features, owned, writeState: profile.writeState !== false });

        const port = await freePort();
        const loadLog = path.join(dir, 'api-load.json');
        const proc = run(dir, 'apps/api/index.js', childEnv(dir, {
            GOOBSTER_RUNTIME_MODE: 'standalone',
            GOOBSTER_API_PORT: String(port),
            GOOBSTER_LOAD_LOG: loadLog
        }));
        boot = { port, proc, loadLog };
        try {
            boot.health = await waitForHealth(port, proc.exited);
            boot.cookie = await signIn(port);
            boot.features = await (await fetch(`http://127.0.0.1:${port}/api/app/features`, { headers: { cookie: boot.cookie } })).json();
            boot.mcpDescription = await (await fetch(`http://127.0.0.1:${port}/api/app/mcp`, { headers: { cookie: boot.cookie } })).json();
            boot.statuses = {};
            for (const id of [...profile.selected, ...profile.excluded]) boot.statuses[id] = await call(port, boot.cookie, ROUTES[id]);
        } finally {
            proc.child.kill('SIGTERM');
            boot.exit = await proc.exited;
        }
        boot.load = JSON.parse(fs.readFileSync(loadLog, 'utf8'));
    }, 90_000);

    test('the tree really leaves the unselected features out', () => {
        const removedFeatures = new Set(tree.excludedFiles.map(file => owned.ownership.owners[file]));
        if (profile.features && profile.features.length === 0) {
            expect(tree.selected).toEqual(['core']);
            expect(fs.existsSync(path.join(tree.dir, 'packages/core/services/projectService.js'))).toBe(false);
            expect(tree.excludedPackages).toContain('discord.js');
        }
        for (const id of tree.excludedFeatures) {
            if (owned.catalog.FEATURES[id].payload?.files?.length && tree.excludedFiles.some(file => owned.ownership.owners[file] === id)) {
                expect(removedFeatures.has(id)).toBe(true);
            }
        }
        // Finding B5: the GPL packages are no longer declared at all, so a
        // reduced tree neither keeps nor has to exclude them.
        expect(tree.keptPackageKeys.some(key => /play-dl|play-audio/.test(key))).toBe(false);
        expect(tree.excludedPackages).not.toEqual(expect.arrayContaining(['play-dl']));
    });

    test('apps/api boots: /health and the feature list answer', () => {
        expect(boot.health).toMatchObject({ status: 'healthy', service: 'api', mode: 'standalone' });
        expect(boot.features.error).toBeNull();
        expect(boot.features.features.core.active).toBe(true);
        if (profile.writeState !== false) {
            expect(boot.features.source).toBe('file');
            for (const id of tree.excludedFeatures) expect([id, boot.features.features[id].installed]).toEqual([id, false]);
            for (const id of tree.selected.filter(id => id !== 'core')) expect([id, boot.features.features[id].installed]).toEqual([id, true]);
        }
        if (tree.selected.includes('mcp')) expect(boot.mcpDescription.tools.length).toBeGreaterThan(0);
        else expect(boot.mcpDescription).toMatchObject({ installed: false, tools: [] });
    });

    test('selected routes answer and excluded routes are 404', () => {
        expect(profile.selected.filter(id => boot.statuses[id] === 404 || boot.statuses[id] >= 500).map(id => [id, boot.statuses[id]])).toEqual([]);
        expect(profile.excluded.filter(id => boot.statuses[id] !== 404).map(id => [id, boot.statuses[id]])).toEqual([]);
    });

    test('it shuts down cleanly with no MODULE_NOT_FOUND outside what the selection removed', () => {
        expect(boot.exit).toEqual({ code: 0, signal: null });
        expect(boot.proc.output.text).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/);
        const misses = classifyMisses(tree, boot.load.missing);
        expect(misses.unexpected).toEqual([]);
        if (tree.excludedFeatures.length === 0) expect(misses.removed).toEqual([]);
        else expect(misses.removed.length).toBeGreaterThan(0);
    });

    test('no excluded file or package was loaded, discord.js included', () => {
        expect(boot.load.loaded.length).toBeGreaterThan(100);
        expect(strayLoads(tree, boot.load.loaded)).toEqual([]);
        expect(boot.load.loaded.filter(file => /\/node_modules\/discord\.js\//.test(file))).toEqual([]);
    });

    if (profile.dormant) {
        test('dormant data: report, audit, export and erasure work with the feature modules absent', async () => {
            const out = path.join(tree.dir, 'probe.json');
            const loadLog = path.join(tree.dir, 'probe-load.json');
            const proc = run(tree.dir, 'tests/helpers/reducedPayloadProbe.js', childEnv(tree.dir, {
                GOOBSTER_PROBE_OUT: out,
                GOOBSTER_LOAD_LOG: loadLog
            }));
            const exit = await proc.exited;
            const summary = JSON.parse(fs.readFileSync(out, 'utf8'));
            expect(summary.error).toBeUndefined();
            expect(exit).toEqual({ code: 0, signal: null });
            expect(summary.engine).toBe(process.env.GOOBSTER_DB_URL ? 'postgres' : 'sqlite');
            expect(summary.seeded).toBe(summary.tables);

            expect(summary.report.observatory).toMatchObject({ projects: 1, jobs: 1, assets: 1, sharedDashboards: 1 });
            expect(summary.report.spitball).toEqual({ expeditions: 1, briefs: 1 });
            expect(summary.report.developerIntegrations).toEqual({ agentRuns: 1, pendingActions: 1, auditEntries: 1, repoWatches: 1 });
            expect(summary.report.secrets).toEqual([]);
            expect(summary.auditMissing).toEqual({ A: [], B: [] });

            expect(summary.export).toEqual({ status: 'READY', missingTables: [], carriesOtherAccount: false, carriesOwnContent: true, secrets: [] });

            expect(summary.forget).toEqual({
                ok: true,
                remainingA: [],
                wrongTotals: [],
                changedB: [],
                vecBefore: { indexed: 2, stored: 2 },
                vecAfter: { indexed: 1, stored: 1 }
            });

            const load = JSON.parse(fs.readFileSync(loadLog, 'utf8'));
            expect(classifyMisses(tree, load.missing).unexpected).toEqual([]);
            expect(strayLoads(tree, load.loaded)).toEqual([]);
        }, 60_000);
    }
});
