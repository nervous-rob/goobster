/**
 * Guided-tutorial framework (F1) + authored E2/E4 demonstration tours (F2).
 *
 * State machine, catalog allow-list, reset/generation concurrency, privacy
 * erasure, Weekend field notebook samples, and Keep this example. Authored
 * steps for other catalog entries remain empty; F1-style tests inject a
 * temporary catalog with steps to exercise skip vs complete and unavailable
 * steps without depending on production demo copy.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB = path.join(os.tmpdir(), `goobster-tutorials-f2-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const catalog = require('@goobster/core/config/tutorialCatalog');
const samples = require('@goobster/core/config/tutorialSamples');
const tutorials = require('@goobster/core/services/tutorialService');
const privacy = require('@goobster/core/services/privacyService');
const userSettings = require('@goobster/core/services/userSettingsService');
const rooms = require('../apps/web/src/lib/rooms.cjs');

const ACCOUNT = '700000000000000010';
const OTHER = '700000000000000011';

const TEST_STEPS_CATALOG = {
    ...catalog,
    TUTORIALS: catalog.TUTORIALS.map((t) => {
        if (t.id === 'home.orientation') {
            return {
                ...t,
                // Keep production version; only swap steps for the state-machine suite.
                steps: [
                    { id: 'greet', anchorId: 'home-doors' },
                    { id: 'open-chat', anchorId: 'home-chat' },
                    { id: 'needs-obs', requires: { feature: 'observatory' }, anchorId: 'home-obs' }
                ]
            };
        }
        if (t.id === 'chat.basics') {
            return {
                ...t,
                steps: [
                    { id: 'composer', anchorId: 'chat-composer' },
                    { id: 'save-note', anchorId: 'chat-save-note' }
                ]
            };
        }
        return t;
    }),
    TUTORIAL_BY_ID: null
};
TEST_STEPS_CATALOG.TUTORIAL_BY_ID = Object.fromEntries(
    TEST_STEPS_CATALOG.TUTORIALS.map((t) => [t.id, t])
);

function versionOf(tutorialId) {
    return TEST_STEPS_CATALOG.TUTORIAL_BY_ID[tutorialId].version;
}

function caps(overrides = {}) {
    return {
        isOperator: false,
        discordEnabled: false,
        ...overrides,
        features: {
            projects: true,
            observatory: false,
            spitball: true,
            ...(overrides.features || {})
        }
    };
}

async function event(tutorialId, action, fields = {}) {
    const progress = await tutorials.loadProgress(ACCOUNT, tutorialId, versionOf(tutorialId));
    return tutorials.applyEvent({
        accountId: ACCOUNT,
        tutorialId,
        eventId: fields.eventId || `e_${action}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        generation: fields.generation ?? progress.generation,
        expectedRevision: fields.expectedRevision ?? progress.revision,
        stepId: fields.stepId ?? null,
        action,
        caps: fields.caps || caps()
    });
}

beforeEach(async () => {
    tutorials._setCatalogForTests(TEST_STEPS_CATALOG);
    await db.run('DELETE FROM tutorial_progress');
    await db.run('DELETE FROM tutorial_events');
    await db.run('DELETE FROM tutorial_preferences');
    await db.run('DELETE FROM tutorial_feedback');
    await db.run('DELETE FROM user_settings');
    await db.run('DELETE FROM user_setting_revisions');
    await db.run('DELETE FROM kg_nodes');
    await db.run('DELETE FROM knowledge_transfers');
});

afterAll(async () => {
    tutorials._setCatalogForTests(null);
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* */ }
    }
});

describe('catalog parity with the room registry', () => {
    test('lists the same 29 tutorial ids as rooms.cjs, each exactly once', () => {
        // Restore production catalog for this assertion.
        tutorials._setCatalogForTests(null);
        const fromRooms = rooms.ROOMS.flatMap((room) => room.tutorials);
        expect(catalog.TUTORIAL_IDS).toEqual(expect.arrayContaining(fromRooms));
        expect(catalog.TUTORIAL_IDS).toHaveLength(29);
        expect(new Set(catalog.TUTORIAL_IDS).size).toBe(29);
        expect(fromRooms).toHaveLength(29);
        expect(new Set(fromRooms).size).toBe(29);
        for (const id of fromRooms) {
            expect(catalog.TUTORIAL_BY_ID[id].roomId).toBe(
                rooms.ROOMS.find((r) => r.tutorials.includes(id)).id
            );
        }
        tutorials._setCatalogForTests(TEST_STEPS_CATALOG);
    });
});

