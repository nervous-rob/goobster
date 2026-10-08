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
const childProcess = require('node:child_process');

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

describe('package-runtime selection flags', () => {
    const { parseArgs, resolveSelection } = require('../scripts/package-runtime');

    test('no selection flag keeps the full payload', () => {
        const options = parseArgs(['--out', '/tmp/x']);
        expect(options).toMatchObject({ devSign: false });
        expect(options.profile).toBeUndefined();
        const selection = resolveSelection(options);
        expect(selection.name).toBe('full');
        expect(selection.features).toEqual(expect.arrayContaining(['discord', 'music', 'voice', 'sandbox']));
        expect(selection.features).not.toContain('core');
    });

    test('--profile minimal is core only, --features closes over dependsOn, --dev-sign is recorded', () => {
        expect(resolveSelection(parseArgs(['--profile', 'minimal']))).toEqual({ name: 'minimal', features: [] });
        expect(resolveSelection(parseArgs(['--features', 'projects, sandbox']))).toEqual({ name: 'custom', features: ['projects', 'sandbox'] });
        const music = resolveSelection(parseArgs(['--features', 'music']));
        expect(music.name).toBe('custom');
        expect(music.features).toContain('music');
        expect(parseArgs(['--dev-sign']).devSign).toBe(true);
    });

    test('bad selections are refused before anything is built', () => {
        expect(() => parseArgs(['--profile', 'tiny'])).toThrow(/--profile must be one of minimal, full/);
        expect(() => parseArgs(['--profile', 'minimal', '--features', 'voice'])).toThrow(/alternatives/);
        expect(() => parseArgs(['--features'])).toThrow(/needs a value/);
        expect(() => resolveSelection(parseArgs(['--features', 'voice,warpdrive']))).toThrow(/Unknown feature\(s\) for --features: warpdrive/);
    });
});

describe('the manager launchers the payload carries', () => {
    const { launchers } = require('../scripts/package-runtime');

    test('an installed POSIX payload (<code root>/current) takes its roots from <code root>/goobster.env, environment first', () => {
        const text = launchers.posixManager;
        expect(text).toContain('ENV_FILE="$(dirname -- "$REACHED")/goobster.env"');
        expect(text).toContain('if [ "$(basename -- "$REACHED")" = "current" ] && [ -r "$ENV_FILE" ]; then');
        expect(text).toContain('GOOBSTER_[A-Z0-9_]*=*)');
        expect(text).toContain('if ! printenv "$key" >/dev/null 2>&1; then');
        expect(text.indexOf('goobster.env')).toBeLessThan(text.indexOf('GOOBSTER_DATA_DIR="${GOOBSTER_DATA_DIR:-'));
    });

    test('the POSIX launcher judges "current" by the name it was reached by (links kept), not by the directory that name resolves to', () => {
        const text = launchers.posixManager;
        // the linked layout makes `current` a link into live/: a physical path would never be named current
        expect(text).toContain('REACHED=$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd -L)');
        expect(text).toContain('PAYLOAD=$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd -P)');
        expect(text).not.toContain('basename -- "$PAYLOAD"');
    });

    test('the POSIX launcher run through a current link that names a payload under live/ reads goobster.env', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-launcher-'));
        try {
            const live = path.join(root, 'live', 'p-000001');
            fs.mkdirSync(path.join(live, 'bin'), { recursive: true });
            fs.mkdirSync(path.join(live, 'runtime', 'bin'), { recursive: true });
            fs.mkdirSync(path.join(live, 'app', 'apps', 'manager'), { recursive: true });
            fs.writeFileSync(path.join(live, 'bin', 'goobster-manager'), launchers.posixManager, { mode: 0o755 });
            // a stand-in node that prints the roots the launcher exported
            fs.writeFileSync(path.join(live, 'runtime', 'bin', 'node'), '#!/bin/sh\nprintf "%s|%s\\n" "$GOOBSTER_DATA_DIR" "$GOOBSTER_WORKSPACE_ROOT"\n', { mode: 0o755 });
            fs.symlinkSync(live, path.join(root, 'current'));
            fs.writeFileSync(path.join(root, 'goobster.env'), 'GOOBSTER_DATA_DIR=/srv/goobster-data\n');
            const env = { PATH: process.env.PATH, HOME: root };
            const out = childProcess.spawnSync('/bin/sh', [path.join(root, 'current', 'bin', 'goobster-manager'), 'status'], { env, encoding: 'utf8' });
            expect(out.status).toBe(0);
            const [data, workspace] = out.stdout.trim().split('|');
            expect(data).toBe('/srv/goobster-data');
            expect(fs.realpathSync(workspace)).toBe(fs.realpathSync(path.join(live, 'app')));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('the Windows payload launcher reads the same file the same way, so the installed current\\bin launcher sees the installation and not %LOCALAPPDATA%', () => {
        const lines = launchers.windowsManager.split('\r\n');
        expect(lines).toContain('for %%I in ("%PAYLOAD%\\..") do set "CODE=%%~fI"');
        expect(lines).toContain('if /i "%PAYLOAD_NAME%"=="current" if exist "%CODE%\\goobster.env" (');
        expect(lines).toContain('    for /f "usebackq eol=# tokens=1* delims==" %%A in ("%CODE%\\goobster.env") do (');
        expect(lines).toContain('        echo %%A| findstr /b /c:"GOOBSTER_" >nul && if not defined %%A set "%%A=%%B"');
        const read = lines.findIndex((line) => line.includes('goobster.env'));
        const defaults = lines.findIndex((line) => line.includes('if not defined GOOBSTER_HOME'));
        expect(read).toBeGreaterThan(-1);
        expect(read).toBeLessThan(defaults);
        expect(launchers.windowsManager).not.toMatch(/call "%CODE%\\goobster\.env"|^\s*"%CODE%\\goobster\.env"/m);
    });

    test('the Windows payload launcher never takes a substring of a variable that may be undefined: with no argument, cmd drops "%VAR:" and the line fails with a syntax error (exit 255)', () => {
        const lines = launchers.windowsManager.split('\r\n').filter((line) => !/^\s*rem\b/i.test(line));
        const defined = new Set();
        for (const line of lines) {
            for (const match of line.matchAll(/%([A-Za-z_][A-Za-z0-9_]*):~/g)) {
                expect(defined.has(match[1])).toBe(true);
            }
            const set = /^\s*(?:if [^(]*? )?set "([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"/.exec(line);
            // Only a value that cannot be empty counts (a bare %~1 or %1 is empty with no argument).
            if (set && set[2] !== '' && !/^%~?\*?\d*%?$/.test(set[2]) && !/^%~[a-z]*\d$/i.test(set[2])) defined.add(set[1]);
        }
        expect(lines).toContain('set "FIRST=x%~1"');
        expect(lines).toContain('if "%FIRST%"=="x" set "ENTRY=%PAYLOAD%\\app\\apps\\manager\\index.js"');
        expect(lines).toContain('if "%FIRST:~1,1%"=="-" set "ENTRY=%PAYLOAD%\\app\\apps\\manager\\index.js"');
        expect(launchers.windowsManager).not.toContain('%FIRST:~0,1%');
    });
});
