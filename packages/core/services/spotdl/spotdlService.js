const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const { resolveCliCommand } = require('../../utils/cliResolver');
const {
    parseSpotifyUrl,
    listCollectionTrackUrls,
    SpotifyWebError
} = require('../../utils/spotifyWebApi');

let config = {};
try {
    config = require('../../../../config.json');
} catch {
    // Config is optional at module load time (e.g. during tests)
}

/**
 * SpotDL service (local storage edition).
 *
 * Downloads tracks with the system-installed spotdl CLI and keeps them on the
 * local filesystem under data/music. The previous Azure Blob Storage layer was
 * removed for self-hosted deployments (e.g. Raspberry Pi); local file paths
 * work directly with @discordjs/voice audio resources.
 */
class SpotDLService {
    constructor() {
        this.musicDir = path.join(process.cwd(), 'data', 'music');
        this._resolvedCommand = null;
        this._resolvedVersion = null;

        // Spotify credentials are passed to the spotdl CLI as
        // --client-id/--client-secret flags (it does not read env vars).
        // Without them spotdl falls back to its shared default app, which is
        // frequently rate-limited (429s). Env fallback matches other keys.
        const clientId = config.spotify?.clientId || process.env.SPOTIFY_CLIENT_ID;
        const clientSecret = config.spotify?.clientSecret || process.env.SPOTIFY_CLIENT_SECRET;
        if (clientId && clientSecret) {
            this.spotifyCreds = { clientId, clientSecret };
        } else {
            this.spotifyCreds = null;
            console.warn('Spotify credentials not found in config.json. SpotDL downloads may not work without them.');
        }
        this._spotifyTokenCache = {};
        // Pause between playlist batches so Spotify/YouTube Music don't
        // immediately 429 a large public list. Tests set this to 0.
        this._batchPauseMs = 1500;
        this._batchSize = Number(config.spotdl?.batchSize) > 0
            ? Number(config.spotdl.batchSize)
            : 15;
    }

