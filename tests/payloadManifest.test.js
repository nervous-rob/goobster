/**
 * Payload ownership and the release manifest (#328, documentation/packaging.md).
 *
 * Pure checks over the repository: every source file has exactly one owner,
 * the descriptor globs agree with the inventory, the require graph never
 * crosses into a feature the importer does not depend on except through
 * requireOptional, the privacy/export closure needs no feature module, and
 * selecting features from the manifest is closed over `requires` and keeps
 * shared files and dependencies. No database, network or build.
 */

const fs = require('node:fs');
const path = require('node:path');
const catalog = require('@goobster/core/features/catalog');
const payload = require('../scripts/lib/payloadManifest');
const { scanSource, closureOf } = require('../scripts/lib/requireGraph');

const ROOT = path.resolve(__dirname, '..');
const TARGET = { id: 'linux-x64', platform: 'linux', arch: 'x64' };
const NODE = { version: '22.23.3', abi: '127' };
const CORE = 'core';
const { inventory } = catalog;
const OPTIONAL = catalog.FEATURE_IDS.filter(id => id !== CORE);

let ownership;
let manifest;

function build(own = ownership) {
    return payload.buildReleaseManifest({ ownership: own, catalog, coreVersion: '1.2.3', target: TARGET, node: NODE, root: ROOT });
}

function claimOf(kind, id) {
    const found = inventory.ownerOf(kind, id);
    return found ? { owner: found.owner, alsoRequires: found.alsoRequires || [] } : null;
}

function payloadPath(repoPath) {
    return payload.payloadPathOf(repoPath);
}

function depDir(name) {
    return manifest.dependencies.find(dep => dep.name === name && dep.path === `app/node_modules/${name}`)?.path;
}

beforeAll(() => {
    ownership = payload.computeOwnership({ root: ROOT, catalog, target: TARGET });
    manifest = build();
}, 60_000);

describe('descriptor payload validation', () => {
    function withPayload(id, payloadSection) {
        const features = { ...catalog.FEATURES, [id]: { ...catalog.FEATURES[id], payload: payloadSection } };
        return () => catalog.validateCatalog({ FEATURE_IDS: catalog.FEATURE_IDS, FEATURES: features });
    }

    test('the shipped catalog validates', () => {
        expect(() => catalog.validateCatalog()).not.toThrow();
        for (const id of catalog.FEATURE_IDS) {
            const section = catalog.FEATURES[id].payload;
            expect(Array.isArray(section.files)).toBe(true);
            expect(Array.isArray(section.frontend)).toBe(true);
            expect(Array.isArray(section.system)).toBe(true);
        }
    });

    test.each([
        ['missing arrays', { files: [] }, 'BAD_PAYLOAD'],
        ['an absolute glob', { files: ['/etc/passwd'], frontend: [], system: [] }, 'BAD_PAYLOAD_GLOB'],
        ['a parent glob', { files: ['../outside/**'], frontend: [], system: [] }, 'BAD_PAYLOAD_GLOB'],
        ['a repeated glob', { files: ['apps/sandbox/**', 'apps/sandbox/**'], frontend: [], system: [] }, 'DUPLICATE_PAYLOAD_GLOB'],
        ['another feature\'s chunk', { files: [], frontend: ['music'], system: [] }, 'BAD_PAYLOAD_CHUNK'],
        ['an unknown system dependency', { files: [], frontend: [], system: [{ name: 'not-a-binary', kind: 'binary' }] }, 'UNKNOWN_PAYLOAD_SYSTEM']
    ])('rejects %s', (_label, section, code) => {
        expect(withPayload('sandbox', section)).toThrow(expect.objectContaining({ code }));
    });
});

