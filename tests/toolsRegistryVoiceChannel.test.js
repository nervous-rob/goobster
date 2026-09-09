/**
 * Discord voice-channel tools (speakMessage, playTrack) join a guild voice
 * channel. The web portal and automations have none, so they must not
 * appear in the model's function list there — otherwise an accent / "use
 * a voice" request calls speakMessage with extra voice/style settings and
 * then throws on a null member.
 */
const path = require('node:path');
const os = require('node:os');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-voice-channel-tools-${process.pid}.sqlite`);

const toolsRegistry = require('@goobster/core/utils/toolsRegistry');

const names = (defs) => defs.map(d => d.name);

describe('getDefinitions gating', () => {
    test('Discord text chat still offers speakMessage and playTrack', async () => {
        const offered = names(await toolsRegistry.getDefinitions());
        expect(offered).toContain('speakMessage');
        expect(offered).toContain('playTrack');
    });

    test('the web app offers setSpeechAccent instead', async () => {
        const offered = names(await toolsRegistry.getDefinitions(undefined, { isWeb: true }));
        expect(offered).toContain('setSpeechAccent');
        expect(offered).not.toContain('speakMessage');
        expect(offered).not.toContain('playTrack');
    });

    test('unattended automations omit them too', async () => {
        const offered = names(await toolsRegistry.getDefinitions(undefined, { isAutomation: true }));
        expect(offered).not.toContain('speakMessage');
        expect(offered).not.toContain('playTrack');
        expect(offered).not.toContain('setSpeechAccent');
    });

    test('Discord text chat does not offer the portal accent tool', async () => {
        expect(names(await toolsRegistry.getDefinitions())).not.toContain('setSpeechAccent');
    });

    test('an explicit allowlist cannot smuggle them onto a web turn', async () => {
        const offered = names(await toolsRegistry.getDefinitions(
            ['speakMessage', 'playTrack', 'performSearch'],
            { isWeb: true }
        ));
        expect(offered).toEqual(['performSearch']);
    });
});

describe('execute refuses without a Discord voice channel', () => {
    test('speakMessage on a web turn does not throw, even with extra settings', async () => {
        const result = await toolsRegistry.execute('speakMessage', {
            message: 'hello',
            voice: 'british',
            style: 'dramatic',
            accent: 'cockney',
            voice_settings: { stability: 0.2, similarity_boost: 0.9 },
            interactionContext: {
                channelId: 'web:100000000000000001:main',
                member: null,
                user: { id: '100000000000000001' }
            }
        });
        expect(result).toMatch(/not available/i);
        expect(result).toMatch(/Voice settings/i);
    });

    test('playTrack on a web turn does not throw on a null member', async () => {
        const result = await toolsRegistry.execute('playTrack', {
            track: 'daft punk',
            interactionContext: {
                channelId: 'web:100000000000000001:main',
                member: null
            }
        });
        expect(result).toMatch(/not available/i);
    });

    test('speakMessage without a voice channel returns text, never throws', async () => {
        const result = await toolsRegistry.execute('speakMessage', {
            message: 'hello',
            voice: 'Rachel',
            interactionContext: {
                guildId: '500000000000000001',
                member: { voice: { channel: null } }
            }
        });
        expect(result).toMatch(/voice channel/i);
    });

    test('setSpeechAccent on a web turn saves a legalized accent', async () => {
        const userId = '100000000000000088';
        const result = await toolsRegistry.execute('setSpeechAccent', {
            accent: 'british',
            interactionContext: {
                channelId: `web:${userId}:main`,
                user: { id: userId }
            }
        });
        expect(result).toMatch(/British/);
        const webVoiceService = require('@goobster/core/services/webVoiceService');
        expect(await webVoiceService.getVoiceSettings({ userId })).toMatchObject({ accent: 'british' });
    });

    test('setSpeechAccent on Discord points at Voice settings, not Flash', async () => {
        const result = await toolsRegistry.execute('setSpeechAccent', {
            accent: 'british',
            interactionContext: {
                guildId: '500000000000000001',
                user: { id: '100000000000000089' }
            }
        });
        expect(result).toMatch(/web-portal/i);
        expect(result).toMatch(/Flash/i);
    });
});
