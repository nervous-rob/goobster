const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { BlobServiceClient } = require('@azure/storage-blob');
const config = require('../../config.json');

class SpotDLService {
    constructor() {
        this.musicDir = path.join(process.cwd(), 'data', 'music');
        this.blobServiceClient = BlobServiceClient.fromConnectionString(config.azure.storage.connectionString);
        this.containerClient = this.blobServiceClient.getContainerClient('goobster-music');
        this.spotdlPath = 'spotdl'; // Use system-installed SpotDL
        
        // Validate Spotify credentials
        if (!config.spotify?.clientId || !config.spotify?.clientSecret) {
            console.error('Spotify credentials not found in config.json. SpotDL will not work without valid Spotify credentials.');
            return;
        }
        
        // Set up Spotify credentials for SpotDL
        process.env.SPOTIFY_CLIENT_ID = config.spotify.clientId;
        process.env.SPOTIFY_CLIENT_SECRET = config.spotify.clientSecret;
        
        // Log environment information
        console.log('SpotDL Service Initialization:');
        console.log('Music Directory:', this.musicDir);
        console.log('SpotDL Path:', this.spotdlPath);
        console.log('Python Path:', process.env.PYTHON_PATH);
        console.log('Azure Container:', this.containerClient.containerName);
        console.log('Spotify Client ID configured:', !!config.spotify.clientId);
        
        // Ensure container exists
        this.ensureContainerExists();
    }

    async ensureContainerExists() {
        try {
            console.log('Checking Azure Blob Storage container...');
            await this.containerClient.createIfNotExists();
            console.log('Azure Blob Storage container is ready');
        } catch (error) {
            console.error('Error ensuring container exists:', error);
            throw error;
        }
    }

