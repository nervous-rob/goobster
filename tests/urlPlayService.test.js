const { UrlPlayService, classifyUrl } = require('../services/urlPlayService');
const SpotDLService = require('../services/spotdl/spotdlService');
const YtDlpService = require('../services/ytdlp/ytdlpService');

describe('classifyUrl', () => {
    test.each([
        ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'spotify', 'track'],
        ['https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=abc', 'spotify', 'track'],
        ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'spotify', 'playlist'],
        ['https://open.spotify.com/album/6dVIqQ8qmQ5GBnJ9shOYGE', 'spotify', 'album'],
        ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'video'],
        ['https://youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'video'],
        ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'video'],
        ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'video'],
        ['https://youtu.be/dQw4w9WgXcQ?si=xyz', 'youtube', 'video'],
        ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'video'],
        // A watch URL with &list= plays the selected video, not the playlist
        ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123abc', 'youtube', 'video'],
        ['https://www.youtube.com/playlist?list=PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj', 'youtube', 'playlist'],
        ['https://music.youtube.com/playlist?list=PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj', 'youtube', 'playlist']
    ])('%s -> %s %s', (url, source, kind) => {
        expect(classifyUrl(url)).toEqual({ source, kind });
    });

    test.each([
        [null],
        [undefined],
        [''],
        ['not a url'],
        ['https://example.com/watch?v=dQw4w9WgXcQ'],
        ['https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt'],
        ['http://www.youtube.com/watch?v=dQw4w9WgXcQ'], // http (not https)
        ['https://www.youtube.com/playlist'], // no list param
        ['https://vimeo.com/12345']
    ])('unsupported: %s -> null', (url) => {
        expect(classifyUrl(url)).toBeNull();
    });
});

describe('UrlPlayService.streamTracks', () => {
    const makeService = () => {
        const spotdlService = { downloadTrack: jest.fn().mockResolvedValue([{ name: 'A - B.mp3', url: '/x/A - B.mp3' }]) };
        const ytdlpService = { downloadAudio: jest.fn().mockResolvedValue([{ name: 'C - D.mp3', url: '/x/C - D.mp3' }]) };
        return { service: new UrlPlayService({ spotdlService, ytdlpService }), spotdlService, ytdlpService };
    };

    test('routes YouTube videos to yt-dlp without playlist expansion', async () => {
        const { service, ytdlpService, spotdlService } = makeService();
        const onTrack = jest.fn();
        const result = await service.streamTracks('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { onTrack });

        expect(ytdlpService.downloadAudio).toHaveBeenCalledWith(
            'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            { playlist: false, onTrack }
        );
        expect(spotdlService.downloadTrack).not.toHaveBeenCalled();
        expect(result.classification).toEqual({ source: 'youtube', kind: 'video' });
        expect(result.tracks).toHaveLength(1);
    });

    test('routes YouTube playlists to yt-dlp with playlist expansion', async () => {
        const { service, ytdlpService } = makeService();
        await service.streamTracks('https://www.youtube.com/playlist?list=PL123abc');

        expect(ytdlpService.downloadAudio).toHaveBeenCalledWith(
            'https://www.youtube.com/playlist?list=PL123abc',
            { playlist: true, onTrack: undefined }
        );
    });

    test('routes Spotify URLs to spotdl', async () => {
        const { service, spotdlService, ytdlpService } = makeService();
        const onTrack = jest.fn();
        const result = await service.streamTracks('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', { onTrack });

        expect(spotdlService.downloadTrack).toHaveBeenCalledWith(
            'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
            { onTrack }
        );
        expect(ytdlpService.downloadAudio).not.toHaveBeenCalled();
        expect(result.classification).toEqual({ source: 'spotify', kind: 'playlist' });
    });

    test('rejects unsupported URLs', async () => {
        const { service } = makeService();
        await expect(service.streamTracks('https://example.com/song')).rejects.toThrow(/Unsupported URL/);
    });
});

describe('SpotDLService.parseResolvedTrackName', () => {
    test('parses freshly downloaded tracks', () => {
        expect(SpotDLService.parseResolvedTrackName('Downloaded "Rick Astley - Never Gonna Give You Up": https://youtu.be/x'))
            .toBe('Rick Astley - Never Gonna Give You Up.mp3');
    });

    test('parses tracks skipped because the file already exists', () => {
        expect(SpotDLService.parseResolvedTrackName('Skipping Rick Astley - Never Gonna Give You Up (file already exists) '))
            .toBe('Rick Astley - Never Gonna Give You Up.mp3');
        expect(SpotDLService.parseResolvedTrackName('Skipping Daft Punk - One More Time (file already exists) (duplicate)'))
            .toBe('Daft Punk - One More Time.mp3');
    });

    test('parses tracks skipped due to a skip file', () => {
        expect(SpotDLService.parseResolvedTrackName('Skipping Some Artist - Song (skip file found) '))
            .toBe('Some Artist - Song.mp3');
    });

    test('ignores unrelated lines', () => {
        expect(SpotDLService.parseResolvedTrackName('Processing query: ...')).toBeNull();
        expect(SpotDLService.parseResolvedTrackName('Skipping explicit song: X')).toBeNull();
        expect(SpotDLService.parseResolvedTrackName('')).toBeNull();
    });
});

describe('YtDlpService.dedupeArtistPrefixName', () => {
    test('collapses a duplicated artist prefix', () => {
        expect(YtDlpService.dedupeArtistPrefixName('Rick Astley - Rick Astley - Never Gonna Give You Up (Official Video).mp3'))
            .toBe('Rick Astley - Never Gonna Give You Up (Official Video).mp3');
    });

    test('is case-insensitive on the artist match', () => {
        expect(YtDlpService.dedupeArtistPrefixName('RICK ASTLEY - Rick Astley - Song.mp3'))
            .toBe('Rick Astley - Song.mp3');
    });

    test('leaves clean names untouched', () => {
        expect(YtDlpService.dedupeArtistPrefixName('Rick Astley - Never Gonna Give You Up.mp3'))
            .toBe('Rick Astley - Never Gonna Give You Up.mp3');
        expect(YtDlpService.dedupeArtistPrefixName('NoSeparatorTitle.mp3'))
            .toBe('NoSeparatorTitle.mp3');
    });
});
