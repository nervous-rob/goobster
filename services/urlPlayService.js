const SpotDLService = require('./spotdl/spotdlService');
const YtDlpService = require('./ytdlp/ytdlpService');

/**
 * URL play service: classify a pasted music URL and stream its tracks into
 * the local music library, reusing MP3s that already exist.
 *
 * - YouTube video/playlist URLs download via yt-dlp (audio extracted to MP3).
 * - Spotify track/playlist/album URLs download via spotdl (which skips songs
 *   already in data/music).
 *
 * Tracks are reported through an onTrack callback as each becomes available
 * on disk, so playback can start immediately while the rest of a playlist is
 * still downloading.
 */

/**
 * Classify a music URL.
 * @param {string} url
 * @returns {{source: 'spotify'|'youtube', kind: 'track'|'playlist'|'album'|'video'}|null}
 *          null when the URL is not a supported Spotify/YouTube link
 */
function classifyUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();

    const spotifyMatch = trimmed.match(/^https:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?(track|playlist|album)\/[a-zA-Z0-9]+/);
    if (spotifyMatch) {
        return { source: 'spotify', kind: spotifyMatch[1] };
    }

    // Standalone playlist pages (no video selected)
    if (/^https:\/\/(?:www\.|music\.)?youtube\.com\/playlist\?/.test(trimmed) &&
        /[?&]list=[a-zA-Z0-9_-]+/.test(trimmed)) {
        return { source: 'youtube', kind: 'playlist' };
    }

    // Watch pages and short links play the single video, even when a
    // &list= parameter is present (the user clicked a specific video).
    if (/^https:\/\/(?:www\.|music\.|m\.)?youtube\.com\/watch\?/.test(trimmed) &&
        /[?&]v=[a-zA-Z0-9_-]+/.test(trimmed)) {
        return { source: 'youtube', kind: 'video' };
    }
    if (/^https:\/\/(?:www\.)?youtu\.be\/[a-zA-Z0-9_-]+/.test(trimmed)) {
        return { source: 'youtube', kind: 'video' };
    }
    if (/^https:\/\/(?:www\.|music\.)?youtube\.com\/(?:shorts|live)\/[a-zA-Z0-9_-]+/.test(trimmed)) {
        return { source: 'youtube', kind: 'video' };
    }

    return null;
}

class UrlPlayService {
    constructor({ spotdlService, ytdlpService } = {}) {
        this.spotdlService = spotdlService || new SpotDLService();
        this.ytdlpService = ytdlpService || new YtDlpService();
    }

    /**
     * Resolve every track behind a URL into the local music library,
     * invoking onTrack as each file becomes playable.
     *
     * @param {string} url a supported Spotify or YouTube URL
     * @param {object} [options]
     * @param {(track: {name: string, url: string}) => (void|Promise<void>)} [options.onTrack]
     * @returns {Promise<{tracks: Array<{name: string, url: string}>, classification: {source: string, kind: string}}>}
     */
    async streamTracks(url, { onTrack } = {}) {
        const classification = classifyUrl(url);
        if (!classification) {
            throw new Error('Unsupported URL. Please provide a YouTube video/playlist or Spotify track/playlist/album link.');
        }

        let tracks;
        if (classification.source === 'youtube') {
            tracks = await this.ytdlpService.downloadAudio(url, {
                playlist: classification.kind === 'playlist',
                onTrack
            });
        } else {
            tracks = await this.spotdlService.downloadTrack(url, { onTrack });
        }

        return { tracks, classification };
    }
}

module.exports = { UrlPlayService, classifyUrl };