describe('ownership', () => {
    test('every source file has exactly one owner and no glob is dead', () => {
        expect(ownership.conflicts).toEqual([]);
        expect(ownership.unmatchedGlobs).toEqual([]);
        const sources = payload.listTrackedFiles(ROOT).filter(file => payload.SOURCE_ROOTS.some(root => file.startsWith(`${root}/`)));
        expect(sources.length).toBeGreaterThan(500);
        const ids = new Set(catalog.FEATURE_IDS);
        for (const file of sources) {
            expect(ids.has(ownership.owners[file])).toBe(true);
        }
        expect(Object.keys(ownership.owners).sort()).toEqual([...sources].sort());
    });

    test('every require resolves and the dynamic ones are the known set', () => {
        expect(ownership.graph.unresolved).toEqual([]);
        expect(ownership.missingPackages).toEqual([]);
        expect(ownership.graph.dynamic.map(entry => `${entry.from}:${entry.kind}`).sort()).toEqual([
            'apps/api/index.js:require',
            'apps/bot/index.js:require',
            'apps/bot/index.js:require',
            'apps/bot/index.js:require',
            'apps/manager/lazy.js:require',
            'packages/core/services/backupArchive.js:require',
            'packages/core/utils/commandDeployment.js:require'
        ]);
    });

    function allowedHosts(claim) {
        return new Set([claim.owner, ...claim.alsoRequires, 'discord']);
    }

    test('commands and context menus live in files their feature (or a feature it requires) owns', () => {
        for (const [kind, table] of [['command', inventory.commands], ['contextMenu', inventory.contextMenus]]) {
            for (const key of Object.keys(table)) {
                const file = `apps/bot/commands/${key}`;
                expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
                const claim = claimOf(kind, key);
                const host = ownership.owners[file];
                if (!allowedHosts(claim).has(host)) {
                    throw new Error(`${file} is owned by ${host} but the inventory gives it to ${claim.owner}`);
                }
            }
        }
    });

    test('chat tools live in modules their feature (or a feature it requires) owns', () => {
        const dir = 'packages/core/utils/tools';
        for (const name of fs.readdirSync(path.join(ROOT, dir)).filter(entry => entry.endsWith('.js') && entry !== 'helpers.js')) {
            const file = `${dir}/${name}`;
            const host = ownership.owners[file];
            const tools = Object.keys(require(path.join(ROOT, file)));
            expect(tools.length).toBeGreaterThan(0);
            for (const tool of tools) {
                const claim = claimOf('aiTool', tool);
                expect(claim).not.toBeNull();
                if (host === CORE) continue;
                if (![claim.owner, ...claim.alsoRequires].includes(host)) {
                    throw new Error(`${tool} (owned by ${claim.owner}) lives in ${file}, owned by ${host}`);
                }
            }
        }
    });

    test('a requireOptional edge names the feature that owns its target', () => {
        const wrong = [];
        for (const [file, node] of Object.entries(ownership.graph.files)) {
            for (const edge of node.edges) {
                if (edge.kind !== 'optional') continue;
                expect(catalog.FEATURE_IDS).toContain(edge.feature);
                if (!edge.file) continue;
                const target = ownership.owners[edge.file];
                if (target === CORE || !catalog.closure([edge.feature]).includes(target)) {
                    wrong.push(`${file}:${edge.line} ${edge.spec} tagged ${edge.feature}, owned by ${target}`);
                }
            }
        }
        expect(wrong).toEqual([]);
    });

    test('no plain require crosses into a feature the importer does not depend on', () => {
        const crossings = [];
        for (const [file, node] of Object.entries(ownership.graph.files)) {
            const from = ownership.owners[file] || CORE;
            for (const edge of node.edges) {
                if (edge.kind === 'optional' || !edge.file) continue;
                const to = ownership.owners[edge.file] || CORE;
                if (to === CORE || to === from) continue;
                if (from !== CORE && catalog.closure([from]).includes(to)) continue;
                crossings.push(`${from}->${to} ${file}:${edge.line} ${edge.spec}`);
            }
        }
        expect(crossings).toEqual([]);
    });

    test('discord.js belongs to the Discord adapter alone and the API never imports it', () => {
        const dep = manifest.dependencies.find(entry => entry.name === 'discord.js');
        expect(dep).toEqual(expect.objectContaining({ owners: ['discord'], exclusive: true }));
        const apiClosure = closureOf(ownership.graph, ['apps/api/index.js']);
        const plain = [];
        for (const file of apiClosure) {
            for (const edge of ownership.graph.files[file]?.edges || []) {
                if (edge.package === 'discord.js' && edge.kind !== 'optional') plain.push(`${file}:${edge.line}`);
            }
        }
        expect(plain).toEqual([]);
        expect(apiClosure.filter(file => file.startsWith('apps/bot/'))).toEqual([]);
    });

    test('the privacy, audit and export path needs no feature module', () => {
        const entries = [
            'packages/core/services/privacyService.js',
            'packages/core/services/accountExportService.js',
            'packages/core/services/accountExportData.js',
            'packages/core/services/ledgerRetentionService.js',
            'packages/core/services/inboxService.js',
            'packages/core/services/operatorAuditService.js',
            'packages/core/services/dormantDataService.js',
            'packages/core/utils/accountExportArchive.js',
            'packages/core/db/index.js'
        ];
        // Everything these modules load at require time, plus what their own
        // functions require; deeper lazy requires run only on unrelated paths
        // and are covered by the reduced-payload probe (payloadReduced.test.js).
        const own = new Set(entries);
        const seen = new Set(entries);
        const queue = [...entries];
        while (queue.length) {
            const file = queue.shift();
            for (const edge of ownership.graph.files[file]?.edges || []) {
                if (!edge.file || edge.kind === 'optional' || seen.has(edge.file)) continue;
                if (!edge.eager && !own.has(file)) continue;
                seen.add(edge.file);
                queue.push(edge.file);
            }
        }
        expect([...seen].filter(file => ownership.owners[file] !== CORE)).toEqual([]);
        expect(seen.size).toBeGreaterThan(50);
    });

    test('no declared production dependency is unreferenced (play-dl and play-audio are gone, finding B5)', () => {
        // A package nobody imports would be reported here and left out of
        // every payload; the manifests no longer declare one.
        expect(manifest.unreferenced).toEqual([]);
        const names = new Set(manifest.dependencies.map(dep => dep.name));
        expect(names.has('play-dl')).toBe(false);
        expect(names.has('play-audio')).toBe(false);
        for (const file of ['package.json', 'packages/core/package.json']) {
            const declared = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')).dependencies || {};
            expect(Object.keys(declared)).not.toContain('play-dl');
        }
    });

    test('a declared dependency that no source file imports is reported unreferenced', () => {
        // The lockfile is the manifest's source of declared dependencies;
        // add one that nothing requires (the shape play-dl had) and a
        // package only it pulls in.
        const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
        lock.packages['packages/core'].dependencies = { ...lock.packages['packages/core'].dependencies, 'left-over-dep': '^1.0.0' };
        lock.packages['node_modules/left-over-dep'] = { version: '1.0.0', license: 'GPL-3.0', dependencies: { 'left-over-child': '^1.0.0' } };
        lock.packages['node_modules/left-over-child'] = { version: '1.0.0', license: 'GPL-3.0' };
        const again = payload.computeOwnership({ root: ROOT, catalog, target: TARGET, lock });
        expect(again.unreferenced.map(entry => entry.name).sort()).toEqual(['left-over-child', 'left-over-dep']);
        expect(again.unreferenced.find(entry => entry.name === 'left-over-dep').reason).toMatch(/imported by no source file/);
        expect(again.unreferenced.find(entry => entry.name === 'left-over-child').reason).toMatch(/only required by unreferenced left-over-dep/);
        expect(again.dependencies.some(dep => dep.name.startsWith('left-over-'))).toBe(false);
    });

    test('a dependency is exclusive only with one non-core owner', () => {
        for (const dep of manifest.dependencies) {
            expect(dep.exclusive).toBe(dep.owners.length === 1 && dep.owners[0] !== CORE);
        }
        expect(manifest.dependencies.find(dep => dep.name === 'nodemailer')).toEqual(expect.objectContaining({ owners: ['mail'], exclusive: true }));
        expect(manifest.dependencies.find(dep => dep.name === 'express').owners).toContain(CORE);
    });
});

