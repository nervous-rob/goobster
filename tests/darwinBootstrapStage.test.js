/**
 * The macOS bootstrap artifacts (#332, documentation/macos_install.md,
 * "Building"): the per-user tar.gz, the Distribution / scripts / resources
 * tree the pkg is built from, the `pkgbuild` and `productbuild` calls (against
 * fake programs on a private PATH, so the argument vectors are asserted on
 * Linux), the explicit PKG_SKIPPED line when the tools are absent, the
 * unsigned-build labelling, determinism, and the refusal of a payload for
 * another target. The real pkg is built and installed only by the macOS
 * workflow.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { Writable } = require('node:stream');

const payloadStage = require('../scripts/lib/payloadStage');
const darwinLib = require('../scripts/lib/bootstrap/darwin');
const packager = require('../scripts/package-bootstrap-darwin');
const { makeRelease, tempDir } = require('./helpers/installFixture');

const cleanup = [];
const scratch = (label) => tempDir(cleanup, label);
afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

const DIGEST = 'c'.repeat(64);
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const python = childProcess.spawnSync('python3', ['--version'], { stdio: 'pipe' }).status === 0;
const pythonTest = python ? test : test.skip;

/** A valid payload manifest for a macOS target, written onto the fixture release. */
function payload({ target = 'darwin-arm64', sign = false, core = '2.4.0' } = {}) {
    const release = makeRelease(scratch('payload'), { core });
    const [platform, arch] = target.split('-');
    const manifest = { ...release.manifest, payloadDigest: DIGEST, target: { id: target, platform, arch }, layout: { codeRoot: 'app' } };
    let publicKeyFile = null;
    if (sign) {
        const keys = payloadStage.generateDevKeyPair(scratch('keys'));
        const signed = payloadStage.signManifest(manifest, fs.readFileSync(keys.privateKeyPath, 'utf8'));
        payloadStage.writeManifest(release.dir, signed.manifest, signed.signature);
        publicKeyFile = keys.publicKeyPath;
    } else {
        payloadStage.writeManifest(release.dir, manifest);
    }
    return { dir: release.dir, publicKeyFile };
}

/** Fake Apple tools that record their argument vector and create the output they are asked for. */
function fakeTools({ failing = [] } = {}) {
    const dir = scratch('tools');
    const log = path.join(dir, 'calls.log');
    const write = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nPATH=/usr/bin:/bin\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
    const fail = (name) => (failing.includes(name) ? 'echo "boom" >&2; exit 3' : '');
    write('pkgbuild', `${fail('pkgbuild')}\nfor last; do :; done\nfind "$2" -maxdepth 5 -type d >> "${path.join(dir, 'root.log')}"\nprintf component > "$last"`);
    write('productbuild', `${fail('productbuild')}\nfor last; do :; done\nprintf product > "$last"`);
    write('productsign', `${fail('productsign')}\nfor last; do :; done\nprintf signed > "$last"`);
    write('xcrun', `${fail('xcrun')}\nexit 0`);
    return { dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []), rootListing: () => fs.readFileSync(path.join(dir, 'root.log'), 'utf8') };
}

const NO_TOOLS = { PATH: '/nonexistent-goobster-tools' };

async function build(dir, out, extra = {}, env = NO_TOOLS) {
    return packager.build({ target: 'darwin-arm64', payload: dir, out, publicKey: null, pkg: true, requirePkg: false, allowForeignPayload: false, productSign: null, notaryProfile: null, ...extra }, { env });
}

