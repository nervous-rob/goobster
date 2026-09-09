/**
 * Unit tests for the unified user settings facade
 * (services/userSettingsService.js): aggregated reads across the
 * authoritative stores, atomic section writes with revision bumps,
 * optimistic-concurrency conflicts, safe attention editing (never
 * re-enabling a disabled policy), reviewable resets that touch nothing
 * destructive, and the two-step retention flow.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-usersettings-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { dmScopeId } = require('@goobster/core/utils/dmScope');
const guildSettings = require('@goobster/core/utils/guildSettings');
const memeMode = require('@goobster/core/utils/memeMode');
const attentionPolicyService = require('@goobster/core/services/attentionPolicyService');
const eventBusService = require('@goobster/core/services/eventBusService');
const userSettingsService = require('@goobster/core/services/userSettingsService');
const { UserSettingsError } = userSettingsService;

let seq = 0;
const nextUser = () => `10000000000000${String(++seq).padStart(4, '0')}`;

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('getSettings', () => {
    test('a fresh user gets every section at defaults with revision 1', async () => {
        const userId = nextUser();
        const settings = await userSettingsService.getSettings({ userId });
        expect(Object.keys(settings.sections).sort()).toEqual(
            ['account', 'appearance', 'chat', 'connections', 'initiative', 'memory', 'profile', 'voice']
        );
        for (const section of Object.values(settings.sections)) {
            expect(section.revision).toBe(1);
            expect(section.scope).toMatch(/^(private|account|device)$/);
            expect(Array.isArray(section.appliesTo)).toBe(true);
        }
        expect(settings.sections.profile.values).toEqual({
            callGoobster: null, callUser: null, customInstructions: null, personalityDirective: null, memeMode: false
        });
        expect(settings.sections.profile.effective.callGoobster).toBe('Goobster');
        expect(settings.sections.initiative.values.enabled).toBe(false);
        expect(settings.sections.memory.values.retentionDays).toBeNull();
        expect(settings.sections.appearance.values).toEqual({ theme: 'dark', linkByTag: true });
        expect(settings.sections.voice.values).toEqual({ voiceId: null, voiceName: null, speed: 1, accent: null });
        expect(settings.sections.voice.accents).toEqual(expect.arrayContaining([{ id: 'british', label: 'British' }]));
        expect(settings.sections.account.values.userId).toBe(userId);
        expect(settings.capabilities).toEqual(expect.objectContaining({ stt: expect.any(Boolean), tts: expect.any(Boolean) }));
    });

    test('reads the same values the authoritative stores hold', async () => {
        const userId = nextUser();
        const scope = dmScopeId(userId);
        await guildSettings.setBotNickname(scope, 'Goob');
        await guildSettings.setUserNickname(userId, scope, 'Rob');
        await memeMode.setMemeMode(userId, true);
        await guildSettings.setMemoryRetentionDays(scope, 90);
        await guildSettings.setTtsVoice(scope, { speed: 1.5, accent: 'british' });

        const { sections } = await userSettingsService.getSettings({ userId });
        expect(sections.profile.values).toMatchObject({ callGoobster: 'Goob', callUser: 'Rob', memeMode: true });
        expect(sections.profile.sources.callUser).toBe('user-preference');
        expect(sections.memory.values.retentionDays).toBe(90);
        expect(sections.voice.values).toMatchObject({ speed: 1.5, accent: 'british' });
        expect(sections.voice.effective.accentLabel).toBe('British');
    });

    test('capabilities come from the portal voice bridge when one is supplied', async () => {
        const voice = { capabilities: () => ({ stt: true, tts: true, live: false }) };
        const settings = await userSettingsService.getSettings({ userId: nextUser(), voice });
        expect(settings.capabilities).toEqual({ stt: true, tts: true, liveVoice: false });
    });

    test('rejects a missing user id', async () => {
        await expect(userSettingsService.getSettings({ userId: '' }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_USER' });
    });
});

describe('updateSection', () => {
    test('writes profile fields to their stores, bumps the revision, and publishes settings-changed', async () => {
        const userId = nextUser();
        const seen = [];
        const stop = eventBusService.subscribe((event) => { if (event.kind === 'settings-changed') seen.push(event.payload); });
        try {
            const result = await userSettingsService.updateSection({
                userId,
                section: 'profile',
                changes: { callUser: '  Rob  ', customInstructions: 'Be brief.', memeMode: true }
            });
            expect(result.section).toBe('profile');
            expect(result.revision).toBe(2);
            expect(result.data.values).toMatchObject({ callUser: 'Rob', customInstructions: 'Be brief.', memeMode: true });

            expect(await guildSettings.getUserNickname(userId, dmScopeId(userId))).toBe('Rob');
            expect(await memeMode.isMemeModeEnabled(userId)).toBe(true);
            expect(await userSettingsService.getRevision(userId, 'profile')).toBe(2);
            expect(seen).toEqual([expect.objectContaining({ userId, section: 'profile', revision: 2 })]);
        } finally {
            stop();
        }
    });

    test('a stale expectedRevision is a 409 and changes nothing', async () => {
        const userId = nextUser();
        await userSettingsService.updateSection({ userId, section: 'profile', changes: { callGoobster: 'One' } });
        await expect(userSettingsService.updateSection({
            userId, section: 'profile', changes: { callGoobster: 'Two' }, expectedRevision: 1
        })).rejects.toMatchObject({ status: 409, code: 'SETTINGS_CONFLICT', details: { currentRevision: 2 } });
        expect(await guildSettings.getBotNickname(dmScopeId(userId))).toBe('One');
        expect(await userSettingsService.getRevision(userId, 'profile')).toBe(2);
    });

    test('the matching expectedRevision goes through', async () => {
        const userId = nextUser();
        await userSettingsService.updateSection({ userId, section: 'profile', changes: { callGoobster: 'One' } });
        const result = await userSettingsService.updateSection({
            userId, section: 'profile', changes: { callGoobster: 'Two' }, expectedRevision: 2
        });
        expect(result.revision).toBe(3);
        expect(result.data.values.callGoobster).toBe('Two');
    });

    test('validation errors are atomic: nothing in the section is written', async () => {
        const userId = nextUser();
        await expect(userSettingsService.updateSection({
            userId, section: 'profile', changes: { callGoobster: 'Fine', callUser: 'x'.repeat(40) }
        })).rejects.toMatchObject({ status: 400, code: 'BAD_NAME' });
        expect(await guildSettings.getBotNickname(dmScopeId(userId))).toBeNull();
        expect(await userSettingsService.getRevision(userId, 'profile')).toBe(1);
    });

    test('unknown, read-only, and malformed requests are rejected', async () => {
        const userId = nextUser();
        await expect(userSettingsService.updateSection({ userId, section: 'nope', changes: {} }))
            .rejects.toMatchObject({ status: 404, code: 'UNKNOWN_SECTION' });
        await expect(userSettingsService.updateSection({ userId, section: 'connections', changes: {} }))
            .rejects.toMatchObject({ status: 400, code: 'NOT_EDITABLE' });
        await expect(userSettingsService.updateSection({ userId, section: 'account', changes: {} }))
            .rejects.toMatchObject({ status: 400, code: 'NOT_EDITABLE' });
        await expect(userSettingsService.updateSection({ userId, section: 'profile', changes: [] }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    });

    test('chat: rejects unknown providers and reasoning efforts; stores valid overrides', async () => {
        const userId = nextUser();
        await expect(userSettingsService.updateSection({ userId, section: 'chat', changes: { provider: 'skynet' } }))
            .rejects.toMatchObject({ code: 'BAD_PROVIDER' });
        await expect(userSettingsService.updateSection({ userId, section: 'chat', changes: { reasoningEffort: 'ultra' } }))
            .rejects.toMatchObject({ code: 'BAD_REASONING' });
        const result = await userSettingsService.updateSection({
            userId, section: 'chat', changes: { model: 'some-model', reasoningEffort: 'low' }
        });
        expect(result.data.values).toMatchObject({ model: 'some-model', reasoningEffort: 'low' });
        expect(result.data.effective.model).toBe('some-model');
    });

    test('voice: speed bounds, accent legalization, and voice resolution through an injected catalog', async () => {
        const userId = nextUser();
        await expect(userSettingsService.updateSection({ userId, section: 'voice', changes: { speed: 3 } }))
            .rejects.toMatchObject({ code: 'BAD_SPEED' });
        await expect(userSettingsService.updateSection({ userId, section: 'voice', changes: { accent: 'klingon' } }))
            .rejects.toMatchObject({ code: 'BAD_ACCENT' });
        await expect(userSettingsService.updateSection({ userId, section: 'voice', changes: { voiceId: 'Rachel' }, voiceCatalog: null }))
            .rejects.toMatchObject({ status: 503, code: 'TTS_UNAVAILABLE' });

        const catalog = { resolveVoice: jest.fn(async () => ({ id: 'voiceXYZ987654321098', name: 'Rachel' })) };
        const result = await userSettingsService.updateSection({
            userId, section: 'voice', changes: { voiceId: 'rachel', speed: 1.25, accent: 'UK' }, voiceCatalog: catalog
        });
        expect(catalog.resolveVoice).toHaveBeenCalledWith('rachel');
        expect(result.data.values).toEqual({ voiceId: 'voiceXYZ987654321098', voiceName: 'Rachel', speed: 1.25, accent: 'british' });
        expect(await guildSettings.getTtsVoice(dmScopeId(userId))).toMatchObject({ voiceId: 'voiceXYZ987654321098', accent: 'british' });
    });

    test('appearance: persists theme and linkByTag in user_settings', async () => {
        const userId = nextUser();
        await expect(userSettingsService.updateSection({ userId, section: 'appearance', changes: { theme: 'neon' } }))
            .rejects.toMatchObject({ code: 'BAD_THEME' });
        const result = await userSettingsService.updateSection({
            userId, section: 'appearance', changes: { theme: 'light', linkByTag: false }
        });
        expect(result.data.values).toEqual({ theme: 'light', linkByTag: false });
        const row = await db.get('SELECT preferencesJson FROM user_settings WHERE userId = @userId', { userId });
        expect(JSON.parse(row.preferencesJson)).toEqual({ theme: 'light', linkByTag: false });
    });
});

describe('initiative (attention policy) editing', () => {
    test('editing limits for a never-enrolled user does not enroll them', async () => {
        const userId = nextUser();
        const result = await userSettingsService.updateSection({
            userId, section: 'initiative', changes: { initiative: 'assist', maxContactsPerDay: 1 }
        });
        expect(result.data.values).toMatchObject({ enabled: false, initiative: 'assist', maxContactsPerDay: 1 });
        const policy = await attentionPolicyService.get(userId);
        expect(policy.enabled).toBe(false);
    });

    test('editing a disabled policy keeps it disabled; enabling is explicit', async () => {
        const userId = nextUser();
        await attentionPolicyService.enroll({ userId });
        await attentionPolicyService.disable(userId);

        await userSettingsService.updateSection({
            userId, section: 'initiative', changes: { quietStartMinute: 1320, quietEndMinute: 420 }
        });
        expect((await attentionPolicyService.get(userId)).enabled).toBe(false);

        const on = await userSettingsService.updateSection({ userId, section: 'initiative', changes: { enabled: true } });
        expect(on.data.values.enabled).toBe(true);
        expect((await attentionPolicyService.get(userId))).toMatchObject({ enabled: true, quietStartMinute: 1320, quietEndMinute: 420 });

        const off = await userSettingsService.updateSection({ userId, section: 'initiative', changes: { enabled: false } });
        expect(off.data.values.enabled).toBe(false);
    });

    test('boundary overrides merge per category and validate', async () => {
        const userId = nextUser();
        await expect(userSettingsService.updateSection({
            userId, section: 'initiative', changes: { boundaries: { nonsense: { proactiveRead: true } } }
        })).rejects.toMatchObject({ code: 'BAD_CATEGORY' });
        await expect(userSettingsService.updateSection({
            userId, section: 'initiative', changes: { boundaries: { github: { externalWrite: 'yolo' } } }
        })).rejects.toMatchObject({ code: 'BAD_BOUNDARY' });

        const result = await userSettingsService.updateSection({
            userId, section: 'initiative', changes: { boundaries: { github: { externalWrite: 'confirm', proactiveRead: true } } }
        });
        expect(result.data.effective.boundaries.github).toMatchObject({ externalWrite: 'confirm', proactiveRead: true });
    });

    test('quiet hours need both ends; budgets are range-checked', async () => {
        const userId = nextUser();
        await expect(userSettingsService.updateSection({
            userId, section: 'initiative', changes: { quietStartMinute: 60, quietEndMinute: null }
        })).rejects.toMatchObject({ code: 'BAD_QUIET_HOURS' });
        await expect(userSettingsService.updateSection({
            userId, section: 'initiative', changes: { maxContactsPerDay: 99 }
        })).rejects.toMatchObject({ code: 'BAD_BUDGET' });
        await expect(userSettingsService.updateSection({
            userId, section: 'initiative', changes: { enabled: 'yes' }
        })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
});

describe('reset flow', () => {
    test('preview lists only the fields that would change and mutates nothing', async () => {
        const userId = nextUser();
        await userSettingsService.updateSection({ userId, section: 'profile', changes: { callGoobster: 'Goob', memeMode: true } });
        const preview = await userSettingsService.resetPreview({ userId, section: 'profile' });
        expect(preview.currentRevision).toBe(2);
        expect(preview.changes).toEqual({ callGoobster: null, memeMode: false });
        expect(preview.currentValues.callGoobster).toBe('Goob');
        expect(await guildSettings.getBotNickname(dmScopeId(userId))).toBe('Goob');
    });

    test('reset applies the previewed defaults with a revision check', async () => {
        const userId = nextUser();
        await userSettingsService.updateSection({ userId, section: 'profile', changes: { callGoobster: 'Goob' } });
        await expect(userSettingsService.resetSection({ userId, section: 'profile', expectedRevision: 1 }))
            .rejects.toMatchObject({ status: 409 });
        const result = await userSettingsService.resetSection({ userId, section: 'profile', expectedRevision: 2 });
        expect(result.revision).toBe(3);
        expect(result.data.values.callGoobster).toBeNull();
    });

    test('resetting initiative never changes enrollment and clears boundary overrides', async () => {
        const userId = nextUser();
        await attentionPolicyService.enroll({ userId, initiative: 'delegate' });
        await attentionPolicyService.setBoundary({ userId, category: 'github', externalWrite: true });
        const preview = await userSettingsService.resetPreview({ userId, section: 'initiative' });
        expect(preview.changes).not.toHaveProperty('enabled');
        expect(preview.changes).toMatchObject({ initiative: 'nudge', boundaries: {} });

        const result = await userSettingsService.resetSection({ userId, section: 'initiative' });
        expect(result.data.values.enabled).toBe(true);
        expect(result.data.values.initiative).toBe('nudge');
        expect(result.data.values.boundaries).toEqual({});
    });

    test('read-only sections cannot be reset', async () => {
        await expect(userSettingsService.resetPreview({ userId: nextUser(), section: 'connections' }))
            .rejects.toMatchObject({ code: 'NOT_EDITABLE' });
    });
});

describe('retention flow', () => {
    async function seedMemory(userId, ageDays) {
        const createdAt = new Date(Date.now() - ageDays * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        await db.run(
            `INSERT INTO memory_embeddings (guildId, authorId, content, embedding, dims, model, createdAt)
             VALUES (@scope, @userId, @content, @embedding, 2, 'test-embed', @createdAt)`,
            { scope: dmScopeId(userId), userId, content: `memory ${ageDays}d`, embedding: Buffer.from(new Float32Array([0.1, 0.2]).buffer), createdAt }
        );
    }

    test('preview counts what would be purged without touching anything', async () => {
        const userId = nextUser();
        await seedMemory(userId, 100);
        await seedMemory(userId, 5);
        const preview = await userSettingsService.retentionPreview({ userId, days: 30 });
        expect(preview).toMatchObject({
            section: 'memory', currentRevision: 1, currentRetentionDays: null, proposedRetentionDays: 30,
            memoryCount: 2, affectedCount: 1, dataClasses: ['memories']
        });
        const { c } = await db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE guildId = @scope', { scope: dmScopeId(userId) });
        expect(c).toBe(2);
        expect(await guildSettings.getMemoryRetentionDays(dmScopeId(userId))).toBeNull();
    });

    test('apply saves the window, bumps the revision, purges, and reports the real count', async () => {
        const userId = nextUser();
        await seedMemory(userId, 100);
        await seedMemory(userId, 5);
        const result = await userSettingsService.applyRetention({ userId, days: 30, expectedRevision: 1 });
        expect(result.revision).toBe(2);
        expect(result.purged).toBe(1);
        expect(result.data.values.retentionDays).toBe(30);
        const { c } = await db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE guildId = @scope', { scope: dmScopeId(userId) });
        expect(c).toBe(1);

        const forever = await userSettingsService.applyRetention({ userId, days: null });
        expect(forever.purged).toBe(0);
        expect(forever.data.values.retentionDays).toBeNull();
    });

    test('a plain memory section save never purges', async () => {
        const userId = nextUser();
        await seedMemory(userId, 100);
        await userSettingsService.updateSection({ userId, section: 'memory', changes: { retentionDays: 30 } });
        const { c } = await db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE guildId = @scope', { scope: dmScopeId(userId) });
        expect(c).toBe(1);
    });

    test('rejects out-of-range windows', async () => {
        await expect(userSettingsService.retentionPreview({ userId: nextUser(), days: 99999 }))
            .rejects.toMatchObject({ code: 'BAD_RETENTION' });
        await expect(userSettingsService.applyRetention({ userId: nextUser(), days: -1 }))
            .rejects.toMatchObject({ code: 'BAD_RETENTION' });
    });
});

describe('error shape', () => {
    test('UserSettingsError carries status, code, and details', () => {
        const error = new UserSettingsError(409, 'SETTINGS_CONFLICT', 'nope', { currentRevision: 3 });
        expect(error).toMatchObject({ name: 'UserSettingsError', status: 409, code: 'SETTINGS_CONFLICT', details: { currentRevision: 3 } });
    });
});
