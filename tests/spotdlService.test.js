const SpotDLService = require('@goobster/core/services/spotdl/spotdlService');

// The constructor warns when config.json has no Spotify credentials.
let warnSpy;
beforeAll(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => warnSpy.mockRestore());

describe('parseVersion', () => {
    test.each([
        ['4.5.2\n', '4.5.2'],
        ['spotdl 4.4', '4.4'],
        ['', null],
        ['no digits here', null]
    ])('%j -> %j', (input, expected) => {
        expect(SpotDLService.parseVersion(input)).toBe(expected);
    });
});

describe('supportsOfficialApiFlag', () => {
    test.each([
        ['4.5.2', true],
        ['4.5', true],
        ['5.0.0', true],
        ['4.4.3', false],
        ['3.9.9', false],
        [null, false],
        ['garbage', false]
    ])('%j -> %j', (version, expected) => {
        expect(SpotDLService.supportsOfficialApiFlag(version)).toBe(expected);
    });
});

describe('_credentialArgs', () => {
    const makeService = ({ creds = true, version = '4.5.2' } = {}) => {
        const service = new SpotDLService();
        service.spotifyCreds = creds ? { clientId: 'id', clientSecret: 'secret' } : null;
        service._resolvedVersion = version;
        return service;
    };

    test('adds --use-official-api on spotdl >= 4.5 so credentials take effect', () => {
        expect(makeService()._credentialArgs()).toEqual([
            '--client-id', 'id',
            '--client-secret', 'secret',
            '--no-cache',
            '--use-official-api'
        ]);
    });

    test('omits the flag on spotdl < 4.5 (flag does not exist there)', () => {
        expect(makeService({ version: '4.4.3' })._credentialArgs()).toEqual([
            '--client-id', 'id',
            '--client-secret', 'secret',
            '--no-cache'
        ]);
    });

    test('returns no args without credentials', () => {
        expect(makeService({ creds: false })._credentialArgs()).toEqual([]);
    });
});

describe('summarizeFailure', () => {
    // Shaped like spotdl's rich boxed traceback output.
    const boxedTraceback = (finalLine) => [
        'Processing query:',
        'https://open.spotify.com/playlist/abc',
        'An error occurred',
        '╭───────────────────── Traceback (most recent call last) ──────────────────────╮',
        '│ /home/pi/.local/goobster-venv/lib/python3.13/site-packages/spotdl/co │',
        '│ nsole/entry_point.py:160 in entry_point                                      │',
        '│ ❱ 160 │   │   OPERATIONS[arguments.operation](                               │',
        '│ /home/pi/.local/goobster-venv/lib/python3.13/site-packages/SpotipyFr │',
        '│ ee/Formatter.py:139 in formatPlaylist                                        │',
        '│ ❱ 139 │   │   playlist["owner"] = playlist["ownerV2"]["data"]                │',
        '╰──────────────────────────────────────────────────────────────────────────────╯',
        finalLine
    ].join('\n');

    test("KeyError 'ownerV2' without credentials points at config.json", () => {
        const message = SpotDLService.summarizeFailure({
            output: boxedTraceback("KeyError: 'ownerV2'"),
            errorOutput: '',
            code: 1,
            hasCredentials: false
        });
        expect(message).toContain('anonymous Spotify client');
        expect(message).toContain('clientId');
        expect(message.length).toBeLessThan(500);
    });

    test('the newer "Playlist not available" wording is recognized too', () => {
        const message = SpotDLService.summarizeFailure({
            output: boxedTraceback('SpotifyException: Playlist not available or not accessible, make sure it is public.'),
            errorOutput: '',
            code: 1,
            hasCredentials: false
        });
        expect(message).toContain('anonymous Spotify client');
    });

    test('with credentials the playlist breakage message differs', () => {
        const message = SpotDLService.summarizeFailure({
            output: boxedTraceback("KeyError: 'ownerV2'"),
            errorOutput: '',
            code: 1,
            hasCredentials: true
        });
        expect(message).toContain('official Spotify API');
        expect(message).not.toContain('anonymous');
    });

    test('generic failures keep the last error line, bounded', () => {
        const message = SpotDLService.summarizeFailure({
            output: boxedTraceback('AudioProviderError: YT-DLP download error - something else'),
            errorOutput: '',
            code: 1,
            hasCredentials: false
        });
        expect(message).toBe('SpotDL exited with code 1: AudioProviderError: YT-DLP download error - something else');
    });

    test('rate-limit output keeps "429" so command-level detection still works', () => {
        const message = SpotDLService.summarizeFailure({
            output: 'Max Retries reached, too many 429 error responses from Spotify',
            errorOutput: '',
            code: 1,
            hasCredentials: false
        });
        expect(message).toMatch(/429/);
    });

    test('never exceeds a safe Discord reply size', () => {
        const message = SpotDLService.summarizeFailure({
            output: `An error occurred\nSomeError: ${'x'.repeat(5000)}`,
            errorOutput: 'y'.repeat(5000),
            code: 1,
            hasCredentials: false
        });
        expect(message.length).toBeLessThan(400);
    });
});
