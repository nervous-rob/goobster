/**
 * Classic HTTP TTS (services/voice/elevenLabsTTSService.js): spoken text is
 * sanitized before it reaches the ElevenLabs API - URLs are stripped, and a
 * reply that is nothing but a link is skipped entirely.
 */
const ElevenLabsTTSService = require('../services/voice/elevenLabsTTSService');

function makeService() {
    return new ElevenLabsTTSService({ elevenlabs: { apiKey: 'test-key' } });
}

describe('textToSpeech URL stripping', () => {
    test('a URL-only reply is skipped without calling the API', async () => {
        const service = makeService();
        service.fetchStream = jest.fn();

        await service.textToSpeech('https://example.com/only/a/link', {}, {});
        await service.textToSpeech('  <https://a.b>  www.c.d/e  ', {}, {});

        expect(service.fetchStream).not.toHaveBeenCalled();
    });

    test('URLs are stripped from mixed replies before synthesis', async () => {
        const service = makeService();
        // Reject to stop the pipeline right after the text is submitted
        service.fetchStream = jest.fn().mockRejectedValue(new Error('stop-after-capture'));

        await expect(
            service.textToSpeech('Check [the docs](https://docs.example.com) at https://example.com/x today.', {}, {})
        ).rejects.toThrow('stop-after-capture');

        expect(service.fetchStream).toHaveBeenCalledWith('Check the docs at today.');
    });
});
