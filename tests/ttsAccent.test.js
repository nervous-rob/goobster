/**
 * ElevenLabs v3 accent catalog (utils/ttsAccent.js): legalize free-form
 * requests, refuse unknown names, and prefix the audio tag used by portal TTS.
 */
const {
    AUDIO_TAG_MODEL,
    listAccents,
    legalizeAccent,
    modelSupportsAudioTags,
    applyAccentTag
} = require('@goobster/core/utils/ttsAccent');

describe('legalizeAccent', () => {
    test('maps aliases onto catalog ids', () => {
        expect(legalizeAccent('UK').id).toBe('british');
        expect(legalizeAccent('british accent').tag).toBe('[British accent]');
        expect(legalizeAccent('southern us').id).toBe('southern-us');
        expect(legalizeAccent('none')).toBeNull();
        expect(legalizeAccent('')).toBeNull();
        expect(legalizeAccent(null)).toBeNull();
    });

    test('throws on unknown names with the known list', () => {
        expect(() => legalizeAccent('klingon')).toThrow(/Unknown accent/);
        expect(() => legalizeAccent('klingon')).toThrow(/British/);
    });
});

describe('audio tags', () => {
    test('only eleven_v3 models read tags', () => {
        expect(modelSupportsAudioTags(AUDIO_TAG_MODEL)).toBe(true);
        expect(modelSupportsAudioTags('eleven_v3_conversational')).toBe(true);
        expect(modelSupportsAudioTags('eleven_flash_v2_5')).toBe(false);
    });

    test('applyAccentTag prefixes once', () => {
        const accent = legalizeAccent('british');
        expect(applyAccentTag('Hello.', accent)).toBe('[British accent] Hello.');
        expect(applyAccentTag('[British accent] Hello.', accent)).toBe('[British accent] Hello.');
    });

    test('listAccents is the picker catalog', () => {
        expect(listAccents().map(a => a.id)).toEqual(expect.arrayContaining(['british', 'american']));
    });
});
