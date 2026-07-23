const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;

let config = {};
try {
    config = require('../../config.json');
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

        // Spotify credentials are passed to the spotdl CLI as
        // --client-id/--client-secret flags (it does not read env vars).
        // Without them spotdl falls back to its shared default app, which is
        // frequently rate-limited (429s).
        if (config.spotify?.clientId && config.spotify?.clientSecret) {
            this.spotifyCreds = {
                clientId: config.spotify.clientId,
                clientSecret: config.spotify.clientSecret
            };
        } else {
            this.spotifyCreds = null;
            console.warn('Spotify credentials not found in config.json. SpotDL downloads may not work without them.');
        }
    }

    /**
     * CLI args shared by every spotdl invocation that talks to Spotify.
     * --no-cache avoids spotipy's stale token cache ignoring custom
     * credentials (spotDL#2606).
     */
    _credentialArgs() {
        if (!this.spotifyCreds) return [];
        return [
            '--client-id', this.spotifyCreds.clientId,
            '--client-secret', this.spotifyCreds.clientSecret,
            '--no-cache'
        ];
    }

    async ensureMusicDir() {
        await fs.mkdir(this.musicDir, { recursive: true });
    }

    /**
     * Locate a working spotdl invocation, cached after first success.
     * Order: config.spotdl.path override, `spotdl` on PATH, the Raspberry Pi
     * installer's venv locations (~/.local/goobster-venv and ~/.local/bin -
     * neither is on PATH under systemd), then `python -m spotdl` (covers pip
     * --user installs whose Scripts dir isn't on PATH, common on Windows).
     * @returns {Promise<{cmd: string, baseArgs: string[]}>}
     */
    async _resolveSpotdlCommand() {
        if (this._resolvedCommand) return this._resolvedCommand;

        const home = os.homedir();
        const candidates = [
            config.spotdl?.path ? { cmd: config.spotdl.path, baseArgs: [] } : null,
            { cmd: 'spotdl', baseArgs: [] },
            process.platform !== 'win32'
                ? { cmd: path.join(home, '.local', 'goobster-venv', 'bin', 'spotdl'), baseArgs: [] }
                : null,
            process.platform !== 'win32'
                ? { cmd: path.join(home, '.local', 'bin', 'spotdl'), baseArgs: [] }
                : null,
            { cmd: process.platform === 'win32' ? 'python' : 'python3', baseArgs: ['-m', 'spotdl'] }
        ].filter(Boolean);

        for (const candidate of candidates) {
            const works = await new Promise(resolve => {
                const probe = spawn(candidate.cmd, [...candidate.baseArgs, '--version']);
                probe.on('error', () => resolve(false));
                probe.on('close', code => resolve(code === 0));
            });
            if (works) {
                console.log(`SpotDL resolved to: ${candidate.cmd} ${candidate.baseArgs.join(' ')}`.trim());
                this._resolvedCommand = candidate;
                return candidate;
            }
        }

        throw new Error(
            'spotdl CLI not found. Install it with "pip install spotdl" - on Raspberry Pi OS use a venv: ' +
            '"python3 -m venv ~/.local/goobster-venv && ~/.local/goobster-venv/bin/pip install spotdl yt-dlp" ' +
            '(or set spotdl.path in config.json).'
        );
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
     * Download a Spotify/YouTube URL with spotdl. Tracks whose MP3 already
     * exists in the library are skipped by spotdl but still included in the
     * result, so callers can play cached songs without re-downloading.
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
        const { cmd, baseArgs } = await this._resolveSpotdlCommand();

        // Snapshot the directory before downloading so we can detect new files
        // even when stdout parsing misses them.
        const filesBefore = new Set(await fs.readdir(this.musicDir));

        return new Promise((resolve, reject) => {
            const args = [
                ...baseArgs,
                'download', url,
                '--output', this.musicDir,
                '--log-level', 'INFO',
                // Optional audio-provider override (config spotdl.audioProviders,
                // e.g. ["youtube"]) - useful when YouTube Music (spotdl's
                // default) 403/429-blocks the host's IP.
                ...(Array.isArray(config.spotdl?.audioProviders) && config.spotdl.audioProviders.length
                    ? ['--audio', ...config.spotdl.audioProviders]
                    : []),
                ...this._credentialArgs()
            ];
            console.log(`Spawning SpotDL process: ${cmd} ${baseArgs.join(' ')}`.trim());
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
                if (code !== 0) {
                    reject(new Error(`SpotDL process exited with code ${code}. Stderr: ${errorOutput || 'None'}. Stdout: ${output}`));
                    return;
                }

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

                    if (tracks.length === 0) {
                        reject(new Error('SpotDL finished, but no downloaded files were detected.'));
                        return;
                    }

                    console.log(`Successfully downloaded ${tracks.length} track(s).`);
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
