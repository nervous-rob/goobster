/**
 * The artifact hygiene scan (#341, scripts/release-verify-artifacts.js): every forbidden path and link
 * shape through the pure rules, then real archives built by the bootstrap archiver (and hand-made ones the
 * archiver would never write) through the tar reader, the `.run` container, a directory tree, native
 * binary headers and the CLI's exit codes. Keys are generated at test time.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const bootstrapStage = require('../scripts/lib/bootstrapStage');
const scan = require('../scripts/release-verify-artifacts');

const roots = [];
afterAll(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `goobster-hyg-${label}-`));
    roots.push(dir);
    return dir;
}

function write(root, rel, content = 'x\n') {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

const rulesOf = (violations) => violations.map(item => item.rule);

/** A payload-shaped tree that is clean. */
function cleanTree(label = 'clean') {
    const root = tempDir(label);
    write(root, 'bin/goobster-api', '#!/bin/sh\n');
    write(root, 'app/apps/api/server.js', 'module.exports = {};\n');
    write(root, 'app/node_modules/left-pad/index.js', 'module.exports = 1;\n');
    write(root, 'app/node_modules/left-pad/tests/spec.js', '// vendored package tests are fine\n');
    write(root, 'app/node_modules/left-pad/data/table.json', '{}\n');
    write(root, 'app/documentation/readme.md', '# docs\n');
    write(root, 'runtime/bin/node', 'not really node\n');
    write(root, 'payload-manifest.json', '{}\n');
    fs.symlinkSync('server.js', path.join(root, 'app', 'apps', 'api', 'alias.js'));
    return root;
}

