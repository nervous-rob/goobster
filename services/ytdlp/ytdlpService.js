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
 * yt-dlp service (local storage edition).
 *
 * Downloads YouTube audio as MP3 with the system-installed yt-dlp CLI into
 * the same local music library as SpotDL (data/music), so downloaded videos
 * are playable through the existing MusicService queue and /playtrack.
 *
 * Files are named "Artist - Title.mp3" (uploader falls back for artist) to
 * match the SpotDL naming convention that parseTrackName expects.
 */
class YtDlpService {
    constructor() {
        this.musicDir = path.join(process.cwd(), 'data', 'music');
        this._resolvedCommand = null;
    }

    async ensureMusicDir() {
        await fs.mkdir(this.musicDir, { recursive: true });
    }

    /**
     * Locate a working yt-dlp invocation, cached after first success.
     * Order mirrors SpotDLService: config.ytdlp.path override, `yt-dlp` on
     * PATH, the Raspberry Pi installer's venv locations (not on PATH under
     * systemd), then `python -m yt_dlp` (covers pip --user installs).
     * @returns {Promise<{cmd: string, baseArgs: string[]}>}
     */
    async _resolveYtDlpCommand() {
        if (this._resolvedCommand) return this._resolvedCommand;

        const home = os.homedir();
        const candidates = [
            config.ytdlp?.path ? { cmd: config.ytdlp.path, baseArgs: [] } : null,
            { cmd: 'yt-dlp', baseArgs: [] },
            process.platform !== 'win32'
                ? { cmd: path.join(home, '.local', 'goobster-venv', 'bin', 'yt-dlp'), baseArgs: [] }
                : null,
            process.platform !== 'win32'
                ? { cmd: path.join(home, '.local', 'bin', 'yt-dlp'), baseArgs: [] }
                : null,
            { cmd: process.platform === 'win32' ? 'python' : 'python3', baseArgs: ['-m', 'yt_dlp'] }
        ].filter(Boolean);

        for (const candidate of candidates) {
            const works = await new Promise(resolve => {
                const probe = spawn(candidate.cmd, [...candidate.baseArgs, '--version']);
                probe.on('error', () => resolve(false));
                probe.on('close', code => resolve(code === 0));
            });
            if (works) {
                console.log(`yt-dlp resolved to: ${candidate.cmd} ${candidate.baseArgs.join(' ')}`.trim());
                this._resolvedCommand = candidate;
                return candidate;
            }
        }

        throw new Error(
            'yt-dlp CLI not found. Install it with "pip install yt-dlp" - on Raspberry Pi OS use a venv: ' +
            '"python3 -m venv ~/.local/goobster-venv && ~/.local/goobster-venv/bin/pip install spotdl yt-dlp" ' +
            '(or set ytdlp.path in config.json).'
        );
    }

    /**
     * Download the audio of a YouTube video or playlist as MP3 into the
     * local music library. Videos whose MP3 already exists are skipped by
     * yt-dlp (--no-overwrites) but still reported, so replays don't
     * re-download anything.
     *
     * @param {string} url YouTube video or playlist URL
     * @param {object} [options]
     * @param {boolean} [options.playlist=false] allow yt-dlp to expand playlists
     * @param {number} [options.maxItems] cap on playlist entries (default
     *        config.ytdlp.maxPlaylistItems or 50)
     * @param {(track: {name: string, url: string}) => void} [options.onTrack]
     *        called as each track becomes available on disk (progressive
     *        queueing while the rest of a playlist is still downloading)
     * @returns {Promise<Array<{name: string, url: string}>>}
     */
    async downloadAudio(url, { playlist = false, maxItems, onTrack } = {}) {
        console.log('Starting YouTube audio download:', url);

        await this.ensureMusicDir();
        const { cmd, baseArgs } = await this._resolveYtDlpCommand();

        // Single videos: reuse the library copy when it already exists
        // (metadata probe only - no media download).
        if (!playlist) {
            const cached = await this._findCachedTrack(url);
            if (cached) {
                if (onTrack) {
                    try {
                        await onTrack(cached);
                    } catch (callbackError) {
                        console.error('onTrack callback error:', callbackError);
                    }
                }
                return [cached];
            }
        }

        return new Promise((resolve, reject) => {
            const args = [
                ...baseArgs,
                '--extract-audio',
                '--audio-format', 'mp3',
                '--no-overwrites',
                '--no-simulate',
                '--no-warnings',
                // Print the final on-disk path of each entry once it has
                // finished post-processing (also printed for skipped files).
                '--print', 'after_move:filepath',
                playlist ? '--yes-playlist' : '--no-playlist',
                // Bound giant playlists so one link can't fill the disk.
                ...(playlist
                    ? ['--playlist-items', `1:${maxItems || config.ytdlp?.maxPlaylistItems || 50}`]
                    : []),
                // Keep one broken playlist entry from killing the whole run.
                '--ignore-errors',
                '--output', path.join(this.musicDir, '%(artist,creator,uploader|Unknown Artist)s - %(title)s.%(ext)s'),
                url
            ];
            console.log(`Spawning yt-dlp process: ${cmd} ${baseArgs.join(' ')}`.trim());
            const ytdlp = spawn(cmd, args);

            const tracks = [];
            let stdoutBuffer = '';
            let errorOutput = '';
            const pendingChecks = [];

            const handleLine = (line) => {
                const filePath = line.trim();
                if (!filePath || !filePath.toLowerCase().endsWith('.mp3')) return;
                // Only accept paths inside our music dir (defensive; the
                // output template already points there).
                if (path.dirname(filePath) !== this.musicDir) return;

                pendingChecks.push((async () => {
                    try {
                        await fs.access(filePath);
                    } catch {
                        console.warn(`yt-dlp reported "${filePath}" but it is not on disk, skipping`);
                        return;
                    }
                    const finalPath = await this._dedupeArtistPrefix(filePath);
                    const track = { name: path.basename(finalPath), url: finalPath };
                    if (tracks.some(t => t.name === track.name)) return;
                    tracks.push(track);
                    if (onTrack) {
                        try {
                            await onTrack(track);
                        } catch (callbackError) {
                            console.error('onTrack callback error:', callbackError);
                        }
                    }
                })());
            };

            ytdlp.stdout.on('data', (data) => {
                stdoutBuffer += data.toString();
                const lines = stdoutBuffer.split('\n');
                stdoutBuffer = lines.pop(); // keep the unterminated tail
                lines.forEach(handleLine);
            });

            ytdlp.stderr.on('data', (data) => {
                const dataStr = data.toString();
                errorOutput += dataStr;
                console.error(`yt-dlp: ${dataStr}`);
            });

            ytdlp.on('error', (err) => {
                console.error('Failed to start yt-dlp process:', err);
                reject(err);
            });

            ytdlp.on('close', async (code) => {
                console.log(`yt-dlp process exited with code ${code}`);
                if (stdoutBuffer) handleLine(stdoutBuffer);
                await Promise.all(pendingChecks);

                // --ignore-errors makes yt-dlp exit non-zero when *any*
                // playlist entry failed; partial success is still success.
                if (tracks.length === 0) {
                    reject(new Error(`yt-dlp finished (code ${code}) but no audio files were produced. ${errorOutput ? `Stderr: ${errorOutput}` : ''}`.trim()));
                    return;
                }

                console.log(`yt-dlp resolved ${tracks.length} track(s).`);
                resolve(tracks);
            });
        });
    }

