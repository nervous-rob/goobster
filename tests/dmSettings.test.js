/**
 * DM "admin" settings: a DM behaves like a one-member guild whose member is
 * the admin. /personalitydirective, /aisettings, /thoughtfulmode, and
 * /nickname store their values under the user's DM scope (dm:<userId>) and
 * the chat pipeline resolves them from there.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-dm-settings-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../services/aiService', () => ({
    getProvider: () => 'openai',
    getDefaultModel: () => 'test-default-model',
    getThoughtfulPreset: () => ({ provider: 'openai', model: 'test-thoughtful-model', reasoningEffort: 'high' })
}));

const db = require('../db');
const { dmScopeId } = require('../utils/dmScope');
const {
    getPersonalityDirective,
    getGuildAI,
    getBotNickname,
    getUserNickname
} = require('../utils/guildSettings');
const { getPreferredUserName, getBotPreferredName } = require('../utils/guildContext');

const personalityDirective = require('../commands/settings/personalitydirective');
const aisettings = require('../commands/settings/aisettings');
const thoughtfulmode = require('../commands/settings/thoughtfulmode');
const nickname = require('../commands/settings/nickname');

const USER = '100000000000000001';
const DM_SCOPE = dmScopeId(USER);

function makeDmInteraction({ subcommand, group = null, strings = {} }) {
    return {
        guild: null,
        guildId: null,
        user: { id: USER, username: 'rob' },
        member: null,
        options: {
            getSubcommand: () => subcommand,
            getSubcommandGroup: () => group,
            getString: (name) => strings[name] ?? null
        },
        reply: jest.fn().mockResolvedValue(undefined)
    };
}

afterAll(() => {
    try {
        fs.unlinkSync(TEST_DB);
    } catch { /* not created */ }
});

describe('DM settings commands (the DM user is the admin of their scope)', () => {
    test('all four settings commands are DM-enabled', () => {
        for (const command of [personalityDirective, aisettings, thoughtfulmode, nickname]) {
            expect(command.dmAllowed).toBe(true);
        }
    });

    test('/personalitydirective set stores the directive under the DM scope', async () => {
        const interaction = makeDmInteraction({
            subcommand: 'set',
            strings: { directive: 'Be extra cozy and use lowercase.' }
        });
        await personalityDirective.execute(interaction);

        expect(interaction.reply).toHaveBeenCalledTimes(1);
        expect(interaction.reply.mock.calls[0][0].content).toContain('✅');

        const row = db.get('SELECT personality_directive FROM guild_settings WHERE guildId = @g', { g: DM_SCOPE });
        expect(row.personality_directive).toBe('Be extra cozy and use lowercase.');

        // The chat pipeline reads it through the same helper
        expect(await getPersonalityDirective(DM_SCOPE)).toBe('Be extra cozy and use lowercase.');
    });

    test('/aisettings set stores AI overrides under the DM scope', async () => {
        const interaction = makeDmInteraction({
            subcommand: 'set',
            strings: { provider: 'gemini', model: 'test-model', reasoning: 'low' }
        });
        await aisettings.execute(interaction);

        const settings = await getGuildAI(DM_SCOPE);
        expect(settings).toEqual({ provider: 'gemini', model: 'test-model', reasoningEffort: 'low' });
    });

    test('/thoughtfulmode enable pins the thoughtful preset for the DM scope', async () => {
        const interaction = makeDmInteraction({ subcommand: 'enable' });
        await thoughtfulmode.execute(interaction);

        const settings = await getGuildAI(DM_SCOPE);
        expect(settings.model).toBe('test-thoughtful-model');
        expect(settings.reasoningEffort).toBe('high');
    });

    test('/nickname bot set works in a DM without Manage Server or a guild member', async () => {
        const interaction = makeDmInteraction({
            subcommand: 'set',
            group: 'bot',
            strings: { nickname: 'Snugbot' }
        });
        await nickname.execute(interaction);

        expect(interaction.reply.mock.calls[0][0].content).toContain('Snugbot');
        expect(await getBotNickname(DM_SCOPE)).toBe('Snugbot');
    });

    test('/nickname user set stores the nickname under the DM scope', async () => {
        const interaction = makeDmInteraction({
            subcommand: 'set',
            group: 'user',
            strings: { nickname: 'Robbo' }
        });
        await nickname.execute(interaction);

        expect(await getUserNickname(USER, DM_SCOPE)).toBe('Robbo');
    });

    test('the chat pipeline name helpers resolve DM-scope nicknames', async () => {
        expect(await getBotPreferredName(DM_SCOPE, null)).toBe('Snugbot');
        expect(await getPreferredUserName(USER, DM_SCOPE, { user: { username: 'rob' } })).toBe('Robbo');
    });

    test('DM-scope settings never leak into a guild', async () => {
        const guildId = '200000000000000001';
        expect(await getPersonalityDirective(guildId)).toBeNull();
        expect(await getGuildAI(guildId)).toEqual({ provider: null, model: null, reasoningEffort: null });
        expect(await getBotNickname(guildId)).toBeNull();
    });
});
