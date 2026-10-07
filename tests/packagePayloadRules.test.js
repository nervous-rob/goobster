/**
 * The payload rules behind scripts/package-runtime.js (issue #327,
 * documentation/packaging_proof.md): what may never ship, the pinned Node
 * runtime per target, how an npm install log is judged for "no compile",
 * and the binary-header reader that records glibc / macOS / DLL baselines.
 * Pure functions over lists and text: no network, no payload build.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rules = require('../scripts/lib/packageRules');
const { inspectBinary, looksLikeBinary, compareVersions, maxVersion } = require('../scripts/lib/nativeBinaryInfo');

const file = rel => ({ rel, type: 'file' });
const dir = rel => ({ rel, type: 'dir' });
const link = rel => ({ rel, type: 'symlink' });

describe('target matrix and Node pins', () => {
    test('every promised target resolves and has a pinned SHA-256 for its archive', () => {
        const promised = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];
        expect(Object.keys(rules.TARGETS).sort()).toEqual([...promised].sort());
        for (const id of promised) {
            const download = rules.nodeDownload(rules.resolveTarget(id));
            expect(download.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(download.url.startsWith('https://nodejs.org/dist/')).toBe(true);
            expect(download.file).toContain(rules.pins.nodeVersion);
        }
    });

    test('windows uses the zip and node.exe, unix the tarball and bin/node', () => {
        expect(rules.nodeDownload(rules.resolveTarget('win32-x64')).file).toMatch(/win-x64\.zip$/);
        expect(rules.TARGETS['win32-x64'].nodeBin).toBe('node.exe');
        expect(rules.nodeDownload(rules.resolveTarget('linux-arm64')).file).toMatch(/linux-arm64\.tar\.gz$/);
        expect(rules.TARGETS['linux-arm64'].nodeBin).toBe('bin/node');
    });

    test('the pinned runtime is a Node 22 LTS (module ABI 127)', () => {
        expect(rules.pins.nodeVersion.startsWith('22.')).toBe(true);
        expect(rules.pins.moduleVersion).toBe('127');
    });

    test('unsupported targets are refused with the promised list', () => {
        expect(() => rules.resolveTarget('linux-armv7l')).toThrow(/Promised targets: linux-x64/);
        expect(() => rules.resolveTarget('win32-arm64')).toThrow(/Unsupported target/);
    });

    test('hostTargetId joins platform and arch', () => {
        expect(rules.hostTargetId('darwin', 'arm64')).toBe('darwin-arm64');
    });
});

describe('validatePayloadEntries', () => {
    test('a clean payload has no violations', () => {
        const entries = [
            dir('app'), dir('app/node_modules'), file('app/node_modules/pkg/index.js'),
            dir('app/node_modules/pkg/test'), file('app/node_modules/pkg/test/a.js'),
            dir('app/node_modules/undici/lib/web/cache'), file('app/node_modules/undici/lib/web/cache/cache.js'),
            file('app/apps/api/index.js'), file('app/package.json'), file('bin/goobster-api')
        ];
        expect(rules.validatePayloadEntries(entries)).toEqual([]);
    });

    test('any symlink is a violation, including npm workspace and .bin links', () => {
        const violations = rules.validatePayloadEntries([link('app/node_modules/@goobster/core'), link('app/node_modules/.bin/semver')]);
        expect(violations.map(v => v.rule)).toEqual(['symlink', 'symlink']);
    });

    test('config.json, env files and database files are refused anywhere', () => {
        const violations = rules.validatePayloadEntries([
            file('app/config.json'), file('app/node_modules/x/config.json'), file('app/.env'), file('app/.env.local'),
            file('app/data/goobster.sqlite'), file('app/x.db-wal')
        ]);
        const refused = violations.filter(v => v.rule === 'secret-or-user-data-file').map(v => v.rel);
        expect(refused).toEqual(expect.arrayContaining(['app/config.json', 'app/node_modules/x/config.json', 'app/.env', 'app/.env.local', 'app/data/goobster.sqlite', 'app/x.db-wal']));
    });

    test('state and developer directories are refused outside node_modules only', () => {
        const rulesHit = rules.validatePayloadEntries([
            dir('app/data'), file('app/logs/goobster.log'), file('app/cache/x'), file('app/tests/a.test.js'), file('app/e2e/a.spec.js'), file('app/.git/HEAD')
        ]).map(v => v.rule);
        expect(rulesHit).toEqual(expect.arrayContaining(['forbidden-directory:data', 'forbidden-directory:logs', 'forbidden-directory:cache', 'forbidden-directory:tests', 'forbidden-directory:e2e', 'forbidden-directory:.git']));
        expect(rules.validatePayloadEntries([file('app/node_modules/a/data/x.json'), file('app/node_modules/a/cache/y')])).toEqual([]);
    });
});

describe('isCodeFileExcluded', () => {
    test('keeps source, drops state, tests and secrets', () => {
        expect(rules.isCodeFileExcluded('packages/core/db/schema.sql')).toBe(false);
        expect(rules.isCodeFileExcluded('apps/api/server.js')).toBe(false);
        expect(rules.isCodeFileExcluded('packages/core/node_modules/x/index.js')).toBe(true);
        expect(rules.isCodeFileExcluded('apps/api/tests/a.js')).toBe(true);
        expect(rules.isCodeFileExcluded('documentation/config.json')).toBe(true);
        expect(rules.isCodeFileExcluded('clients/x/.env')).toBe(true);
    });
});

describe('findCompileTraces', () => {
    test('a prebuilt module (build/Release/*.node only) is clean', () => {
        expect(rules.findCompileTraces([file('app/node_modules/better-sqlite3/build/Release/better_sqlite3.node')])).toEqual([]);
    });

    test('node-gyp leftovers are flagged', () => {
        const hits = rules.findCompileTraces([
            file('app/node_modules/x/build/Makefile'),
            file('app/node_modules/x/build/config.gypi'),
            file('app/node_modules/x/build/Release/obj.target/x/src/a.o'),
            file('app/node_modules/y/build/y.vcxproj'),
            file('app/node_modules/y/build/Release/y.pdb')
        ]);
        expect(hits).toHaveLength(5);
    });
});

describe('validateBinaryTargets', () => {
    const target = rules.resolveTarget('linux-arm64');
    test('matching format and architecture passes; universal Mach-O counts', () => {
        expect(rules.validateBinaryTargets([{ rel: 'a.node', info: { format: 'elf', arch: ['arm64'] } }], target)).toEqual([]);
        expect(rules.validateBinaryTargets([{ rel: 'b.node', info: { format: 'macho', arch: ['x64', 'arm64'] } }], rules.resolveTarget('darwin-arm64'))).toEqual([]);
    });

    test('a foreign architecture or format is a violation', () => {
        const violations = rules.validateBinaryTargets([
            { rel: 'x64.node', info: { format: 'elf', arch: ['x64'] } },
            { rel: 'win.node', info: { format: 'pe', arch: ['arm64'] } }
        ], target);
        expect(violations.map(v => v.rule)).toEqual(['binary-arch:x64!=arm64', 'binary-format:pe!=elf']);
    });
});

describe('analyzeInstallLog', () => {
    const prebuilt = [
        '> better-sqlite3@11.10.0 install',
        '> prebuild-install || node-gyp rebuild --release',
        'prebuild-install http request GET https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/better-sqlite3-v11.10.0-node-v127-linux-x64.tar.gz',
        'prebuild-install http 200 https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/better-sqlite3-v11.10.0-node-v127-linux-x64.tar.gz',
        '> sharp@0.32.6 install',
        '> (node install/libvips && node install/dll-copy && prebuild-install) || (node install/can-compile && node-gyp rebuild && node install/dll-copy)',
        'sharp: Downloading https://github.com/lovell/sharp-libvips/releases/download/v8.14.5/libvips-8.14.5-linux-x64.tar.br',
        'sharp: Integrity check passed for linux-x64',
        'prebuild-install http 200 https://github.com/lovell/sharp/releases/download/v0.32.6/sharp-v0.32.6-napi-v7-linux-x64.tar.gz'
    ].join('\n');

    test('echoed install scripts that merely mention node-gyp are not a compile', () => {
        const result = rules.analyzeInstallLog(prebuilt);
        expect(result.compileOutput).toEqual([]);
        expect(result.prebuildFetches).toHaveLength(2);
        expect(result.prebuildFetches[0]).toContain('better-sqlite3-v11.10.0-node-v127-linux-x64.tar.gz');
        expect(result.libvips).toHaveLength(2);
    });

    test('node-gyp runtime output, make and compiler lines are a compile', () => {
        const log = `${prebuilt}\nprebuild-install warn install No prebuilt binaries found\ngyp info it worked if it ends with ok\nmake: Entering directory '/x/build'\ng++ -o Release/obj.target/a.o ../a.cc`;
        const result = rules.analyzeInstallLog(log);
        expect(result.compileOutput.length).toBeGreaterThanOrEqual(4);
    });
});

describe('nativeBinaryInfo', () => {
    test('the running Node binary reports this platform format and architecture', () => {
        const info = inspectBinary(process.execPath);
        const format = { linux: 'elf', darwin: 'macho', win32: 'pe' }[process.platform];
        expect(info.format).toBe(format);
        expect(info.arch).toContain(process.arch);
    });

    test('unrecognised files are reported as unknown, not guessed', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-binary-'));
        try {
            const text = path.join(tmp, 'fake.node');
            fs.writeFileSync(text, 'not a binary at all, just text, long enough to read a header from');
            expect(inspectBinary(text).format).toBe('unknown');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('version comparison is numeric, not lexical', () => {
        expect(compareVersions('2.9', '2.28')).toBeLessThan(0);
        expect(maxVersion(['2.17', '2.29', '2.5'])).toBe('2.29');
        expect(maxVersion([])).toBeNull();
    });

    test('shared-library file names are recognised', () => {
        for (const name of ['a.node', 'vec0.so', 'libvips-cpp.so.42', 'x.dylib', 'sodium.dll']) expect(looksLikeBinary(name)).toBe(true);
        expect(looksLikeBinary('index.js')).toBe(false);
    });
});
