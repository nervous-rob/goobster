/**
 * `update.stage` (#342, documentation/manager_update.md): the offered release is downloaded to a
 * `.partial`, checked against the signed index (size, SHA-256), verified as a payload and staged
 * beside `current`, which never changes. A refusal at any step leaves nothing behind.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const { drive, codeOf, snapshot, tempDir } = require('./helpers/installFixture');
const { newKey, makePayload, publish, installBase, migrationsText } = require('./helpers/updateFixture');

const roots = [];
afterAll(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

async function world({ next = {}, publishOptions = {}, key = newKey(roots, 'trusted'), updateDeps = {}, source = true } = {}) {
    const base = makePayload(tempDir(roots, 'base'), key, { core: '2.4.0' });
    const second = makePayload(tempDir(roots, 'next'), key, { core: '2.5.0', ...next });
    const published = await publish(roots, key, second, publishOptions);
    const harness = await installBase({ roots, key, base, sourceDir: source ? published.dir : null, updateDeps });
    return { key, base, second, published, harness };
}

const codeState = (harness) => ['current', 'previous', 'staging'].map(name => snapshot(path.join(harness.code, name))).join('\n--\n');
const updateDir = (harness) => path.join(harness.settings.storeDir, 'update');
const staged = (harness) => JSON.parse(fs.readFileSync(path.join(updateDir(harness), 'staged.json'), 'utf8'));
const ledger = (harness, id) => Object.fromEntries(harness.manager.journal.read(id).record.progress.map(item => [item.name, item.status]));
const leftovers = (harness) => {
    const dir = path.join(harness.code, 'releases');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.partial')) : [];
};

describe('update.stage', () => {
    test('downloads, verifies and stages the offered release beside current, which does not change', async () => {
        const { harness, second } = await world();
        const before = codeState(harness);
        const config = path.join(harness.code, 'config.json');
        fs.writeFileSync(config, JSON.stringify({ token: 'tok-update-secret-0123456789' }));
        const { applied } = await drive(harness, 'update.stage', {});
        expect(applied.operation.status).toBe('applied');
        expect(applied.result).toMatchObject({ staged: true, version: '2.5.0', releaseId: second.releaseId, schemaChanging: false, features: ['core', 'tavern'] });
        expect(ledger(harness, applied.operation.id)).toEqual({
            preflight: 'done', 'fetch-index': 'done', 'verify-index': 'done', space: 'done', download: 'done', 'verify-artifact': 'done', 'verify-payload': 'done', stage: 'done', record: 'done'
        });
        expect(snapshot(path.join(harness.code, 'current'))).toBe(before.split('\n--\n')[0]);
        const stagingDir = path.join(harness.code, 'staging', staged(harness).stagingDir);
        expect(fs.existsSync(path.join(stagingDir, 'payload-manifest.json'))).toBe(true);
        expect(fs.readFileSync(path.join(stagingDir, 'app', 'apps', 'bot', 'index.js'), 'utf8')).toContain('2.5.0');
        expect(fs.existsSync(path.join(harness.code, 'releases', second.releaseId, 'payload-manifest.json'))).toBe(true);
        expect(staged(harness)).toMatchObject({ releaseId: second.releaseId, version: '2.5.0', schemaChanging: false });
        expect(leftovers(harness)).toEqual([]);
        expect(fs.readFileSync(config, 'utf8')).toContain('tok-update-secret-0123456789');
        expect(JSON.stringify(harness.manager.journal.read(applied.operation.id).record)).not.toContain('tok-update-secret');
    });

    test('says a release is schema-changing when its schema or its column migrations differ', async () => {
        const columns = await world({ next: { columns: [['users', 'nickname', 'TEXT']] } });
        expect((await drive(columns.harness, 'update.stage', {})).applied.result).toMatchObject({ staged: true, schemaChanging: true });
        expect(staged(columns.harness).fromFingerprint).not.toBe(staged(columns.harness).schemaFingerprint);

        const schema = await world({ next: { schema: 'CREATE TABLE t (a INTEGER, b TEXT);\n' } });
        expect((await drive(schema.harness, 'update.stage', {})).applied.result).toMatchObject({ staged: true, schemaChanging: true });

        const same = await world({ next: { marker: 'only-code-changed' } });
        expect((await drive(same.harness, 'update.stage', {})).applied.result).toMatchObject({ staged: true, schemaChanging: false });
        expect(migrationsText([])).toContain('COLUMN_MIGRATIONS');
    });

    test('a corrupted download is refused at the digest and nothing is applied or left behind', async () => {
        const { harness } = await world({ publishOptions: { corrupt: 'bytes' } });
        const before = codeState(harness);
        const failure = await drive(harness, 'update.stage', {}).catch(error => error);
        expect(failure.code).toBe('ARTIFACT_DIGEST_MISMATCH');
        expect(codeState(harness)).toBe(before);
        expect(fs.existsSync(path.join(updateDir(harness), 'staged.json'))).toBe(false);
        expect(leftovers(harness)).toEqual([]);
        expect(fs.readdirSync(path.join(harness.code, 'releases'))).toEqual([]);
    });

    test('an archive whose digest matches but whose files do not is refused by the payload check', async () => {
        const { harness } = await world({ publishOptions: { corrupt: 'file' } });
        const before = codeState(harness);
        const code = await codeOf(drive(harness, 'update.stage', {}));
        expect(code).not.toBe('OK');
        expect(code).toBe('INCOMPLETE');
        expect(codeState(harness)).toBe(before);
        expect(fs.existsSync(path.join(updateDir(harness), 'staged.json'))).toBe(false);
        expect(leftovers(harness)).toEqual([]);
        expect(fs.readdirSync(path.join(harness.code, 'releases'))).toEqual([]);
    });

    test('an index signed by a key nobody trusts stops before anything is downloaded', async () => {
        const trusted = newKey(roots, 'trusted');
        const stranger = newKey(roots, 'stranger');
        const { harness } = await world({ key: trusted, publishOptions: { signWith: stranger } });
        expect(await codeOf(drive(harness, 'update.stage', {}))).toBe('UNTRUSTED_KEY');
        expect(fs.existsSync(path.join(harness.code, 'releases'))).toBe(false);
        const check = JSON.parse(fs.readFileSync(path.join(updateDir(harness), 'last-check.json'), 'utf8'));
        expect(check).toMatchObject({ outcome: 'blocked', code: 'UNTRUSTED_KEY' });
    });

    test('there is nothing to stage when the installation already runs the newest release', async () => {
        const key = newKey(roots, 'trusted');
        const base = makePayload(tempDir(roots, 'base'), key, { core: '2.4.0' });
        const published = await publish(roots, key, base);
        const harness = await installBase({ roots, key, base, sourceDir: published.dir });
        expect(await codeOf(drive(harness, 'update.stage', {}))).toBe('NO_UPDATE_AVAILABLE');
    });

    test('refuses before downloading when there is not enough free space', async () => {
        const { harness } = await world({ updateDeps: { freeBytes: () => 1024 } });
        const failure = await drive(harness, 'update.stage', {}).catch(error => error);
        expect(failure.code).toBe('INSUFFICIENT_SPACE');
        expect(fs.existsSync(path.join(harness.code, 'releases'))).toBe(false);
    });

    test('a download that breaks half way leaves no partial file and no staged release', async () => {
        const key = newKey(roots, 'trusted');
        const base = makePayload(tempDir(roots, 'base'), key, { core: '2.4.0' });
        const second = makePayload(tempDir(roots, 'next'), key, { core: '2.5.0' });
        const source = await publish(roots, key, second);
        const fetchImpl = async (url) => {
            const href = String(url);
            if (href.startsWith('https://api.github.com/')) {
                const assets = fs.readdirSync(source.dir).map(name => ({ name, browser_download_url: `https://github.com/dl/${name}` }));
                const body = Buffer.from(JSON.stringify([{ tag_name: 'v2.5.0', draft: false, prerelease: false, assets }]));
                return { ok: true, status: 200, url: href, body: Readable.toWeb(Readable.from([body])), json: async () => JSON.parse(body.toString()) };
            }
            const name = decodeURIComponent(href.split('/').pop());
            const bytes = fs.readFileSync(path.join(source.dir, name));
            const cut = name.endsWith('.tar.gz');
            const stream = Readable.from((async function* () {
                yield bytes.subarray(0, cut ? Math.floor(bytes.length / 2) : bytes.length);
                if (cut) throw new Error('connection reset');
            })());
            return { ok: true, status: 200, url: href, body: Readable.toWeb(stream) };
        };
        const harness = await installBase({ roots, key, base, updateDeps: { fetch: fetchImpl } });
        await drive(harness, 'update.policy', { source: { kind: 'github-release', owner: 'nervous-rob', repo: 'goobster' } });
        const before = codeState(harness);
        expect(await codeOf(drive(harness, 'update.stage', {}))).toBe('DOWNLOAD_FAILED');
        expect(codeState(harness)).toBe(before);
        expect(leftovers(harness)).toEqual([]);
        expect(fs.existsSync(path.join(updateDir(harness), 'staged.json'))).toBe(false);
    });

    test('refuses to stage while an update is being handed over or waits for a decision', async () => {
        const { harness } = await world();
        const dir = updateDir(harness);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'handoff.json'), JSON.stringify({ phase: 'pending' }));
        expect(await codeOf(drive(harness, 'update.stage', {}))).toBe('UPDATE_IN_PROGRESS');
        fs.writeFileSync(path.join(dir, 'recovery.json'), JSON.stringify({ code: 'X' }));
        expect(await codeOf(drive(harness, 'update.stage', {}))).toBe('RECOVERY_PENDING');
    });

    test('staging again replaces the staged release and keeps the retained releases bounded', async () => {
        const { harness, second } = await world();
        await drive(harness, 'update.stage', {});
        const again = await drive(harness, 'update.stage', {});
        expect(again.applied.result).toMatchObject({ staged: true, releaseId: second.releaseId });
        expect(fs.readdirSync(path.join(harness.code, 'releases'))).toEqual([second.releaseId]);
    });
});

describe('landing a downloaded file', () => {
    const { landFile } = require('../apps/manager/update/source');

    test('syncs the landed file through a handle opened for writing, as Windows requires (a read-only fsync fails there with EPERM)', async () => {
        const dir = tempDir(roots, 'land');
        const readOnly = new Set();
        const windowsLike = {
            ...fs,
            openSync(file, flags, mode) {
                const fd = fs.openSync(file, flags, mode);
                if (flags === 'r') readOnly.add(fd);
                return fd;
            },
            fsyncSync(fd) {
                if (readOnly.has(fd)) {
                    const error = new Error('EPERM: operation not permitted, fsync');
                    error.code = 'EPERM';
                    throw error;
                }
                return fs.fsyncSync(fd);
            },
            closeSync(fd) {
                readOnly.delete(fd);
                return fs.closeSync(fd);
            }
        };
        const bytes = Buffer.from('a release artifact');
        const dest = path.join(dir, 'artifact.tar.gz');
        const landed = await landFile({ fs: windowsLike, readable: Readable.from([bytes]), dest, limit: 1024, expect: { size: bytes.length } });
        expect(landed.bytes).toBe(bytes.length);
        expect(fs.readFileSync(dest)).toEqual(bytes);
        expect(fs.existsSync(`${dest}.partial`)).toBe(false);
    });
});

describe('the tar the archive is read with', () => {
    const archive = require('../apps/manager/update/archive');

    test('is the one on PATH everywhere but Windows', () => {
        expect(archive.tarCommand({ platform: 'linux' })).toBe('tar');
        expect(archive.tarCommand({ platform: 'darwin' })).toBe('tar');
    });

    test('on Windows is System32\'s bsdtar when it is there, since Git Bash puts a GNU tar first that reads D:\\ as a remote host', () => {
        const seen = [];
        const exists = (file) => { seen.push(file); return true; };
        expect(archive.tarCommand({ platform: 'win32', env: { SystemRoot: 'D:\\Windows' }, exists })).toBe('D:\\Windows\\System32\\tar.exe');
        expect(seen).toEqual(['D:\\Windows\\System32\\tar.exe']);
        expect(archive.tarCommand({ platform: 'win32', env: {}, exists: () => true })).toBe('C:\\Windows\\System32\\tar.exe');
        expect(archive.tarCommand({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists: () => false })).toBe('tar');
    });

    test('a file tar cannot read is refused as ARCHIVE_UNREADABLE with the call and exit status as the reason, not tar\'s output', () => {
        const dir = tempDir(roots, 'notar');
        const file = path.join(dir, 'not-an-archive.tar.gz');
        fs.writeFileSync(file, 'this is not a gzip stream at all');
        let failure = null;
        try { archive.listMembers(file); } catch (error) { failure = error; }
        expect(failure).not.toBeNull();
        expect(failure.code).toBe('ARCHIVE_UNREADABLE');
        expect(failure.details.reason).toMatch(/^LIST_EXIT_\d+$/);
        expect(JSON.stringify(failure)).not.toContain('not-an-archive');
    });
});