    async downloadTrack(spotifyUrl) {
        console.log('Starting track download:', spotifyUrl);
        return new Promise(async (resolve, reject) => {
            try {
                // Ensure music directory exists
                await fs.mkdir(this.musicDir, { recursive: true });

                console.log('Spawning SpotDL process with path:', this.spotdlPath);
                // Added --log-level DEBUG for potentially more detailed output if needed
                const spotdl = spawn(this.spotdlPath, ['download', spotifyUrl, '--output', this.musicDir, '--log-level', 'INFO']); 
                
                let output = '';
                let errorOutput = '';
                const downloadedFilesFromOutput = [];

                spotdl.stdout.on('data', (data) => {
                    const dataStr = data.toString();
                    output += dataStr;
                    console.log(`SpotDL: ${dataStr}`);
                    
                    // Attempt to parse filenames from stdout
                    // Example formats: "Downloaded: Artist - Title.mp3", "Processing: Artist - Title.mp3" might indicate final name
                    // Updated format: Downloaded "Artist - Title": youtube-url
                    const lines = dataStr.split('\\n');
                    lines.forEach(line => {
                        // Look for lines indicating a file was processed or downloaded
                        // Match "Downloaded \"Some Artist - Some Title\":"
                        const match = line.match(/Downloaded\\s+"([^"]+)"/i);
                        if (match && match[1]) {
                            // Extract the base filename (Artist - Title) and append .mp3
                            const baseFilename = match[1].trim();
                            const filename = `${baseFilename}.mp3`;
                            // Avoid duplicates
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
                        // Include stderr in the error message for better debugging
                        reject(new Error(`SpotDL process exited with code ${code}. Stderr: ${errorOutput || 'None'}. Stdout: ${output}`));
                        return;
                    }

                    // Give filesystem a brief moment to settle, just in case
                    await new Promise(resolve => setTimeout(resolve, 200)); 

                    try {
                        if (downloadedFilesFromOutput.length === 0) {
                            // Fallback: if stdout parsing failed, try reading directory again
                            console.warn("Could not parse filenames from SpotDL output. Falling back to directory reading.");
                            const filesAfter = await fs.readdir(this.musicDir);
                            const mp3Files = filesAfter.filter(f => f.endsWith('.mp3')); // Simpler check for any mp3
                            if (mp3Files.length > 0) {
                                console.log("Found MP3 files via directory reading:", mp3Files);
                                // Use these files instead, although we can't be sure they are from *this* run
                                downloadedFilesFromOutput.push(...mp3Files); 
                            } else {
                                reject(new Error('SpotDL finished, but no downloaded files were detected from output or directory listing.'));
                                return;
                            }
                        }
                        
                        // Remove duplicates just in case
                        const uniqueFiles = [...new Set(downloadedFilesFromOutput)];
                        console.log('Processing downloaded files:', uniqueFiles);
                        
                        console.log('DEBUG: Contents of uniqueFiles before mapping:', uniqueFiles);
                        
                        const uploadPromises = uniqueFiles.map(async (downloadedFile) => {
                            const filePath = path.join(this.musicDir, downloadedFile);
                            const blobName = downloadedFile; // Use the original filename

                            try {
                                await fs.access(filePath); // Check if the local file exists
                                console.log(`Uploading ${downloadedFile} to blob storage as: ${blobName}`);
                                const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

                                const exists = await blockBlobClient.exists();
                                if (exists) {
                                    console.warn(`Blob ${blobName} already exists. Overwriting.`);
                                }

                                await blockBlobClient.uploadFile(filePath);
                                console.log(`Successfully uploaded ${blobName}`);
                                
                                await fs.unlink(filePath); // Clean up local file
                                console.log('Deleted local file:', filePath);

                                return { 
                                    status: 'fulfilled', 
                                    value: {
                                        url: blockBlobClient.url,
                                        name: blobName
                                    } 
                                };
                            } catch (fileError) {
                                let errorMessage = `Error processing file ${downloadedFile}: ${fileError.message}`;
                                if (fileError.code === 'ENOENT') {
                                     errorMessage = `Error processing file ${downloadedFile}: Local file not found at ${filePath}. It might have been moved or deleted prematurely, or the parsed name was incorrect.`;
                                }
                                console.error(errorMessage);
                                // Return a rejected status for Promise.allSettled
                                return { status: 'rejected', reason: errorMessage }; 
                            }
                        });

                        const results = await Promise.allSettled(uploadPromises);
                        
                        const uploadedTracks = [];
                        const failedUploads = [];

                        results.forEach(result => {
                            if (result.status === 'fulfilled') {
                                uploadedTracks.push(result.value);
                            } else {
                                failedUploads.push(result.reason);
                            }
                        });

                        if (failedUploads.length > 0) {
                            console.error(`Failed to process ${failedUploads.length} file(s):`, failedUploads.join(', '));
                        }
                        
                        if (uploadedTracks.length === 0 && uniqueFiles.length > 0) {
                             console.error(`Processed ${uniqueFiles.length} potential files, but failed to upload any. Check file processing errors above.`);
                             reject(new Error(`Failed to upload any of the ${uniqueFiles.length} potentially downloaded files. Check logs.`));
                             return;
                        }

                        console.log(`Successfully uploaded ${uploadedTracks.length} track(s).`);
                        resolve(uploadedTracks); // Resolve with the array of successfully uploaded tracks

                    } catch (processingError) {
                        console.error('Error processing downloaded files after SpotDL close:', processingError);
                        reject(processingError);
                    }
                });
            } catch (setupError) {
                console.error('Error during download setup:', setupError);
                reject(setupError);
            }
        });
    }

    async listTracks() {
        const tracks = [];
        for await (const blob of this.containerClient.listBlobsFlat()) {
            tracks.push({
                name: blob.name,
                url: `${this.containerClient.url}/${blob.name}`,
                lastModified: blob.properties.lastModified
            });
        }
        return tracks;
    }

    async deleteTrack(trackName) {
        const blockBlobClient = this.containerClient.getBlockBlobClient(trackName);
        await blockBlobClient.delete();
    }

    async getTrackUrl(trackName) {
        const blockBlobClient = this.containerClient.getBlockBlobClient(trackName);
        // Generate SAS URL that expires in 1 hour
        const sasUrl = await blockBlobClient.generateSasUrl({
            permissions: 'r',
            expiresOn: new Date(new Date().valueOf() + 3600 * 1000)
        });
        return sasUrl;
    }

    async checkHealth() {
        try {
            // Check if SpotDL is available
            await new Promise((resolve, reject) => {
                const spotdl = spawn(this.spotdlPath, ['--version']);
                spotdl.on('close', (code) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error('SpotDL is not available'));
                    }
                });
            });

            // Check if Azure container is accessible
            await this.containerClient.getProperties();

            return {
                status: 'healthy',
                spotdl: 'available',
                azure: 'connected'
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