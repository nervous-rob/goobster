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
        this.spotdlPath = '/usr/local/bin/spotdl';
        
        // Ensure container exists
        this.ensureContainerExists();
    }

    async ensureContainerExists() {
        try {
            await this.containerClient.createIfNotExists();
            console.log('Azure Blob Storage container is ready');
        } catch (error) {
            console.error('Error ensuring container exists:', error);
            throw error;
        }
    }

    async downloadTrack(spotifyUrl) {
        return new Promise((resolve, reject) => {
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

            spotdl.on('close', async (code) => {
                if (code !== 0) {
                    reject(new Error(`SpotDL process exited with code ${code}: ${error}`));
                    return;
                }

                try {
                    // Find the downloaded file
                    const files = await fs.readdir(this.musicDir);
                    const downloadedFile = files.find(f => f.endsWith('.mp3'));
                    
                    if (!downloadedFile) {
                        reject(new Error('No MP3 file found after download'));
                        return;
                    }

                    const filePath = path.join(this.musicDir, downloadedFile);
                    
                    // Upload to blob storage
                    const blobName = `${Date.now()}-${downloadedFile}`;
                    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
                    
                    await blockBlobClient.uploadFile(filePath);
                    
                    // Clean up local file
                    await fs.unlink(filePath);
                    
                    resolve({
                        url: blockBlobClient.url,
                        name: downloadedFile
                    });
                } catch (err) {
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