describe('F2 authored demonstration tours', () => {
    test('home, chat, knowledge, and apps tours ship steps with demos and keepables', () => {
        tutorials._setCatalogForTests(null);
        const authored = ['home.orientation', 'chat.basics', 'knowledge.basics', 'projects.apps'];
        for (const id of authored) {
            const def = catalog.TUTORIAL_BY_ID[id];
            expect(def.version).toBe(2);
            expect(def.steps.length).toBeGreaterThan(0);
        }
        expect(catalog.TUTORIAL_BY_ID['home.orientation'].steps.some((s) => s.demo === 'chat-to-note')).toBe(true);
        expect(catalog.TUTORIAL_BY_ID['chat.basics'].steps.find((s) => s.id === 'save-as-note').keepablePieceId)
            .toBe('note-anemones');
        expect(catalog.TUTORIAL_BY_ID['knowledge.basics'].steps.find((s) => s.id === 'create-note').keepablePieceId)
            .toBe('note-anemones');
        expect(catalog.TUTORIAL_BY_ID['projects.apps'].steps.some((s) => s.demo === 'open-unfiled')).toBe(true);
        // Other catalog entries stay empty until a later package.
        expect(catalog.TUTORIAL_BY_ID['projects.basics'].steps).toEqual([]);
        expect(catalog.TUTORIAL_BY_ID['music.overview'].steps).toEqual([]);
        tutorials._setCatalogForTests(TEST_STEPS_CATALOG);
    });

    test('listForAccount attaches the Weekend field notebook sample', async () => {
        tutorials._setCatalogForTests(null);
        const listed = await tutorials.listForAccount({ accountId: ACCOUNT, caps: caps() });
        expect(listed.sample.id).toBe(samples.SAMPLE_SCENARIO_ID);
        expect(listed.sample.notes).toHaveLength(2);
        expect(listed.catalog.find((c) => c.id === 'chat.basics').steps.some((s) => s.demo)).toBe(true);
        expect(listed.catalog.find((c) => c.id === 'chat.basics').launchable).toBe(true);
        tutorials._setCatalogForTests(TEST_STEPS_CATALOG);
    });

    test('Keep this example copies a sample note once; unknown pieces are rejected', async () => {
        tutorials._setCatalogForTests(null);
        await expect(tutorials.keepExample({ accountId: ACCOUNT, pieceId: 'nope' }))
            .rejects.toMatchObject({ code: 'UNKNOWN_PIECE', status: 400 });

        const first = await tutorials.keepExample({ accountId: ACCOUNT, pieceId: 'note-anemones' });
        expect(first.kept).toBe(true);
        expect(first.alreadyHad).toBeUndefined();
        expect(first.note.label).toBe('Tide-pool anemones');

        const again = await tutorials.keepExample({ accountId: ACCOUNT, pieceId: 'note-anemones' });
        expect(again.alreadyHad).toBe(true);
        expect(again.note.label).toBe('Tide-pool anemones');

        const rows = await db.all(
            `SELECT label, content FROM kg_nodes WHERE scopeKey = @scope`,
            { scope: `USER:${ACCOUNT}` }
        );
        expect(rows.filter((r) => r.label === 'Tide-pool anemones')).toHaveLength(1);
        expect(rows[0].content).toMatch(/Weekend field notebook tutorial/);

        // Sample fixtures themselves are not retrieval rows.
        expect(rows.every((r) => r.label !== samples.SAMPLE.project.name)).toBe(true);
        tutorials._setCatalogForTests(TEST_STEPS_CATALOG);
    });

    test('tour events never create knowledge rows; only keepExample does', async () => {
        tutorials._setCatalogForTests(null);
        const home = catalog.TUTORIAL_BY_ID['home.orientation'];
        await tutorials.applyEvent({
            accountId: ACCOUNT,
            tutorialId: 'home.orientation',
            eventId: 'f2-start',
            generation: 1,
            expectedRevision: 0,
            action: 'start',
            caps: caps()
        });
        await tutorials.applyEvent({
            accountId: ACCOUNT,
            tutorialId: 'home.orientation',
            eventId: 'f2-skip-step',
            generation: 1,
            expectedRevision: 1,
            stepId: home.steps[0].id,
            action: 'skip_step',
            caps: caps()
        });
        const before = (await db.get(
            `SELECT COUNT(*) AS c FROM kg_nodes WHERE scopeKey = @scope`,
            { scope: `USER:${ACCOUNT}` }
        )).c;
        expect(before).toBe(0);
        tutorials._setCatalogForTests(TEST_STEPS_CATALOG);
    });
});

