/**
 * Phase 2 Workshop pin → project asset migration.
 *
 * Idempotence, grant carry-over, slug-collision suffixes, workshop
 * project-cap bypass, and Promote. Throwaway SQLite; no network.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-workshop-mig-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const webAppletService = require('@goobster/core/services/webAppletService');
const projectAssetService = require('@goobster/core/services/projectAssetService');
const observatoryService = require('@goobster/core/services/observatoryService');
const {
    migrateAll,
    promoteToProject,
    allocateSlug,
    slugFromTitle,
    MIGRATION_KEY
} = require('@goobster/core/services/workshopPinMigration');

const OTHER = `mig-other-${process.pid}`;
let userSeq = 0;
function nextUser() {
    return `mig-user-${process.pid}-${userSeq++}`;
}

const GRANT_SOURCE = '<html><head><meta name="goobster-observatory-read" content="jwst-atlas, other-lab"><title>Reader</title></head></html>';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* gone */ }
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM project_asset_versions');
    await db.run('DELETE FROM project_assets');
    await db.run('DELETE FROM observatory_projects');
    await db.run('DELETE FROM web_applets');
    await db.run('DELETE FROM data_migrations');
});

describe('allocateSlug', () => {
    test('suffixes colliding titles', () => {
        const taken = new Set();
        expect(allocateSlug(taken, slugFromTitle('My App'))).toBe('my-app');
        expect(allocateSlug(taken, slugFromTitle('my-app'))).toBe('my-app-2');
        expect(allocateSlug(taken, slugFromTitle('My App'))).toBe('my-app-3');
    });

    test('falls back when the title has no slug characters', () => {
        expect(slugFromTitle('!!!')).toBe('applet');
    });
});

