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

    test('a genuine too-many-429 is a rate-limit message, not a private-playlist one', () => {
        const message = SpotDLService.summarizeFailure({
            output: 'Max Retries reached, too many 429 error responses from Spotify',
            errorOutput: '',
            code: 1,
            hasCredentials: false
        });
        expect(message).toMatch(/rate limit/i);
        expect(message).toMatch(/credentials/i);
        expect(message).not.toMatch(/private or invite-only/i);
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

    test('spotipy 404-retried-as-429 is a private playlist, not a rate limit', () => {
        const output = [
            'Your application has reached a rate/request limit. Retry will occur after: 0 s',
            'Max Retries reached',
            "MaxRetryError: HTTPSConnectionPool(host='api.spotify.com', port=443): Max retries exceeded with url: /v1/playlists/5UYoV2TL8AWysuMvf4erin?additional_types=track (Caused by ResponseError('too many 404 error responses'))",
            'SpotifyException: http status: 429, code: -1 - /v1/playlists/5UYoV2TL8AWysuMvf4erin?additional_types=track: Max Retries, reason: too many 404 error responses'
        ].join('\n');
        const withCreds = SpotDLService.summarizeFailure({
            output,
            errorOutput: '',
            code: 1,
            hasCredentials: true
        });
        expect(withCreds).toMatch(/private or invite-only/i);
        expect(withCreds).toMatch(/\?pt=/);
        expect(withCreds).not.toMatch(/rate-limited/i);
        expect(withCreds).not.toMatch(/Add .*clientId/i);

        const withoutCreds = SpotDLService.summarizeFailure({
            output,
            errorOutput: '',
            code: 1,
            hasCredentials: false
        });
        expect(withoutCreds).toMatch(/clientId/);
        expect(withoutCreds).toMatch(/public/i);
    });

    test('a genuine too-many-429 is still a rate-limit message', () => {
        const message = SpotDLService.summarizeFailure({
            output: 'Your application has reached a rate/request limit. Retry will occur after: 5 s\ntoo many 429 error responses',
            errorOutput: '',
            code: 1,
            hasCredentials: true
        });
        expect(message).toMatch(/rate-limited/i);
    });
});

describe('userFacingMessage', () => {
    test('rewrites leftover 404-as-429 wording when credentials are already set', () => {
        const message = SpotDLService.userFacingMessage(
            new Error('SpotDL exited with code 1: http status: 429, reason: too many 404 error responses'),
            { hasCredentials: true }
        );
        expect(message).toMatch(/private or invite-only/i);
        expect(message).not.toMatch(/Add .*clientId/i);
    });

    test('passes SpotifyWebError text through unchanged', () => {
        const { SpotifyWebError } = require('@goobster/core/utils/spotifyWebApi');
        const error = new SpotifyWebError('Spotify could not open that playlist or album.', {
            status: 404,
            code: 'PRIVATE_OR_MISSING'
        });
        expect(SpotDLService.userFacingMessage(error, { hasCredentials: true }))
            .toBe(error.message);
    });
});

describe('_resolveDownloadUrls', () => {
    test('leaves tracks and YouTube URLs as a single unexpanded item', async () => {
        const service = new SpotDLService();
        service.spotifyCreds = { clientId: 'id', clientSecret: 'secret' };
        service._listCollectionTrackUrls = jest.fn();
        await expect(service._resolveDownloadUrls('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'))
            .resolves.toEqual({
                urls: ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'],
                expanded: false
            });
        expect(service._listCollectionTrackUrls).not.toHaveBeenCalled();
    });

    test('does not expand playlists when credentials are missing', async () => {
        const service = new SpotDLService();
        service.spotifyCreds = null;
        service._listCollectionTrackUrls = jest.fn();
        const url = 'https://open.spotify.com/playlist/5UYoV2TL8AWysuMvf4erin?pt=abc';
        await expect(service._resolveDownloadUrls(url))
            .resolves.toEqual({ urls: [url], expanded: false });
        expect(service._listCollectionTrackUrls).not.toHaveBeenCalled();
    });

    test('expands a playlist through the official API', async () => {
        const service = new SpotDLService();
        service.spotifyCreds = { clientId: 'id', clientSecret: 'secret' };
        service._listCollectionTrackUrls = jest.fn().mockResolvedValue([
            'https://open.spotify.com/track/aaa',
            'https://open.spotify.com/track/bbb'
        ]);
        const result = await service._resolveDownloadUrls(
            'https://open.spotify.com/playlist/5UYoV2TL8AWysuMvf4erin?pt=abc'
        );
        expect(result).toEqual({
            urls: [
                'https://open.spotify.com/track/aaa',
                'https://open.spotify.com/track/bbb'
            ],
            expanded: true
        });
        expect(service._listCollectionTrackUrls).toHaveBeenCalledWith(
            'https://open.spotify.com/playlist/5UYoV2TL8AWysuMvf4erin?pt=abc',
            expect.objectContaining({
                clientId: 'id',
                clientSecret: 'secret',
                tokenCache: service._spotifyTokenCache
            })
        );
    });

    test('throws when expansion finds no downloadable tracks', async () => {
        const service = new SpotDLService();
        service.spotifyCreds = { clientId: 'id', clientSecret: 'secret' };
        service._listCollectionTrackUrls = jest.fn().mockResolvedValue([]);
        await expect(service._resolveDownloadUrls('https://open.spotify.com/playlist/empty'))
            .rejects.toThrow(/no downloadable tracks/i);
    });
});

