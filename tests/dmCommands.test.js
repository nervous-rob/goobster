/**
 * DM slash-command availability contract: commands flagged dmAllowed are
 * registered globally with DM contexts (deploy-commands.js); everything else
 * stays guild-registered. This spec pins the allowlist so a command can't
 * silently leak into (or out of) DMs.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-dm-commands-test-${process.pid}.sqlite`);

// Some command modules read config.json at load time; provide a minimal one
// when absent (same approach as scripts/smoke-require.js).
const configPath = path.join(__dirname, '..', 'config.json');
let createdConfig = false;
beforeAll(() => {
    if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, JSON.stringify({
            clientId: '0',
            guildIds: ['0'],
            token: 'test-placeholder'
        }, null, 2));
        createdConfig = true;
    }
});

afterAll(() => {
    if (createdConfig) fs.unlinkSync(configPath);
    try {
        fs.unlinkSync(process.env.GOOBSTER_DB_PATH);
    } catch { /* not created */ }
});

const DM_ALLOWED = [
    'commands/chat/chat.js',
    'commands/chat/joke.js',
    'commands/chat/poem.js',
    'commands/image/generate.js',
    'commands/utility/help.js',
    'commands/utility/ping.js',
    'commands/utility/memeMode.js'
];

// Representative guild-only commands (server settings, economy, voice)
const GUILD_ONLY = [
    'commands/settings/privacy.js',
    'commands/settings/personalitydirective.js',
    'commands/economy/points.js',
    'commands/utility/server.js'
];

describe('DM command allowlist', () => {
    test.each(DM_ALLOWED)('%s is flagged dmAllowed', (file) => {
        const command = require(path.join(__dirname, '..', file));
        expect(command.dmAllowed).toBe(true);
        expect(command.data).toBeDefined();
        expect(typeof command.execute).toBe('function');
    });

    test.each(GUILD_ONLY)('%s stays guild-only', (file) => {
        const command = require(path.join(__dirname, '..', file));
        expect(command.dmAllowed).toBeUndefined();
    });
});
