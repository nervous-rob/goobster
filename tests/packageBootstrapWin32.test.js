/**
 * The Windows installer packaging (#331, documentation/windows_install.md): the
 * deterministic build header, the refusals, the skip reasons in the report, the
 * pin check on the service host, and - when makensis is on the machine - a real
 * build of the NSIS script twice with identical bytes. The installer's own
 * behaviour on Windows is proven by the windows-bootstrap workflow.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const pack = require('../scripts/package-bootstrap-win32');
const PINS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'bootstrap-pins.json'), 'utf8'));

const cleanup = [];
const scratch = (label) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `goobster-w32pkg-${label}-`));
    cleanup.push(dir);
    return dir;
};
afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const DIGEST = 'b'.repeat(64);

function payload({ version = '1.2.3', target = 'win32-x64', node = true } = {}) {
    const dir = scratch('payload');
    const put = (relative, text) => {
        const file = path.join(dir, ...relative.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    };
    if (node) put('runtime/node.exe', 'MZ fake node');
    put('app/apps/manager/bootstrap/win32.js', '// entry');
    put('app/node_modules/zeta/index.js', 'z');
    put('app/node_modules/alpha/index.js', 'a');
    put('app/node_modules/alpha/with space.js', 'a');
    put('bin/goobster-manager.cmd', '@echo off');
    fs.mkdirSync(path.join(dir, 'app', 'empty'));
    put('payload-manifest.json', JSON.stringify({ payloadDigest: DIGEST, release: { core: version }, target: { id: target } }));
    return dir;
}

function fakeHost() {
    const file = path.join(scratch('host'), 'WinSW.NET4.exe');
    fs.writeFileSync(file, 'MZ fake winsw');
    return { file, pins: { winsw: { ...PINS.winsw, sha256: sha256(fs.readFileSync(file)) } } };
}

describe('parseArgs', () => {
    test('reads every flag', () => {
        const options = pack.parseArgs(['--target', 'win32-x64', '--payload', 'p', '--out', 'o', '--makensis', 'm', '--require-installer', '--winsw-file', 'w']);
        expect(options).toMatchObject({ target: 'win32-x64', payload: 'p', out: 'o', makensis: 'm', requireInstaller: true, winswFile: 'w' });
    });

    test('refuses unknown flags, missing values and a half-configured signtool', () => {
        expect(() => pack.parseArgs(['--nope'])).toThrow(/unknown option/);
        expect(() => pack.parseArgs(['--payload'])).toThrow(/needs a value/);
        expect(() => pack.parseArgs(['--signtool', 'signtool.exe'])).toThrow(/--sign-thumbprint/);
        expect(() => pack.parseArgs(['--signtool', 's', '--sign-thumbprint', 'abc', '--sign-timestamp-url', 'https://t.example/'])).toThrow(/40-hex/);
        expect(() => pack.parseArgs(['--signtool', 's', '--sign-thumbprint', 'a'.repeat(40), '--sign-timestamp-url', 'http://t.example/'])).toThrow(/https/);
    });
});

describe('the build header', () => {
    test('lists files in one deterministic order with Windows targets', () => {
        const dir = payload();
        const listing = pack.listPayload(dir);
        expect(listing.map(item => item.dir)).toEqual([
            '', 'app', 'app/apps', 'app/apps/manager', 'app/apps/manager/bootstrap', 'app/empty',
            'app/node_modules', 'app/node_modules/alpha', 'app/node_modules/zeta', 'bin', 'runtime'
        ]);
        expect(listing[7].files).toEqual(['index.js', 'with space.js']);
        const header = pack.renderHeader({
            version: '1.2.3', payloadDigest: DIGEST, build: 'dev', signed: false, label: 'UNSIGNED DEVELOPMENT BUILD',
            outFile: '/out/x.exe', iconFile: '/i.ico', payloadDir: dir, hostFile: '/t/WinSW.NET4.exe', scriptDir: '/s', listing
        });
        expect(header).toContain('!define VERSION_NUMERIC "1.2.3.0"');
        expect(header).toContain(`!define PAYLOAD_DIGEST "${DIGEST}"`);
        expect(header).toContain('!define LABEL "UNSIGNED DEVELOPMENT BUILD"');
        expect(header).toContain('SetOutPath "$Stage\\payload\\app\\node_modules\\alpha"');
        expect(header).toContain('SetOutPath "$Stage\\payload\\app\\empty"');
        expect(header).toContain('File /oname=goobster-service.exe "WinSW.NET4.exe"');
        expect(header).toBe(pack.renderHeader({
            version: '1.2.3', payloadDigest: DIGEST, build: 'dev', signed: false, label: 'UNSIGNED DEVELOPMENT BUILD',
            outFile: '/out/x.exe', iconFile: '/i.ico', payloadDir: dir, hostFile: '/t/WinSW.NET4.exe', scriptDir: '/s', listing: pack.listPayload(dir)
        }));
    });

    test('refuses a symbolic link and names the script could misread', () => {
        const linked = payload();
        fs.symlinkSync('/etc', path.join(linked, 'app', 'link'));
        expect(() => pack.listPayload(linked)).toThrow(expect.objectContaining({ code: 'PAYLOAD_SYMLINK' }));
        const odd = payload();
        fs.writeFileSync(path.join(odd, 'app', 'we$ird.js'), '');
        expect(() => pack.listPayload(odd)).toThrow(expect.objectContaining({ code: 'PAYLOAD_NAME_UNSUPPORTED' }));
    });

    test('the version resource needs major.minor.patch, and the digest must be a SHA-256', () => {
        expect(pack.versionNumeric('0.0.1-rc.2')).toBe('0.0.1.0');
        expect(() => pack.versionNumeric('nightly')).toThrow(/major.minor.patch/);
        expect(() => pack.renderHeader({ version: '1.0.0"', payloadDigest: DIGEST, listing: [] })).toThrow(/characters/);
        expect(() => pack.renderHeader({ version: '1.0.0', payloadDigest: 'nope', listing: [] })).toThrow(/not a SHA-256/);
    });

    test('the icon is a classic .ico with three images, the same bytes every time', () => {
        const icon = pack.iconIco();
        expect(icon.readUInt16LE(0)).toBe(0);
        expect(icon.readUInt16LE(2)).toBe(1);
        expect(icon.readUInt16LE(4)).toBe(3);
        expect(icon.readUInt32LE(6 + 12)).toBe(6 + 3 * 16);
        expect(pack.iconIco().equals(icon)).toBe(true);
    });
});

describe('build with a fake toolchain', () => {
    const okRun = (calls) => (program, args, opts) => {
        calls.push({ program, args, opts });
        if (args[0] === '-VERSION') return { status: 0, stdout: 'v3.09\n' };
        const out = fs.readFileSync(args.find(arg => arg.startsWith('-DBUILD_HEADER=')).slice('-DBUILD_HEADER='.length), 'utf8');
        const outFile = /!define OUTFILE "([^"]+)"/.exec(out)[1];
        fs.writeFileSync(outFile, 'MZ installer');
        return { status: 0, stdout: '', stderr: '' };
    };

    test('writes the dev-labelled installer and a report with the pinned host', async () => {
        const dir = payload();
        const out = scratch('out');
        const host = fakeHost();
        const calls = [];
        const { report, exeFile } = await pack.build(
            { target: 'win32-x64', payload: dir, out, makensis: process.execPath, winswFile: host.file },
            { run: okRun(calls), pins: host.pins }
        );
        expect(path.basename(exeFile)).toBe('goobster-1.2.3-win32-x64-dev.exe');
        expect(report).toMatchObject({
            schema: 1, target: 'win32-x64', version: '1.2.3', build: 'dev', signed: false, label: 'UNSIGNED DEVELOPMENT BUILD',
            payloadDigest: DIGEST, skipped: []
        });
        expect(report.signing).toEqual({ keyId: null, unsignedReason: 'NO_SIGNATURE' });
        expect(report.installer.host).toEqual({ name: 'WinSW.NET4.exe', version: PINS.winsw.version, sha256: host.pins.winsw.sha256 });
        expect(report.installer.authenticode).toEqual({ signed: false, tool: null });
        expect(report.artifacts).toEqual([{ kind: 'installer', name: 'goobster-1.2.3-win32-x64-dev.exe', bytes: 12, sha256: sha256('MZ installer') }]);
        expect(JSON.parse(fs.readFileSync(path.join(out, 'bootstrap-report-win32-x64.json'), 'utf8'))).toEqual(report);
        const build = calls.find(call => call.args.some(arg => arg.startsWith('-DBUILD_HEADER=')));
        expect(build.args).toEqual(expect.arrayContaining(['-NOCONFIG']));
        expect(JSON.stringify(report)).not.toMatch(/https?:/);
    });

    test('a service host that does not match its pin skips the installer with the reason', async () => {
        const dir = payload();
        const out = scratch('out');
        const calls = [];
        const stray = path.join(scratch('stray'), 'WinSW.NET4.exe');
        fs.writeFileSync(stray, 'something else');
        const { report, exeFile } = await pack.build({ target: 'win32-x64', payload: dir, out, makensis: process.execPath, winswFile: stray }, { run: okRun(calls) });
        expect(exeFile).toBeNull();
        expect(report.skipped).toEqual([expect.objectContaining({ code: 'INSTALLER_SKIPPED', reason: 'WINSW_HASH_MISMATCH' })]);
        expect(report.artifacts).toEqual([]);
        expect(calls).toEqual([]);
    });

    test('an unreachable download and a downloaded mismatch each skip with their own reason', async () => {
        const dir = payload();
        const tools = scratch('tools');
        const base = { target: 'win32-x64', payload: dir, makensis: process.execPath, toolsDir: tools };
        const down = await pack.build({ ...base, out: scratch('out') }, { run: okRun([]), doDownload: async () => { throw new Error('offline'); } });
        expect(down.report.skipped[0]).toMatchObject({ reason: 'WINSW_UNAVAILABLE', detail: 'offline' });
        const wrong = await pack.build({ ...base, out: scratch('out') }, { run: okRun([]), doDownload: async (url, file) => fs.writeFileSync(file, 'tampered') });
        expect(wrong.report.skipped[0]).toMatchObject({ reason: 'WINSW_HASH_MISMATCH' });
        expect(fs.readdirSync(tools)).toEqual([]);
    });

    test('no makensis is a skip with its reason, and the report is still written', async () => {
        const dir = payload();
        const out = scratch('out');
        const host = fakeHost();
        const { report, exeFile } = await pack.build({ target: 'win32-x64', payload: dir, out, winswFile: host.file }, { env: { PATH: scratch('empty') }, pins: host.pins });
        expect(exeFile).toBeNull();
        expect(report.skipped).toEqual([expect.objectContaining({ code: 'INSTALLER_SKIPPED', reason: 'MAKENSIS_UNAVAILABLE' })]);
        expect(fs.existsSync(path.join(out, 'bootstrap-report-win32-x64.json'))).toBe(true);
    });

    test('a failing makensis leaves no installer behind and says why', async () => {
        const dir = payload();
        const out = scratch('out');
        const host = fakeHost();
        const run = (program, args) => (args[0] === '-VERSION'
            ? { status: 0, stdout: 'v3.09\n' }
            : { status: 1, stdout: '', stderr: 'Error in script on line 9\n' });
        const { report, exeFile } = await pack.build({ target: 'win32-x64', payload: dir, out, makensis: process.execPath, winswFile: host.file }, { run, pins: host.pins });
        expect(exeFile).toBeNull();
        expect(report.skipped[0]).toMatchObject({ reason: 'MAKENSIS_FAILED' });
        expect(report.skipped[0].detail).toContain('Error in script');
        expect(fs.readdirSync(out)).toEqual(['bootstrap-report-win32-x64.json']);
    });

    test('signtool runs only when asked and a failure drops the installer', async () => {
        const dir = payload();
        const host = fakeHost();
        const calls = [];
        const run = (program, args, opts) => (program === 'signtool.exe' ? (calls.push(args), { status: 0 }) : okRun(calls)(program, args, opts));
        const options = { target: 'win32-x64', payload: dir, makensis: process.execPath, winswFile: host.file, signtool: 'signtool.exe', signThumbprint: 'a'.repeat(40), signTimestampUrl: 'https://t.example/ts' };
        const done = await pack.build({ ...options, out: scratch('out') }, { run, pins: host.pins });
        expect(done.report.installer.authenticode).toEqual({ signed: true, tool: 'signtool' });
        expect(calls.find(args => args[0] === 'sign')).toEqual(expect.arrayContaining(['/fd', 'SHA256', '/sha1', 'a'.repeat(40)]));
        const out = scratch('out');
        const failing = (program, args, opts) => (program === 'signtool.exe' ? { status: 1 } : okRun([])(program, args, opts));
        await expect(pack.build({ ...options, out }, { run: failing, pins: host.pins })).rejects.toThrow(/installer was not kept/);
        expect(fs.readdirSync(out)).toEqual([]);
    });

    test('refuses another target, a payload for another target and a payload with no Node runtime', async () => {
        const out = scratch('out');
        await expect(pack.build({ target: 'linux-x64', payload: payload(), out })).rejects.toThrow(/--target must be/);
        await expect(pack.build({ target: 'win32-x64', payload: payload({ target: 'linux-x64' }), out })).rejects.toThrow(/not win32-x64/);
        await expect(pack.build({ target: 'win32-x64', payload: payload({ node: false }), out })).rejects.toThrow(/runtime\/node.exe/);
    });
});

describe('makensis lookup', () => {
    test('prefers --makensis, then MAKENSIS, then PATH, and the usual Windows folders', () => {
        const only = (...files) => file => files.includes(file);
        expect(pack.findMakensis({ options: { makensis: '/x/m' }, env: {}, exists: only('/x/m') })).toBe(path.resolve('/x/m'));
        expect(pack.findMakensis({ options: { makensis: '/x/m' }, env: {}, exists: only() })).toBeNull();
        expect(pack.findMakensis({ options: {}, env: { MAKENSIS: '/y/m' }, exists: only('/y/m') })).toBe(path.resolve('/y/m'));
        expect(pack.findMakensis({ options: {}, env: { PATH: '/a:/b' }, platform: 'linux', exists: only('/b/makensis') })).toBe('/b/makensis');
        expect(pack.findMakensis({ options: {}, env: { ProgramFiles: 'C:\\PF' }, platform: 'win32', exists: only(path.join('C:\\PF', 'NSIS', 'makensis.exe')) })).toBe(path.join('C:\\PF', 'NSIS', 'makensis.exe'));
    });
});

const haveMakensis = Boolean(pack.findMakensis({ options: {}, env: process.env }));
const real = haveMakensis ? describe : describe.skip;

real('with a real makensis', () => {
    test('the installer script compiles, and two builds of one payload are the same bytes', async () => {
        const host = fakeHost();
        const first = payload();
        const second = path.join(scratch('copy'), 'payload');
        fs.cpSync(first, second, { recursive: true });
        const later = new Date(Date.now() + 86400000);
        for (const entry of fs.readdirSync(path.join(second, 'runtime'))) fs.utimesSync(path.join(second, 'runtime', entry), later, later);
        const options = { target: 'win32-x64', winswFile: host.file };
        const one = await pack.build({ ...options, payload: first, out: scratch('out') }, { pins: host.pins });
        const two = await pack.build({ ...options, payload: second, out: scratch('out') }, { pins: host.pins });
        expect(one.report.skipped).toEqual([]);
        expect(one.exeFile).toBeTruthy();
        const head = fs.readFileSync(one.exeFile).subarray(0, 2).toString('latin1');
        expect(head).toBe('MZ');
        expect(fs.readFileSync(one.exeFile).equals(fs.readFileSync(two.exeFile))).toBe(true);
        expect(one.report.installer.tool.name).toBe('makensis');
    });
});
