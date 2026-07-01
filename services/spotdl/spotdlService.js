const { spawn } = require('child_process');
const path = require('path');
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
        this.spotdlPath = 'spotdl'; // Use system-installed SpotDL

        // Set up Spotify credentials for SpotDL when configured
        if (config.spotify?.clientId && config.spotify?.clientSecret) {
            process.env.SPOTIFY_CLIENT_ID = config.spotify.clientId;
            process.env.SPOTIFY_CLIENT_SECRET = config.spotify.clientSecret;
        } else {
            console.warn('Spotify credentials not found in config.json. SpotDL downloads may not work without them.');
        }
    }

    async ensureMusicDir() {
        await fs.mkdir(this.musicDir, { recursive: true });
    }

    async validateUrl(url) {
        if (!url) {
            throw new Error('URL is required');
        }

        // Spotify URL patterns
        const spotifyPatterns = [
            /^https:\/\/open\.spotify\.com\/track\/[a-zA-Z0-9]+/,
            /^https:\/\/open\.spotify\.com\/playlist\/[a-zA-Z0-9]+/,
            /^https:\/\/open\.spotify\.com\/album\/[a-zA-Z0-9]+/
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

    async downloadTrack(url) {
        console.log('Starting track download:', url);

        await this.validateUrl(url);
        await this.ensureMusicDir();

        // Snapshot the directory before downloading so we can detect new files
        // even when stdout parsing misses them.
        const filesBefore = new Set(await fs.readdir(this.musicDir));

        return new Promise((resolve, reject) => {
            console.log('Spawning SpotDL process with path:', this.spotdlPath);
            const spotdl = spawn(this.spotdlPath, ['download', url, '--output', this.musicDir, '--log-level', 'INFO']);

            let output = '';
            let errorOutput = '';
            const downloadedFilesFromOutput = [];

            spotdl.stdout.on('data', (data) => {
                const dataStr = data.toString();
                output += dataStr;
                console.log(`SpotDL: ${dataStr}`);

                // Parse filenames from stdout, e.g. 'Downloaded "Artist - Title": url'
                const lines = dataStr.split('\n');
                lines.forEach(line => {
                    const match = line.match(/Downloaded\s+"([^"]+)"/i) || line.match(/Downloaded:\s+([^\n]+)/i);
                    if (match && match[1]) {
                        const filename = `${match[1].trim()}.mp3`;
                        if (!downloadedFilesFromOutput.includes(filename)) {
                            console.log(`Detected downloaded file from output: ${filename}`);
                            downloadedFilesFromOutput.push(filename);
                        }
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
            // Check if SpotDL is available
            await new Promise((resolve, reject) => {
                const spotdl = spawn(this.spotdlPath, ['--version']);
                spotdl.on('error', () => reject(new Error('SpotDL is not available')));
                spotdl.on('close', (code) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error('SpotDL is not available'));
                    }
                });
            });

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
