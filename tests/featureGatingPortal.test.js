/**
 * Portal rooms, tutorials and self-docs reflect feature availability (#321).
 *
 * Covers: parity between the room/view/tutorial catalogs and the feature
 * inventory and catalog; the rooms.cjs availability helpers (nav, nested
 * views, Tools cards, deep links, the user-hidden distinction, the legacy
 * fallback); the tutorial service (listed unavailable, refused with
 * FEATURE_UNAVAILABLE, progress preserved, restored on re-enable, identical
 * to legacy with no features.json); self-docs front matter, query-time
 * annotations in search/read/list and an idempotent seed; and the
 * documentation/features.md generator.
 *
 * Feature state is injected through an in-memory fs, so nothing here reads
 * config.json, a key or the network.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB = path.join(os.tmpdir(), `goobster-gating-portal-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-gating-docs-'));
const DOCS_DIR = path.join(FIXTURE_ROOT, 'docs');
const OPERATOR_DIR = path.join(FIXTURE_ROOT, 'operator-notes');
fs.mkdirSync(DOCS_DIR, { recursive: true });
fs.mkdirSync(OPERATOR_DIR, { recursive: true });
process.env.GOOBSTER_SELF_DOCS_SOURCES = DOCS_DIR;
process.env.GOOBSTER_SELF_DOCS_OPERATOR_DIR = OPERATOR_DIR;
process.env.GOOBSTER_SELF_DOCS_EMBEDDINGS = '0';

const db = require('@goobster/core/db');
const catalog = require('@goobster/core/features/catalog');
const inventory = require('@goobster/core/features/inventory');
const { features } = require('@goobster/core/features/featureState');
const tutorialCatalog = require('@goobster/core/config/tutorialCatalog');
const tutorials = require('@goobster/core/services/tutorialService');
const selfDocsService = require('@goobster/core/services/selfDocsService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const rooms = require('../apps/web/src/lib/rooms.cjs');
const featureStatus = require('../apps/web/src/lib/featureStatus.cjs');
const docsManifest = require('../apps/web/docs/manifest.json');
const generator = require('../scripts/generate-features-doc');

const { FEATURE_IDS, FEATURES } = catalog;
const REPO_ROOT = path.join(__dirname, '..');
const ACCOUNT = '710000000000000021';
const STATE_FILE = '/virtual/data/features.json';

function memoryFs(files) {
    return {
        existsSync: (p) => files.has(p),
        readFileSync: (p) => files.get(p),
        writeFileSync() {},
        renameSync() {},
        mkdirSync() {},
        unlinkSync() {}
    };
}

/** Every manageable feature installed and active except `off`, which is installed but switched off. */
function useState({ off = [] } = {}) {
    const entries = {};
    for (const id of FEATURE_IDS.filter((feature) => feature !== 'core')) {
        entries[id] = { installed: true, active: !off.includes(id) };
    }
    const files = new Map([[STATE_FILE, JSON.stringify({
        version: 1, revision: 1, updatedAt: '2026-10-06 21:14:02', origin: 'operator', features: entries
    })]]);
    features._resetForTests({ fs: memoryFs(files), filePath: STATE_FILE, env: {}, config: {} });
}

function useNoStateFile() {
    features._resetForTests({ fs: memoryFs(new Map()), filePath: STATE_FILE, env: {}, config: {} });
}

/** What /api/app/features reports, built from the live resolver the way the route does. */
function reportedStatus() {
    const out = {};
    for (const id of FEATURE_IDS) {
        const state = features.availability(id);
        out[id] = {
            installed: true,
            configured: true,
            active: state.active,
            pending: false,
            requested: state.active,
            pendingActive: state.active,
            reasons: state.reasons.map((reason) => ({ code: reason.code, ...(reason.dependency ? { dependency: reason.dependency } : {}) })),
            warnings: []
        };
    }
    return { source: 'file', revision: 1, origin: 'operator', error: null, features: out };
}

function viewer(overrides = {}) {
    return {
        id: ACCOUNT,
        identity: { operator: false },
        discord: { enabled: true },
        features: { projects: true, observatory: true, spitball: true },
        featureStatus: null,
        ...overrides
    };
}

function viewerWithStatus(off = [], overrides = {}) {
    useState({ off });
    return viewer({ featureStatus: reportedStatus(), ...overrides });
}