describe('downloadTrack batching', () => {
    test('downloads an expanded playlist in batches and keeps going after a failed batch', async () => {
        const service = new SpotDLService();
        service.spotifyCreds = { clientId: 'id', clientSecret: 'secret' };
        service._batchPauseMs = 0;
        service._batchSize = 15;
        service.validateUrl = jest.fn().mockResolvedValue({ type: 'spotify', isValid: true });
        service.ensureMusicDir = jest.fn().mockResolvedValue();
        const urls = Array.from({ length: 32 }, (_, i) => `https://open.spotify.com/track/${i}`);
        service._resolveDownloadUrls = jest.fn().mockResolvedValue({ urls, expanded: true });
        service._runSpotdlDownload = jest.fn()
            .mockResolvedValueOnce([{ name: 'a.mp3', url: '/music/a.mp3' }])
            .mockRejectedValueOnce(new Error('SpotDL exited with code 1: batch boom'))
            .mockResolvedValueOnce([{ name: 'c.mp3', url: '/music/c.mp3' }]);

        const readdir = jest.spyOn(require('fs').promises, 'readdir')
            .mockResolvedValue([]);

        const tracks = await service.downloadTrack('https://open.spotify.com/playlist/big');
        expect(service._runSpotdlDownload).toHaveBeenCalledTimes(3);
        expect(service._runSpotdlDownload.mock.calls[0][0]).toHaveLength(15);
        expect(service._runSpotdlDownload.mock.calls[1][0]).toHaveLength(15);
        expect(service._runSpotdlDownload.mock.calls[2][0]).toHaveLength(2);
        expect(service._runSpotdlDownload.mock.calls[0][1].failSoft).toBe(true);
        expect(tracks.map(t => t.name)).toEqual(['a.mp3', 'c.mp3']);
        readdir.mockRestore();
    });

    test('rethrows the first batch error when every batch fails', async () => {
        const service = new SpotDLService();
        service._batchPauseMs = 0;
        service.validateUrl = jest.fn().mockResolvedValue({ type: 'spotify', isValid: true });
        service.ensureMusicDir = jest.fn().mockResolvedValue();
        service._resolveDownloadUrls = jest.fn().mockResolvedValue({
            urls: ['https://open.spotify.com/track/1', 'https://open.spotify.com/track/2'],
            expanded: true
        });
        const boom = new Error('SpotDL exited with code 1: all dead');
        service._runSpotdlDownload = jest.fn().mockRejectedValue(boom);
        const readdir = jest.spyOn(require('fs').promises, 'readdir').mockResolvedValue([]);

        await expect(service.downloadTrack('https://open.spotify.com/playlist/dead'))
            .rejects.toThrow(/all dead/);
        readdir.mockRestore();
    });

    test('does not batch an unexpanded single URL', async () => {
        const service = new SpotDLService();
        service._batchPauseMs = 0;
        service.validateUrl = jest.fn().mockResolvedValue({ type: 'spotify', isValid: true });
        service.ensureMusicDir = jest.fn().mockResolvedValue();
        const url = 'https://open.spotify.com/track/abc';
        service._resolveDownloadUrls = jest.fn().mockResolvedValue({ urls: [url], expanded: false });
        service._runSpotdlDownload = jest.fn().mockResolvedValue([{ name: 'one.mp3', url: '/music/one.mp3' }]);
        const readdir = jest.spyOn(require('fs').promises, 'readdir').mockResolvedValue([]);

        await service.downloadTrack(url);
        expect(service._runSpotdlDownload).toHaveBeenCalledTimes(1);
        expect(service._runSpotdlDownload.mock.calls[0][0]).toEqual([url]);
        expect(service._runSpotdlDownload.mock.calls[0][1].failSoft).toBe(false);
        readdir.mockRestore();
    });
});
