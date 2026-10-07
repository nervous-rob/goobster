/**
 * Instance defaults (services/instanceDefaultsService.js): what a person
 * inherits until they choose, as against the enforced host policy.
 *
 * Two people share one instance: one has made an explicit choice, the other
 * has not. Changing a default moves only the second; an explicit preference
 * is never overwritten; and the enforced limit still caps both whatever the
 * defaults say. Runs on SQLite and on Postgres.
 */
process.env.OPENAI_API_KEY = 'test-openai';
process.env.ANTHROPIC_API_KEY = 'test-anthropic';

const db = require('@goobster/core/db');
const defaults = require('@goobster/core/services/instanceDefaultsService');
const userSettings = require('@goobster/core/services/userSettingsService');
const budgets = require('@goobster/core/services/usageBudgetService');
const state = require('@goobster/core/services/instanceStateService');

let seq = 0;
let EXPLICIT;
let INHERITING;
const nextUser = () => `1000000000008${String(++seq).padStart(5, '0')}`;

const pref = (userId, key) => userSettings.getPreference(userId, key);

async function clear() {
    await state.remove('defaults');
}

beforeAll(async () => {
    await db.get('SELECT 1 AS ok');
});

beforeEach(clear);
afterAll(clear);

describe('the defaults document', () => {
    test('starts empty and round-trips set, change and remove', async () => {
        expect(await defaults.get()).toEqual({});
        const first = await defaults.set([
            { id: 'defaults.appearance.theme', action: 'set', value: 'light' },
            { id: 'defaults.budget.usageAlertTokens', action: 'set', value: '250000' }
        ]);
        expect(first.changed.sort()).toEqual(['defaults.appearance.theme', 'defaults.budget.usageAlertTokens']);
        expect(await defaults.get()).toEqual({ appearance: { theme: 'light' }, budget: { usageAlertTokens: 250000 } });
        expect(await defaults.getFlat()).toEqual({ 'defaults.appearance.theme': 'light', 'defaults.budget.usageAlertTokens': 250000 });

        const second = await defaults.set([{ id: 'defaults.appearance.theme', action: 'set', value: 'light' }]);
        expect(second.changed).toEqual([]);

        await defaults.set([
            { id: 'defaults.appearance.theme', action: 'remove' },
            { id: 'defaults.budget.usageAlertTokens', action: 'remove' }
        ]);
        expect(await defaults.get()).toEqual({});
        expect(await state.get('defaults')).toBeNull();
    });

    test('refuses an unknown field, a bad value, a duplicate, a bad action and an empty batch; nothing is written', async () => {
        const bad = [
            [{ id: 'defaults.appearance.theme', action: 'set', value: 'neon' }, 'BAD_VALUE|INVALID'],
            [{ id: 'limits.dailyTokens', action: 'set', value: 5 }, 'UNKNOWN_FIELD'],
            [{ id: 'nope', action: 'set', value: 1 }, 'UNKNOWN_FIELD'],
            [{ id: 'defaults.appearance.theme', action: 'frobnicate' }, 'BAD_ACTION'],
            [{ id: 'defaults.appearance.theme', action: 'set' }, '.']
        ];
        for (const [change] of bad) {
            await expect(defaults.set([change])).rejects.toMatchObject({ code: 'INVALID_DEFAULTS' });
        }
        await expect(defaults.set([
            { id: 'defaults.appearance.theme', action: 'set', value: 'dark' },
            { id: 'defaults.appearance.theme', action: 'remove' }
        ])).rejects.toMatchObject({ details: [{ code: 'DUPLICATE_CHANGE' }] });
        await expect(defaults.set([])).rejects.toMatchObject({ details: [{ code: 'NO_CHANGES' }] });
        expect(await state.get('defaults')).toBeNull();
    });

    test('a hand-edited row cannot inject an unknown key or an invalid value', async () => {
        await state.set('defaults', { appearance: { theme: 'neon', startPage: 'home' }, evil: { x: 1 }, memory: { chatHistoryRetentionDays: 0 } });
        expect(await defaults.get()).toEqual({ appearance: { startPage: 'home' } });
    });
});