describe('the entry rules', () => {
    const file = (p) => ({ path: p, type: 'file' });
    const dir = (p) => ({ path: p, type: 'dir' });

    test.each([
        ['config.json at the code root', file('app/config.json'), 'secret-or-user-data-file'],
        ['config.json inside a package', file('app/node_modules/x/config.json'), 'secret-or-user-data-file'],
        ['config.json in any case', file('app/Config.JSON'), 'secret-or-user-data-file'],
        ['features.json', file('app/data/features.json'), 'features-file'],
        ['an .env file', file('app/.env'), 'secret-or-user-data-file'],
        ['an .env.local file', file('app/.env.local'), 'secret-or-user-data-file'],
        ['a sqlite database', file('data/goobster.sqlite'), 'secret-or-user-data-file'],
        ['a sqlite write-ahead log', file('app/goobster.sqlite-wal'), 'secret-or-user-data-file'],
        ['a sqlite3 file', file('app/x.sqlite3'), 'secret-or-user-data-file'],
        ['a .db file', file('app/x.db'), 'secret-or-user-data-file'],
        ['a data directory', dir('app/data'), 'forbidden-directory:data'],
        ['a file under logs', file('logs/bot.log'), 'forbidden-directory:logs'],
        ['node_modules/.cache', dir('app/node_modules/.cache'), 'node-modules-cache'],
        ['a file in node_modules/.cache', file('app/node_modules/.cache/babel/x'), 'node-modules-cache'],
        ['.git at the root', dir('.git'), 'forbidden-directory:.git'],
        ['.git inside a package', file('app/node_modules/x/.git/HEAD'), 'forbidden-directory:.git'],
        ['the repository tests', file('app/tests/a.test.js'), 'forbidden-directory:tests'],
        ['the repository e2e', file('e2e/a.spec.js'), 'forbidden-directory:e2e'],
        ['the repository .github', file('.github/workflows/ci.yml'), 'forbidden-directory:.github'],
        ['a p12 bundle', file('certs/signing.p12'), 'key-or-certificate-bundle'],
        ['a pfx bundle', file('certs/signing.pfx'), 'key-or-certificate-bundle'],
        ['an ssh private key by name', file('home/id_ed25519'), 'private-key-file'],
        ['a parent segment', file('app/../../etc/passwd'), 'path-traversal'],
        ['a leading parent segment', file('../x'), 'path-traversal'],
        ['an absolute path', file('/etc/passwd'), 'path-traversal'],
        ['a Windows drive path', file('C:/Windows/x'), 'path-traversal'],
        ['a backslash parent segment', file('app\\..\\..\\x'), 'path-traversal'],
        ['a NUL in the name', file('app/x\0y'), 'path-traversal'],
        ['an absolute symlink', { path: 'app/link', type: 'symlink', linkTarget: '/etc' }, 'symlink-absolute'],
        ['a Windows absolute symlink', { path: 'app/link', type: 'symlink', linkTarget: 'C:\\Windows' }, 'symlink-absolute'],
        ['a symlink out of the root', { path: 'app/link', type: 'symlink', linkTarget: '../../outside' }, 'symlink-escapes-root'],
        ['a symlink at the root out of it', { path: 'link', type: 'symlink', linkTarget: '../x' }, 'symlink-escapes-root'],
        ['a hard link out of the root', { path: 'app/hard', type: 'hardlink', linkTarget: '../../x' }, 'symlink-escapes-root'],
        ['a device node', { path: 'dev/null', type: 'other' }, 'special-file']
    ])('refuses %s', (_label, entry, rule) => {
        expect(rulesOf(scan.checkEntry(entry))).toContain(rule);
    });

    test.each([
        ['an ordinary payload file', file('app/apps/api/server.js')],
        ['a package that ships its own tests and data', file('app/node_modules/x/tests/a.js')],
        ['a package data directory', dir('app/node_modules/x/data')],
        ['a leading ./', file('./app/server.js')],
        ['a directory with a trailing slash', dir('app/documentation/')],
        ['a symlink that stays inside', { path: 'app/a/link', type: 'symlink', linkTarget: '../b/target' }],
        ['a symlink to a sibling', { path: 'app/link', type: 'symlink', linkTarget: 'sibling' }],
        ['a hard link to a file in the archive', { path: 'app/hard', type: 'hardlink', linkTarget: 'app/real' }],
        ['a public certificate', file('app/certs/ca.pem')],
        ['documentation that mentions a data directory', file('app/documentation/data_reset.md')]
    ])('accepts %s', (_label, entry) => {
        expect(scan.checkEntry(entry)).toEqual([]);
    });

    test('a violation reports a sanitised path, never raw control characters', () => {
        const [violation] = scan.checkEntry({ path: 'app/\u001b[31m/../x', type: 'file' });
        expect(violation.rule).toBe('path-traversal');
        expect(violation.path).not.toMatch(/[\u0000-\u001f]/);
    });

    test('resolveInside follows .. and stops at the root', () => {
        expect(scan.resolveInside('a/b/c', '../d')).toBe('a/d');
        expect(scan.resolveInside('a/b', '../../x')).toBeNull();
        expect(scan.resolveInside('a', './b')).toBe('b');
    });
});

