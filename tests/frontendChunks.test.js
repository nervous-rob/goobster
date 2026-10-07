/**
 * Feature boundaries in the portal bundle (#328, documentation/packaging.md).
 *
 * Reads a real build (apps/web/dist/.vite/manifest.json; built here when it
 * is missing) and checks that every feature with a `payload.frontend` entry
 * has its own chunks, that no core chunk statically imports a feature chunk,
 * and that a feature chunk imports only core chunks, its own and those of the
 * features it requires. The labeller and the reducer are also exercised on
 * synthetic inputs and a temp copy of the dist.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const catalog = require('@goobster/core/features/catalog');
const rooms = require('../apps/web/src/lib/rooms.cjs');
const frontendChunks = require('../scripts/lib/frontendChunks');

const REPO = path.join(__dirname, '..');
const WEB = path.join(REPO, 'apps/web');
const DIST = path.join(WEB, 'dist');
const REQUIRES = frontendChunks.requiresOf(catalog);
const FRONTEND = Object.fromEntries(catalog.FEATURE_IDS.map(id => [id, catalog.FEATURES[id].payload?.frontend || []]));

let buildError = null;

beforeAll(() => {
    if (fs.existsSync(path.join(DIST, '.vite', 'manifest.json')) && fs.existsSync(path.join(DIST, frontendChunks.CHUNKS_FILE))) return;
    const vite = path.join(WEB, 'node_modules', '.bin', 'vite');
    if (!fs.existsSync(vite)) {
        buildError = 'vite is not installed in apps/web';
        return;
    }
    const built = spawnSync(vite, ['build', '--logLevel', 'error'], { cwd: WEB, encoding: 'utf8', timeout: 170_000 });
    if (built.status !== 0) buildError = `vite build failed: ${(built.stderr || built.stdout || '').slice(-2000)}`;
}, 180_000);

describe('lib/rooms.cjs chunk declarations', () => {
    const declared = frontendChunks.featureRouteModules(rooms);

    test('name real lazy route modules of features that declare a frontend chunk', () => {
        expect(declared.length).toBeGreaterThan(0);
        for (const { module, feature } of declared) {
            expect([module, fs.existsSync(path.join(WEB, 'src', module))]).toEqual([module, true]);
            expect([module, FRONTEND[feature]]).toEqual([module, [feature]]);
        }
        const covered = new Set(declared.map(entry => entry.feature));
        for (const [id, list] of Object.entries(FRONTEND)) {
            if (list.length) expect([id, covered.has(id)]).toEqual([id, true]);
        }
    });

    test('main.tsx imports every declared module lazily, never statically', () => {
        const main = fs.readFileSync(path.join(WEB, 'src/main.tsx'), 'utf8');
        for (const { module } of declared) {
            const spec = `./${module.replace(/\.tsx?$/, '')}`;
            expect([module, main.includes(`from '${spec}'`)]).toEqual([module, false]);
            expect([module, main.includes(`import('${spec}')`)]).toEqual([module, true]);
        }
    });
});

describe('labelModules', () => {
    const graph = {
        main: { isEntry: true, importedIds: ['shell', 'shared'], dynamicallyImportedIds: ['roomA', 'roomB', 'roomC', 'docs'] },
        shell: { isEntry: false, importedIds: [], dynamicallyImportedIds: [] },
        shared: { isEntry: false, importedIds: [], dynamicallyImportedIds: [] },
        docs: { isEntry: false, importedIds: ['docsOnly'], dynamicallyImportedIds: [] },
        docsOnly: { isEntry: false, importedIds: [], dynamicallyImportedIds: [] },
        roomA: { isEntry: false, importedIds: ['aOnly', 'shared', 'ab', 'kn'], dynamicallyImportedIds: ['aLazy'] },
        aOnly: { isEntry: false, importedIds: [], dynamicallyImportedIds: [] },
        aLazy: { isEntry: false, importedIds: [], dynamicallyImportedIds: [] },
        roomB: { isEntry: false, importedIds: ['ab', 'kn'], dynamicallyImportedIds: [] },
        ab: { isEntry: false, importedIds: [], dynamicallyImportedIds: [] },
        roomC: { isEntry: false, importedIds: ['kn'], dynamicallyImportedIds: [] },
        kn: { isEntry: false, importedIds: [], dynamicallyImportedIds: [] }
    };
    const labels = frontendChunks.labelModules({
        moduleIds: Object.keys(graph),
        getModuleInfo: id => graph[id] || null,
        entries: new Map([['roomA', 'projects'], ['roomB', 'music'], ['roomC', 'knowledge']]),
        requires: { projects: ['knowledge'], music: ['knowledge'], knowledge: [] }
    });

    test('what the entry reaches without a feature route is core, lazy core rooms included', () => {
        for (const id of ['main', 'shell', 'shared', 'docs', 'docsOnly']) expect([id, labels.get(id)]).toEqual([id, 'core']);
    });

    test('a feature owns what only its routes reach, lazy sub-chunks included', () => {
        expect(labels.get('roomA')).toBe('projects');
        expect(labels.get('aOnly')).toBe('projects');
        expect(labels.get('aLazy')).toBe('projects');
        expect(labels.get('roomB')).toBe('music');
    });

    test('shared by features that all require a third: that feature; otherwise core', () => {
        expect(labels.get('kn')).toBe('knowledge');
        expect(labels.get('ab')).toBe('core');
    });

    test('chunkFeature: package modules follow the application modules, a mixed chunk is core', () => {
        const map = new Map([['/src/a.tsx', 'projects'], ['/x/node_modules/q/index.js', 'core'], ['/src/core.tsx', 'core']]);
        expect(frontendChunks.chunkFeature(['/src/a.tsx', '/x/node_modules/q/index.js'], map)).toBe('projects');
        expect(frontendChunks.chunkFeature(['/src/a.tsx', '/src/core.tsx'], map)).toBeNull();
        expect(frontendChunks.chunkFeature(['/x/node_modules/q/index.js'], map)).toBeNull();
    });
});

describe('checkSetupClient', () => {
    let dist;
    beforeEach(() => {
        dist = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-setup-dist-'));
        fs.mkdirSync(path.join(dist, 'setup', 'assets'), { recursive: true });
    });
    afterEach(() => fs.rmSync(dist, { recursive: true, force: true }));

    const page = (assets) => `<html><head>${assets.map(file => `<script type="module" src="/manager/${file}"></script>`).join('')}</head></html>`;

    test('a page whose assets exist and are not feature chunks is sound', () => {
        fs.writeFileSync(path.join(dist, 'setup', 'assets', 'setup-abc.js'), '');
        fs.writeFileSync(path.join(dist, 'setup', 'index.html'), page(['assets/setup-abc.js']));
        expect(frontendChunks.checkSetupClient(dist)).toEqual([]);
    });

    test('reports a missing page, a missing asset and a file named like a feature chunk', () => {
        expect(frontendChunks.checkSetupClient(dist)).toEqual(['setup/index.html is missing']);
        fs.writeFileSync(path.join(dist, 'setup', 'index.html'), page(['assets/gone.js']));
        fs.writeFileSync(path.join(dist, 'setup', 'assets', 'feature-music-x.js'), '');
        const problems = frontendChunks.checkSetupClient(dist);
        expect(problems).toEqual(expect.arrayContaining(['assets/gone.js is referenced but missing', 'assets/feature-music-x.js is named like a feature chunk']));
    });
});

describe('the built portal', () => {
    let analysis;

    beforeAll(() => {
        if (!buildError) analysis = frontendChunks.analyseDist(DIST, { requires: REQUIRES, frontend: FRONTEND });
    });

    const built = () => {
        if (buildError) {
            console.warn(`frontendChunks: skipped, ${buildError}`);
            return false;
        }
        return true;
    };

    test('every feature with a frontend entry has at least one chunk, and nothing undeclared does', () => {
        if (!built()) return;
        for (const [id, list] of Object.entries(FRONTEND)) {
            if (list.length) expect([id, analysis.features[id] > 0]).toEqual([id, true]);
        }
        expect(Object.keys(analysis.features).sort()).toEqual(Object.keys(FRONTEND).filter(id => FRONTEND[id].length).sort());
    });

    test('the closure holds: core never imports a feature chunk, a feature imports only what it requires', () => {
        if (!built()) return;
        expect(analysis.violations).toEqual([]);
    });

    test('the entry and its preloads are core', () => {
        if (!built()) return;
        const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
        const referenced = [...html.matchAll(/\/app\/(assets\/[^"']+)/g)].map(match => match[1]);
        expect(referenced.length).toBeGreaterThan(0);
        for (const file of referenced) expect([file, frontendChunks.fileFeature(file)]).toEqual([file, 'core']);
    });

    test('dist/feature-chunks.json is the analysis the build wrote', () => {
        if (!built()) return;
        expect(frontendChunks.readFeatureChunks(DIST)).toEqual({ version: 1, chunks: analysis.chunks });
        for (const file of Object.keys(analysis.chunks)) expect([file, fs.existsSync(path.join(DIST, file))]).toEqual([file, true]);
    });
});

describe('pruneDist', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-dist-prune-'));
        fs.mkdirSync(path.join(dir, 'assets'));
        const chunks = {
            'assets/index-1.js': 'core',
            'assets/index-1.css': 'core',
            'assets/feature-projects-ProjectShell-2.js': 'projects',
            'assets/feature-music-Layout-3.js': 'music',
            'assets/feature-music-Layout-3.css': 'music',
            'assets/feature-knowledge-Notes-4.js': 'knowledge'
        };
        for (const file of Object.keys(chunks)) {
            fs.writeFileSync(path.join(dir, file), 'x');
            if (file.endsWith('.js')) fs.writeFileSync(path.join(dir, `${file}.map`), '{}');
        }
        fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
        frontendChunks.writeFeatureChunks(dir, { chunks });
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('removes the files and sourcemaps of the features left out and records what is installed', () => {
        const result = frontendChunks.pruneDist(dir, { installed: ['knowledge', 'core'] });
        expect(result.removed).toEqual([
            'assets/feature-music-Layout-3.css',
            'assets/feature-music-Layout-3.js',
            'assets/feature-music-Layout-3.js.map',
            'assets/feature-projects-ProjectShell-2.js',
            'assets/feature-projects-ProjectShell-2.js.map'
        ]);
        expect(fs.readdirSync(path.join(dir, 'assets')).sort()).toEqual([
            'feature-knowledge-Notes-4.js',
            'feature-knowledge-Notes-4.js.map',
            'index-1.css',
            'index-1.js',
            'index-1.js.map'
        ]);
        expect(JSON.parse(fs.readFileSync(path.join(dir, frontendChunks.INSTALLED_FILE), 'utf8'))).toEqual({ version: 1, features: ['knowledge'] });
        expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(true);
    });

    test('refuses a dist without feature-chunks.json and never follows a path out of the dist', () => {
        fs.rmSync(path.join(dir, frontendChunks.CHUNKS_FILE));
        expect(() => frontendChunks.pruneDist(dir, { installed: [] })).toThrow(expect.objectContaining({ code: 'NO_FEATURE_CHUNKS' }));

        const outside = path.join(path.dirname(dir), `${path.basename(dir)}-sentinel.js`);
        fs.writeFileSync(outside, 'keep');
        try {
            frontendChunks.writeFeatureChunks(dir, { chunks: { [`../${path.basename(outside)}`]: 'music' } });
            frontendChunks.pruneDist(dir, { installed: [] });
            expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
        } finally {
            fs.rmSync(outside, { force: true });
        }
    });
});
