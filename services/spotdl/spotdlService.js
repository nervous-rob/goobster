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
        this.spotdlPath = 'spotdl'; // Use the global installation
        
        // Log environment information
        console.log('SpotDL Service Initialization:');
        console.log('Music Directory:', this.musicDir);
        console.log('SpotDL Path:', this.spotdlPath);
        console.log('Python Path:', process.env.PYTHON_PATH);
        
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
        return new Promise((resolve, reject) => {
            console.log('Spawning SpotDL process with path:', this.spotdlPath);
            const spotdl = spawn(this.spotdlPath, ['download', spotifyUrl, '--output', this.musicDir]);
            
            let output = '';
            let error = '';

            spotdl.stdout.on('data', (data) => {
                output += data.toString();
                console.log(`SpotDL: ${data}`);
            });

            spotdl.stderr.on('data', (data) => {
                error += data.toString();
                console.error(`SpotDL Error: ${data}`);
            });

            spotdl.on('error', (err) => {
                console.error('Failed to start SpotDL process:', err);
                reject(err);
            });

            spotdl.on('close', async (code) => {
                console.log(`SpotDL process exited with code ${code}`);
                if (code !== 0) {
                    reject(new Error(`SpotDL process exited with code ${code}: ${error}`));
                    return;
                }

                try {
                    // Find the downloaded file
                    const files = await fs.readdir(this.musicDir);
                    console.log('Files in music directory:', files);
                    const downloadedFile = files.find(f => f.endsWith('.mp3'));
                    
                    if (!downloadedFile) {
                        reject(new Error('No MP3 file found after download'));
                        return;
                    }

                    console.log('Found downloaded file:', downloadedFile);
                    const filePath = path.join(this.musicDir, downloadedFile);
                    
                    // Upload to blob storage
                    const blobName = `${Date.now()}-${downloadedFile}`;
                    console.log('Uploading to blob storage:', blobName);
                    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
                    
                    await blockBlobClient.uploadFile(filePath);
                    
                    // Clean up local file
                    await fs.unlink(filePath);
                    
                    resolve({
                        url: blockBlobClient.url,
                        name: downloadedFile
                    });
                } catch (err) {
                    console.error('Error processing downloaded file:', err);
                    reject(err);
                }
            });
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