/**
 * Unit tests for ElevenLabs voice resolution
 * (services/voice/elevenLabsTTSService.js): name/ID lookup against the voice
 * library, prefix matching on display names, caching, and the speak-time
 * fallback to the default voice. node-fetch is mocked - no network.
 */
jest.mock('node-fetch', () => jest.fn());

const fetch = require('node-fetch');
const ElevenLabsTTSService = require('../services/voice/elevenLabsTTSService');

const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

const LIBRARY = [
    { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah - Mature, Reassuring, Confident', category: 'premade' },
    { voice_id: 'nPczCjzI2devNBz1zQrb', name: 'Brian - Deep, Resonant and Comforting', category: 'premade' },
    { voice_id: 'AAAAAAAAAAAAAAAA0001', name: 'Brian - Deep, Resonant and Comforting', category: 'professional' },
    { voice_id: 'pMsXgVXv3BLzUgSXRplE', name: 'Serena', category: 'premade' }
];

function mockVoicesResponse() {
    return { ok: true, json: async () => ({ voices: LIBRARY }) };
}

function makeService() {
    return new ElevenLabsTTSService({ elevenlabs: { apiKey: 'test-key' } });
}

beforeEach(() => {
    fetch.mockReset();
});

describe('resolveVoice', () => {
    test('matches an exact display name case-insensitively', async () => {
        fetch.mockResolvedValueOnce(mockVoicesResponse());
        const service = makeService();
        await expect(service.resolveVoice('serena')).resolves.toEqual({
            id: 'pMsXgVXv3BLzUgSXRplE',
            name: 'Serena'
        });
    });

    test('matches the base name before the " - description" suffix', async () => {
        fetch.mockResolvedValueOnce(mockVoicesResponse());
        const service = makeService();
        await expect(service.resolveVoice('Sarah')).resolves.toEqual({
            id: 'EXAVITQu4vr4xnSDxMaL',
            name: 'Sarah - Mature, Reassuring, Confident'
        });
    });

    test('rejects unknown voices with the available names listed', async () => {
        fetch.mockResolvedValueOnce(mockVoicesResponse());
        const service = makeService();
        await expect(service.resolveVoice('Rachel')).rejects.toThrow(
            /voice "Rachel" not found .* Available: .*Sarah/
        );
    });

    test('rejects ambiguous base names (two Brians)', async () => {
        fetch.mockResolvedValueOnce(mockVoicesResponse());
        const service = makeService();
        await expect(service.resolveVoice('Brian')).rejects.toThrow(/ambiguous/);
    });

    test('resolves library IDs to their names without extra lookups', async () => {
        fetch.mockResolvedValue(mockVoicesResponse());
        const service = makeService();
        await expect(service.resolveVoice('pMsXgVXv3BLzUgSXRplE')).resolves.toEqual({
            id: 'pMsXgVXv3BLzUgSXRplE',
            name: 'Serena'
        });
        expect(fetch).toHaveBeenCalledTimes(1); // just the library list
    });

    test('manual IDs outside the library inherit their info from the per-voice endpoint', async () => {
        fetch.mockImplementation(async (url) => {
            const u = String(url);
            if (u.endsWith('/v1/voices')) return mockVoicesResponse();
            if (u.includes(`/v1/voices/${DEFAULT_VOICE_ID}`)) {
                return {
                    ok: true,
                    json: async () => ({ voice_id: DEFAULT_VOICE_ID, name: 'Janet', category: 'professional' })
                };
            }
            return { ok: false, status: 400, json: async () => ({ detail: 'voice_not_found' }) };
        });
        const service = makeService();

        // Accessible ID not in the library list: name/category are inherited
        await expect(service.resolveVoice(DEFAULT_VOICE_ID)).resolves.toEqual({
            id: DEFAULT_VOICE_ID,
            name: 'Janet'
        });

        // Nonexistent ID: rejected at save time with a clear error
        await expect(service.resolveVoice('zzzzzzzzzzzzzzzzzzzz')).rejects.toThrow(
            /voice ID "zzzzzzzzzzzzzzzzzzzz" does not exist/
        );
    });
});

describe('resolveVoiceId caching', () => {
    test('IDs skip the network entirely; resolved names are cached', async () => {
        fetch.mockResolvedValue(mockVoicesResponse());
        const service = makeService();

        await expect(service.resolveVoiceId('pMsXgVXv3BLzUgSXRplE')).resolves.toBe('pMsXgVXv3BLzUgSXRplE');
        expect(fetch).not.toHaveBeenCalled();

        await expect(service.resolveVoiceId('Sarah')).resolves.toBe('EXAVITQu4vr4xnSDxMaL');
        expect(fetch).toHaveBeenCalledTimes(1);

        // Second lookup of the same alias hits the cache, not the API
        await expect(service.resolveVoiceId('Sarah')).resolves.toBe('EXAVITQu4vr4xnSDxMaL');
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('fetchStream fallback', () => {
    test('an unresolvable configured voice falls back to the default voice instead of failing', async () => {
        const service = makeService();
        service.voiceId = 'Rachel'; // not in the library

        fetch.mockImplementation(async (url) => {
            if (String(url).includes('/v1/voices')) return mockVoicesResponse();
            return { ok: true, body: 'stream' };
        });

        const response = await service.fetchStream('hello');
        expect(response.ok).toBe(true);

        const ttsCall = fetch.mock.calls.find(([url]) => String(url).includes('/v1/text-to-speech/'));
        expect(ttsCall[0]).toContain(`/v1/text-to-speech/${DEFAULT_VOICE_ID}/stream`);
    });

    test('a valid configured voice name is resolved and used', async () => {
        const service = makeService();
        service.voiceId = 'Serena';

        fetch.mockImplementation(async (url) => {
            if (String(url).includes('/v1/voices')) return mockVoicesResponse();
            return { ok: true, body: 'stream' };
        });

        await service.fetchStream('hello');
        const ttsCall = fetch.mock.calls.find(([url]) => String(url).includes('/v1/text-to-speech/'));
        expect(ttsCall[0]).toContain('/v1/text-to-speech/pMsXgVXv3BLzUgSXRplE/stream');
    });
});