describe('without the Apple tools (this machine)', () => {
    test('builds the tar.gz and the tree, labels both as an unsigned development build, and says PKG_SKIPPED with the reason', async () => {
        const { dir } = payload();
        const out = scratch('out');
        const result = await build(dir, out);
        expect(fs.readdirSync(out).sort()).toEqual(['bootstrap-report-darwin-arm64.json', 'goobster-2.4.0-darwin-arm64-dev.tar.gz', 'macos-pkg-arm64']);
        expect(result.pkgFile).toBeNull();
        expect(result.report).toMatchObject({
            schema: 1,
            target: 'darwin-arm64',
            version: '2.4.0',
            build: 'dev',
            signed: false,
            label: 'UNSIGNED DEVELOPMENT BUILD',
            foreignPayload: null,
            payloadDigest: DIGEST,
            pkg: null
        });
        expect(result.report.skipped).toEqual([{ code: 'PKG_SKIPPED', reason: 'TOOL_MISSING', detail: expect.stringContaining('pkgbuild and productbuild are not on PATH') }]);
        expect(result.report.artifacts.map(item => item.kind)).toEqual(['tar.gz']);
        expect(result.report.artifacts[0]).toMatchObject({ name: 'goobster-2.4.0-darwin-arm64-dev.tar.gz', sha256: sha256(fs.readFileSync(path.join(out, 'goobster-2.4.0-darwin-arm64-dev.tar.gz'))) });
        expect(result.report.appleSigning).toEqual({ productsign: { requested: false, done: false }, notarization: { requested: false, done: false } });
        expect(JSON.parse(fs.readFileSync(path.join(out, 'bootstrap-report-darwin-arm64.json'), 'utf8'))).toEqual(result.report);
        expect(JSON.stringify(result.report)).not.toContain(os.tmpdir());
    });

    test('the tar.gz unpacks (into a path with spaces) to one folder holding install.command, a README and the payload', async () => {
        const { dir } = payload();
        const out = scratch('out');
        await build(dir, out);
        const dest = path.join(scratch('dest'), 'unpack here');
        fs.mkdirSync(dest);
        const unpacked = childProcess.spawnSync('tar', ['-xzf', path.join(out, 'goobster-2.4.0-darwin-arm64-dev.tar.gz'), '-C', dest], { encoding: 'utf8' });
        expect(unpacked.status).toBe(0);
        expect(fs.readdirSync(dest)).toEqual(['goobster-2.4.0-darwin-arm64-dev']);
        const folder = path.join(dest, 'goobster-2.4.0-darwin-arm64-dev');
        expect(fs.readdirSync(folder).sort()).toEqual(['README.txt', 'install.command', 'payload']);
        expect(fs.statSync(path.join(folder, 'install.command')).mode & 0o777).toBe(0o755);
        expect(fs.existsSync(path.join(folder, 'payload', 'payload-manifest.json'))).toBe(true);
        expect(fs.readFileSync(path.join(folder, 'README.txt'), 'utf8')).toContain('UNSIGNED DEVELOPMENT BUILD');
        expect(fs.readFileSync(path.join(folder, 'README.txt'), 'utf8')).toContain('xattr -dr com.apple.quarantine');
    });

    test('install.command is filled in, valid sh, per-user, refuses sudo and carries the digest the payload declares', async () => {
        const { dir } = payload();
        const out = scratch('out');
        await build(dir, out);
        const dest = scratch('dest');
        childProcess.spawnSync('tar', ['-xzf', path.join(out, 'goobster-2.4.0-darwin-arm64-dev.tar.gz'), '-C', dest]);
        const file = path.join(dest, 'goobster-2.4.0-darwin-arm64-dev', 'install.command');
        const text = fs.readFileSync(file, 'utf8');
        expect(text).not.toMatch(/@[A-Z0-9_]+@/);
        expect(text).toContain(`GOOBSTER_BOOTSTRAP_PAYLOAD_DIGEST='${DIGEST}'`);
        expect(text).toContain("GOOBSTER_BOOTSTRAP_TARGET='darwin-arm64'");
        expect(text).toContain("GOOBSTER_BOOTSTRAP_BUILD='dev'");
        expect(text).toContain('--per-user');
        expect(text).toContain('not with sudo');
        expect(text).toContain('UNSIGNED DEVELOPMENT build');
        expect(childProcess.spawnSync('sh', ['-n', file]).status).toBe(0);
        const help = childProcess.spawnSync('sh', [file, '--help'], { encoding: 'utf8' });
        expect(help.status).toBe(0);
        expect(help.stdout).toContain('own account');
        const refused = childProcess.spawnSync('sh', [file], { encoding: 'utf8' });
        expect(refused.status).toBe(3);
        expect(refused.stderr).toContain('this installer is for macOS');
    });

    test('the same payload gives the same tar.gz, tree and report bytes', async () => {
        const { dir } = payload();
        const first = scratch('out-a');
        const second = scratch('out-b');
        await build(dir, first);
        await build(dir, second);
        const files = ['goobster-2.4.0-darwin-arm64-dev.tar.gz', 'bootstrap-report-darwin-arm64.json', path.join('macos-pkg-arm64', 'Distribution.xml'), path.join('macos-pkg-arm64', 'scripts', 'postinstall')];
        for (const file of files) expect(fs.readFileSync(path.join(first, file)).equals(fs.readFileSync(path.join(second, file)))).toBe(true);
    });

    test('--no-pkg says so; --require-pkg turns the skip into a failed exit', async () => {
        const { dir } = payload();
        const result = await build(dir, scratch('out'), { pkg: false });
        expect(result.report.skipped).toEqual([{ code: 'PKG_SKIPPED', reason: 'NOT_REQUESTED', detail: '--no-pkg' }]);

        const stdout = sink();
        const stderr = sink();
        const code = await packager.main(['--target', 'darwin-arm64', '--payload', dir, '--out', scratch('out'), '--require-pkg'], { env: NO_TOOLS, stdout, stderr });
        expect(code).toBe(1);
        expect(stdout.text()).toContain('PKG_SKIPPED: TOOL_MISSING');
        expect(stdout.text()).toContain('UNSIGNED DEVELOPMENT BUILD');
        expect(stderr.text()).toContain('The pkg was required');
        expect(await packager.main(['--target', 'darwin-arm64', '--payload', dir, '--out', scratch('out')], { env: NO_TOOLS, stdout: sink(), stderr: sink() })).toBe(0);
    });
});

