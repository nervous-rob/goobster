/**
 * Versioned project assets (services/projectAssetService.js).
 *
 * Exercises CRUD, monotonic versions, identical-source dedupe, rollback,
 * prune-at-cap, grant legalization, and /forget-me against a throwaway
 * SQLite file. No network, no keys — projects are inserted directly.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-project-assets-${process.pid}.sqlite`);

const db = require('@goobster/core/db');
const { ProjectAssetService, ProjectAssetError } = require('@goobster/core/services/projectAssetService');

const OTHER = `asset-other-${process.pid}`;
let userSeq = 0;
function nextUser() {
    return `asset-user-${process.pid}-${userSeq++}`;
}

function makeService(overrides = {}) {
    return new ProjectAssetService({
        config: {
            maxAssetsPerProject: 20,
            maxVersionsPerAsset: 50,
            ...overrides
        }
    });
}

async function seedProject(userId, slug = 'lab', name = 'Lab') {
    await db.run(
        `INSERT INTO observatory_projects (userId, slug, name)
         VALUES (@userId, @slug, @name)`,
        { userId, slug, name }
    );
    return { slug, name };
}

async function expectThrow(fn, expected) {
    let caught = null;
    try { await fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(ProjectAssetError);
    expect(caught).toMatchObject(expected);
    return caught;
}

afterAll(async () => {
    await db.closeConnection();
    try { fs.rmSync(process.env.GOOBSTER_DB_PATH, { force: true }); } catch { /* held open */ }
    for (const suffix of ['-shm', '-wal']) {
        try { fs.rmSync(process.env.GOOBSTER_DB_PATH + suffix, { force: true }); } catch { /* gone */ }
    }
});

describe('asset CRUD', () => {
    test('save creates an app asset at v1 and get returns the head', async () => {
        const svc = makeService();
        const USER = nextUser();
        await seedProject(USER, 'crud-lab', 'CRUD Lab');
        const saved = await svc.save({
            userId: USER,
            project: 'crud-lab',
            name: 'Dashboard',
            kind: 'app',
            language: 'html',
            source: '<html><title>Dash</title></html>',
            origin: 'portal'
        });
        expect(saved.slug).toBe('dashboard');
        expect(saved.kind).toBe('app');
        expect(saved.version).toBe(1);
        expect(saved.currentVersion).toBe(1);
        expect(saved.deduped).toBe(false);
        expect(saved.source).toContain('Dash');

        const listed = await svc.list({ userId: USER, project: 'crud-lab', kind: 'app' });
        expect(listed).toHaveLength(1);
        expect(listed[0].slug).toBe('dashboard');
        expect(listed[0].currentVersion).toBe(1);

        const got = await svc.get({ userId: USER, project: 'crud-lab', asset: 'dashboard' });
        expect(got.version).toBe(1);
        expect(got.source).toContain('Dash');
    });

    test('save_script and save_note accept their languages', async () => {
        const svc = makeService();
        const USER = nextUser();
        await seedProject(USER, 'kinds-lab', 'Kinds');
        const script = await svc.save({
            userId: USER, project: 'kinds-lab', name: 'Ingest',
            kind: 'script', language: 'python', source: 'print("hi")'
        });
        expect(script.kind).toBe('script');
        expect(script.language).toBe('python');
        const note = await svc.save({
            userId: USER, project: 'kinds-lab', name: 'Readme',
            kind: 'note', language: 'markdown', source: '# hello'
        });
        expect(note.kind).toBe('note');
        const all = await svc.list({ userId: USER, project: 'kinds-lab' });
        expect(all.map(a => a.kind).sort()).toEqual(['note', 'script']);
    });

    test('refuses the wrong language for a kind and an empty source', async () => {
        const svc = makeService();
        const USER = nextUser();
        await seedProject(USER, 'bad-lab', 'Bad');
        await expectThrow(() => svc.save({
            userId: USER, project: 'bad-lab', name: 'x',
            kind: 'app', language: 'python', source: '<html></html>'
        }), { code: 'BAD_LANGUAGE', status: 400 });
        await expectThrow(() => svc.save({
            userId: USER, project: 'bad-lab', name: 'x',
            kind: 'app', language: 'html', source: '   '
        }), { code: 'BAD_SOURCE', status: 400 });
        await expectThrow(() => svc.get({
            userId: USER, project: 'nope', asset: 'x'
        }), { code: 'NO_SUCH_PROJECT', status: 404 });
    });

    test('update renames and legalizes grants against the head source', async () => {
        const svc = makeService();
        const USER = nextUser();
        await seedProject(USER, 'grant-lab', 'Grants');
        await svc.save({
            userId: USER, project: 'grant-lab', name: 'Viewer',
            kind: 'app', language: 'html',
            source: '<html><meta name="goobster-observatory-read" content="grant-lab"><title>V</title></html>',
            grants: { observatoryRead: ['grant-lab', 'not-declared', 'BAD SLUG'] }
        });
        const updated = await svc.update({
            userId: USER, project: 'grant-lab', asset: 'viewer',
            name: 'Sky Viewer',
            grants: { observatoryRead: ['grant-lab', 'other-lab'] }
        });
        expect(updated.name).toBe('Sky Viewer');
        expect(updated.grants.observatoryRead).toEqual(['grant-lab']);
    });

    test('delete removes the asset and its versions', async () => {
        const svc = makeService();
        const USER = nextUser();
        await seedProject(USER, 'del-lab', 'Del');
        await svc.save({
            userId: USER, project: 'del-lab', name: 'Gone',
            kind: 'note', language: 'markdown', source: 'bye'
        });
        const gone = await svc.delete({ userId: USER, project: 'del-lab', asset: 'gone' });
        expect(gone.deleted).toBe(true);
        await expectThrow(() => svc.get({
            userId: USER, project: 'del-lab', asset: 'gone'
        }), { code: 'NO_SUCH_ASSET', status: 404 });
    });

    test('another user cannot see the asset', async () => {
        const svc = makeService();
        const USER = nextUser();
        await seedProject(USER, 'own-lab', 'Own');
        await seedProject(OTHER, 'own-lab', 'Own');
        await svc.save({
            userId: USER, project: 'own-lab', name: 'Secret',
            kind: 'note', language: 'markdown', source: 'shh'
        });
        await expectThrow(() => svc.get({
            userId: OTHER, project: 'own-lab', asset: 'secret'
        }), { code: 'NO_SUCH_ASSET', status: 404 });
    });
});

