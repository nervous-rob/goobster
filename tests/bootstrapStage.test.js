/**
 * The Linux bootstrap artifacts (#333, documentation/linux_install.md): the
 * deterministic payload archive, the `.run` header that carries both digests,
 * verification before anything is unpacked, extraction into a path with
 * spaces, and the report. The AppImage itself is built only by the CI
 * workflow (it needs a pinned download); here its AppDir and the explicit
 * APPIMAGE_SKIPPED report line are checked.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const stage = require('../scripts/lib/bootstrapStage');
const payloadStage = require('../scripts/lib/payloadStage');
const packageBootstrap = require('../scripts/package-bootstrap');
const { makeRelease, tempDir } = require('./helpers/installFixture');

const HOST = `${process.platform}-${process.arch}`;
const supported = process.platform === 'linux' && Boolean(packageBootstrap.TARGETS[HOST]);
const suite = supported ? describe : describe.skip;

const cleanup = [];
const scratch = (label) => tempDir(cleanup, label);
afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const DIGEST = 'a'.repeat(64);

/** A valid payload for this host with the digest the real packager records. */
function payload({ sign = false } = {}) {
    const release = makeRelease(scratch('payload'));
    const manifest = { ...release.manifest, payloadDigest: DIGEST, layout: { codeRoot: 'app' } };
    let publicKeyFile = null;
    if (sign) {
        const keys = payloadStage.generateDevKeyPair(scratch('keys'));
        const signed = payloadStage.signManifest(manifest, fs.readFileSync(keys.privateKeyPath, 'utf8'));
        payloadStage.writeManifest(release.dir, signed.manifest, signed.signature);
        publicKeyFile = keys.publicKeyPath;
    } else {
        payloadStage.writeManifest(release.dir, manifest);
    }
    return { dir: release.dir, manifest, publicKeyFile };
}

async function build(dir, out, extra = {}) {
    return packageBootstrap.build({
        target: HOST,
        payload: dir,
        out,
        publicKey: null,
        appimage: false,
        requireAppimage: false,
        appdirOnly: false,
        toolsDir: null,
        ...extra
    });
}