describe('state machine', () => {
    test('rejects an unknown tutorial id', async () => {
        await expect(tutorials.applyEvent({
            accountId: ACCOUNT,
            tutorialId: 'made.up',
            eventId: 'x1',
            generation: 1,
            expectedRevision: 0,
            action: 'start',
            caps: caps()
        })).rejects.toMatchObject({ code: 'UNKNOWN_TUTORIAL', status: 404 });
    });

    test('admin.instance cannot launch for an ordinary account', async () => {
        await expect(tutorials.applyEvent({
            accountId: ACCOUNT,
            tutorialId: 'admin.instance',
            eventId: 'x2',
            generation: 1,
            expectedRevision: 0,
            action: 'start',
            caps: caps({ isOperator: false })
        })).rejects.toMatchObject({ code: 'TUTORIAL_FORBIDDEN', status: 403 });

        const listed = await tutorials.listForAccount({ accountId: ACCOUNT, caps: caps() });
        expect(listed.catalog.find((c) => c.id === 'admin.instance')).toBeUndefined();
    });

    test('start records unavailable steps and does not mark them done', async () => {
        const started = await event('home.orientation', 'start');
        expect(started.status).toBe('in_progress');
        expect(started.currentStepId).toBe('greet');
        expect(started.unavailableStepIds).toContain('needs-obs');
        expect(started.completedStepIds).not.toContain('needs-obs');
        expect(started.skippedStepIds).not.toContain('needs-obs');
    });

    test('a tutorial with no applicable steps does not launch', async () => {
        // All steps require observatory which is off, and we strip the open ones.
        tutorials._setCatalogForTests({
            ...TEST_STEPS_CATALOG,
            TUTORIALS: TEST_STEPS_CATALOG.TUTORIALS.map((t) =>
                t.id === 'home.orientation'
                    ? { ...t, steps: [{ id: 'only-obs', requires: { feature: 'observatory' } }] }
                    : t
            ),
            TUTORIAL_BY_ID: Object.fromEntries(
                TEST_STEPS_CATALOG.TUTORIALS.map((t) => [
                    t.id,
                    t.id === 'home.orientation'
                        ? { ...t, steps: [{ id: 'only-obs', requires: { feature: 'observatory' } }] }
                        : t
                ])
            )
        });
        await expect(event('home.orientation', 'start')).rejects.toMatchObject({
            code: 'NO_APPLICABLE_STEPS'
        });
        tutorials._setCatalogForTests(TEST_STEPS_CATALOG);
    });

    test('skip_step is not complete_step; finish can include skips', async () => {
        await event('home.orientation', 'start');
        const skipped = await event('home.orientation', 'skip_step', { stepId: 'greet' });
        expect(skipped.skippedStepIds).toContain('greet');
        expect(skipped.completedStepIds).not.toContain('greet');
        expect(skipped.currentStepId).toBe('open-chat');

        const done = await event('home.orientation', 'complete_step', { stepId: 'open-chat' });
        expect(done.completedStepIds).toContain('open-chat');
        expect(done.skippedStepIds).toContain('greet');
        // needs-obs is unavailable, so the tour finishes with skips.
        expect(done.status).toBe('finished_with_skips');
        expect(done.unavailableStepIds).toContain('needs-obs');
        expect(done.completedStepIds).not.toContain('needs-obs');
    });

    test('skipping one tutorial leaves another not_started', async () => {
        await event('home.orientation', 'start');
        const skipped = await event('home.orientation', 'skip_tutorial');
        expect(skipped.status).toBe('skipped');

        const chat = await tutorials.loadProgress(ACCOUNT, 'chat.basics', versionOf('chat.basics'));
        expect(chat.status).toBe('not_started');
        expect(chat.revision).toBe(0);
    });

    test('retried events are idempotent and cannot advance twice', async () => {
        await event('home.orientation', 'start', { eventId: 'start-once' });
        const first = await event('home.orientation', 'complete_step', {
            eventId: 'complete-greet',
            stepId: 'greet'
        });
        expect(first.completedStepIds).toEqual(['greet']);
        expect(first.revision).toBe(2);

        const replay = await event('home.orientation', 'complete_step', {
            eventId: 'complete-greet',
            stepId: 'greet',
            // Stale expectedRevision would normally 409 — but same eventId short-circuits.
            expectedRevision: 0,
            generation: 1
        });
        expect(replay.revision).toBe(2);
        expect(replay.completedStepIds).toEqual(['greet']);
        expect(replay.currentStepId).toBe('open-chat');
    });

    test('a stale generation cannot restore a reset', async () => {
        const started = await event('home.orientation', 'start');
        expect(started.generation).toBe(1);
        const reset = await tutorials.resetOne({
            accountId: ACCOUNT,
            tutorialId: 'home.orientation',
            caps: caps()
        });
        expect(reset.generation).toBe(2);
        expect(reset.status).toBe('not_started');
        expect(reset.revision).toBe(0);

        await expect(tutorials.applyEvent({
            accountId: ACCOUNT,
            tutorialId: 'home.orientation',
            eventId: 'stale-complete',
            generation: 1,
            expectedRevision: started.revision,
            stepId: 'greet',
            action: 'complete_step',
            caps: caps()
        })).rejects.toMatchObject({ code: 'STALE_GENERATION', status: 409 });

        const after = await tutorials.loadProgress(ACCOUNT, 'home.orientation', versionOf('home.orientation'));
        expect(after.status).toBe('not_started');
        expect(after.completedStepIds).toEqual([]);
    });

    test('reset one and reset all clear progress without touching notes or tool visibility', async () => {
        await event('home.orientation', 'start');
        await event('chat.basics', 'start');
        await tutorials.patchPreferences(ACCOUNT, { autoStart: false });

        // Seed a note and a hidden tool so we can prove they survive.
        await db.run(
            `INSERT INTO kg_nodes (guildId, scopeKey, type, label, content, curation, source, createdAt, updatedAt)
             VALUES ('dm:700000000000000010', 'USER:700000000000000010', 'concept', 'Keep me', 'body', 'saved', 'user', datetime('now'), datetime('now'))`
        );
        await userSettings.updateSection({
            userId: ACCOUNT,
            section: 'appearance',
            changes: { hiddenToolRooms: ['music'] }
        });

        await tutorials.resetOne({ accountId: ACCOUNT, tutorialId: 'home.orientation', caps: caps() });
        const home = await tutorials.loadProgress(ACCOUNT, 'home.orientation', versionOf('home.orientation'));
        expect(home.status).toBe('not_started');
        expect(home.generation).toBe(2);
        const chatStill = await tutorials.loadProgress(ACCOUNT, 'chat.basics', versionOf('chat.basics'));
        expect(chatStill.status).toBe('in_progress');

        await tutorials.resetAll({ accountId: ACCOUNT, caps: caps() });
        const chat = await tutorials.loadProgress(ACCOUNT, 'chat.basics', versionOf('chat.basics'));
        expect(chat.status).toBe('not_started');
        expect(chat.generation).toBe(2);

        const prefs = await tutorials.getPreferences(ACCOUNT);
        expect(prefs.autoStart).toBe(false);

        const note = await db.get(
            `SELECT label FROM kg_nodes WHERE scopeKey = 'USER:700000000000000010' AND label = 'Keep me'`
        );
        expect(note.label).toBe('Keep me');

        const settings = await userSettings.getSettings({ userId: ACCOUNT });
        expect(settings.sections.appearance.values.hiddenToolRooms).toEqual(['music']);
    });

    test('PATCH preferences changes auto-start only', async () => {
        await event('home.orientation', 'start');
        await event('home.orientation', 'complete_step', { stepId: 'greet' });
        const before = await tutorials.loadProgress(ACCOUNT, 'home.orientation', versionOf('home.orientation'));
        await tutorials.patchPreferences(ACCOUNT, { autoStart: false });
        const after = await tutorials.loadProgress(ACCOUNT, 'home.orientation', versionOf('home.orientation'));
        expect(after.completedStepIds).toEqual(before.completedStepIds);
        expect(after.revision).toBe(before.revision);
        expect((await tutorials.getPreferences(ACCOUNT)).autoStart).toBe(false);
    });

    test('clients cannot invent step ids', async () => {
        await event('home.orientation', 'start');
        await expect(event('home.orientation', 'complete_step', { stepId: 'invented' }))
            .rejects.toMatchObject({ code: 'UNKNOWN_STEP', status: 400 });
    });
});