function caps(overrides = {}) {
    return {
        isOperator: false,
        discordEnabled: true,
        ...overrides,
        features: { projects: true, observatory: true, spitball: true, ...(overrides.features || {}) }
    };
}

afterAll(async () => {
    features._resetForTests();
    await db.closeConnection();
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('catalog parity: rooms, views and tutorials against the inventory', () => {
    const nonCore = (ids) => [...new Set(ids)].filter((id) => id !== 'core').sort();

    test('every room declares exactly the features the inventory says it needs', () => {
        for (const room of rooms.ROOMS) {
            const claim = inventory.ownerOf('room', room.id);
            expect({ room: room.id, features: nonCore(rooms.requiredFeatures(room.requires)) })
                .toEqual({ room: room.id, features: nonCore([claim.owner, ...claim.alsoRequires]) });
        }
    });

    test('every declared feature id is a catalog feature', () => {
        const declared = [];
        for (const room of rooms.ROOMS) {
            declared.push(...rooms.requiredFeatures(room.requires));
            for (const view of room.views || []) declared.push(...rooms.requiredFeatures(view.requires));
        }
        for (const tutorial of tutorialCatalog.TUTORIALS) declared.push(...tutorialCatalog.requiredFeatureIds(tutorial.requires));
        for (const step of tutorialCatalog.TUTORIALS.flatMap((tutorial) => tutorial.steps || [])) {
            declared.push(...tutorialCatalog.requiredFeatureIds(step.requires));
        }
        expect(declared.length).toBeGreaterThan(0);
        for (const id of declared) expect(FEATURE_IDS).toContain(id);
    });

    test('a nested view is gated by its room owner or a feature that depends on it', () => {
        const dependsOnOwner = (id, owner) => {
            const seen = new Set();
            const walk = (current) => {
                if (current === owner) return true;
                if (seen.has(current)) return false;
                seen.add(current);
                return (FEATURES[current]?.dependsOn || []).some(walk);
            };
            return walk(id);
        };
        let checked = 0;
        for (const room of rooms.ROOMS) {
            const { owner } = inventory.ownerOf('room', room.id);
            for (const view of room.views || []) {
                for (const id of rooms.requiredFeatures(view.requires)) {
                    checked++;
                    expect({ room: room.id, view: view.id, ok: dependsOnOwner(id, owner) })
                        .toEqual({ room: room.id, view: view.id, ok: true });
                }
            }
        }
        expect(checked).toBeGreaterThan(0);
    });

    test('every tutorial declares the owner and alsoRequires features the inventory lists', () => {
        for (const tutorial of tutorialCatalog.TUTORIALS) {
            const claim = inventory.ownerOf('tutorial', tutorial.id);
            expect({ tutorial: tutorial.id, features: nonCore(tutorialCatalog.requiredFeatureIds(tutorial.requires)) })
                .toEqual({ tutorial: tutorial.id, features: nonCore([claim.owner, ...claim.alsoRequires]) });
        }
    });

    test('the corrected tour requirements are in place', () => {
        const byId = tutorialCatalog.TUTORIAL_BY_ID;
        expect(tutorialCatalog.requiredFeatureIds(byId['knowledge.research'].requires)).toEqual(['expeditions']);
        expect(tutorialCatalog.requiredFeatureIds(byId['projects.runs'].requires).sort()).toEqual(['observatory', 'projects']);
        expect(tutorialCatalog.requiredFeatureIds(byId['trading.basics'].requires).sort()).toEqual(['discord', 'exchange']);
    });

    test('the portal feature table copies the catalog titles, doc pages and doc slugs', () => {
        const slugs = new Set(docsManifest.flatMap((section) => section.pages.map((page) => page[0])));
        const manifestPath = new Map(docsManifest.flatMap((section) => section.pages.map((page) => [page[0], page[2]])));
        expect(Object.keys(featureStatus.FEATURE_META).sort()).toEqual([...FEATURE_IDS].sort());
        for (const id of FEATURE_IDS) {
            const meta = featureStatus.FEATURE_META[id];
            expect({ id, title: meta.title }).toEqual({ id, title: FEATURES[id].title });
            expect({ id, listed: FEATURES[id].docs.includes(meta.docPath) }).toEqual({ id, listed: true });
            if (meta.docSlug) {
                expect({ id, slug: slugs.has(meta.docSlug) }).toEqual({ id, slug: true });
                expect(manifestPath.get(meta.docSlug)).toBeTruthy();
            }
        }
        for (const id of Object.keys(featureStatus.LEGACY_FLAGS)) expect(FEATURE_IDS).toContain(id);
    });
});

describe('rooms.cjs availability helpers', () => {
    test('no status fetched: the legacy me.features switches decide, as before', () => {
        const on = viewer();
        expect(rooms.isRoomAvailable(rooms.ROOM_BY_ID.projects, on)).toBe(true);
        expect(rooms.isRoomAvailable(rooms.ROOM_BY_ID.trading, on)).toBe(true);
        expect(rooms.availableViews(rooms.ROOM_BY_ID.knowledge, on).map((view) => view.id)).toContain('research');

        const off = viewer({ features: { projects: false, observatory: false, spitball: false }, discord: { enabled: false } });
        expect(rooms.isRoomAvailable(rooms.ROOM_BY_ID.projects, off)).toBe(false);
        expect(rooms.isRoomAvailable(rooms.ROOM_BY_ID.trading, off)).toBe(false);
        expect(rooms.availableViews(rooms.ROOM_BY_ID.knowledge, off).map((view) => view.id)).not.toContain('research');
        expect(rooms.unavailableReason(rooms.ROOM_BY_ID.trading, off)).toMatch(/not connected to Discord/);
    });

    test('a reported status that agrees with the legacy switches changes nothing', () => {
        useNoStateFile();
        const legacyFlags = { projects: features.isActive('projects'), observatory: features.isActive('observatory'), spitball: features.isActive('expeditions') };
        const plain = viewer({ features: legacyFlags, discord: { enabled: features.isActive('discord') } });
        const withStatus = { ...plain, featureStatus: reportedStatus() };
        for (const room of rooms.ROOMS) {
            expect({ room: room.id, available: rooms.isRoomAvailable(room, withStatus) })
                .toEqual({ room: room.id, available: rooms.isRoomAvailable(room, plain) });
            expect({ room: room.id, views: rooms.availableViews(room, withStatus).map((view) => view.id) })
                .toEqual({ room: room.id, views: rooms.availableViews(room, plain).map((view) => view.id) });
        }
    });

    test('a host-disabled feature removes its room and nested view from navigation', () => {
        const me = viewerWithStatus(['projects']);
        expect(rooms.isRoomAvailable(rooms.ROOM_BY_ID.projects, me)).toBe(false);
        expect(rooms.isRoomAvailable(rooms.ROOM_BY_ID.knowledge, me)).toBe(true);

        const noResearch = viewerWithStatus(['expeditions']);
        expect(rooms.isRoomAvailable(rooms.ROOM_BY_ID.knowledge, noResearch)).toBe(true);
        expect(rooms.availableViews(rooms.ROOM_BY_ID.knowledge, noResearch).map((view) => view.id)).not.toContain('research');
        expect(rooms.availableViews(rooms.ROOM_BY_ID.knowledge, noResearch).map((view) => view.id)).toContain('notes');
    });

    test('the reported status wins over a legacy flag that still says on, and a legacy off vetoes it', () => {
        const reportedOff = { ...viewerWithStatus(['music']), features: { projects: true, observatory: true, spitball: true } };
        expect(rooms.isRoomAvailable(rooms.ROOM_BY_ID.music, reportedOff)).toBe(false);

        useState();
        const legacyVeto = viewer({ featureStatus: reportedStatus(), features: { projects: false, observatory: true, spitball: true } });
        expect(rooms.isRoomAvailable(rooms.ROOM_BY_ID.projects, legacyVeto)).toBe(false);
    });

    test('the unavailable reason names the dependency by title', () => {
        const me = viewerWithStatus(['projects']);
        useState({ off: ['projects'] });
        const reason = rooms.roomUnavailability(rooms.ROOM_BY_ID.projects, me);
        expect(reason).toMatchObject({ kind: 'feature', feature: 'projects', title: 'Projects' });

        const dependent = viewerWithStatus(['economy']);
        const exchange = rooms.roomUnavailability(rooms.ROOM_BY_ID.trading, dependent);
        expect(exchange).toMatchObject({ kind: 'feature', feature: 'exchange', reasons: [{ code: 'DEPENDENCY_INACTIVE', dependency: 'economy' }] });
        expect(exchange.sentence).toContain('Economy');
        expect(exchange.docSlug).toBe('trading');
    });

    test('a deep link to an unavailable room or view resolves to a described state, never null', () => {
        const me = viewerWithStatus(['projects']);
        const room = rooms.routeUnavailability('/projects', me);
        expect(room).toMatchObject({ level: 'room', feature: 'projects', title: 'Projects' });
        expect(room.room.id).toBe('projects');
        expect(room.sentence).toMatch(/Projects/);
        expect(rooms.routeUnavailability('/projects/abc/runs', me)).toMatchObject({ level: 'room', feature: 'projects' });

        const research = viewerWithStatus(['expeditions']);
        expect(rooms.routeUnavailability('/knowledge/research', research)).toMatchObject({ level: 'view', feature: 'expeditions' });
        expect(rooms.routeUnavailability('/knowledge/notes', research)).toBeNull();
        expect(rooms.routeUnavailability('/knowledge', research)).toBeNull();
    });

    test('an anonymous viewer and an operator-only room are never described as feature-unavailable', () => {
        expect(rooms.routeUnavailability('/projects', null)).toBeNull();
        const me = viewerWithStatus([]);
        expect(rooms.routeUnavailability('/host', me)).toBeNull();
        expect(rooms.routeUnavailability('/chat', me)).toBeNull();
    });

    test('Tools cards: unavailable is distinct from user-hidden', () => {
        const me = viewerWithStatus(['music']);
        const cards = rooms.toolCards([], me);
        const music = cards.find((card) => card.room.id === 'music');
        expect(music).toMatchObject({ available: false, unavailable: { kind: 'feature', feature: 'music' } });
        expect(music.unavailable.sentence).toMatch(/Music/);
        expect(cards.filter((card) => card.room.id !== 'music').every((card) => card.available || card.room.requires)).toBe(true);

        const hidden = rooms.toolCards(['music'], me);
        expect(hidden.find((card) => card.room.id === 'music')).toBeUndefined();

        const availableMe = viewerWithStatus([]);
        const hiddenAvailable = rooms.catalogTools(['music']);
        expect(hiddenAvailable.find((room) => room.id === 'music')).toBeUndefined();
        expect(rooms.toolCards([], availableMe).find((card) => card.room.id === 'music')).toMatchObject({ available: true, unavailable: null });
    });
});

describe('guided tours and the feature state', () => {
    const projectsRuns = tutorialCatalog.TUTORIAL_BY_ID['projects.runs'];

    async function event(tutorialId, action, fields = {}) {
        const version = tutorialCatalog.TUTORIAL_BY_ID[tutorialId].version;
        const progress = await tutorials.loadProgress(ACCOUNT, tutorialId, version);
        return tutorials.applyEvent({
            accountId: ACCOUNT,
            tutorialId,
            eventId: `e_${action}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            generation: progress.generation,
            expectedRevision: progress.revision,
            stepId: fields.stepId ?? null,
            action,
            caps: fields.caps || caps()
        });
    }

    beforeEach(async () => {
        await db.run('DELETE FROM tutorial_progress');
        await db.run('DELETE FROM tutorial_events');
    });

    afterAll(() => features._resetForTests());

    test('with no features.json the reported value equals the legacy flags and nothing is refused', async () => {
        useNoStateFile();
        for (const id of FEATURE_IDS) expect({ id, off: features.enforcedOff(id) }).toEqual({ id, off: false });

        const listed = await tutorials.listForAccount({ accountId: ACCOUNT, caps: caps({ isOperator: true }) });
        for (const entry of listed.catalog) {
            const definition = tutorialCatalog.TUTORIAL_BY_ID[entry.id];
            const reportedOn = tutorialCatalog.requiredFeatureIds(definition.requires).every((id) => features.isActive(id));
            expect({ id: entry.id, available: entry.available }).toEqual({ id: entry.id, available: reportedOn });
            expect(entry.unavailable === null).toBe(entry.available);
        }
    });

    test('a tour whose feature is switched off is listed unavailable, with the reason and dependency', async () => {
        useState({ off: ['projects'] });
        const listed = await tutorials.listForAccount({ accountId: ACCOUNT, caps: caps() });
        const basics = listed.catalog.find((entry) => entry.id === 'projects.basics');
        expect(basics).toMatchObject({ available: false, launchable: false, unavailable: { feature: 'projects', reasons: [{ code: 'DISABLED' }] } });
        const runs = listed.catalog.find((entry) => entry.id === 'projects.runs');
        expect(runs.available).toBe(false);
        expect(runs.unavailable.reasons.map((reason) => reason.code)).toEqual(['DISABLED']);

        const open = listed.catalog.find((entry) => entry.id === 'chat.basics');
        expect(open).toMatchObject({ available: true, unavailable: null });
    });

    test('a tour behind a dependency reports the dependency', async () => {
        useState({ off: ['sandbox'] });
        const listed = await tutorials.listForAccount({ accountId: ACCOUNT, caps: caps() });
        const runs = listed.catalog.find((entry) => entry.id === 'projects.runs');
        expect(runs).toMatchObject({ available: false, unavailable: { feature: 'observatory', reasons: [{ code: 'DEPENDENCY_INACTIVE', dependency: 'sandbox' }] } });
    });

    test('start, advance, complete, reset and demo actions are refused with FEATURE_UNAVAILABLE and never complete the tour', async () => {
        useState({ off: ['observatory'] });
        const refused = { code: 'FEATURE_UNAVAILABLE', status: 404, details: { feature: 'observatory' } };
        await expect(event('projects.runs', 'start')).rejects.toMatchObject(refused);
        for (const action of ['complete_step', 'skip_step', 'skip_tutorial', 'pause', 'back']) {
            await expect(event('projects.runs', action, { stepId: projectsRuns.steps[0].id })).rejects.toMatchObject(refused);
        }
        await expect(tutorials.resetOne({ accountId: ACCOUNT, tutorialId: 'projects.runs' })).rejects.toMatchObject(refused);

        const progress = await tutorials.loadProgress(ACCOUNT, 'projects.runs', projectsRuns.version);
        expect(progress.status).toBe('not_started');
        expect(progress.revision).toBe(0);
    });

    test('saved progress survives a feature going away and comes back when it returns', async () => {
        useState();
        const started = await event('projects.runs', 'start');
        const firstStep = projectsRuns.steps[0].id;
        const advanced = await event('projects.runs', 'complete_step', { stepId: firstStep });
        expect(started.status).toBe('in_progress');
        expect(advanced.completedStepIds).toContain(firstStep);

        useState({ off: ['observatory'] });
        await expect(event('projects.runs', 'complete_step', { stepId: projectsRuns.steps[1].id })).rejects.toMatchObject({ code: 'FEATURE_UNAVAILABLE' });
        await expect(tutorials.resetOne({ accountId: ACCOUNT, tutorialId: 'projects.runs' })).rejects.toMatchObject({ code: 'FEATURE_UNAVAILABLE' });
        const kept = await tutorials.loadProgress(ACCOUNT, 'projects.runs', projectsRuns.version);
        expect(kept.status).toBe('in_progress');
        expect(kept.completedStepIds).toEqual([firstStep]);
        expect(kept.revision).toBe(advanced.revision);

        const listed = await tutorials.listForAccount({ accountId: ACCOUNT, caps: caps() });
        const entry = listed.catalog.find((tutorial) => tutorial.id === 'projects.runs');
        expect(entry.available).toBe(false);
        expect(listed.progress.find((row) => row.tutorialId === 'projects.runs')).toMatchObject({ status: 'in_progress', completedStepIds: [firstStep] });

        useState();
        const back = await tutorials.listForAccount({ accountId: ACCOUNT, caps: caps() });
        expect(back.catalog.find((tutorial) => tutorial.id === 'projects.runs')).toMatchObject({ available: true, launchable: true, unavailable: null });
        const resumed = await event('projects.runs', 'complete_step', { stepId: projectsRuns.steps[1].id });
        expect(resumed.completedStepIds).toEqual([firstStep, projectsRuns.steps[1].id]);
    });

    test('reset all leaves an unavailable tour alone', async () => {
        useState();
        await event('projects.runs', 'start');
        await event('chat.basics', 'start').catch(() => null);
        useState({ off: ['observatory'] });
        await tutorials.resetAll({ accountId: ACCOUNT });
        const kept = await tutorials.loadProgress(ACCOUNT, 'projects.runs', projectsRuns.version);
        expect(kept.status).toBe('in_progress');
    });

    test('the legacy capability snapshot still vetoes a tour when no features.json exists', async () => {
        useNoStateFile();
        await expect(event('projects.basics', 'start', { caps: caps({ features: { projects: false } }) }))
            .rejects.toMatchObject({ code: 'FEATURE_UNAVAILABLE', details: { feature: 'projects' } });
    });
});

describe('self-docs carry the feature and say when it is unavailable', () => {
    const FILLER = 'Further detail follows in this section for completeness. '.repeat(20);
    const SANDBOX_DOC = `---\ntitle: Sandbox notes\nfeature: sandbox\nsummary: How the sandbox works.\n---\n\n# Sandbox notes\n\nThe sandbox runs short snippets in isolation.\n\n${FILLER}\n`;
    const PLAIN_DOC = `---\ntitle: Telescope Guide\nsummary: How to point the telescope.\n---\n\n# Telescope\n\nPoint the telescope at the sky.\n\n${FILLER}\n`;
    const UNKNOWN_DOC = `---\ntitle: Mystery\nfeature: not-a-feature\n---\n\n# Mystery\n\nThis mentions the sandbox too.\n`;

    beforeEach(async () => {
        fs.rmSync(DOCS_DIR, { recursive: true, force: true });
        fs.mkdirSync(DOCS_DIR, { recursive: true });
        fs.writeFileSync(path.join(DOCS_DIR, 'sandbox_notes.md'), SANDBOX_DOC);
        fs.writeFileSync(path.join(DOCS_DIR, 'telescope_guide.md'), PLAIN_DOC);
        await db.run('DELETE FROM self_docs');
        selfDocsService.invalidateCache();
        selfDocsService._seededOnce = false;
    });

    afterAll(() => features._resetForTests());

    test('front matter feature is parsed, and an unknown id is dropped with a warning', () => {
        const doc = selfDocsService.parseDoc(SANDBOX_DOC, { relPath: 'documentation/sandbox_notes.md' });
        expect(doc.feature).toBe('sandbox');
        expect(doc.warnings).toEqual([]);

        const plain = selfDocsService.parseDoc(PLAIN_DOC, { relPath: 'documentation/telescope_guide.md' });
        expect(plain.feature).toBeFalsy();

        const unknown = selfDocsService.parseDoc(UNKNOWN_DOC, { relPath: 'documentation/mystery.md' });
        expect(unknown.feature).toBeFalsy();
        expect(unknown.warnings.join(' ')).toMatch(/feature/);
    });

    test('the seed stores the tag, stays idempotent, and never stores availability', async () => {
        useState({ off: ['sandbox'] });
        const first = await selfDocsService.seed();
        expect(first.inserted).toBeGreaterThan(0);
        const second = await selfDocsService.seed();
        expect(second).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
        expect(second.unchanged).toBe(second.chunks);

        const rows = await db.all('SELECT slug, tags, content FROM self_docs');
        const sandbox = rows.filter((row) => row.slug.endsWith('sandbox_notes'));
        expect(sandbox.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.content).not.toMatch(/Not available on this installation/);
            expect(row.tags).not.toMatch(/Not available/);
        }
        expect(sandbox[0].tags).toContain(selfDocsService.featureTag('sandbox'));

        useState();
        const third = await selfDocsService.seed();
        expect(third).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
    });

    test('search, read and list annotate an inactive feature at query time, and never hide the doc', async () => {
        useState();
        await selfDocsService.seed();
        const active = await toolsRegistry.execute('consultDocs', { action: 'search', query: 'sandbox snippets isolation' });
        expect(String(active)).toContain('sandbox_notes');
        expect(String(active)).not.toMatch(/Not available on this installation/);

        useState({ off: ['sandbox'] });
        const search = String(await toolsRegistry.execute('consultDocs', { action: 'search', query: 'sandbox snippets isolation' }));
        expect(search).toContain('sandbox_notes');
        expect(search).toMatch(/Not available on this installation: Sandbox is turned off/);

        const read = String(await toolsRegistry.execute('consultDocs', { action: 'read', slug: 'sandbox_notes' }));
        expect(read).toMatch(/Not available on this installation: Sandbox/);
        expect(read).toContain('The sandbox runs short snippets');

        const list = String(await toolsRegistry.execute('consultDocs', { action: 'list' }));
        const lines = list.split('\n');
        const index = lines.findIndex((line) => line.includes('sandbox_notes') || line.includes('Sandbox notes'));
        expect(index).toBeGreaterThanOrEqual(0);
        expect(lines.slice(index, index + 3).join('\n')).toMatch(/Not available on this installation/);
        const telescope = lines.findIndex((line) => line.includes('Telescope'));
        expect(lines.slice(telescope, telescope + 2).join('\n')).not.toMatch(/Not available/);

        useState();
        const again = String(await toolsRegistry.execute('consultDocs', { action: 'read', slug: 'sandbox_notes' }));
        expect(again).not.toMatch(/Not available on this installation/);
    });

    test('the annotation is one short line and names a dependency reason', () => {
        useState({ off: ['projects'] });
        const note = selfDocsService.describeAvailability('observatory');
        expect(note).toMatchObject({ feature: 'observatory', title: 'Observatory' });
        expect(note.note.split('\n')).toHaveLength(1);
        expect(note.note.length).toBeLessThan(220);
        expect(note.reason).toMatch(/Projects/);
        expect(selfDocsService.describeAvailability('core')).toBeNull();
        expect(selfDocsService.describeAvailability(null)).toBeNull();
        useState();
        expect(selfDocsService.describeAvailability('observatory')).toBeNull();
    });

    test('keyword search works with no embeddings or keys', async () => {
        useState();
        await selfDocsService.seed();
        const result = await selfDocsService.search({ query: 'telescope sky' });
        expect(result.mode).toBe('keyword');
        expect(result.results[0].relPath).toContain('telescope_guide');
    });
});

describe('documentation front matter and documentation/features.md', () => {
    // These three describe a wider subject than one feature (the installable
    // app, the runtime split, accounts), so a single availability line would
    // mislead on most of the page.
    const UNTAGGED = new Set([
        'documentation/independent_runtime.md',
        'documentation/pwa.md',
        'documentation/identity.md'
    ]);

    function frontMatterFeature(file) {
        const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
        const match = text.match(/^---\n([\s\S]*?)\n---/);
        if (!match) return null;
        const line = match[1].split('\n').find((entry) => /^feature:/.test(entry));
        return line ? line.replace(/^feature:\s*/, '').trim() : null;
    }

    test('docs listed by a feature carry that feature (or one of the features listing them)', () => {
        const listedBy = new Map();
        for (const id of FEATURE_IDS) {
            for (const doc of FEATURES[id].docs) listedBy.set(doc, [...(listedBy.get(doc) || []), id]);
        }
        for (const [doc, ids] of listedBy) {
            const tag = frontMatterFeature(doc);
            if (ids.every((id) => id === 'core')) {
                expect({ doc, tag }).toEqual({ doc, tag: null });
            } else if (UNTAGGED.has(doc)) {
                expect({ doc, tag }).toEqual({ doc, tag: null });
            } else {
                expect({ doc, tagged: ids.includes(tag) }).toEqual({ doc, tagged: true });
            }
        }
    });

    test('every feature tag in the corpus is a catalog id (extra docs about a feature may carry it too)', () => {
        const docsDir = path.join(REPO_ROOT, 'documentation');
        const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
            entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
        ));
        let tagged = 0;
        for (const abs of walk(docsDir).filter((file) => file.endsWith('.md'))) {
            const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
            const tag = frontMatterFeature(rel);
            if (!tag) continue;
            expect({ rel, known: FEATURE_IDS.includes(tag) }).toEqual({ rel, known: true });
            tagged++;
        }
        expect(tagged).toBeGreaterThanOrEqual(18);
    });

    test('documentation/features.md is current and says availability is per installation', () => {
        const onDisk = fs.readFileSync(path.join(REPO_ROOT, 'documentation/features.md'), 'utf8');
        expect(onDisk).toBe(generator.render());
        expect(onDisk).toMatch(/per installation/i);
        for (const id of FEATURE_IDS) expect(onDisk).toContain(FEATURES[id].title);
    });

    test('the --check mode passes when current', () => {
        const writes = [];
        const originalWrite = process.stdout.write;
        process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
        let code;
        try { code = generator.main(['--check']); } finally { process.stdout.write = originalWrite; }
        expect(code).toBe(0);
    });
});