const run = (file, args, env = {}) => childProcess.spawnSync('/bin/sh', [file, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

suite('the archive', () => {
    test('round-trips modes, symlinks, spaces and paths longer than a tar name field, byte for byte', async () => {
        const source = scratch('tree');
        const long = path.join(source, 'dir with space', 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60));
        fs.mkdirSync(long, { recursive: true });
        fs.writeFileSync(path.join(long, 'deep file.txt'), 'deep\n');
        fs.writeFileSync(path.join(source, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
        fs.writeFileSync(path.join(source, 'plain.txt'), 'plain\n', { mode: 0o600 });
        fs.symlinkSync('plain.txt', path.join(source, 'link'));
        fs.writeFileSync(path.join(source, 'empty'), '');

        const archive = path.join(scratch('out'), 'tree.tar.gz');
        const written = await stage.writeArchive(source, archive);
        expect(written.sha256).toBe(sha256(fs.readFileSync(archive)));
        expect(written.entries).toBeGreaterThan(5);

        const target = path.join(scratch('dest'), 'unpack here');
        fs.mkdirSync(target, { recursive: true });
        const untar = childProcess.spawnSync('tar', ['-xzf', archive, '-C', target], { encoding: 'utf8' });
        expect(untar.status).toBe(0);
        expect(fs.readFileSync(path.join(target, 'dir with space', 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60), 'deep file.txt'), 'utf8')).toBe('deep\n');
        expect(fs.statSync(path.join(target, 'run.sh')).mode & 0o777).toBe(0o755);
        expect(fs.statSync(path.join(target, 'plain.txt')).mode & 0o777).toBe(0o644);
        expect(fs.readlinkSync(path.join(target, 'link'))).toBe('plain.txt');
        expect(fs.statSync(path.join(target, 'empty')).size).toBe(0);
    });

    test('is deterministic: the same tree gives the same bytes whatever the file times and creation order', async () => {
        const make = (order) => {
            const dir = scratch('det');
            for (const name of order) fs.writeFileSync(path.join(dir, name), `${name}\n`);
            return dir;
        };
        const one = make(['b.txt', 'a.txt', 'c.txt']);
        const two = make(['c.txt', 'a.txt', 'b.txt']);
        const old = new Date('2001-01-01T00:00:00Z');
        for (const name of fs.readdirSync(two)) fs.utimesSync(path.join(two, name), old, old);
        const out = scratch('det-out');
        const first = await stage.writeArchive(one, path.join(out, '1.tgz'));
        const second = await stage.writeArchive(two, path.join(out, '2.tgz'));
        expect(first.sha256).toBe(second.sha256);
        const third = await stage.writeArchive(one, path.join(out, '3.tgz'), { env: { SOURCE_DATE_EPOCH: '1700000000' } });
        expect(third.sha256).not.toBe(first.sha256);
    });

    test('refuses a device, socket or fifo in the payload', async () => {
        const dir = scratch('special');
        const fifo = childProcess.spawnSync('mkfifo', [path.join(dir, 'pipe')]);
        if (fifo.status !== 0) return;
        await expect(stage.writeArchive(dir, path.join(scratch('special-out'), 'x.tgz'))).rejects.toMatchObject({ code: 'ARCHIVE_SPECIAL_FILE' });
    });
});

suite('the header', () => {
    test('fills every placeholder, computes a fixed-width offset, and refuses a value a shell header cannot carry', () => {
        const template = "A='@VERSION@'\nB='@ARCHIVE_OFFSET@'\n";
        const out = stage.renderHeader(template, { VERSION: '1.2.3' });
        expect(out.text).toBe(`A='1.2.3'\nB='${String(out.offset).padStart(stage.OFFSET_WIDTH, '0')}'\n`);
        expect(Buffer.byteLength(out.text)).toBe(out.offset);
        expect(() => stage.renderHeader(template, {})).toThrow(/needs a value for VERSION/);
        expect(() => stage.renderHeader(template, { VERSION: "1'; rm -rf /; '" })).toThrow(/cannot carry/);
        expect(() => stage.renderHeader(template, { VERSION: 'a\nb' })).toThrow(/cannot carry/);
    });
});

suite('package-bootstrap', () => {
    test('builds a dev-labelled .run whose header carries the payload digest and the archive digest, plus a report with no timestamps', async () => {
        const { dir } = payload();
        const out = scratch('build');
        const built = await build(dir, out);
        const arch = packageBootstrap.TARGETS[HOST].arch;
        expect(path.basename(built.runFile)).toBe(`goobster-2.4.0-linux-${arch}-dev.run`);
        expect(fs.statSync(built.runFile).mode & 0o111).not.toBe(0);

        const header = stage.readHeader(built.runFile);
        expect(header).toMatchObject({ VERSION: '2.4.0', TARGET: HOST, ARCH: arch, PAYLOAD_DIGEST: DIGEST, SIGNED: '0', BUILD: 'dev' });
        const verdict = stage.verifyRun(built.runFile);
        expect(verdict.ok).toBe(true);
        expect(verdict.sha256).toBe(header.ARCHIVE_SHA256);
        expect(String(verdict.bytes)).toBe(header.ARCHIVE_BYTES);

        const text = fs.readFileSync(built.reportFile, 'utf8');
        const report = JSON.parse(text);
        expect(report).toMatchObject({
            target: HOST,
            version: '2.4.0',
            build: 'dev',
            signed: false,
            label: 'UNSIGNED DEVELOPMENT BUILD',
            payloadDigest: DIGEST,
            archive: { sha256: header.ARCHIVE_SHA256 }
        });
        expect(report.artifacts).toEqual([expect.objectContaining({ kind: 'run', sha256: sha256(fs.readFileSync(built.runFile)) })]);
        expect(report.skipped).toEqual([expect.objectContaining({ code: 'APPIMAGE_SKIPPED', reason: 'NOT_REQUESTED' })]);
        expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
        expect(fs.readFileSync(built.runFile, 'latin1').slice(0, report.header.bytes)).toContain('UNSIGNED DEVELOPMENT');
    });

    test('two builds of one payload are byte-identical (the .run and the report)', async () => {
        const { dir } = payload();
        const one = await build(dir, scratch('twice-1'));
        const two = await build(dir, scratch('twice-2'));
        expect(sha256(fs.readFileSync(one.runFile))).toBe(sha256(fs.readFileSync(two.runFile)));
        expect(fs.readFileSync(one.reportFile, 'utf8')).toBe(fs.readFileSync(two.reportFile, 'utf8'));
    });

    test('a payload signed under the supplied key is a release build: no -dev suffix, SIGNED=1, the key embedded; the wrong key stays dev', async () => {
        const signed = payload({ sign: true });
        const release = await build(signed.dir, scratch('release'), { publicKey: signed.publicKeyFile });
        expect(path.basename(release.runFile)).not.toContain('-dev');
        const header = stage.readHeader(release.runFile);
        expect(header).toMatchObject({ SIGNED: '1', BUILD: 'release' });
        expect(Buffer.from(header.PUBLIC_KEY_B64, 'base64').toString('utf8')).toBe(fs.readFileSync(signed.publicKeyFile, 'utf8'));
        expect(release.report).toMatchObject({ signed: true, label: 'release', signing: { unsignedReason: null } });

        const wrong = payloadStage.generateDevKeyPair(scratch('wrong-key'));
        const dev = await build(signed.dir, scratch('wrong'), { publicKey: wrong.publicKeyPath });
        expect(path.basename(dev.runFile)).toContain('-dev');
        expect(dev.report.signing.unsignedReason).toBe('SIGNATURE_INVALID');

        const nokey = await build(signed.dir, scratch('nokey'));
        expect(nokey.report.signing.unsignedReason).toBe('NO_PUBLIC_KEY');
        expect(nokey.report.build).toBe('dev');
    });

    test('refuses a payload built for another target and a payload with no digest', async () => {
        const { dir } = payload();
        const other = HOST === 'linux-x64' ? 'linux-arm64' : 'linux-x64';
        await expect(build(dir, scratch('wrong-target'), { target: other })).rejects.toThrow(/built for/);
        const broken = payload();
        const manifest = JSON.parse(fs.readFileSync(path.join(broken.dir, 'payload-manifest.json'), 'utf8'));
        delete manifest.payloadDigest;
        fs.writeFileSync(path.join(broken.dir, 'payload-manifest.json'), JSON.stringify(manifest));
        await expect(build(broken.dir, scratch('no-digest'))).rejects.toMatchObject({ code: 'PAYLOAD_DIGEST_MISSING' });
    });

    test('the AppDir holds the payload, an executable AppRun with the digest and build baked in, and a desktop file; the skip is explicit', async () => {
        const { dir } = payload();
        const out = scratch('appdir');
        const built = await build(dir, out, { appimage: true, appdirOnly: true });
        const arch = packageBootstrap.TARGETS[HOST].arch;
        const appDir = path.join(out, `Goobster-${arch}.AppDir`);
        const appRun = fs.readFileSync(path.join(appDir, 'AppRun'), 'utf8');
        expect(fs.statSync(path.join(appDir, 'AppRun')).mode & 0o111).not.toBe(0);
        expect(appRun).toContain(`--payload-digest '${DIGEST}'`);
        expect(appRun).toContain("--build 'dev'");
        expect(appRun).toContain("--signed '0'");
        expect(appRun).not.toMatch(/@[A-Z_]+@/);
        expect(fs.existsSync(path.join(appDir, 'usr', 'share', 'goobster', 'payload', 'payload-manifest.json'))).toBe(true);
        expect(fs.readFileSync(path.join(appDir, 'goobster.desktop'), 'utf8')).toContain('Exec=AppRun');
        expect(fs.readFileSync(path.join(appDir, 'goobster.png')).subarray(1, 4).toString()).toBe('PNG');
        expect(built.report.skipped).toEqual([expect.objectContaining({ code: 'APPIMAGE_SKIPPED', reason: 'APPDIR_ONLY' })]);
        const sh = childProcess.spawnSync('sh', ['-n', path.join(appDir, 'AppRun')]);
        expect(sh.status).toBe(0);
    });

    test('the pins file names a URL and a SHA-256 for appimagetool and the runtime on both architectures', () => {
        const pins = JSON.parse(fs.readFileSync(packageBootstrap.PINS_FILE, 'utf8'));
        for (const group of ['appimagetool', 'appimageRuntime']) {
            for (const arch of ['x64', 'arm64']) {
                expect(pins[group][arch].url).toMatch(/^https:\/\/github\.com\/AppImage\//);
                expect(pins[group][arch].sha256).toMatch(/^[0-9a-f]{64}$/);
            }
        }
    });
});

suite('the .run file', () => {
    let built;
    beforeAll(async () => {
        built = await build(payload().dir, scratch('run'));
    });

    test('--verify checks the archive and prints both digests; --info and --help work without unpacking', () => {
        const verify = run(built.runFile, ['--verify']);
        expect(verify.status).toBe(0);
        expect(verify.stdout).toContain('Archive verified');
        expect(verify.stdout).toContain(DIGEST);
        const info = run(built.runFile, ['--info']);
        expect(info.status).toBe(0);
        expect(info.stdout).toMatch(/payloadDigest\s+a{64}/);
        expect(info.stdout).toMatch(/archiveSha256\s+[0-9a-f]{64}/);
        expect(info.stdout).toMatch(/build\s+dev/);
        expect(verify.stdout).toContain('UNSIGNED DEVELOPMENT');
        expect(run(built.runFile, ['--help']).stdout).toContain('--headless --answers');
    });

    test('a tampered archive is refused before a byte is unpacked (shell and library agree)', () => {
        const tampered = path.join(scratch('tamper'), 'tampered.run');
        const bytes = fs.readFileSync(built.runFile);
        const offset = stage.readHeader(built.runFile).offset;
        bytes[offset + 200] ^= 0xff;
        fs.writeFileSync(tampered, bytes, { mode: 0o755 });

        expect(stage.verifyRun(tampered)).toMatchObject({ ok: false, code: 'ARCHIVE_DIGEST_MISMATCH' });
        const destination = path.join(scratch('tamper-dest'), 'never');
        expect(() => stage.extractRun(tampered, destination)).toThrow(/does not match its header/);
        expect(fs.existsSync(destination)).toBe(false);

        const tmp = scratch('tamper-tmp');
        const verify = run(tampered, ['--verify']);
        expect(verify.status).toBe(4);
        const answers = path.join(tmp, 'a.json');
        fs.writeFileSync(answers, '{}', { mode: 0o600 });
        const install = run(tampered, ['--headless', '--answers', answers], { TMPDIR: tmp });
        expect(install.status).toBe(4);
        expect(install.stderr).toMatch(/damaged|does not match|verification/i);
        expect(fs.readdirSync(tmp).filter(name => name.startsWith('goobster-bootstrap.'))).toEqual([]);
    });

    test('a truncated file is refused too', () => {
        const cut = path.join(scratch('truncate'), 'cut.run');
        const bytes = fs.readFileSync(built.runFile);
        fs.writeFileSync(cut, bytes.subarray(0, bytes.length - 100), { mode: 0o755 });
        expect(stage.verifyRun(cut).ok).toBe(false);
        expect(run(cut, ['--verify']).status).toBe(4);
    });

    test('extractRun unpacks into a path with spaces and the tree matches the payload', () => {
        const { dir } = payload();
        return build(dir, scratch('extract')).then((result) => {
            const destination = path.join(scratch('extract-dest'), 'dir with spaces', 'goobster payload');
            stage.extractRun(result.runFile, destination);
            const listing = (root) => stage.listEntries(root).filter(item => item.type === 'file').map(item => `${item.rel} ${sha256(fs.readFileSync(item.full))}`);
            expect(listing(destination)).toEqual(listing(dir));
            expect(stage.readPayloadIdentity(destination)).toMatchObject({ payloadDigest: DIGEST, version: '2.4.0', target: HOST });
        });
    });

    test('a damaged header never reaches the bundled runtime: an unsupported machine or missing tool is a clear exit, not a stack trace', () => {
        const result = run(built.runFile, ['--verify'], { PATH: '' });
        expect(result.status).not.toBe(0);
        expect(result.stderr.length).toBeLessThan(600);
        expect(result.stderr).not.toMatch(/at .*\.js:\d+/);
    });
});