describe('privacy', () => {
    test('progress and feedback are on the erasure, audit and transparency paths', async () => {
        await event('home.orientation', 'start');
        await tutorials.patchPreferences(ACCOUNT, { autoStart: true });
        await db.run(
            `INSERT INTO tutorial_feedback (accountId, tutorialId, version, stepId, signal, createdAt)
             VALUES (@u, 'home.orientation', @v, 'greet', 'unclear', datetime('now'))`,
            { u: ACCOUNT, v: versionOf('home.orientation') }
        );
        // Another account's row must survive.
        await db.run(
            `INSERT INTO tutorial_progress (
                accountId, tutorialId, version, generation, revision, status,
                completedStepIdsJson, skippedStepIdsJson, unavailableStepIdsJson, updatedAt
             ) VALUES (@u, 'chat.basics', @v, 1, 1, 'paused', '[]', '[]', '[]', datetime('now'))`,
            { u: OTHER, v: versionOf('chat.basics') }
        );

        const summary = await tutorials.summarizeForUser(ACCOUNT);
        expect(summary.progressRows).toBeGreaterThan(0);
        expect(summary.feedbackRows).toBe(1);

        const report = await privacy.buildUserReport({ guildId: `dm:${ACCOUNT}`, userId: ACCOUNT });
        expect(report.tutorials.feedbackRows).toBe(1);
        expect(report.tutorials.progressRows).toBeGreaterThan(0);

        const audit = await privacy.auditUser({ userId: ACCOUNT });
        expect(audit.byTable.tutorial_progress).toBeGreaterThan(0);
        expect(audit.byTable.tutorial_feedback).toBe(1);

        const result = await privacy.forgetUser({ userId: ACCOUNT });
        expect(result.tutorialProgress).toBeGreaterThan(0);
        expect(result.tutorialFeedback).toBe(1);
        expect((await db.get(
            'SELECT COUNT(*) AS c FROM tutorial_progress WHERE accountId = @u', { u: ACCOUNT }
        )).c).toBe(0);
        expect((await db.get(
            'SELECT COUNT(*) AS c FROM tutorial_progress WHERE accountId = @u', { u: OTHER }
        )).c).toBe(1);
    });
});