describe('inheritance', () => {
    beforeEach(async () => {
        EXPLICIT = nextUser();
        INHERITING = nextUser();
        await userSettings.updateSection({ userId: EXPLICIT, section: 'appearance', changes: { theme: 'light' } });
    });

    test('only the person without a stored choice inherits a default, and a changed default moves only them', async () => {
        await defaults.set([{ id: 'defaults.appearance.theme', action: 'set', value: 'system' }]);
        expect(await pref(EXPLICIT, 'theme')).toBe('light');
        expect(await pref(INHERITING, 'theme')).toBe('system');

        await defaults.set([{ id: 'defaults.appearance.theme', action: 'set', value: 'light' }]);
        expect(await pref(INHERITING, 'theme')).toBe('light');
        await defaults.set([{ id: 'defaults.appearance.theme', action: 'remove' }]);
        expect(await pref(INHERITING, 'theme')).toBe('dark');
        expect(await pref(EXPLICIT, 'theme')).toBe('light');
    });

    test('an explicit choice of the factory value is still explicit and is never overwritten', async () => {
        await userSettings.updateSection({ userId: INHERITING, section: 'appearance', changes: { theme: 'dark' } });
        await defaults.set([{ id: 'defaults.appearance.theme', action: 'set', value: 'system' }]);
        expect(await pref(INHERITING, 'theme')).toBe('dark');
    });

    test('saving one setting no longer freezes every other setting as a personal choice', async () => {
        await userSettings.updateSection({ userId: INHERITING, section: 'appearance', changes: { linkByTag: false } });
        const row = await db.get('SELECT preferencesJson FROM user_settings WHERE userId = @userId', { userId: INHERITING });
        expect(Object.keys(JSON.parse(row.preferencesJson))).toEqual(['linkByTag']);
        await defaults.set([{ id: 'defaults.appearance.theme', action: 'set', value: 'system' }]);
        expect(await pref(INHERITING, 'theme')).toBe('system');
        expect(await pref(INHERITING, 'linkByTag')).toBe(false);
    });

    test('the settings view says where each value comes from', async () => {
        await defaults.set([
            { id: 'defaults.appearance.theme', action: 'set', value: 'system' },
            { id: 'defaults.appearance.startPage', action: 'set', value: 'chat' },
            { id: 'defaults.budget.usageAlertTokens', action: 'set', value: 90000 },
            { id: 'defaults.memory.chatHistoryRetentionDays', action: 'set', value: 365 }
        ]);
        const mine = await userSettings.getSettings({ userId: INHERITING });
        expect(mine.sections.appearance.effective).toMatchObject({ theme: 'system', startPage: 'chat' });
        expect(mine.sections.appearance.sources).toMatchObject({ theme: 'instance-default', startPage: 'instance-default' });
        expect(mine.sections.chat.effective.usageAlertTokens).toBe(90000);
        expect(mine.sections.chat.sources.usageAlertTokens).toBe('instance-default');
        expect(mine.sections.memory.effective.chatHistoryRetentionDays).toBe(365);
        expect(mine.sections.memory.sources.chatHistoryRetentionDays).toBe('instance-default');

        const theirs = await userSettings.getSettings({ userId: EXPLICIT });
        expect(theirs.sections.appearance.effective.theme).toBe('light');
        expect(theirs.sections.appearance.sources.theme).toBe('account-preference');
        expect(theirs.sections.appearance.effective.startPage).toBe('chat');
    });

    test('a default chat provider and model apply to a person with no choice of their own, only while the provider is configured', async () => {
        await defaults.set([
            { id: 'defaults.chat.provider', action: 'set', value: 'anthropic' },
            { id: 'defaults.chat.model', action: 'set', value: 'claude-default-test' }
        ]);
        const mine = await userSettings.getSettings({ userId: INHERITING });
        expect(mine.sections.chat.effective).toMatchObject({ provider: 'anthropic', model: 'claude-default-test' });
        expect(mine.sections.chat.sources).toMatchObject({ provider: 'instance-default', model: 'instance-default' });
        expect(mine.sections.chat.values.provider).toBeNull();

        expect(defaults.resolveChat({ provider: 'openai' }, { chat: { provider: 'anthropic', model: 'm' } }, { configuredProviders: ['openai', 'anthropic'] }))
            .toMatchObject({ provider: 'openai', providerSource: 'user-override', model: null });
        expect(defaults.resolveChat({}, { chat: { provider: 'gemini', model: 'm' } }, { configuredProviders: ['openai'], hostProvider: 'openai' }))
            .toMatchObject({ provider: null, providerSource: 'host-default', model: null });
        expect(defaults.resolveChat({ model: 'mine' }, { chat: { provider: 'anthropic', model: 'm' } }, { configuredProviders: ['anthropic'] }))
            .toMatchObject({ provider: 'anthropic', model: 'mine', modelSource: 'user-override' });
        expect(await defaults.resolveAI({}, { configuredProviders: ['anthropic'] }))
            .toMatchObject({ provider: 'anthropic', model: 'claude-default-test' });
    });

    test('a default retention window is what the purge sees for a person without their own', async () => {
        await defaults.set([{ id: 'defaults.memory.chatHistoryRetentionDays', action: 'set', value: 30 }]);
        expect(await pref(INHERITING, 'chatHistoryRetentionDays')).toBe(30);
        await userSettings.updateSection({ userId: EXPLICIT, section: 'memory', changes: { chatHistoryRetentionDays: null } });
        expect(await pref(EXPLICIT, 'chatHistoryRetentionDays')).toBeNull();
    });
});

describe('a default is not a policy', () => {
    test('the enforced token limit still caps both people whatever the defaults say', async () => {
        EXPLICIT = nextUser();
        INHERITING = nextUser();
        const original = await state.get('limits');
        try {
            await budgets.setPolicy({ dailyTokens: 1000 });
            await defaults.set([
                { id: 'defaults.budget.usageAlertTokens', action: 'set', value: 9_999_999 },
                { id: 'defaults.memory.chatHistoryRetentionDays', action: 'set', value: 3650 }
            ]);
            for (const userId of [EXPLICIT, INHERITING]) {
                const limits = await budgets.describe(userId);
                expect(limits.dailyTokens).toBe(1000);
            }
            expect((await budgets.policy()).dailyTokens).toBe(1000);
            expect(await pref(INHERITING, 'usageAlertTokens')).toBe(9_999_999);

            await budgets.setPolicy({ dailyTokens: 2000 });
            expect((await defaults.get()).budget.usageAlertTokens).toBe(9_999_999);
            expect((await budgets.describe(INHERITING)).dailyTokens).toBe(2000);
        } finally {
            if (original) await state.set('limits', original);
            else await state.remove('limits');
        }
    });

    test('defaults are stored apart from the limits and cannot name one', async () => {
        await defaults.set([{ id: 'defaults.budget.usageAlertTokens', action: 'set', value: 5 * 100000 }]);
        expect(await state.get('limits')).toBeNull();
        await expect(defaults.set([{ id: 'limits.dailyTokens', action: 'set', value: 1 }])).rejects.toMatchObject({ code: 'INVALID_DEFAULTS' });
    });
});