describe('release manifest v1', () => {
    test('has the documented shape', () => {
        expect(Object.keys(manifest).sort()).toEqual(['dependencies', 'files', 'frontend', 'groups', 'node', 'release', 'target', 'unreferenced', 'version']);
        expect(manifest.version).toBe(1);
        expect(manifest.release).toEqual({ core: '1.2.3', compatibleCore: '>=1.2.3 <2.0.0' });
        expect(manifest.target).toEqual(TARGET);
        expect(manifest.node).toEqual(NODE);
        expect(Object.keys(manifest.groups).sort()).toEqual([...catalog.FEATURE_IDS].sort());
        for (const [id, group] of Object.entries(manifest.groups)) {
            expect(Array.isArray(group.files)).toBe(true);
            expect(Array.isArray(group.dependencies)).toBe(true);
            if (id === CORE) continue;
            expect(group.requires).toEqual(catalog.FEATURES[id].dependsOn);
            expect(group.frontend).toEqual(catalog.FEATURES[id].payload.frontend);
            expect(group.system).toEqual(catalog.FEATURES[id].payload.system);
        }
        const ids = new Set(Object.keys(manifest.groups));
        for (const file of manifest.files) {
            expect(Object.keys(file).sort()).toEqual(['owner', 'path', 'sha256', 'size']);
            expect(ids.has(file.owner)).toBe(true);
            expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
        for (const dep of manifest.dependencies) {
            expect(Object.keys(dep).sort()).toEqual(['exclusive', 'license', 'name', 'native', 'owners', 'path', 'version']);
        }
    });

    test('a file appears in exactly one group', () => {
        const all = Object.values(manifest.groups).flatMap(group => group.files);
        expect(new Set(all).size).toBe(all.length);
        expect(all.length).toBe(manifest.files.length);
    });

    test('is deterministic and independent of input order', () => {
        const again = payload.computeOwnership({
            root: ROOT, catalog, target: TARGET, files: payload.listTrackedFiles(ROOT).reverse()
        });
        expect(payload.canonicalJson(build(again))).toBe(payload.canonicalJson(manifest));
        expect(payload.canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{\n  "a": [\n    {\n      "c": 3,\n      "d": 2\n    }\n  ],\n  "b": 1\n}\n');
    });

    test('built from payload files, it lists only the dependencies that have files there', () => {
        const kept = manifest.dependencies.find(dep => dep.name === 'discord.js' && dep.path);
        const dropped = manifest.dependencies.find(dep => dep.name === 'sharp' && dep.path);
        const files = manifest.files.slice(0, 200).map(({ path: filePath, sha256, size }) => ({ path: filePath, sha256, size }));
        files.push({ path: `${kept.path}/package.json`, sha256: '0'.repeat(64), size: 2 });
        const fromPayload = payload.buildReleaseManifest({ ownership, catalog, coreVersion: '1.2.3', target: TARGET, node: NODE, files });
        const paths = fromPayload.dependencies.map(dep => dep.path);
        expect(paths).toContain(kept.path);
        expect(paths).not.toContain(dropped.path);
        expect(fromPayload.groups.exchange.dependencies).not.toContain('sharp');
    });
});

describe('selectPayload', () => {
    function select(features) {
        return payload.selectPayload(manifest, { features });
    }

    test('minimal keeps only core and drops every optional dependency', () => {
        const picked = select([]);
        expect(picked.features).toEqual([CORE]);
        expect(picked.excluded.features.sort()).toEqual([...OPTIONAL].sort());
        const kept = new Set(picked.dependencies);
        for (const dep of manifest.dependencies) {
            expect(kept.has(dep.path)).toBe(dep.owners.includes(CORE));
        }
        for (const name of ['discord.js', '@discordjs/voice', 'nodemailer']) {
            expect(picked.excluded.dependencies).toContain(depDir(name));
        }
        expect(picked.files).toContain(payloadPath('packages/core/services/privacyService.js'));
        expect(picked.files).toContain(payloadPath('packages/core/services/dormantDataService.js'));
        expect(picked.excluded.files).toContain(payloadPath('packages/core/services/projectService.js'));
        expect(picked.excluded.files).toContain(payloadPath('packages/core/services/tavern/interactionHandler.js'));
    });

    test('full keeps everything', () => {
        const picked = select(catalog.FEATURE_IDS);
        expect(picked.excluded).toEqual({ features: [], files: [], dependencies: [], chunks: [] });
        expect(picked.files.length).toBe(manifest.files.length);
    });

    test('voice without music keeps the voice stack and drops the music modules', () => {
        const picked = select(['voice']);
        expect(picked.features.sort()).toEqual([CORE, 'voice']);
        expect(picked.files).toContain(payloadPath('packages/core/services/voice/index.js'));
        expect(picked.files).toContain(payloadPath('packages/core/services/voice/pcmUtils.js'));
        expect(picked.excluded.files).toContain(payloadPath('packages/core/services/voice/musicService.js'));
        expect(picked.excluded.files).toContain(payloadPath('packages/core/services/spotdl/spotdlService.js'));
        expect(picked.dependencies).toContain(depDir('@discordjs/voice'));
        expect(picked.excluded.dependencies).toContain(depDir('discord.js'));
    });

    test('projects without mcp drops the MCP server only', () => {
        const picked = select(['projects']);
        expect(picked.files).toContain(payloadPath('packages/core/services/projectService.js'));
        expect(picked.excluded.files).toContain(payloadPath('packages/core/mcp/tools.js'));
        expect(picked.excluded.files).not.toContain(payloadPath('packages/core/services/mcpTokenService.js'));
    });

    test('knowledge without expeditions drops the research pipeline', () => {
        const picked = select(['knowledge']);
        expect(picked.files).toContain(payloadPath('packages/core/web/routes/spitball.js'));
        expect(picked.excluded.files).toContain(payloadPath('packages/core/services/spitballExpeditionService.js'));
        expect(picked.excluded.files).toContain(payloadPath('packages/core/services/expeditionBriefService.js'));
    });

    test('selection closes over requires', () => {
        expect(select(['observatory']).features.sort()).toEqual([CORE, 'observatory', 'projects', 'sandbox']);
        expect(select(['expeditions']).features.sort()).toEqual([CORE, 'expeditions', 'knowledge']);
        expect(() => select(['nope'])).toThrow(expect.objectContaining({ code: 'UNKNOWN_FEATURE' }));
    });

    test('the Discord adapter and its exclusive dependencies go together', () => {
        const without = select(OPTIONAL.filter(id => !catalog.closure([id]).includes('discord')));
        expect(without.excluded.features.sort()).toEqual(['discord', ...catalog.dependentsOf('discord')].sort());
        const exclusive = manifest.dependencies.filter(dep => dep.exclusive && dep.owners[0] === 'discord').map(dep => dep.path).sort();
        expect(exclusive).toContain(depDir('discord.js'));
        expect(without.excluded.dependencies.sort()).toEqual(exclusive);
        expect(select(['discord']).dependencies).toContain(depDir('discord.js'));
    });

    test('a shared file or dependency stays while any owner is selected', () => {
        const shared = manifest.dependencies.find(dep => dep.name === '@discordjs/voice');
        expect(shared.exclusive).toBe(false);
        for (const owner of shared.owners) {
            expect(select([owner]).dependencies).toContain(shared.path);
        }
    });
});

describe('requireGraph', () => {
    test('reads literal, optional and ESM specs and reports dynamic ones', () => {
        const source = [
            "const a = require('./a');",
            '// require(\'./commented\')',
            'function f() {',
            "    const b = require(\"pkg/sub\");",
            "    const c = requireOptional('./c', { feature: 'music' });",
            '    return require(name);',
            '}',
            "import d from './d.js';"
        ].join('\n');
        const { specs, dynamic } = scanSource(source);
        expect(specs.map(({ spec, kind, feature, eager }) => [spec, kind, feature, eager])).toEqual([
            ['./c', 'optional', 'music', false],
            ['./a', 'require', null, true],
            ['pkg/sub', 'require', null, false],
            ['./d.js', 'import', null, true]
        ]);
        expect(dynamic).toEqual([expect.objectContaining({ line: 6, kind: 'require' })]);
    });
});