describe('versioning', () => {
    test('saves append monotonic versions and get can fetch a specific one', async () => {
        const svc = makeService();
        const USER = nextUser();
        await seedProject(USER, 'ver-lab', 'Versions');
        await svc.save({
            userId: USER, project: 'ver-lab', name: 'Dash',
            kind: 'app', language: 'html', source: '<html>v1</html>'
        });
        const v2 = await svc.save({
            userId: USER, project: 'ver-lab', slug: 'dash', name: 'Dash',
            kind: 'app', language: 'html', source: '<html>v2</html>', note: 'added bars'
        });
        expect(v2.version).toBe(2);
        expect(v2.currentVersion).toBe(2);
        expect(v2.note).toBe('added bars');

        const old = await svc.get({
            userId: USER, project: 'ver-lab', asset: 'dash', version: 1
        });
        expect(old.version).toBe(1);
        expect(old.source).toBe('<html>v1</html>');
        expect(old.currentVersion).toBe(2);

        const history = await svc.listVersions({
            userId: USER, project: 'ver-lab', asset: 'dash'
        });
        expect(history.versions.map(v => v.version)).toEqual([2, 1]);
        expect(history.versions[0].isHead).toBe(true);
    });

    test('identical-source save is a no-op that returns the head', async () => {
        const svc = makeService();
        const USER = nextUser();
        await seedProject(USER, 'dupe-lab', 'Dupe');
        const first = await svc.save({
            userId: USER, project: 'dupe-lab', name: 'Same',
            kind: 'app', language: 'html', source: '<html>same</html>'
        });
        const again = await svc.save({
            userId: USER, project: 'dupe-lab', slug: 'same',
            kind: 'app', language: 'html', source: '<html>same</html>'
        });
        expect(again.deduped).toBe(true);
        expect(again.version).toBe(first.version);
        expect(again.versionId).toBe(first.versionId);
        const history = await svc.listVersions({
            userId: USER, project: 'dupe-lab', asset: 'same'
        });
        expect(history.versions).toHaveLength(1);
    });

    test('rollback moves currentVersionId without deleting history', async () => {
        const svc = makeService();
        const USER = nextUser();
        await seedProject(USER, 'rb-lab', 'Rollback');
        await svc.save({
            userId: USER, project: 'rb-lab', name: 'Dash',
            kind: 'app', language: 'html', source: '<html>one</html>'
        });
        await svc.save({
            userId: USER, project: 'rb-lab', slug: 'dash',
            kind: 'app', language: 'html', source: '<html>two</html>'
        });
        const rolled = await svc.rollback({
            userId: USER, project: 'rb-lab', asset: 'dash', version: 1
        });
        expect(rolled.version).toBe(1);
        expect(rolled.currentVersion).toBe(1);
        expect(rolled.source).toBe('<html>one</html>');
        const history = await svc.listVersions({
            userId: USER, project: 'rb-lab', asset: 'dash'
        });
        expect(history.versions).toHaveLength(2);
        expect(history.versions.find(v => v.version === 1).isHead).toBe(true);
        expect(history.versions.find(v => v.version === 2).isHead).toBe(false);
    });

    test('prunes oldest non-head versions once past the cap', async () => {
        const svc = makeService({ maxVersionsPerAsset: 3 });
        const USER = nextUser();
        await seedProject(USER, 'prune-lab', 'Prune');
        for (let i = 1; i <= 5; i++) {
            await svc.save({
                userId: USER, project: 'prune-lab', name: 'Dash',
                kind: 'app', language: 'html', source: `<html>v${i}</html>`
            });
        }
        const history = await svc.listVersions({
            userId: USER, project: 'prune-lab', asset: 'dash'
        });
        expect(history.versions.map(v => v.version).sort((a, b) => a - b)).toEqual([3, 4, 5]);
        expect(history.versions.find(v => v.version === 5).isHead).toBe(true);
        await expectThrow(() => svc.get({
            userId: USER, project: 'prune-lab', asset: 'dash', version: 1
        }), { code: 'NO_SUCH_VERSION', status: 404 });
    });

    test('rollback head is never pruned when later versions are added', async () => {
        const svc = makeService({ maxVersionsPerAsset: 2 });
        const USER = nextUser();
        await seedProject(USER, 'keep-head', 'Keep');
        await svc.save({
            userId: USER, project: 'keep-head', name: 'Dash',
            kind: 'app', language: 'html', source: '<html>a</html>'
        });
        await svc.save({
            userId: USER, project: 'keep-head', slug: 'dash',
            kind: 'app', language: 'html', source: '<html>b</html>'
        });
        await svc.rollback({
            userId: USER, project: 'keep-head', asset: 'dash', version: 1
        });
        await svc.save({
            userId: USER, project: 'keep-head', slug: 'dash',
            kind: 'app', language: 'html', source: '<html>c</html>'
        });
        const history = await svc.listVersions({
            userId: USER, project: 'keep-head', asset: 'dash'
        });
        const versions = history.versions.map(v => v.version).sort((a, b) => a - b);
        expect(versions).toHaveLength(2);
        expect(versions).toContain(3);
        expect(history.versions.find(v => v.isHead).version).toBe(3);
    });

    test('refuses a kind change on an existing slug', async () => {
        const svc = makeService();
        const USER = nextUser();
        await seedProject(USER, 'kind-lab', 'Kind');
        await svc.save({
            userId: USER, project: 'kind-lab', name: 'Dash',
            kind: 'app', language: 'html', source: '<html></html>'
        });
        await expectThrow(() => svc.save({
            userId: USER, project: 'kind-lab', slug: 'dash',
            kind: 'note', language: 'markdown', source: '# no'
        }), { code: 'KIND_MISMATCH', status: 409 });
    });

    test('caps new assets per project', async () => {
        const svc = makeService({ maxAssetsPerProject: 1 });
        const USER = nextUser();
        await seedProject(USER, 'cap-lab', 'Cap');
        await svc.save({
            userId: USER, project: 'cap-lab', name: 'One',
            kind: 'note', language: 'markdown', source: 'a'
        });
        await expectThrow(() => svc.save({
            userId: USER, project: 'cap-lab', name: 'Two',
            kind: 'note', language: 'markdown', source: 'b'
        }), { code: 'TOO_MANY_ASSETS', status: 400 });
        const extra = await svc.save({
            userId: USER, project: 'cap-lab', name: 'Two',
            kind: 'note', language: 'markdown', source: 'b',
            ignoreAssetCap: true
        });
        expect(extra.slug).toBe('two');
    });
});

describe('erasure', () => {
    test('forgetUser deletes by userId and leaves other users alone', async () => {
        const svc = makeService();
        const USER = nextUser();
        await seedProject(USER, 'erase-lab', 'Erase');
        await seedProject(OTHER, 'erase-lab', 'Erase');
        await svc.save({
            userId: USER, project: 'erase-lab', name: 'Mine',
            kind: 'note', language: 'markdown', source: 'rob'
        });
        await svc.save({
            userId: OTHER, project: 'erase-lab', name: 'Theirs',
            kind: 'note', language: 'markdown', source: 'alice'
        });
        const gone = await svc.forgetUser(USER);
        expect(gone.assets).toBe(1);
        expect(gone.versions).toBe(1);
        expect((await svc.countUser(USER)).assets).toBe(0);
        expect((await svc.countUser(OTHER)).assets).toBe(1);
        expect((await svc.countUser(OTHER)).versions).toBe(1);
    });
});