    /**
     * YouTube titles often already start with the artist ("Rick Astley -
     * Never Gonna Give You Up"), so the "%(artist)s - %(title)s" template can
     * produce "Rick Astley - Rick Astley - ...". Collapse the duplicated
     * prefix so parseTrackName sees a clean "Artist - Title".
     * @param {string} filename e.g. "Rick Astley - Rick Astley - Song.mp3"
     * @returns {string} e.g. "Rick Astley - Song.mp3"
     */
    static dedupeArtistPrefixName(filename) {
        const base = filename.replace(/\.mp3$/i, '');
        const match = base.match(/^(.+?) - (.+)$/);
        if (!match) return filename;
        const [, artist, rest] = match;
        if (!rest.toLowerCase().startsWith(`${artist.toLowerCase()} - `)) return filename;
        return `${rest}.mp3`;
    }

    /**
     * Rename a downloaded file to its deduped name (or drop it when the
     * deduped file already exists in the library).
     * @param {string} filePath
     * @returns {Promise<string>} the (possibly renamed) file path
     */
    async _dedupeArtistPrefix(filePath) {
        const dedupedName = YtDlpService.dedupeArtistPrefixName(path.basename(filePath));
        if (dedupedName === path.basename(filePath)) return filePath;

        const dedupedPath = path.join(this.musicDir, dedupedName);
        try {
            await fs.access(dedupedPath);
            // A file with the clean name already exists - drop the duplicate.
            await fs.unlink(filePath);
        } catch {
            await fs.rename(filePath, dedupedPath);
        }
        return dedupedPath;
    }

    /**
     * Cheap metadata probe for a single video: asks yt-dlp what the output
     * filename would be (with its own sanitization) and checks whether that
     * MP3 - or its deduped rename - is already in the library. Lets replays
     * of the same URL play instantly without re-downloading.
     * @param {string} url
     * @returns {Promise<{name: string, url: string}|null>}
     */
    async _findCachedTrack(url) {
        const { cmd, baseArgs } = await this._resolveYtDlpCommand();

        const printedPath = await new Promise((resolve) => {
            const probe = spawn(cmd, [
                ...baseArgs,
                '--skip-download',
                '--no-warnings',
                '--no-playlist',
                '--print', 'filename',
                '--output', path.join(this.musicDir, '%(artist,creator,uploader|Unknown Artist)s - %(title)s.mp3'),
                url
            ]);
            let output = '';
            probe.stdout.on('data', d => { output += d.toString(); });
            probe.on('error', () => resolve(null));
            probe.on('close', code => resolve(code === 0 ? output.trim().split('\n')[0]?.trim() : null));
        });
        if (!printedPath) return null;

        const candidates = [
            path.join(this.musicDir, YtDlpService.dedupeArtistPrefixName(path.basename(printedPath))),
            printedPath
        ];
        for (const candidate of candidates) {
            try {
                await fs.access(candidate);
                console.log(`YouTube audio already in library: ${candidate}`);
                return { name: path.basename(candidate), url: candidate };
            } catch {
                // keep looking
            }
        }
        return null;
    }

    async checkHealth() {
        try {
            await this._resolveYtDlpCommand();
            await this.ensureMusicDir();
            return {
                status: 'healthy',
                ytdlp: 'available',
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

module.exports = YtDlpService;
