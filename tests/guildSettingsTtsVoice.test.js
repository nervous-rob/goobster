/**
 * Per-scope TTS voice settings (utils/guildSettings.js): a guild's voice in
 * servers, a user's personal voice under their dm:<userId> scope - the same
 * pattern as personality directives. Voice ids are resolved by callers at
 * save time; this layer stores/returns them with the playback speed.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-ttsvoice-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { dmScopeId } = require('@goobster/core/utils/dmScope');
const { getTtsVoice, setTtsVoice } = require('@goobster/core/utils/guildSettings');

const GUILD = '600000000000000001';
const USER = '600000000000000002';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

describe('getTtsVoice / setTtsVoice', () => {
    test('defaults to no voice and no speed', async () => {
        expect(await getTtsVoice('600000000000000099')).toEqual({
            voiceId: null, voiceName: null, speed: null
        });
    });

    test('stores a guild voice and reads it back (cache invalidated)', async () => {
        const saved = await setTtsVoice(GUILD, { voiceId: 'voiceAAA111111111111', voiceName: 'Aria' });
        expect(saved).toEqual({ voiceId: 'voiceAAA111111111111', voiceName: 'Aria', speed: null });
        expect(await getTtsVoice(GUILD)).toEqual(saved);
    });

    test('a DM scope stores independently of guilds (per-user voice)', async () => {
        await setTtsVoice(dmScopeId(USER), { voiceId: 'voiceBBB222222222222', voiceName: 'Baxter', speed: 1.25 });
        expect(await getTtsVoice(dmScopeId(USER))).toEqual({
            voiceId: 'voiceBBB222222222222', voiceName: 'Baxter', speed: 1.25
        });
        // The guild row from the previous test is untouched
        expect((await getTtsVoice(GUILD)).voiceId).toBe('voiceAAA111111111111');
    });

    test('partial updates leave other fields alone', async () => {
        await setTtsVoice(GUILD, { speed: 1.5 });
        expect(await getTtsVoice(GUILD)).toEqual({
            voiceId: 'voiceAAA111111111111', voiceName: 'Aria', speed: 1.5
        });
    });

    test('null clears back to the default voice', async () => {
        const cleared = await setTtsVoice(GUILD, { voiceId: null, voiceName: null, speed: null });
        expect(cleared).toEqual({ voiceId: null, voiceName: null, speed: null });
    });

    test('rejects out-of-range speeds', async () => {
        await expect(setTtsVoice(GUILD, { speed: 0.25 })).rejects.toThrow(/Invalid TTS speed/);
        await expect(setTtsVoice(GUILD, { speed: 5 })).rejects.toThrow(/Invalid TTS speed/);
        await expect(setTtsVoice(GUILD, { speed: 'fast' })).rejects.toThrow(/Invalid TTS speed/);
    });
});