describe('tar archives', () => {
    async function archive(root, name = 'payload.tar.gz') {
        const out = path.join(tempDir('archive-out'), name);
        await bootstrapStage.writeArchive(root, out, {});
        return out;
    }

    test('the bootstrap archiver output is read entry for entry, including PAX long paths and links', async () => {
        const root = cleanTree();
        const long = `app/${'deep/'.repeat(30)}file.txt`;
        write(root, long, 'long\n');
        const result = await scan.scanArtifact(await archive(root), { target: 'linux-x64' });
        expect(result.violations).toEqual([]);
        expect(result.skipped).toBeUndefined();
        const listed = bootstrapStage.listEntries(root).length;
        expect(result.entries).toBe(listed);
    });

    test('readTarEntries sees the long path, the link target and the entry types', async () => {
        const root = cleanTree();
        const long = `app/${'segment/'.repeat(20)}end.txt`;
        write(root, long, 'x');
        const tarFile = path.join(tempDir('plain-tar'), 'payload.tar');
        const gz = await archive(root);
        fs.writeFileSync(tarFile, zlib.gunzipSync(fs.readFileSync(gz)));
        const entries = scan.readTarEntries(tarFile);
        expect(entries.find(entry => entry.path === long)).toMatchObject({ type: 'file', size: 1 });
        expect(entries.find(entry => entry.path === 'app/apps/api/alias.js')).toMatchObject({ type: 'symlink', linkTarget: 'server.js' });
        expect(entries.some(entry => entry.type === 'dir')).toBe(true);
    });

    test('each injected file is found in a real archive', async () => {
        for (const [rel, rule] of [
            ['app/config.json', 'secret-or-user-data-file'],
            ['app/data/features.json', 'features-file'],
            ['data/goobster.sqlite', 'secret-or-user-data-file'],
            ['logs/bot.log', 'forbidden-directory:logs'],
            ['app/.env', 'secret-or-user-data-file'],
            ['app/node_modules/.cache/x', 'node-modules-cache'],
            ['.git/HEAD', 'forbidden-directory:.git'],
            ['tests/a.test.js', 'forbidden-directory:tests'],
            ['e2e/a.spec.js', 'forbidden-directory:e2e'],
            ['.github/workflows/ci.yml', 'forbidden-directory:.github']
        ]) {
            const root = cleanTree('inject');
            write(root, rel, 'x');
            const result = await scan.scanArtifact(await archive(root), { target: 'linux-x64' });
            expect(rulesOf(result.violations)).toContain(rule);
        }
    });

    test('a symlink that escapes or is absolute is found in a real archive', async () => {
        const escaping = cleanTree('escape');
        fs.symlinkSync('../../../../outside', path.join(escaping, 'app', 'apps', 'escape'));
        expect(rulesOf((await scan.scanArtifact(await archive(escaping), {})).violations)).toEqual(['symlink-escapes-root']);
        const absolute = cleanTree('absolute');
        fs.symlinkSync('/etc/passwd', path.join(absolute, 'app', 'abs'));
        expect(rulesOf((await scan.scanArtifact(await archive(absolute), {})).violations)).toEqual(['symlink-absolute']);
    });

    /** A ustar header the archiver would never write. */
    function header({ name, type = '0', size = 0, linkname = '' }) {
        const block = Buffer.alloc(512);
        const put = (text, at, len) => block.write(text.slice(0, len), at, 'latin1');
        put(name, 0, 100);
        put('0000644\0', 100, 8);
        put('0000000\0', 108, 8);
        put('0000000\0', 116, 8);
        put(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
        put('00000000000\0', 136, 12);
        block.fill(0x20, 148, 156);
        put(type, 156, 1);
        put(linkname, 157, 100);
        put('ustar\0', 257, 6);
        put('00', 263, 2);
        let sum = 0;
        for (const byte of block) sum += byte;
        put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
        return block;
    }

    test('a hand-made archive with a parent segment, an absolute name and a device node is refused', () => {
        const tarFile = path.join(tempDir('evil'), 'evil.tar');
        const body = Buffer.alloc(512, 0x78);
        fs.writeFileSync(tarFile, Buffer.concat([
            header({ name: 'ok.txt', size: 1 }), body,
            header({ name: '../escape.txt', size: 1 }), body,
            header({ name: '/etc/cron.d/x', size: 1 }), body,
            header({ name: 'dev/tty0', type: '3' }),
            header({ name: 'link', type: '2', linkname: '/etc/shadow' }),
            Buffer.alloc(1024)
        ]));
        const result = scan.scanTarFile(tarFile, {});
        expect(result.entries).toBe(5);
        expect(rulesOf(result.violations).sort()).toEqual(['path-traversal', 'path-traversal', 'special-file', 'symlink-absolute']);
    });

    test('a corrupt header is an error, not a clean scan', () => {
        const tarFile = path.join(tempDir('corrupt'), 'corrupt.tar');
        const block = header({ name: 'a.txt' });
        block[10] ^= 0xff;
        fs.writeFileSync(tarFile, Buffer.concat([block, Buffer.alloc(1024)]));
        expect(() => scan.scanTarFile(tarFile, {})).toThrow(/checksum/);
    });
});

describe('key material', () => {
    test('a private key in a .pem is found; a public certificate bundle is not', async () => {
        const pair = crypto.generateKeyPairSync('ed25519');
        const root = cleanTree('keys');
        write(root, 'app/certs/server.pem', pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
        write(root, 'app/certs/ca.pem', pair.publicKey.export({ type: 'spki', format: 'pem' }));
        write(root, 'app/certs/notes.txt', pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
        const violations = scan.scanTree(root, {}).violations;
        expect(violations).toEqual([{ rule: 'private-key', path: 'app/certs/server.pem' }]);
        expect(JSON.stringify(violations)).not.toMatch(/BEGIN/);
    });

    test('the same holds inside an archive', async () => {
        const pair = crypto.generateKeyPairSync('ed25519');
        const root = cleanTree('keys-archive');
        write(root, 'app/server.key', pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
        const out = path.join(tempDir('keys-out'), 'a.tar.gz');
        await bootstrapStage.writeArchive(root, out, {});
        expect(rulesOf((await scan.scanArtifact(out, {})).violations)).toEqual(['private-key']);
    });
});

describe('a directory tree', () => {
    test('a clean tree with an internal link is clean', () => {
        const result = scan.scanTree(cleanTree(), { target: 'linux-x64' });
        expect(result.violations).toEqual([]);
        expect(result.entries).toBeGreaterThan(8);
    });

    test('links are read, never followed', () => {
        const root = cleanTree('links');
        fs.symlinkSync(os.tmpdir(), path.join(root, 'app', 'tmp'));
        fs.symlinkSync('../../..', path.join(root, 'app', 'up'));
        expect(rulesOf(scan.scanTree(root, {}).violations).sort()).toEqual(['symlink-absolute', 'symlink-escapes-root']);
    });
});

describe('native binaries', () => {
    const elf = '/bin/ls';
    const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const onLinux = process.platform === 'linux' && fs.existsSync(elf) && ['x64', 'arm64'].includes(process.arch);

    (onLinux ? test : test.skip)('an ELF for this machine is accepted as its own target and refused as another platform or CPU', async () => {
        const root = cleanTree('binary');
        fs.copyFileSync(elf, path.join(root, 'app', 'addon.node'));
        const out = path.join(tempDir('binary-out'), 'a.tar.gz');
        await bootstrapStage.writeArchive(root, out, {});
        expect((await scan.scanArtifact(out, { target: `linux-${hostArch}` })).violations).toEqual([]);
        const otherCpu = hostArch === 'x64' ? 'linux-arm64' : 'linux-x64';
        expect(rulesOf((await scan.scanArtifact(out, { target: otherCpu })).violations)).toEqual([`binary-arch:${hostArch}!=${hostArch === 'x64' ? 'arm64' : 'x64'}`]);
        expect(rulesOf((await scan.scanArtifact(out, { target: 'win32-x64' })).violations)).toEqual(['binary-format:elf!=pe']);
        expect(rulesOf((await scan.scanArtifact(out, { target: 'darwin-arm64' })).violations)).toEqual(['binary-format:elf!=macho']);
        expect(rulesOf(scan.scanTree(root, { target: 'win32-x64' }).violations)).toEqual(['binary-format:elf!=pe']);
    });

    test('a file that only has a binary name but no recognisable header is not a violation', async () => {
        const root = cleanTree('fake-binary');
        write(root, 'app/fake.node', 'plain text\n');
        expect(scan.scanTree(root, { target: 'win32-x64' }).violations).toEqual([]);
    });
});

describe('the .run container', () => {
    const TEMPLATE = "#!/bin/sh\nGOOBSTER_ARCHIVE_OFFSET='@ARCHIVE_OFFSET@'\nexit 0\n";

    async function makeRun(root, name = 'goobster-1.0.0-linux-x64-dev.run') {
        const dir = tempDir('run');
        const archiveFile = path.join(dir, 'payload.tar.gz');
        await bootstrapStage.writeArchive(root, archiveFile, {});
        const outFile = path.join(dir, name);
        bootstrapStage.assembleRun({ template: TEMPLATE, values: {}, archiveFile, outFile });
        return outFile;
    }

    test('reads the archive behind the shell header and infers the target from the name', async () => {
        const result = await scan.scanArtifact(await makeRun(cleanTree()), {});
        expect(result).toMatchObject({ kind: 'run', target: 'linux-x64' });
        expect(result.skipped).toBeUndefined();
        expect(result.violations).toEqual([]);
        expect(result.entries).toBeGreaterThan(8);
    });

    test('finds a config.json carried inside it', async () => {
        const root = cleanTree();
        write(root, 'app/config.json', '{"token":"placeholder"}\n');
        expect(rulesOf((await scan.scanArtifact(await makeRun(root), {})).violations)).toEqual(['secret-or-user-data-file']);
    });

    test('a .run with no archive offset in its header is an error', async () => {
        const file = path.join(tempDir('bad-run'), 'x-linux-x64.run');
        fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
        await expect(scan.scanArtifact(file, {})).rejects.toThrow(/GOOBSTER_ARCHIVE_OFFSET/);
    });
});

describe('targets and kinds', () => {
    test.each([
        ['goobster-1.0.0-linux-x64.run', 'linux-x64'],
        ['goobster-1.0.0-darwin-arm64.pkg', 'darwin-arm64'],
        ['goobster-1.0.0-win32-x64.exe', 'win32-x64'],
        ['Goobster-1.0.0-arm64.AppImage', 'linux-arm64']
    ])('%s is %s', (name, target) => {
        expect(scan.targetOf(name, null)).toBe(target);
        expect(scan.targetOf(name, 'darwin-x64')).toBe('darwin-x64');
    });

    test('the dev AppImage name carries no arch suffix the scan can read, so the target must be given', () => {
        expect(scan.targetOf('Goobster-1.0.0-x64-dev.AppImage', null)).toBeNull();
    });

    test.each([['a.run', 'run'], ['a.tar.gz', 'tar.gz'], ['a.tgz', 'tar.gz'], ['A.AppImage', 'appimage'], ['a.pkg', 'pkg'], ['a.exe', 'exe'], ['a.zip', 'zip'], ['a.txt', null]])('%s is %s', (name, kind) => {
        expect(scan.kindOf(name)).toBe(kind);
    });
});

describe('skips and the command line', () => {
    function capture() {
        const out = [];
        const err = [];
        return { out, err, stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } };
    }

    test('a container this machine cannot open is reported as skipped with its reason, and --strict fails on it', async () => {
        const dir = tempDir('skip');
        write(dir, 'goobster-1.0.0-darwin-arm64.pkg', 'not a real pkg');
        const lenient = await scan.scanAll([dir], {});
        if (process.platform !== 'darwin') {
            expect(lenient).toMatchObject({ ok: true, status: 'clean', skipped: 1 });
            expect(lenient.results[0].skipped.code).toBe('PKG_NEEDS_MACOS');
            expect(await scan.scanAll([dir], { strict: true })).toMatchObject({ ok: false, status: 'skipped' });
        }
    });

    test('exit codes: 0 clean, 2 a violation, 3 a strict skip, 1 usage', async () => {
        const clean = cleanTree('cli-clean');
        const first = capture();
        expect(await scan.main([clean, '--target', 'linux-x64'], first)).toBe(0);
        expect(first.out.join('')).toContain('"status":"clean"');

        const dirty = cleanTree('cli-dirty');
        write(dirty, 'app/config.json', '{}');
        const second = capture();
        expect(await scan.main([dirty], second)).toBe(2);
        expect(second.out.join('')).toContain('secret-or-user-data-file: app/config.json');

        if (process.platform !== 'darwin') {
            const skipDir = tempDir('cli-skip');
            write(skipDir, 'goobster-1.0.0-darwin-x64.pkg', 'x');
            expect(await scan.main([skipDir, '--strict'], capture())).toBe(3);
            expect(await scan.main([skipDir], capture())).toBe(0);
        }
        expect(await scan.main([], capture())).toBe(1);
        expect(await scan.main([clean, '--target', 'beos'], capture())).toBe(1);
        expect(await scan.main([path.join(clean, 'missing')], capture())).toBe(1);
        expect(await scan.main(['--bogus'], capture())).toBe(1);
    });

    test('--report writes the full result as JSON', async () => {
        const dirty = cleanTree('cli-report');
        write(dirty, 'app/.env', 'A=1');
        const report = path.join(tempDir('report'), 'report.json');
        await scan.main([dirty, '--report', report], capture());
        const parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
        expect(parsed).toMatchObject({ ok: false, status: 'violations', violations: 1 });
        expect(parsed.results[0].violations[0]).toEqual({ rule: 'secret-or-user-data-file', path: 'app/.env' });
    });
});
