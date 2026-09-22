/**
 * Guided-tutorial framework (Increment F1).
 *
 * State machine, catalog allow-list, reset/generation concurrency, privacy
 * erasure. Authored tour steps arrive in F2 — tests inject a temporary
 * catalog with steps to exercise skip vs complete and unavailable steps.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB = path.join(os.tmpdir(), `goobster-tutorials-f1-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const catalog = require('@goobster/core/config/tutorialCatalog');
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

function caps(overrides = {}) {
    return {
        isOperator: false,
        discordEnabled: false,
        features: { projects: true, observatory: false, spitball: true },
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
    const progress = await tutorials.loadProgress(ACCOUNT, tutorialId,
        TEST_STEPS_CATALOG.TUTORIAL_BY_ID[tutorialId].version);
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
    test('lists the same 28 tutorial ids as rooms.cjs, each exactly once', () => {
        // Restore production catalog for this assertion.
        tutorials._setCatalogForTests(null);
        const fromRooms = rooms.ROOMS.flatMap((room) => room.tutorials);
        expect(catalog.TUTORIAL_IDS).toEqual(expect.arrayContaining(fromRooms));
        expect(catalog.TUTORIAL_IDS).toHaveLength(28);
        expect(new Set(catalog.TUTORIAL_IDS).size).toBe(28);
        expect(fromRooms).toHaveLength(28);
        expect(new Set(fromRooms).size).toBe(28);
        for (const id of fromRooms) {
            expect(catalog.TUTORIAL_BY_ID[id].roomId).toBe(
                rooms.ROOMS.find((r) => r.tutorials.includes(id)).id
            );
        }
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

        const chat = await tutorials.loadProgress(ACCOUNT, 'chat.basics', 1);
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

        const after = await tutorials.loadProgress(ACCOUNT, 'home.orientation', 1);
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
        const home = await tutorials.loadProgress(ACCOUNT, 'home.orientation', 1);
        expect(home.status).toBe('not_started');
        expect(home.generation).toBe(2);
        const chatStill = await tutorials.loadProgress(ACCOUNT, 'chat.basics', 1);
        expect(chatStill.status).toBe('in_progress');

        await tutorials.resetAll({ accountId: ACCOUNT, caps: caps() });
        const chat = await tutorials.loadProgress(ACCOUNT, 'chat.basics', 1);
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
        const before = await tutorials.loadProgress(ACCOUNT, 'home.orientation', 1);
        await tutorials.patchPreferences(ACCOUNT, { autoStart: false });
        const after = await tutorials.loadProgress(ACCOUNT, 'home.orientation', 1);
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
             VALUES (@u, 'home.orientation', 1, 'greet', 'unclear', datetime('now'))`,
            { u: ACCOUNT }
        );
        // Another account's row must survive.
        await db.run(
            `INSERT INTO tutorial_progress (
                accountId, tutorialId, version, generation, revision, status,
                completedStepIdsJson, skippedStepIdsJson, unavailableStepIdsJson, updatedAt
             ) VALUES (@u, 'chat.basics', 1, 1, 1, 'paused', '[]', '[]', '[]', datetime('now'))`,
            { u: OTHER }
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
    test('the tutorial service module does not pull AI, transfers or inbox writers', () => {
        const src = fs.readFileSync(
            require.resolve('@goobster/core/services/tutorialService'),
            'utf8'
        );
        expect(src).not.toMatch(/aiService|knowledgeTransferService|inboxService|observatoryService/);
        expect(src).toMatch(/tutorial_progress/);
    });
});
