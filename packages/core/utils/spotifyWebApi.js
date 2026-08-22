/**
 * Spotify playlist/album expansion.
 *
 * February 2026 Web API change: GET /v1/playlists/{id}/tracks is gone, and
 * GET /v1/playlists/{id}/items only returns contents for playlists the
 * authenticated *user* owns or collaborates on. Client-credentials has no
 * user, so that path 403s for every playlist. Public playlists are expanded
 * from the embed page (`__NEXT_DATA__.trackList`) instead — we do not call
 * /items at all, because a valid client-credentials token still 401s there
 * and that was being reported as "check your clientId/clientSecret".
 * Albums still use the official /v1/albums/{id}/tracks endpoint.
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

const PLAYLIST_UNREADABLE =
    'Spotify will not list that playlist. Since Feb 2026 the official API '
    + 'only returns items for playlists you own, and this one is not on the '
    + 'public embed page either (invite links with ?pt= do not count). Make '
    + 'the playlist public in Spotify, wait a minute, and paste the link '
    + 'again. Albums and single tracks still work.';

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
 * GET a Spotify Web API path with 429 backoff. 403/404 are not retried —
 * /playlists/{id}/tracks is gone (403) and private lists 404.
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
        if (response.status === 403 || response.status === 404) {
            throw new SpotifyWebError(PLAYLIST_UNREADABLE, {
                status: response.status,
                code: 'PRIVATE_OR_MISSING'
            });
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

function unwrapTrack(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.item && typeof item.item === 'object') return item.item;
    if (item.track && typeof item.track === 'object') return item.track;
    return item;
}

function trackUrlFromItem(item) {
    const track = unwrapTrack(item);
    if (!track || track.type && track.type !== 'track') return null;
    const id = track.id || (typeof track.uri === 'string' && track.uri.startsWith('spotify:track:')
        ? track.uri.slice('spotify:track:'.length)
        : null);
    if (!id || track.is_local) return null;
    return `https://open.spotify.com/track/${id}`;
}

/**
 * Pull track URLs out of an embed-page `__NEXT_DATA__` blob.
 * @param {string} html
 * @returns {string[]}
 */
function parseEmbedTrackUrls(html) {
    const match = String(html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return [];
    let data;
    try {
        data = JSON.parse(match[1]);
    } catch {
        return [];
    }
    if (data?.props?.pageProps?.status === 404) return [];
    const list = data?.props?.pageProps?.state?.data?.entity?.trackList;
    if (!Array.isArray(list)) return [];
    const urls = [];
    for (const row of list) {
        const uri = typeof row?.uri === 'string' ? row.uri : '';
        const idMatch = uri.match(/^spotify:track:([A-Za-z0-9]+)$/);
        if (idMatch && !urls.includes(`https://open.spotify.com/track/${idMatch[1]}`)) {
            urls.push(`https://open.spotify.com/track/${idMatch[1]}`);
        }
    }
    return urls;
}

/**
 * @param {string} playlistId
 * @param {{fetchImpl?: typeof fetch, maxItems?: number}} [opts]
 * @returns {Promise<string[]>}
 */
async function listPlaylistTrackUrlsFromEmbed(playlistId, { fetchImpl = fetch, maxItems = Infinity } = {}) {
    const response = await fetchImpl(`https://open.spotify.com/embed/playlist/${playlistId}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html'
        }
    });
    const html = typeof response.text === 'function'
        ? await response.text()
        : '';
    const urls = parseEmbedTrackUrls(html);
    if (urls.length === 0) {
        throw new SpotifyWebError(PLAYLIST_UNREADABLE, {
            status: response.status === 404 ? 404 : 403,
            code: 'PRIVATE_OR_MISSING'
        });
    }
    const cap = Number(maxItems) > 0 && Number.isFinite(Number(maxItems))
        ? Number(maxItems)
        : urls.length;
    return urls.slice(0, cap);
}

async function paginateOfficialCollection(firstPath, { accessToken, fetchImpl, maxItems }) {
    const urls = [];
    let path = firstPath;
    while (path && urls.length < maxItems) {
        const page = await spotifyGet(path, { accessToken, fetchImpl });
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

/**
 * Expand a Spotify playlist or album URL into canonical track URLs.
 * Single-track URLs return a one-element array. Playlists prefer the
 * public embed page (official /items 401s/403s for client-credentials).
 *
 * @param {string} url
 * @param {{clientId?: string, clientSecret?: string, fetchImpl?: typeof fetch, maxItems?: number, tokenCache?: {accessToken?: string, expiresAt?: number}}} opts
 * @returns {Promise<string[]>}
 */
async function listCollectionTrackUrls(url, opts = {}) {
    const parsed = parseSpotifyUrl(url);
    if (!parsed) {
        throw new SpotifyWebError('Not a Spotify track, playlist, or album URL.', { code: 'BAD_URL' });
    }
    if (parsed.kind === 'track') return [parsed.canonicalUrl];

    const maxItems = Number(opts.maxItems) > 0 ? Number(opts.maxItems) : Infinity;
    const fetchImpl = opts.fetchImpl || fetch;

    if (parsed.kind === 'playlist') {
        // Client-credentials tokens are accepted by /api/token and then
        // rejected with 401 on /playlists/{id}/items (no user = not owner).
        // That is not a config typo — skip the official call.
        return listPlaylistTrackUrlsFromEmbed(parsed.id, { fetchImpl, maxItems });
    }

    if (!opts.clientId || !opts.clientSecret) {
        throw new SpotifyWebError(
            'Spotify album lookup needs spotify.clientId/clientSecret in config.json.',
            { code: 'BAD_CREDENTIALS' }
        );
    }
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
    return paginateOfficialCollection(
        `/v1/albums/${parsed.id}/tracks?limit=50`,
        { accessToken: cache.accessToken, fetchImpl, maxItems }
    );
}

module.exports = {
    SpotifyWebError,
    PLAYLIST_UNREADABLE,
    parseSpotifyUrl,
    fetchClientCredentialsToken,
    spotifyGet,
    parseEmbedTrackUrls,
    listPlaylistTrackUrlsFromEmbed,
    listCollectionTrackUrls
};