describe('side-effect boundary', () => {
    test('tour events stay off AI, transfers and inbox writers; Keep is an explicit path', () => {
        const src = fs.readFileSync(
            require.resolve('@goobster/core/services/tutorialService'),
            'utf8'
        );
        expect(src).not.toMatch(/aiService|knowledgeTransferService|inboxService|observatoryService/);
        expect(src).toMatch(/tutorial_progress/);
        // keepExample is the only knowledge write — it is not reachable from applyEvent.
        expect(src).toMatch(/async function keepExample/);
        expect(src).toMatch(/knowledgeGraphService/);
        const applyIdx = src.indexOf('async function applyEvent');
        const keepIdx = src.indexOf('async function keepExample');
        const applyBlock = src.slice(applyIdx, keepIdx);
        expect(applyBlock).not.toMatch(/knowledgeGraphService|createUserNote|keepExample/);
    });
});


describe('concurrent tutorial writes (both database engines)', () => {
    test('simultaneous first events have one winner, while identical retries share a receipt', async () => {
        const args = { accountId: ACCOUNT, tutorialId: 'home.orientation', generation: 1, expectedRevision: 0, action: 'start', caps: caps() };
        const writes = await Promise.allSettled([
            tutorials.applyEvent({ ...args, eventId: 'first-a' }),
            tutorials.applyEvent({ ...args, eventId: 'first-b' })
        ]);
        expect(writes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(writes.find(r => r.status === 'rejected').reason.code).toBe('STALE_REVISION');
        const retries = await Promise.all([
            tutorials.applyEvent({ ...args, accountId: OTHER, eventId: 'same' }),
            tutorials.applyEvent({ ...args, accountId: OTHER, eventId: 'same' })
        ]);
        expect(retries[0]).toEqual(retries[1]);
        expect(retries[0].revision).toBe(1);
    });

    test('a reset waits for an in-flight advance and its generation cannot be resurrected', async () => {
        await event('home.orientation', 'start');
        let reached;
        let release;
        const waiting = new Promise(resolve => { reached = resolve; });
        const resume = new Promise(resolve => { release = resolve; });
        let held = false;
        // Hold the event after its read, before its write. A competing reset
        // must wait for the same lock, rather than commit and get overwritten.
        const txOriginal = db.transaction.bind(db);
        const txSpy = jest.spyOn(db, 'transaction').mockImplementation(fn => txOriginal(tx => fn({
            ...tx,
            get: async (sql, params) => {
                const result = await tx.get(sql, params);
                if (!held && sql.includes('SELECT * FROM tutorial_progress')) {
                    held = true;
                    reached();
                    await resume;
                }
                return result;
            }
        })));
        try {
            const advance = event('home.orientation', 'complete_step', { stepId: 'greet' });
            await waiting;
            let resetFinished = false;
            const reset = tutorials.resetOne({ accountId: ACCOUNT, tutorialId: 'home.orientation', caps: caps() })
                .then(result => { resetFinished = true; return result; });
            await new Promise(resolve => setTimeout(resolve, 75));
            expect(resetFinished).toBe(false);
            release();
            await advance;
            expect((await reset).generation).toBe(2);
            const final = await tutorials.loadProgress(ACCOUNT, 'home.orientation', versionOf('home.orientation'));
            expect(final).toMatchObject({ generation: 2, revision: 0, status: 'not_started', completedStepIds: [] });
            await expect(event('home.orientation', 'complete_step', { stepId: 'greet', generation: 1, expectedRevision: 1 }))
                .rejects.toMatchObject({ code: 'STALE_GENERATION' });
        } finally { release(); txSpy.mockRestore(); }
    });

    test('concurrent reset-one and reset-all each increment the generation', async () => {
        await Promise.all([
            tutorials.resetOne({ accountId: ACCOUNT, tutorialId: 'home.orientation', caps: caps() }),
            tutorials.resetAll({ accountId: ACCOUNT, caps: caps() })
        ]);
        expect((await tutorials.loadProgress(ACCOUNT, 'home.orientation', versionOf('home.orientation'))).generation).toBe(3);
    });
});


describe('first-use task (#266)', () => {
    test('ordered actions, pause/resume, acceptance and reset stay account scoped', async () => {
        const id = 'home.first-task';
        const beforeNotes = await db.get('SELECT COUNT(*) AS n FROM kg_nodes');
        const started = await event(id, 'start');
        expect(started.currentStepId).toBe('question');
        await expect(event(id, 'finish')).rejects.toMatchObject({ code: 'TASK_INCOMPLETE' });
        await expect(event(id, 'complete_step', { stepId: 'accept' })).rejects.toMatchObject({ code: 'TASK_STEP_MISMATCH' });
        await event(id, 'complete_step', { stepId: 'question' });
        await event(id, 'pause');
        await expect(event(id, 'complete_step', { stepId: 'research' })).rejects.toMatchObject({ code: 'TASK_STEP_MISMATCH' });
        expect((await event(id, 'start')).currentStepId).toBe('research');
        for (const stepId of ['research', 'evidence']) await event(id, 'complete_step', { stepId });
        await tutorials.keepExample({ accountId: ACCOUNT, pieceId: 'note-anemones' });
        for (const stepId of ['keep', 'accept', 'export']) await event(id, 'complete_step', { stepId });
        const done = await tutorials.loadProgress(ACCOUNT, id, 1);
        expect(done.status).toBe('completed');
        expect((await tutorials.loadProgress(OTHER, id, 1)).status).toBe('not_started');
        const events = await db.all('SELECT action, stepId, createdAt FROM tutorial_events WHERE accountId = @u AND tutorialId = @id', { u: ACCOUNT, id });
        expect(events.find(e => e.action === 'complete_step' && e.stepId === 'accept').createdAt).toBeTruthy();
        expect((await db.get('SELECT COUNT(*) AS n FROM kg_nodes')).n).toBe(beforeNotes.n + 1);
        await tutorials.resetOne({ accountId: ACCOUNT, tutorialId: id });
        expect((await db.get('SELECT COUNT(*) AS n FROM kg_nodes')).n).toBe(beforeNotes.n + 1);
        expect((await tutorials.loadProgress(ACCOUNT, id, 1)).generation).toBe(2);
        await tutorials.forgetUser(ACCOUNT);
        expect((await tutorials.countUserData(ACCOUNT)).events).toBe(0);
    });

    test('skipping acceptance cannot claim an exported accepted output', async () => {
        const id = 'home.first-task';
        await event(id, 'start');
        for (const stepId of ['question', 'research', 'evidence', 'keep', 'accept']) await event(id, 'skip_step', { stepId });
        await expect(event(id, 'complete_step', { stepId: 'export' })).rejects.toMatchObject({ code: 'TASK_NOT_ACCEPTED' });
        expect((await event(id, 'skip_step', { stepId: 'export' })).status).toBe('finished_with_skips');
        expect((await db.get('SELECT COUNT(*) AS n FROM kg_nodes')).n).toBe(0);
        expect((await db.get('SELECT COUNT(*) AS n FROM user_settings')).n).toBe(0);
    });
});