describe('migrateAll', () => {
    test('creates a workshop project and one app asset per pin', async () => {
        const USER = nextUser();
        const pin = await webAppletService.pin({
            userId: USER,
            language: 'html',
            source: GRANT_SOURCE,
            grants: { observatoryRead: ['jwst-atlas', 'not-declared'] }
        });
        await webAppletService.pin({
            userId: USER,
            language: 'svg',
            source: '<svg><title>Orbit</title></svg>',
            title: 'Orbit'
        });

        const first = await migrateAll();
        expect(first.users).toBe(1);
        expect(first.migrated).toBe(2);
        expect(first.linked).toBe(0);

        const workshop = await db.get(
            `SELECT id, slug, name FROM observatory_projects
             WHERE userId = @userId AND slug = 'workshop'`,
            { userId: USER }
        );
        expect(workshop.name).toBe('Workshop');

        const listed = await projectAssetService.list({ userId: USER, project: 'workshop' });
        expect(listed).toHaveLength(2);
        const reader = listed.find(a => a.slug === 'reader');
        expect(reader.kind).toBe('app');
        expect(reader.grants).toEqual({ observatoryRead: ['jwst-atlas'] });
        const got = await projectAssetService.get({
            userId: USER, project: 'workshop', asset: 'reader'
        });
        expect(got.origin).toBe('migration');
        expect(got.source).toContain('jwst-atlas');

        const pinned = await webAppletService.listPinned(USER);
        expect(pinned.every(a => a.migrated)).toBe(true);
        expect(pinned.find(a => a.id === pin.id).migratedProject).toBe('workshop');
        expect(pinned.find(a => a.id === pin.id).migratedAssetSlug).toBe('reader');

        const marker = await db.get(
            'SELECT key FROM data_migrations WHERE key = @key',
            { key: MIGRATION_KEY }
        );
        expect(marker.key).toBe(MIGRATION_KEY);
    });

    test('a second run is a no-op (no extra versions)', async () => {
        const USER = nextUser();
        await webAppletService.pin({
            userId: USER, language: 'html', source: '<html><title>Dash</title></html>'
        });
        await migrateAll();
        const second = await migrateAll();
        expect(second.migrated).toBe(0);
        expect(second.linked).toBe(0);
        expect(second.users).toBe(0);
        const history = await projectAssetService.listVersions({
            userId: USER, project: 'workshop', asset: 'dash'
        });
        expect(history.versions).toHaveLength(1);
        expect(history.versions[0].version).toBe(1);
    });

    test('relinks an orphaned pin without creating a new version', async () => {
        const USER = nextUser();
        const pin = await webAppletService.pin({
            userId: USER, language: 'html', source: '<html><title>Keep</title></html>'
        });
        await migrateAll();
        await db.run(
            'UPDATE web_applets SET migratedAssetId = NULL WHERE id = @id',
            { id: pin.id }
        );
        const again = await migrateAll();
        expect(again.linked).toBe(1);
        expect(again.migrated).toBe(0);
        const history = await projectAssetService.listVersions({
            userId: USER, project: 'workshop', asset: 'keep'
        });
        expect(history.versions).toHaveLength(1);
        const refreshed = await webAppletService.get({ userId: USER, appletId: pin.id });
        expect(refreshed.migrated).toBe(true);
    });

    test('colliding titles become distinct slugs, not versions of one asset', async () => {
        const USER = nextUser();
        await webAppletService.pin({
            userId: USER, language: 'html',
            source: '<html><title>My App</title><p>one</p></html>'
        });
        await webAppletService.pin({
            userId: USER, language: 'html',
            source: '<html><h1>my-app</h1><p>two</p></html>'
        });
        await migrateAll();
        const listed = await projectAssetService.list({ userId: USER, project: 'workshop' });
        const slugs = listed.map(a => a.slug).sort();
        expect(slugs).toEqual(['my-app', 'my-app-2']);
        expect(listed.every(a => a.currentVersion === 1)).toBe(true);
    });

    test('users at the project cap still get a workshop project', async () => {
        const USER = nextUser();
        await db.run(
            `INSERT INTO observatory_projects (userId, slug, name)
             VALUES (@userId, 'alpha', 'Alpha'), (@userId, 'beta', 'Beta')`,
            { userId: USER }
        );
        await webAppletService.pin({
            userId: USER, language: 'html', source: '<html><title>Cap</title></html>'
        });
        const result = await migrateAll();
        expect(result.migrated).toBe(1);
        const workshop = await db.get(
            `SELECT slug FROM observatory_projects
             WHERE userId = @userId AND slug = 'workshop'`,
            { userId: USER }
        );
        expect(workshop).toBeTruthy();
        const count = await db.get(
            'SELECT COUNT(*) AS c FROM observatory_projects WHERE userId = @userId',
            { userId: USER }
        );
        expect(count.c).toBe(3);
    });

    test('does not touch another user\'s pins', async () => {
        const USER = nextUser();
        await webAppletService.pin({
            userId: USER, language: 'html', source: '<html><title>Mine</title></html>'
        });
        await webAppletService.pin({
            userId: OTHER, language: 'html', source: '<html><title>Theirs</title></html>'
        });
        await migrateAll();
        expect((await projectAssetService.list({ userId: USER, project: 'workshop' }))).toHaveLength(1);
        expect((await projectAssetService.list({ userId: OTHER, project: 'workshop' }))).toHaveLength(1);
        expect((await webAppletService.listPinned(USER))[0].migrated).toBe(true);
        expect((await webAppletService.listPinned(OTHER))[0].migrated).toBe(true);
    });
});

describe('promoteToProject', () => {
    test('promotes a pin into the workshop project and marks it migrated', async () => {
        const USER = nextUser();
        const pin = await webAppletService.pin({
            userId: USER, language: 'html', source: '<html><title>Promo</title></html>'
        });
        const result = await promoteToProject({
            userId: USER,
            appletId: pin.id,
            name: 'Promo'
        });
        expect(result.asset.project).toBe('workshop');
        expect(result.asset.slug).toBe('promo');
        expect(result.asset.origin).toBe('portal');
        expect(result.applet.migrated).toBe(true);
        expect(result.applet.migratedAssetSlug).toBe('promo');
    });

    test('promotes a discovered fence (no pin) into a chosen project', async () => {
        const USER = nextUser();
        await observatoryService.ensureWorkshopProject(USER);
        await db.run(
            `INSERT INTO observatory_projects (userId, slug, name)
             VALUES (@userId, 'lab', 'Lab')`,
            { userId: USER }
        );
        const result = await promoteToProject({
            userId: USER,
            project: 'lab',
            name: 'From Chat',
            language: 'html',
            source: '<html><title>From Chat</title></html>'
        });
        expect(result.asset.project).toBe('lab');
        expect(result.asset.slug).toBe('from-chat');
        expect(result.applet).toBeNull();
        expect((await webAppletService.listPinned(USER))).toHaveLength(0);
    });
});
