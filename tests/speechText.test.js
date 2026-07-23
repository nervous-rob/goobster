/**
 * Speech text sanitation (services/voice/speechText.js): URLs are never
 * narrated by TTS, whether the reply arrives whole (classic engine) or as
 * streamed deltas that may split a URL anywhere (realtime engine).
 */
const { stripUrlsForSpeech, createStreamingUrlStripper } = require('../services/voice/speechText');

describe('stripUrlsForSpeech', () => {
    test('removes bare http/https URLs', () => {
        expect(stripUrlsForSpeech('Check out https://example.com/some/long/path?q=1 for details.'))
            .toBe('Check out for details.');
        expect(stripUrlsForSpeech('See http://foo.bar today'))
            .toBe('See today');
    });

    test('removes www. URLs without a scheme', () => {
        expect(stripUrlsForSpeech('Go to www.example.com/page now'))
            .toBe('Go to now');
    });

    test('keeps the label of markdown links', () => {
        expect(stripUrlsForSpeech('Read [the docs](https://docs.example.com/v2) first'))
            .toBe('Read the docs first');
    });

    test('removes Discord embed-suppressed <url> links', () => {
        expect(stripUrlsForSpeech('Link here <https://example.com/x> ok'))
            .toBe('Link here ok');
    });

    test('cleans up parens emptied by a removed URL', () => {
        expect(stripUrlsForSpeech('The site (https://example.com) is down.'))
            .toBe('The site is down.');
    });

    test('returns an empty string for a URL-only reply', () => {
        expect(stripUrlsForSpeech('https://example.com/only/a/link')).toBe('');
        expect(stripUrlsForSpeech('  https://a.b  https://c.d  ')).toBe('');
    });

    test('passes URL-free text through untouched', () => {
        expect(stripUrlsForSpeech('Just a normal sentence, nothing to strip.'))
            .toBe('Just a normal sentence, nothing to strip.');
        expect(stripUrlsForSpeech('')).toBe('');
        expect(stripUrlsForSpeech(null)).toBe('');
    });
});

describe('createStreamingUrlStripper', () => {
    function run(deltas) {
        const stripper = createStreamingUrlStripper();
        const out = deltas.map(d => stripper.write(d));
        out.push(stripper.flush());
        return out.join('');
    }

    test('plain text streams through with spacing intact', () => {
        expect(run(['Hello ', 'there, ', 'how are ', 'you?']))
            .toBe('Hello there, how are you?');
    });

    test('strips a URL split across many deltas', () => {
        expect(run(['The docs are at ', 'https://exa', 'mple.com/a/very', '/long/path?q=1 ', 'if you want them.']))
            .toBe('The docs are at if you want them.');
    });

    test('strips a URL at the very end of the stream (flush)', () => {
        expect(run(['Find it at ', 'https://example.com', '/deep/link']))
            .toBe('Find it at ');
    });

    test('a URL-only stream produces no speakable text', () => {
        expect(run(['https://example.com/', 'onl', 'y/a/link'])).toBe('');
    });

    test('words are not falsely held: partial words flush correctly', () => {
        expect(run(['unbroken-single-word'])).toBe('unbroken-single-word');
    });

    test('write returns nothing until a whitespace proves the word complete', () => {
        const stripper = createStreamingUrlStripper();
        expect(stripper.write('hel')).toBe('');
        expect(stripper.write('lo ')).toBe('hello ');
        expect(stripper.write('wor')).toBe('');
        expect(stripper.write('ld')).toBe('');
        expect(stripper.flush()).toBe('world'); // flush releases the held tail
    });
});
