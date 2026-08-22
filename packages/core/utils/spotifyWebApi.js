/**
 * Official Spotify Web API helpers (client-credentials).
 *
 * Used to expand playlists/albums into track URLs so spotdl never has to
 * call GET /v1/playlists/{id} itself. That endpoint 404s for private and
 * invite-only playlists (share links with ?pt=); spotipy then retries the
 * 404 until it reports a fake 429 ("too many 404 error responses").
 */

class SpotifyWebError extends Error {
    /**
     * @param {string} message
     * @param {{status?: number, code?: string}} [meta]
     */
    constructor(message, { status = 0, code = 'SPOTIFY_ERROR' } = {}) {
        super(message);
        this.name = 'SpotifyWebError';
        this.status = status;
        this.code = code;
    }
}

/**
 * @param {string} url
 * @returns {{kind: 'track'|'playlist'|'album', id: string, pt: string|null, canonicalUrl: string}|null}
 */
function parseSpotifyUrl(url) {
    const trimmed = String(url || '').trim();
    const match = trimmed.match(
        /^https:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?(track|playlist|album)\/([a-zA-Z0-9]+)/
    );
    if (!match) return null;
    let pt = null;
    try {
        pt = new URL(trimmed).searchParams.get('pt');
    } catch {
        // ignore malformed query
    }
    return {
        kind: match[1],
        id: match[2],
        pt,
        canonicalUrl: `https://open.spotify.com/${match[1]}/${match[2]}`
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @param {{clientId: string, clientSecret: string, fetchImpl?: typeof fetch}} creds
 * @returns {Promise<{accessToken: string, expiresAt: number}>}
 */
async function fetchClientCredentialsToken({ clientId, clientSecret, fetchImpl = fetch }) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetchImpl('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
        throw new SpotifyWebError(
            'Spotify rejected the client-credentials login. Check spotify.clientId/clientSecret in config.json.',
            { status: response.status, code: 'BAD_CREDENTIALS' }
        );
    }
    const expiresIn = Number(body.expires_in) || 3600;
    return {
        accessToken: body.access_token,
        expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000
    };
}

/**
 * GET a Spotify Web API path with 429 backoff. 404 is not retried — Spotify
 * uses it for private/inaccessible playlists, and retrying produces the
 * "too many 404 error responses" / fake-429 spotipy reports.
 *
 * @param {string} path path beginning with /v1/
 * @param {{accessToken: string, fetchImpl?: typeof fetch, retries?: number}} opts
 */
async function spotifyGet(path, { accessToken, fetchImpl = fetch, retries = 5 }) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const response = await fetchImpl(`https://api.spotify.com${path}`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (response.status === 429) {
            const retryAfter = Number(response.headers.get('retry-after'));
            const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0
                ? Math.min(retryAfter, 30) * 1000
                : 1000 * (2 ** attempt);
            lastError = new SpotifyWebError(
                'Spotify rate-limited the playlist lookup. Wait a minute and try again.',
                { status: 429, code: 'RATE_LIMIT' }
            );
            if (attempt === retries) break;
            await sleep(waitMs);
            continue;
        }
        if (response.status === 401) {
            throw new SpotifyWebError(
                'Spotify rejected the access token. Check spotify.clientId/clientSecret in config.json.',
                { status: 401, code: 'BAD_CREDENTIALS' }
            );
        }
        if (response.status === 404) {
            throw new SpotifyWebError(
                'Spotify could not open that playlist or album. The official API returns 404 for private or invite-only playlists (share links with ?pt=) and missing albums. Make the playlist public, or paste a public playlist/album/track link.',
                { status: 404, code: 'PRIVATE_OR_MISSING' }
            );
        }
        if (!response.ok) {
            throw new SpotifyWebError(
                `Spotify API ${response.status} for ${path}`,
                { status: response.status, code: 'SPOTIFY_ERROR' }
            );
        }
        return response.json();
    }
    throw lastError;
}

function trackUrlFromItem(item) {
    const track = item?.track && typeof item.track === 'object' ? item.track : item;
    if (!track || track.type && track.type !== 'track') return null;
    const id = track.id || (typeof track.uri === 'string' && track.uri.startsWith('spotify:track:')
        ? track.uri.slice('spotify:track:'.length)
        : null);
    if (!id || track.is_local) return null;
    return `https://open.spotify.com/track/${id}`;
}

/**
 * Expand a Spotify playlist or album URL into canonical track URLs.
 * Single-track URLs return a one-element array. Pagination follows
 * `next` / offset until exhausted or maxItems is reached (0 = no cap).
 *
 * @param {string} url
 * @param {{clientId: string, clientSecret: string, fetchImpl?: typeof fetch, maxItems?: number, tokenCache?: {accessToken?: string, expiresAt?: number}}} opts
 * @returns {Promise<string[]>}
 */
async function listCollectionTrackUrls(url, opts) {
    const parsed = parseSpotifyUrl(url);
    if (!parsed) {
        throw new SpotifyWebError('Not a Spotify track, playlist, or album URL.', { code: 'BAD_URL' });
    }
    if (parsed.kind === 'track') return [parsed.canonicalUrl];

    const maxItems = Number(opts.maxItems) > 0 ? Number(opts.maxItems) : Infinity;
    const fetchImpl = opts.fetchImpl || fetch;
    const cache = opts.tokenCache || {};
    if (!cache.accessToken || !cache.expiresAt || cache.expiresAt <= Date.now()) {
        const fresh = await fetchClientCredentialsToken({
            clientId: opts.clientId,
            clientSecret: opts.clientSecret,
            fetchImpl
        });
        cache.accessToken = fresh.accessToken;
        cache.expiresAt = fresh.expiresAt;
    }

    const firstPath = parsed.kind === 'playlist'
        ? `/v1/playlists/${parsed.id}/tracks?limit=100&additional_types=track`
        : `/v1/albums/${parsed.id}/tracks?limit=50`;

    const urls = [];
    let path = firstPath;
    while (path && urls.length < maxItems) {
        const page = await spotifyGet(path, { accessToken: cache.accessToken, fetchImpl });
        const items = Array.isArray(page.items) ? page.items : [];
        for (const item of items) {
            const trackUrl = trackUrlFromItem(item);
            if (trackUrl && !urls.includes(trackUrl)) urls.push(trackUrl);
            if (urls.length >= maxItems) break;
        }
        if (!page.next || urls.length >= maxItems) break;
        try {
            path = new URL(page.next).pathname + new URL(page.next).search;
        } catch {
            break;
        }
    }
    return urls;
}

module.exports = {
    SpotifyWebError,
    parseSpotifyUrl,
    fetchClientCredentialsToken,
    spotifyGet,
    listCollectionTrackUrls
};
