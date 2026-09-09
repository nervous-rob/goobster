const { describeLive } = require('./helpers');

describeLive('elevenlabs', () => {
    test('listVoices returns an array with a valid key', async () => {
        const ElevenLabsTTSService = require('@goobster/core/services/voice/elevenLabsTTSService');
        const service = new ElevenLabsTTSService();
        expect(service.disabled).toBeFalsy();
        const voices = await service.listVoices();
        expect(Array.isArray(voices)).toBe(true);
    });
});
