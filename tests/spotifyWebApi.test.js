const {
    parseSpotifyUrl,
    spotifyGet,
    listCollectionTrackUrls,
    parseEmbedTrackUrls,
    PLAYLIST_UNREADABLE
} = require('@goobster/core/utils/spotifyWebApi');

function jsonResponse(status, body, headers = {}) {
    const raw = JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => headers[name.toLowerCase()] || null },
        json: async () => body,
        text: async () => raw
    };
}

function htmlResponse(status, html) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => html
    };
}

function embedHtml(trackList, { status } = {}) {
    const payload = status === 404
        ? { props: { pageProps: { status: 404, title: 'Page not found' } } }
        : {
            props: {
                pageProps: {
                    state: { data: { entity: { type: 'playlist', trackList } } }
                }
            }
        };
    return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></html>`;
}

describe('parseSpotifyUrl', () => {
    test('parses a playlist share link including the ?pt= invite token', () => {
        const parsed = parseSpotifyUrl(
            'https://open.spotify.com/playlist/5UYoV2TL8AWysuMvf4erin?si=8d469c7379cb4d54&pt=e4b7da2371ff054be2940cc64212d4fb'
        );
        expect(parsed).toEqual({
            kind: 'playlist',
            id: '5UYoV2TL8AWysuMvf4erin',
            pt: 'e4b7da2371ff054be2940cc64212d4fb',
            canonicalUrl: 'https://open.spotify.com/playlist/5UYoV2TL8AWysuMvf4erin'
        });
    });

    test('parses intl locale track and album URLs', () => {
        expect(parseSpotifyUrl('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=abc')).toMatchObject({
            kind: 'track',
            id: '4uLU6hMCjMI75M1A2tKUQC',
            pt: null
        });
        expect(parseSpotifyUrl('https://open.spotify.com/album/6dVIqQ8qmQ5GBnJ9shOYGE')).toMatchObject({
            kind: 'album',
            id: '6dVIqQ8qmQ5GBnJ9shOYGE'
        });
    });

    test('rejects unsupported URLs', () => {
        expect(parseSpotifyUrl('https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt')).toBeNull();
        expect(parseSpotifyUrl('not a url')).toBeNull();
    });
});

describe('spotifyGet', () => {
    test('does not retry a 404 (private / invite-only playlist)', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(404, { error: { status: 404 } }));
        await expect(spotifyGet('/v1/playlists/abc/items', {
            accessToken: 'tok',
            fetchImpl
        })).rejects.toMatchObject({
            name: 'SpotifyWebError',
            status: 404,
            code: 'PRIVATE_OR_MISSING'
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('does not retry a 403 (removed /tracks endpoint or non-owned playlist)', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(403, { error: { status: 403, message: 'Forbidden' } }));
        await expect(spotifyGet('/v1/playlists/abc/tracks?limit=100&additional_types=track', {
            accessToken: 'tok',
            fetchImpl
        })).rejects.toMatchObject({
            name: 'SpotifyWebError',
            status: 403,
            code: 'PRIVATE_OR_MISSING',
            message: PLAYLIST_UNREADABLE
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('retries a real 429 then succeeds', async () => {
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': '0' }))
            .mockResolvedValueOnce(jsonResponse(200, { items: [] }));
        const page = await spotifyGet('/v1/playlists/abc/tracks', {
            accessToken: 'tok',
            fetchImpl
        });
        expect(page).toEqual({ items: [] });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe('listCollectionTrackUrls', () => {
    const creds = { clientId: 'id', clientSecret: 'secret' };

    test('expands playlists from the embed page and does not call the official API', async () => {
        const fetchImpl = jest.fn((url) => {
            if (url.includes('open.spotify.com/embed/playlist/biglist')) {
                return htmlResponse(200, embedHtml([
                    { uri: 'spotify:track:aaa111aaa111aaa111aaa1' },
                    { uri: 'spotify:episode:nope' },
                    { uri: 'spotify:track:bbb222bbb222bbb222bbb2' }
                ]));
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        const urls = await listCollectionTrackUrls(
            'https://open.spotify.com/playlist/biglist?pt=invite',
            { ...creds, fetchImpl }
        );
        expect(urls).toEqual([
            'https://open.spotify.com/track/aaa111aaa111aaa111aaa1',
            'https://open.spotify.com/track/bbb222bbb222bbb222bbb2'
        ]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls.some(([url]) => url.includes('api.spotify.com') || url.includes('accounts.spotify.com'))).toBe(false);
    });

    test('paginates album tracks and skips local / non-track items', async () => {
        const fetchImpl = jest.fn((url) => {
            if (url === 'https://accounts.spotify.com/api/token') {
                return jsonResponse(200, { access_token: 'tok', expires_in: 3600 });
            }
            if (url.includes('/albums/bigalbum/tracks') && !url.includes('offset=')) {
                return jsonResponse(200, {
                    items: [
                        { id: 'aaa', type: 'track' },
                        { id: 'local1', type: 'track', is_local: true },
                        { id: 'epi', type: 'episode' }
                    ],
                    next: 'https://api.spotify.com/v1/albums/bigalbum/tracks?offset=50&limit=50'
                });
            }
            if (url.includes('offset=50')) {
                return jsonResponse(200, {
                    items: [{ uri: 'spotify:track:bbb', type: 'track' }],
                    next: null
                });
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        const urls = await listCollectionTrackUrls(
            'https://open.spotify.com/album/bigalbum',
            { ...creds, fetchImpl }
        );
        expect(urls).toEqual([
            'https://open.spotify.com/track/aaa',
            'https://open.spotify.com/track/bbb'
        ]);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    test('returns a single-track URL without calling the API', async () => {
        const fetchImpl = jest.fn();
        const urls = await listCollectionTrackUrls(
            'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
            { ...creds, fetchImpl }
        );
        expect(urls).toEqual(['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC']);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('honors maxItems on the embed track list', async () => {
        const fetchImpl = jest.fn((url) => {
            if (url.includes('open.spotify.com/embed/playlist/p')) {
                return htmlResponse(200, embedHtml([
                    { uri: 'spotify:track:aaa111aaa111aaa111aaa1' },
                    { uri: 'spotify:track:bbb222bbb222bbb222bbb2' },
                    { uri: 'spotify:track:ccc333ccc333ccc333ccc3' }
                ]));
            }
            throw new Error(`unexpected fetch ${url}`);
        });
        const urls = await listCollectionTrackUrls(
            'https://open.spotify.com/playlist/p',
            { ...creds, fetchImpl, maxItems: 2 }
        );
        expect(urls).toEqual([
            'https://open.spotify.com/track/aaa111aaa111aaa111aaa1',
            'https://open.spotify.com/track/bbb222bbb222bbb222bbb2'
        ]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('reuses a still-valid token cache', async () => {
        const fetchImpl = jest.fn((url) => {
            if (url.includes('/albums/')) {
                return jsonResponse(200, {
                    items: [{ id: 't1', type: 'track' }],
                    next: null
                });
            }
            throw new Error(`unexpected fetch ${url}`);
        });
        const tokenCache = { accessToken: 'cached', expiresAt: Date.now() + 60_000 };
        const urls = await listCollectionTrackUrls(
            'https://open.spotify.com/album/6dVIqQ8qmQ5GBnJ9shOYGE',
            { ...creds, fetchImpl, tokenCache }
        );
        expect(urls).toEqual(['https://open.spotify.com/track/t1']);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('does not treat an official /items 401 as bad credentials (never calls it)', async () => {
        const fetchImpl = jest.fn((url) => {
            if (url.includes('accounts.spotify.com') || url.includes('api.spotify.com')) {
                throw new Error(`official API should not be called for playlists: ${url}`);
            }
            if (url.includes('open.spotify.com/embed/playlist/public1')) {
                return htmlResponse(200, embedHtml([
                    { uri: 'spotify:track:aaa111aaa111aaa111aaa1' }
                ]));
            }
            throw new Error(`unexpected fetch ${url}`);
        });
        const urls = await listCollectionTrackUrls(
            'https://open.spotify.com/playlist/public1',
            { ...creds, fetchImpl }
        );
        expect(urls).toEqual(['https://open.spotify.com/track/aaa111aaa111aaa111aaa1']);
    });

    test('expands a playlist from the embed page without credentials', async () => {
        const fetchImpl = jest.fn((url) => {
            if (url.includes('open.spotify.com/embed/playlist/nocreds')) {
                return htmlResponse(200, embedHtml([{ uri: 'spotify:track:ccc333ccc333ccc333ccc3' }]));
            }
            throw new Error(`unexpected fetch ${url}`);
        });
        const urls = await listCollectionTrackUrls(
            'https://open.spotify.com/playlist/nocreds',
            { fetchImpl }
        );
        expect(urls).toEqual(['https://open.spotify.com/track/ccc333ccc333ccc333ccc3']);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('surfaces an embed-404 as a public-playlist error, not a credentials error', async () => {
        const fetchImpl = jest.fn((url) => {
            if (url.includes('accounts.spotify.com') || url.includes('api.spotify.com')) {
                throw new Error(`official API should not be called for playlists: ${url}`);
            }
            return htmlResponse(200, embedHtml([], { status: 404 }));
        });
        await expect(listCollectionTrackUrls(
            'https://open.spotify.com/playlist/5UYoV2TL8AWysuMvf4erin?si=88e40f0e42f04497',
            { ...creds, fetchImpl }
        )).rejects.toMatchObject({
            name: 'SpotifyWebError',
            code: 'PRIVATE_OR_MISSING',
            message: PLAYLIST_UNREADABLE
        });
    });
});

describe('parseEmbedTrackUrls', () => {
    test('reads trackList uris and ignores a 404 embed page', () => {
        expect(parseEmbedTrackUrls(embedHtml([
            { uri: 'spotify:track:abc' },
            { uri: 'spotify:track:abc' },
            { uri: 'spotify:local:x' }
        ]))).toEqual(['https://open.spotify.com/track/abc']);
        expect(parseEmbedTrackUrls(embedHtml([], { status: 404 }))).toEqual([]);
        expect(parseEmbedTrackUrls('<html>no data</html>')).toEqual([]);
    });
});