    /**
     * Extract a dotted version ("4.5.2") from `spotdl --version` output.
     * @param {string} text
     * @returns {string|null}
     */
    static parseVersion(text) {
        const match = String(text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
        return match ? match[0] : null;
    }

    /**
     * spotdl >= 4.5 defaults to the anonymous SpotipyFree client and only
     * uses provided credentials when --use-official-api is passed (before
     * 4.5 the official API was the only path and the flag doesn't exist).
     * @param {string|null} version
     * @returns {boolean}
     */
    static supportsOfficialApiFlag(version) {
        const match = String(version || '').match(/^(\d+)\.(\d+)/);
        if (!match) return false;
        const major = Number(match[1]);
        const minor = Number(match[2]);
        return major > 4 || (major === 4 && minor >= 5);
    }

    /**
     * CLI args shared by every spotdl invocation that talks to Spotify.
     * --no-cache avoids spotipy's stale token cache ignoring custom
     * credentials (spotDL#2606). --use-official-api (spotdl >= 4.5) makes
     * the credentials actually take effect - without it spotdl 4.5+ ignores
     * them and uses its anonymous SpotipyFree client.
     */
    _credentialArgs() {
        if (!this.spotifyCreds) return [];
        return [
            '--client-id', this.spotifyCreds.clientId,
            '--client-secret', this.spotifyCreds.clientSecret,
            '--no-cache',
            ...(SpotDLService.supportsOfficialApiFlag(this._resolvedVersion)
                ? ['--use-official-api']
                : [])
        ];
    }

    async ensureMusicDir() {
        await fs.mkdir(this.musicDir, { recursive: true });
    }

    /**
     * Locate a working spotdl invocation, cached after first success.
     * Order: config.spotdl.path override, `spotdl` on PATH, the Raspberry Pi
     * installer's venv locations (~/.local/goobster-venv and ~/.local/bin -
     * neither is on PATH under systemd), the Docker image venv (/opt/venv),
     * then `python -m spotdl` (covers pip --user installs whose Scripts dir
     * isn't on PATH, common on Windows). When nothing works, the error lists
     * every candidate and why it failed (broken venv, SIGSEGV, EACCES, ...).
     * @returns {Promise<{cmd: string, baseArgs: string[]}>}
     */
    async _resolveSpotdlCommand() {
        if (this._resolvedCommand) return this._resolvedCommand;

        const home = os.homedir();
        const candidates = [
            config.spotdl?.path
                ? { cmd: config.spotdl.path, baseArgs: [], label: 'config spotdl.path' }
                : null,
            { cmd: 'spotdl', baseArgs: [] },
            process.platform !== 'win32'
                ? { cmd: path.join(home, '.local', 'goobster-venv', 'bin', 'spotdl'), baseArgs: [] }
                : null,
            process.platform !== 'win32'
                ? { cmd: path.join(home, '.local', 'bin', 'spotdl'), baseArgs: [] }
                : null,
            process.platform !== 'win32'
                ? { cmd: '/opt/venv/bin/spotdl', baseArgs: [] }
                : null,
            { cmd: process.platform === 'win32' ? 'python' : 'python3', baseArgs: ['-m', 'spotdl'] }
        ].filter(Boolean);

        const resolved = await resolveCliCommand(candidates, {
            name: 'spotdl',
            installHint:
                'Install it with "pip install spotdl" - on Raspberry Pi OS use a venv: ' +
                '"python3 -m venv ~/.local/goobster-venv && ~/.local/goobster-venv/bin/pip install spotdl yt-dlp" ' +
                '(or set spotdl.path in config.json).'
        });
        this._resolvedVersion = SpotDLService.parseVersion(resolved.versionOutput);
        console.log(`SpotDL resolved to: ${resolved.cmd} ${resolved.baseArgs.join(' ')} (version ${this._resolvedVersion || 'unknown'})`.trim());
        this._resolvedCommand = resolved;
        return resolved;
    }

    async validateUrl(url) {
        if (!url) {
            throw new Error('URL is required');
        }

        // Spotify URL patterns (with optional locale segment, e.g. /intl-de/)
        const spotifyPatterns = [
            /^https:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?track\/[a-zA-Z0-9]+/,
            /^https:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?playlist\/[a-zA-Z0-9]+/,
            /^https:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?album\/[a-zA-Z0-9]+/
        ];

        // YouTube URL patterns
        const youtubePatterns = [
            /^https:\/\/(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/,
            /^https:\/\/(?:www\.)?youtube\.com\/playlist\?list=[a-zA-Z0-9_-]+/,
            /^https:\/\/youtu\.be\/[a-zA-Z0-9_-]+/
        ];

        const isSpotify = spotifyPatterns.some(pattern => pattern.test(url));
        const isYouTube = youtubePatterns.some(pattern => pattern.test(url));

        if (!isSpotify && !isYouTube) {
            throw new Error('Invalid URL. Please provide a valid Spotify or YouTube URL.');
        }

        return {
            type: isSpotify ? 'spotify' : 'youtube',
            isValid: true
        };
    }

    /**
     * Turn a failed spotdl run into a short, actionable error message.
     * spotdl prints rich boxed tracebacks to stdout; dumping those into the
     * error blows Discord's 2000-character reply limit (the full output is
     * already in the logs line by line). Known upstream breakages get a
     * targeted explanation; anything else gets the last error-looking line.
     *
     * @param {{output: string, errorOutput: string, code: number|null, hasCredentials: boolean}} params
     * @returns {string}
     */
    static summarizeFailure({ output, errorOutput, code, hasCredentials }) {
        // eslint-disable-next-line no-control-regex
        const ansiColors = /\u001b\[[0-9;]*m/g;
        const combined = `${output || ''}\n${errorOutput || ''}`
            .replace(ansiColors, '')
            .replace(/[\u2500-\u257f\u276e-\u2771]/g, ' '); // rich box drawing + markers
        const lines = combined.split('\n').map(l => l.trim()).filter(Boolean);

        // Spotify API changes broke spotdl's anonymous (SpotipyFree) client
        // for playlists: KeyError 'ownerV2' on older spotipyfree, a
        // "Playlist not available or not accessible" SpotifyException on
        // newer ones - both for playlists that are actually public.
        const anonymousPlaylistBreak = lines.some(l =>
            /KeyError: 'ownerV2'/.test(l)
            || /Playlist not available or not accessible/i.test(l));
        if (anonymousPlaylistBreak) {
            return hasCredentials
                ? 'Spotify playlist lookup failed even with the official Spotify API. '
                    + 'Check that the spotify.clientId/clientSecret in config.json are valid '
                    + 'and that the playlist is public.'
                : 'Spotify playlist lookup failed: spotdl\'s anonymous Spotify client is '
                    + 'currently broken for playlists (upstream Spotify API change). '
                    + 'Add "spotify": { "clientId", "clientSecret" } to config.json '
                    + '(free app at developer.spotify.com/dashboard) so Goobster can use the '
                    + 'official Spotify API. Single tracks and albums still work without credentials.';
        }

        // spotipy retries Spotify 404s (private / invite-only / missing
        // playlist) until it reports a 429. The "too many 404" reason is
        // the real signal — a genuine rate limit says "too many 429".
        const inaccessiblePlaylist = lines.some(l =>
            /too many 404 error responses/i.test(l)
            || /Max retries exceeded.*\/v1\/playlists\//i.test(l));
        if (inaccessiblePlaylist) {
            return hasCredentials
                ? 'Spotify could not open that playlist. The official API returns 404 for '
                    + 'private or invite-only playlists (share links with ?pt=). Make the '
                    + 'playlist public, or paste a public playlist/album/track link.'
                : 'Spotify could not open that playlist (404, often reported as a 429). '
                    + 'Add "spotify": { "clientId", "clientSecret" } to config.json, and '
                    + 'make sure the playlist is public — invite links (?pt=) only work in the Spotify app.';
        }

        const realRateLimit = lines.some(l =>
            /too many 429 error responses/i.test(l)
            || (/rate\/request limit/i.test(l) && !/404/i.test(combined)));
        if (realRateLimit) {
            return hasCredentials
                ? 'Spotify rate-limited the download. Wait a minute and try again.'
                : 'Spotify rate limit reached. Add your own Spotify API credentials to '
                    + 'config.json to avoid this, or try again in a few minutes.';
        }

        // Tracebacks end with the real exception; scan from the bottom.
        const errorLine = [...lines].reverse().find(l =>
            /(error|exception)/i.test(l) && !/^an error occurred$/i.test(l));
        const detail = (errorLine || lines[lines.length - 1] || '').slice(0, 300);
        return `SpotDL exited with code ${code}${detail ? `: ${detail}` : ''}`;
    }

    /**
     * Discord-safe error text for /play and /spotdl. Prefer the already
     * summarized Error message; rewrite leftover 404-as-429 wording so the
     * commands stop telling people to "add credentials" for a private list.
     * @param {Error|string} error
     * @param {{hasCredentials?: boolean}} [opts]
     * @returns {string}
     */
    static userFacingMessage(error, { hasCredentials = false } = {}) {
        const raw = (error && error.message) || String(error || '');
        if (error instanceof SpotifyWebError) return raw;
        if (/too many 404|private or invite-only/i.test(raw)) {
            return SpotDLService.summarizeFailure({
                output: raw,
                errorOutput: '',
                code: 1,
                hasCredentials
            });
        }
        if (/too many 429|rate limit reached/i.test(raw) && !/404/i.test(raw)) {
            return SpotDLService.summarizeFailure({
                output: raw,
                errorOutput: '',
                code: 1,
                hasCredentials
            });
        }
        return raw.slice(0, 400);
    }

    /**
     * Parse a spotdl stdout line for a track that is now available on disk:
     * freshly downloaded ('Downloaded "Artist - Title": url') or skipped
     * because the MP3 already exists ('Skipping Artist - Title (file already
     * exists)' / '(skip file found)').
     * @param {string} line
     * @returns {string|null} the expected .mp3 filename, or null
     */
    static parseResolvedTrackName(line) {
        const match = line.match(/Downloaded\s+"([^"]+)"/i)
            || line.match(/Downloaded:\s+([^\n]+)/i)
            || line.match(/Skipping\s+(.+?)\s+\((?:file already exists|skip file found)\)/i);
        if (match && match[1]) {
            return `${match[1].trim()}.mp3`;
        }
        return null;
    }

    /**
     * Expand a Spotify playlist/album through the official Web API so spotdl
     * never hits GET /v1/playlists/{id} (404-retried-as-429 on private or
     * invite-only lists, and brittle on large public ones). Falls back to
     * handing the original URL to spotdl when credentials are missing.
     * @param {string} url
     * @returns {Promise<{urls: string[], expanded: boolean}>}
     */
    async _listCollectionTrackUrls(url, opts) {
        return listCollectionTrackUrls(url, opts);
    }

    async _resolveDownloadUrls(url) {
        const parsed = parseSpotifyUrl(url);
        if (!parsed || parsed.kind === 'track' || !this.spotifyCreds) {
            return { urls: [url], expanded: false };
        }

        const maxItems = Number(config.spotdl?.maxPlaylistItems) > 0
            ? Number(config.spotdl.maxPlaylistItems)
            : 0;
        const trackUrls = await this._listCollectionTrackUrls(url, {
            clientId: this.spotifyCreds.clientId,
            clientSecret: this.spotifyCreds.clientSecret,
            maxItems,
            tokenCache: this._spotifyTokenCache
        });
        if (trackUrls.length === 0) {
            throw new Error('That Spotify playlist or album has no downloadable tracks.');
        }
        console.log(`Expanded Spotify ${parsed.kind} ${parsed.id} to ${trackUrls.length} track URL(s)`
            + (parsed.pt ? ' (share link had ?pt=; official API ignores invite tokens)' : ''));
        return { urls: trackUrls, expanded: true };
    }

    /**
     * Download a Spotify/YouTube URL with spotdl. Tracks whose MP3 already
     * exists in the library are skipped by spotdl but still included in the
     * result, so callers can play cached songs without re-downloading.
     * Playlists/albums with credentials are expanded and downloaded in batches.
     *
     * @param {string} url
     * @param {object} [options]
     * @param {(track: {name: string, url: string}) => void} [options.onTrack]
     *        called as each track becomes available on disk (progressive
     *        queueing while the rest of a playlist is still downloading)
     * @returns {Promise<Array<{name: string, url: string}>>}
     */
    async downloadTrack(url, { onTrack } = {}) {
        console.log('Starting track download:', url);

        await this.validateUrl(url);
        await this.ensureMusicDir();

        const { urls, expanded } = await this._resolveDownloadUrls(url);
        const batchSize = expanded ? this._batchSize : urls.length;

        const filesBefore = new Set(await fs.readdir(this.musicDir));
        const allTracks = [];
        const seen = new Set();
        let lastError = null;

        for (let i = 0; i < urls.length; i += batchSize) {
            const batch = urls.slice(i, i + batchSize);
            try {
                const tracks = await this._runSpotdlDownload(batch, {
                    onTrack,
                    filesBefore,
                    failSoft: expanded && urls.length > 1
                });
                for (const track of tracks) {
                    if (seen.has(track.name)) continue;
                    seen.add(track.name);
                    allTracks.push(track);
                    filesBefore.add(track.name);
                }
            } catch (error) {
                lastError = error;
                console.error(`SpotDL batch ${i + 1}-${i + batch.length} of ${urls.length} failed:`, error.message);
                if (!expanded || urls.length === 1) throw error;
            }
            if (i + batchSize < urls.length && this._batchPauseMs > 0) {
                await new Promise(r => setTimeout(r, this._batchPauseMs));
            }
        }

        if (allTracks.length === 0) {
            throw lastError || new Error('SpotDL finished, but no downloaded files were detected.');
        }
        console.log(`Successfully downloaded ${allTracks.length} track(s).`);
        return allTracks;
    }

    /**
     * Run one spotdl download for the given URL list.
     * @param {string[]} urls
     * @param {{onTrack?: Function, filesBefore: Set<string>, failSoft?: boolean}} options
     * @returns {Promise<Array<{name: string, url: string}>>}
     */
    async _runSpotdlDownload(urls, { onTrack, filesBefore, failSoft = false } = {}) {
        const { cmd, baseArgs } = await this._resolveSpotdlCommand();
        const threads = Number(config.spotdl?.threads) > 0 ? Number(config.spotdl.threads) : 2;

        return new Promise((resolve, reject) => {
            const args = [
                ...baseArgs,
                'download', ...urls,
                '--output', this.musicDir,
                '--log-level', 'INFO',
                '--threads', String(threads),
                // Optional audio-provider override (config spotdl.audioProviders,
                // e.g. ["youtube"]) - useful when YouTube Music (spotdl's
                // default) 403/429-blocks the host's IP.
                ...(Array.isArray(config.spotdl?.audioProviders) && config.spotdl.audioProviders.length
                    ? ['--audio', ...config.spotdl.audioProviders]
                    : []),
                ...this._credentialArgs()
            ];
            console.log(`Spawning SpotDL process: ${cmd} (${urls.length} URL(s))`.trim());
            const spotdl = spawn(cmd, args);

            let output = '';
            let errorOutput = '';
            const downloadedFilesFromOutput = [];
            const pendingCallbacks = [];

            const notifyTrack = (filename) => {
                if (!onTrack) return;
                const filePath = path.join(this.musicDir, filename);
                pendingCallbacks.push((async () => {
                    try {
                        await fs.access(filePath);
                    } catch {
                        return; // parsed name not on disk (yet) - final pass handles it
                    }
                    try {
                        await onTrack({ name: filename, url: filePath });
                    } catch (callbackError) {
                        console.error('onTrack callback error:', callbackError);
                    }
                })());
            };

            spotdl.stdout.on('data', (data) => {
                const dataStr = data.toString();
                output += dataStr;
                console.log(`SpotDL: ${dataStr}`);

                // Parse resolved tracks (downloaded or already on disk).
                const lines = dataStr.split('\n');
                lines.forEach(line => {
                    const filename = SpotDLService.parseResolvedTrackName(line);
                    if (filename && !downloadedFilesFromOutput.includes(filename)) {
                        console.log(`Detected resolved file from output: ${filename}`);
                        downloadedFilesFromOutput.push(filename);
                        notifyTrack(filename);
                    }
                });
            });

            spotdl.stderr.on('data', (data) => {
                const dataStr = data.toString();
                errorOutput += dataStr;
                console.error(`SpotDL Error: ${dataStr}`);
            });

            spotdl.on('error', (err) => {
                console.error('Failed to start SpotDL process:', err);
                reject(err);
            });

            spotdl.on('close', async (code) => {
                console.log(`SpotDL process exited with code ${code}`);
                const summarize = () => new Error(SpotDLService.summarizeFailure({
                    output,
                    errorOutput,
                    code,
                    hasCredentials: Boolean(this.spotifyCreds)
                }));

                try {
                    // Give the filesystem a brief moment to settle.
                    await new Promise(r => setTimeout(r, 200));
                    await Promise.all(pendingCallbacks);

                    // Combine stdout-parsed names with newly appeared files.
                    const filesAfter = await fs.readdir(this.musicDir);
                    const newFiles = filesAfter.filter(f => f.endsWith('.mp3') && !filesBefore.has(f));
                    const uniqueFiles = [...new Set([...downloadedFilesFromOutput, ...newFiles])];

                    // Only keep files that actually exist locally.
                    const tracks = [];
                    for (const file of uniqueFiles) {
                        const filePath = path.join(this.musicDir, file);
                        try {
                            await fs.access(filePath);
                            tracks.push({ name: file, url: filePath });
                        } catch {
                            console.warn(`Parsed track "${file}" not found on disk, skipping`);
                        }
                    }

                    if (code !== 0 && tracks.length === 0) {
                        reject(summarize());
                        return;
                    }
                    if (code !== 0 && tracks.length > 0) {
                        console.warn(`SpotDL exited ${code} after resolving ${tracks.length} track(s); keeping them.`);
                    }
                    if (tracks.length === 0) {
                        if (failSoft) {
                            resolve([]);
                            return;
                        }
                        reject(new Error('SpotDL finished, but no downloaded files were detected.'));
                        return;
                    }

                    resolve(tracks);
                } catch (processingError) {
                    console.error('Error processing downloaded files after SpotDL close:', processingError);
                    reject(processingError);
                }
            });
        });
    }

    async listTracks() {
        await this.ensureMusicDir();
        const files = await fs.readdir(this.musicDir);
        const tracks = [];

        for (const file of files) {
            if (!file.endsWith('.mp3')) continue;
            const filePath = path.join(this.musicDir, file);
            try {
                const stats = await fs.stat(filePath);
                tracks.push({
                    name: file,
                    url: filePath,
                    lastModified: stats.mtime
                });
            } catch {
                // File disappeared between readdir and stat; ignore.
            }
        }

        return tracks;
    }

    async deleteTrack(trackName) {
        const filePath = path.join(this.musicDir, path.basename(trackName));
        await fs.unlink(filePath);
    }

    /**
     * Resolve a track name to a playable location. With local storage this is
     * simply the absolute file path, which @discordjs/voice accepts directly.
     */
    async getTrackUrl(trackName) {
        const filePath = path.join(this.musicDir, path.basename(trackName));
        await fs.access(filePath);
        return filePath;
    }

    async checkHealth() {
        try {
            // Check if SpotDL is available (throws when no candidate works)
            await this._resolveSpotdlCommand();

            // Check if the music directory is accessible
            await this.ensureMusicDir();

            return {
                status: 'healthy',
                spotdl: 'available',
                storage: 'local'
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message
            };
        }
    }
}

module.exports = SpotDLService;