function sink() {
    const chunks = [];
    const stream = new Writable({ write(chunk, _enc, done) { chunks.push(chunk.toString()); done(); } });
    stream.text = () => chunks.join('');
    return stream;
}

describe('the pkg tree', () => {
    async function tree(target = 'darwin-arm64', extra = {}) {
        const { dir, publicKeyFile } = payload({ target, ...extra });
        const out = scratch('out');
        const result = await packager.build({ target, payload: dir, out, publicKey: extra.sign ? publicKeyFile : null, pkg: false, allowForeignPayload: false }, { env: NO_TOOLS });
        return { out, treeDir: result.treeDir, result };
    }

    test('the Distribution declares the host architecture, the minimum macOS and the system volume, per target', async () => {
        const arm = fs.readFileSync(path.join((await tree('darwin-arm64')).treeDir, 'Distribution.xml'), 'utf8');
        const intel = fs.readFileSync(path.join((await tree('darwin-x64')).treeDir, 'Distribution.xml'), 'utf8');
        for (const text of [arm, intel]) {
            expect(text).toContain('<installer-gui-script minSpecVersion="2">');
            expect(text).toContain('<os-version min="13.0"/>');
            expect(text).toContain('enable_localSystem="true"');
            expect(text).toContain('enable_anywhere="false"');
            expect(text).toContain('rootVolumeOnly="true"');
            expect(text).toContain('<pkg-ref id="io.goobster.payload" version="2.4.0" auth="Root" onConclusion="none">goobster-payload.pkg</pkg-ref>');
            expect(text).not.toMatch(/@[A-Z0-9_]+@/);
            expect(text).not.toContain('\n\n');
        }
        expect(arm).toContain('hostArchitectures="arm64"');
        expect(intel).toContain('hostArchitectures="x86_64"');
    });

    pythonTest('the Distribution is well formed XML', async () => {
        const { treeDir } = await tree();
        const check = childProcess.spawnSync('python3', ['-c', 'import sys, xml.dom.minidom; [xml.dom.minidom.parse(f) for f in sys.argv[1:]]', path.join(treeDir, 'Distribution.xml')], { encoding: 'utf8' });
        expect(check.stderr).toBe('');
        expect(check.status).toBe(0);
    });

    test('the resources name the unsigned state for a development build and the licence is the repository\'s', async () => {
        const { treeDir } = await tree();
        const welcome = fs.readFileSync(path.join(treeDir, 'resources', 'welcome.html'), 'utf8');
        expect(welcome).toContain('UNSIGNED DEVELOPMENT BUILD');
        expect(welcome).toContain('Goobster 2.4.0 for macOS (Apple silicon)');
        expect(welcome).toContain('/etc/goobster-answers.json');
        expect(fs.readFileSync(path.join(treeDir, 'resources', 'conclusion.html'), 'utf8')).toContain('/opt/goobster/stage/2.4.0/runtime/bin/node');
        expect(fs.readFileSync(path.join(treeDir, 'resources', 'license.txt'), 'utf8')).toBe(fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8'));
    });

    test('the postinstall is valid sh, executable, filled in, and has exactly one headless path and one wizard path', async () => {
        const { treeDir } = await tree();
        const file = path.join(treeDir, 'scripts', 'postinstall');
        const text = fs.readFileSync(file, 'utf8');
        expect(fs.statSync(file).mode & 0o777).toBe(0o755);
        expect(childProcess.spawnSync('sh', ['-n', file]).status).toBe(0);
        expect(text).not.toMatch(/@[A-Z0-9_]+@/);
        expect(text).toContain("GOOBSTER_PKG_VERSION='2.4.0'");
        expect(text).toContain(`GOOBSTER_PKG_PAYLOAD_DIGEST='${DIGEST}'`);
        expect(text).toContain("GOOBSTER_PKG_BUILD='dev'");
        expect(text).toContain("GOOBSTER_PKG_PUBLIC_KEY_B64=''");
        expect(text.match(/\/etc\/goobster-answers\.json/g).length).toBeGreaterThan(0);
        expect(text.match(/--headless/g)).toHaveLength(1);
        expect(text).toContain('launchctl asuser "$CONSOLE_UID" /usr/bin/sudo -u "$CONSOLE_USER" -H');
        expect(text).toContain('"0 600"');
        expect(text).not.toMatch(/\beval\b/);
        expect(text).not.toMatch(/sh -c/);
    });

    test('a signed payload is a release: no -dev, the public key is carried and no unsigned notice is printed', async () => {
        const { out, treeDir, result } = await tree('darwin-arm64', { sign: true });
        expect(result.report.signing).toEqual({ keyId: expect.any(String), unsignedReason: null });
        expect(result.report).toMatchObject({ build: 'release', signed: true, label: 'release' });
        expect(fs.existsSync(path.join(out, 'goobster-2.4.0-darwin-arm64.tar.gz'))).toBe(true);
        const text = fs.readFileSync(path.join(treeDir, 'scripts', 'postinstall'), 'utf8');
        expect(text).toContain("GOOBSTER_PKG_BUILD='release'");
        expect(text).toMatch(/GOOBSTER_PKG_PUBLIC_KEY_B64='[A-Za-z0-9+/=]{40,}'/);
        expect(fs.readFileSync(path.join(treeDir, 'resources', 'welcome.html'), 'utf8')).not.toContain('UNSIGNED');
        const dest = scratch('dest');
        childProcess.spawnSync('tar', ['-xzf', path.join(out, 'goobster-2.4.0-darwin-arm64.tar.gz'), '-C', dest]);
        expect(fs.existsSync(path.join(dest, 'goobster-2.4.0-darwin-arm64', 'release-key.pem'))).toBe(true);
        expect(fs.readFileSync(path.join(dest, 'goobster-2.4.0-darwin-arm64', 'install.command'), 'utf8')).toContain("GOOBSTER_BOOTSTRAP_BUILD='release'");
    });

    test('a value a shell assignment or a path cannot carry is refused before anything is written', () => {
        expect(() => darwinLib.assertVersion('2.4.0')).not.toThrow();
        for (const bad of ['', '../2.4', "2.4'; rm -rf /", '2 4', '2.4\n', '-2.4']) expect(() => darwinLib.assertVersion(bad)).toThrow(/version/);
        expect(() => darwinLib.render('@A@', { shell: { A: "x'y" } })).toThrow(/shell assignment/);
        expect(() => darwinLib.render('@A@', {})).toThrow(/needs a value/);
        expect(darwinLib.render('@A@', { markup: { A: '<&"x">' } })).toBe('&lt;&amp;&quot;x&quot;&gt;');
    });
});

describe('with the Apple tools (fake programs on a private PATH)', () => {
    const envWith = (tools) => ({ PATH: `${tools.dir}:/usr/bin:/bin` });

    test('pkgbuild is given the payload under /opt/goobster/stage/<version> and the scripts, productbuild the Distribution and resources', async () => {
        const tools = fakeTools();
        const { dir } = payload();
        const out = scratch('out');
        const result = await build(dir, out, {}, envWith(tools));
        expect(result.report.skipped).toEqual([]);
        expect(result.report.pkg).toMatchObject({ tools: { pkgbuild: 'pkgbuild', productbuild: 'productbuild' }, signing: { productsign: { requested: false, done: false }, notarization: { requested: false, done: false } } });
        expect(result.report.artifacts.map(item => item.kind)).toEqual(['tar.gz', 'pkg']);
        expect(result.pkgFile).toBe(path.join(out, 'goobster-2.4.0-darwin-arm64-dev.pkg'));
        expect(fs.readFileSync(result.pkgFile, 'utf8')).toBe('product');

        const [pkgbuild, productbuild] = tools.calls();
        expect(pkgbuild).toMatch(/^pkgbuild --root \S+\/pkg-root --identifier io\.goobster\.payload --version 2\.4\.0 --install-location \/ --ownership recommended --scripts .+\/macos-pkg-arm64\/scripts \S+\/goobster-payload\.pkg$/);
        expect(productbuild).toContain(`--distribution ${path.join(out, 'macos-pkg-arm64', 'Distribution.xml')}`);
        expect(productbuild).toContain(`--resources ${path.join(out, 'macos-pkg-arm64', 'resources')}`);
        expect(productbuild).toContain('--version 2.4.0');
        expect(tools.rootListing()).toContain('/pkg-root/opt/goobster/stage/2.4.0');
    });

    test('a failing pkgbuild or productbuild is a PKG_SKIPPED with the tool\'s exit, never a half-written pkg', async () => {
        for (const name of ['pkgbuild', 'productbuild']) {
            const tools = fakeTools({ failing: [name] });
            const { dir } = payload();
            const out = scratch('out');
            const result = await build(dir, out, {}, envWith(tools));
            expect(result.pkgFile).toBeNull();
            expect(result.report.skipped).toEqual([{ code: 'PKG_SKIPPED', reason: `${name.toUpperCase()}_FAILED`, detail: expect.stringContaining('exited 3: boom') }]);
            expect(fs.readdirSync(out).some(file => file.endsWith('.pkg'))).toBe(false);
        }
    });

    test('Apple signing is off unless asked for; productsign and notarytool run only on request, in order', async () => {
        const tools = fakeTools();
        const { dir } = payload();
        const result = await build(dir, scratch('out'), { productSign: 'Developer ID Installer: Example (TEAM)', notaryProfile: 'goobster-notary' }, envWith(tools));
        expect(result.report.appleSigning).toEqual({ productsign: { requested: true, done: true }, notarization: { requested: true, done: true } });
        expect(fs.readFileSync(result.pkgFile, 'utf8')).toBe('signed');
        const calls = tools.calls();
        expect(calls.map(line => line.split(' ')[0])).toEqual(['pkgbuild', 'productbuild', 'productsign', 'xcrun', 'xcrun']);
        expect(calls[2]).toContain('--sign Developer ID Installer: Example (TEAM)');
        expect(calls[3]).toContain('notarytool submit');
        expect(calls[3]).toContain('--keychain-profile goobster-notary --wait');
        expect(calls[4]).toContain('stapler staple');
        const plain = await build(payload().dir, scratch('out'), {}, envWith(fakeTools()));
        expect(plain.report.appleSigning.productsign.requested).toBe(false);
    });

    test('a failing productsign or notarization is reported and no pkg is claimed', async () => {
        const signing = await build(payload().dir, scratch('out'), { productSign: 'id' }, envWith(fakeTools({ failing: ['productsign'] })));
        expect(signing.pkgFile).toBeNull();
        expect(signing.report.skipped[0]).toMatchObject({ code: 'PKG_SKIPPED', reason: 'PRODUCTSIGN_FAILED' });
        const notarizing = await build(payload().dir, scratch('out'), { notaryProfile: 'p' }, envWith(fakeTools({ failing: ['xcrun'] })));
        expect(notarizing.report.skipped[0]).toMatchObject({ code: 'PKG_SKIPPED', reason: 'NOTARIZATION_FAILED' });
    });

    test('tools are found only through absolute PATH entries', () => {
        const tools = fakeTools();
        expect(darwinLib.findTool('pkgbuild', { PATH: tools.dir })).toBe(path.join(tools.dir, 'pkgbuild'));
        expect(darwinLib.findTool('pkgbuild', { PATH: `relative/dir:.:${tools.dir}` })).toBe(path.join(tools.dir, 'pkgbuild'));
        expect(darwinLib.findTool('pkgbuild', { PATH: 'relative/dir:.' })).toBeNull();
        expect(darwinLib.findTool('nothing-like-it', { PATH: tools.dir })).toBeNull();
    });
});

describe('a payload for another target', () => {
    test('is refused unless the packager is told it is a test, then it is labelled foreign and never gets a pkg', async () => {
        const { dir } = payload({ target: 'linux-x64' });
        await expect(build(dir, scratch('out'))).rejects.toThrow('the payload was built for linux-x64, not darwin-arm64');
        const tools = fakeTools();
        const out = scratch('out');
        const result = await build(dir, out, { allowForeignPayload: true }, { PATH: `${tools.dir}:/usr/bin:/bin` });
        expect(result.report).toMatchObject({ signed: false, label: 'UNSIGNED DEVELOPMENT BUILD (FOREIGN PAYLOAD: linux-x64)', foreignPayload: { payloadTarget: 'linux-x64' } });
        expect(result.report.skipped).toEqual([{ code: 'PKG_SKIPPED', reason: 'FOREIGN_PAYLOAD', detail: 'the payload is for linux-x64, not darwin-arm64' }]);
        expect(tools.calls()).toEqual([]);
        expect(fs.existsSync(path.join(out, 'goobster-2.4.0-darwin-arm64-dev.tar.gz'))).toBe(true);
    });

    test('an unknown target and missing arguments are usage errors', async () => {
        await expect(build(payload().dir, scratch('out'), { target: 'darwin-ppc' })).rejects.toThrow('--target must be one of');
        expect(await packager.main(['--target', 'darwin-ppc'], { env: NO_TOOLS, stdout: sink(), stderr: sink() })).toBe(1);
        expect(await packager.main(['--frobnicate'], { env: NO_TOOLS, stdout: sink(), stderr: sink() })).toBe(2);
        expect(packager.parseArgs(['--target', 'darwin-x64', '--payload', '/p', '--out', '/o', '--no-pkg', '--product-sign', 'id', '--notary-profile', 'p']))
            .toMatchObject({ target: 'darwin-x64', pkg: false, productSign: 'id', notaryProfile: 'p' });
    });
});
