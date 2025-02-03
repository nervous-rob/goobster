// TODO: Add proper handling for image generation timeouts
// TODO: Add proper handling for image generation failures
// TODO: Add proper handling for image quality validation
// TODO: Add proper handling for image size limits
// TODO: Add proper handling for image format conversion
// TODO: Add proper handling for image metadata
// TODO: Add proper handling for image caching
// TODO: Add proper handling for image cleanup
// TODO: Add proper handling for image versioning
// TODO: Add proper handling for storage space limits
// TODO: Add proper handling for storage cleanup
// TODO: Add proper handling for storage persistence
// TODO: Add proper handling for storage recovery
// TODO: Add proper handling for storage synchronization

const OpenAI = require('openai');
const config = require('../config.json');
const adventureConfig = require('../config/adventureConfig');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');

const openai = new OpenAI({
    apiKey: config.openaiKey
});

// Configure image storage
const IMAGE_STORAGE_DIR = path.join(__dirname, '..', 'data', 'images');

// Add function to check and compress image if needed
async function prepareImageBuffer(imagePath) {
    try {
        // First convert to square PNG with white background, no alpha
        let buffer = await sharp(imagePath)
            .resize(1024, 1024, {  // Start with max size
                fit: 'contain',
                background: { r: 255, g: 255, b: 255 }
            })
            .flatten({ background: { r: 255, g: 255, b: 255 } }) // Remove alpha channel
            .png({ 
                compressionLevel: 9,  // Maximum PNG compression
            })
            .toBuffer();

        // If still too large, reduce size while maintaining square aspect
        let size = 768;  // Try next size down
        while (buffer.length > 4 * 1024 * 1024 && size >= 256) {
            buffer = await sharp(imagePath)
                .resize(size, size, {
                    fit: 'contain',
                    background: { r: 255, g: 255, b: 255 }
                })
                .flatten({ background: { r: 255, g: 255, b: 255 } })
                .png({ 
                    compressionLevel: 9
                })
                .toBuffer();
            
            size = Math.floor(size * 0.75);  // Reduce by 25% each time
        }

        const fileSizeMB = buffer.length / (1024 * 1024);
        console.log(`Final image size: ${fileSizeMB.toFixed(2)}MB, dimensions: ${size}x${size}`);

        if (buffer.length > 4 * 1024 * 1024) {
            throw new Error('Unable to compress image below 4MB');
        }

        return buffer;
    } catch (error) {
        console.error('Error preparing image:', error);
        throw error;
    }
}

class RateLimiter {
    constructor() {
        this.requests = new Map(); // adventureId -> timestamp[]
        this.lastReset = Date.now();
    }

    canMakeRequest(adventureId) {
        const now = Date.now();
        
        // Reset counters if cooldown period has passed
        if (now - this.lastReset >= adventureConfig.IMAGES.RATE_LIMIT.cooldownPeriod) {
            this.requests.clear();
            this.lastReset = now;
        }

        // Get or initialize request timestamps for this adventure
        const timestamps = this.requests.get(adventureId) || [];
        
        // Remove old timestamps
        const recentTimestamps = timestamps.filter(
            ts => now - ts < adventureConfig.IMAGES.RATE_LIMIT.cooldownPeriod
        );

        // Check limits
        if (recentTimestamps.length >= adventureConfig.IMAGES.RATE_LIMIT.maxImagesPerAdventure) {
            return false;
        }

        // Update timestamps
        this.requests.set(adventureId, [...recentTimestamps, now]);
        return true;
    }
}

class ImageGenerator {
    constructor() {
        this.defaultStyle = adventureConfig.IMAGES.DEFAULT_STYLE;
        this.rateLimiter = new RateLimiter();
        this.ensureStorageDir();
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Ensure the image storage directory exists
     */
    async ensureStorageDir() {
        try {
            await fs.mkdir(IMAGE_STORAGE_DIR, { recursive: true });
        } catch (error) {
            console.error('Failed to create image storage directory:', error);
        }
    }

    /**
     * Generate a unique filename for an image
     */
    generateImageFilename(adventureId, type, referenceKey) {
        const sanitizedRef = referenceKey.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        return `${adventureId}_${type.toLowerCase()}_${sanitizedRef}_${Date.now()}.png`;
    }

    /**
     * Download and store an image locally
     */
    async downloadAndStoreImage(imageUrl, filename) {
        try {
            const response = await axios({
                method: 'GET',
                url: imageUrl,
                responseType: 'arraybuffer'
            });

            const filepath = path.join(IMAGE_STORAGE_DIR, filename);
            await fs.writeFile(filepath, response.data);

            // Return the relative path that can be used in Discord
            return filepath;
        } catch (error) {
            console.error('Failed to download and store image:', error.message);
            return null;
        }
    }

    /**
     * Store image metadata in a JSON file
     */
    async storeImageMetadata(adventureId, type, referenceKey, filepath, styleParameters) {
        try {
            const metadataPath = path.join(IMAGE_STORAGE_DIR, `${adventureId}_metadata.json`);
            let metadata = {};

            // Try to read existing metadata
            try {
                const existingData = await fs.readFile(metadataPath, 'utf8');
                metadata = JSON.parse(existingData);
            } catch (error) {
                // File doesn't exist or is invalid, start fresh
                metadata = { images: [] };
            }

            // Add new image metadata
            metadata.images.push({
                type,
                referenceKey,
                filepath,
                styleParameters,
                generatedAt: new Date().toISOString()
            });

            // Save updated metadata
            await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
            return true;
        } catch (error) {
            console.error('Failed to store image metadata:', error.message);
            return false;
        }
    }

    /**
     * Get the most recent image of a specific type
     */
    async getMostRecentImage(adventureId, type) {
        try {
            const metadataPath = path.join(IMAGE_STORAGE_DIR, `${adventureId}_metadata.json`);
            const data = await fs.readFile(metadataPath, 'utf8');
            const metadata = JSON.parse(data);

            // Find the most recent image of the specified type
            const images = metadata.images
                .filter(img => img.type === type)
                .sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));

            return images[0] || null;
        } catch (error) {
            console.error('Failed to get recent image:', error.message);
            return null;
        }
    }

    /**
     * Generate an image with optional reference
     */
    async generateAndStoreImage(adventureId, type, referenceKey, prompt, styleParams = {}, referenceOptions = null) {
        if (!this.rateLimiter.canMakeRequest(adventureId)) {
            throw new Error('Rate limit exceeded for image generation');
        }

        try {
            // Merge default style with specific type settings and provided params
            const typeSettings = adventureConfig.IMAGES[type] || {};
            const finalStyle = {
                ...this.defaultStyle,
                ...typeSettings,
                ...styleParams
            };

            let filepath;

            if (referenceOptions?.referenceImage) {
                try {
                    // Read and prepare the reference image
                    const referenceBuffer = await prepareImageBuffer(referenceOptions.referenceImage);
                    
                    // Use the variations API endpoint for reference-based generation
                    const response = await openai.images.createVariation({
                        image: referenceBuffer,
                        n: 1,
                        size: "1024x1024",  // Use string format as specified in docs
                        response_format: "url"  // Explicitly request URL response
                    });

                    const imageUrl = response.data[0].url;
                    const filename = this.generateImageFilename(adventureId, type, referenceKey);
                    filepath = await this.downloadAndStoreImage(imageUrl, filename);

                } catch (error) {
                    console.warn('Failed to generate variation from reference image:', error);
                    // Fallback to standard generation if variation fails
                    console.log('Falling back to standard image generation...');
                    return this.generateStandardImage(adventureId, type, referenceKey, prompt, finalStyle);
                }
            } else {
                filepath = await this.generateStandardImage(adventureId, type, referenceKey, prompt, finalStyle);
            }

            if (!filepath) {
                throw new Error('Failed to store image locally');
            }

            // Store metadata with reference info
            await this.storeImageMetadata(
                adventureId, 
                type, 
                referenceKey, 
                filepath, 
                {
                    ...finalStyle,
                    referenceImage: referenceOptions?.referenceImage,
                    referenceType: referenceOptions?.referenceType,
                    styleWeight: referenceOptions?.styleWeight
                }
            );

            return filepath;
        } catch (error) {
            console.error('Failed to generate image:', error.message);
            throw new Error('Failed to generate image');
        }
    }

    // Helper method for standard image generation
    async generateStandardImage(adventureId, type, referenceKey, prompt, finalStyle) {
        // Convert style parameters into a prompt suffix
        const stylePrompt = Object.values(finalStyle).join(', ');
        const fullPrompt = `${prompt}, ${stylePrompt}`;

        // Prepare image generation options
        const generateOptions = {
            model: adventureConfig.IMAGES.GENERATION.model,
            prompt: fullPrompt,
            size: adventureConfig.IMAGES.GENERATION.size,
            quality: adventureConfig.IMAGES.GENERATION.quality,
            style: adventureConfig.IMAGES.GENERATION.style,
            n: 1,
        };

        // Generate image using OpenAI
        const response = await openai.images.generate(generateOptions);
        const imageUrl = response.data[0].url;
        const filename = this.generateImageFilename(adventureId, type, referenceKey);
        
        return await this.downloadAndStoreImage(imageUrl, filename);
    }

    /**
     * Generate a generic image with optional reference
     */
    async generateImage(type, prompt, referenceOptions = null, adventureId = null, referenceKey = null) {
        try {
            // Get style settings for the type
            const typeSettings = adventureConfig.IMAGES[type] || {};
            const finalStyle = {
                ...this.defaultStyle,
                ...typeSettings
            };

            let filepath;

            if (referenceOptions?.referenceImage) {
                try {
                    // Read and prepare the reference image
                    const referenceBuffer = await prepareImageBuffer(referenceOptions.referenceImage);
                    
                    // Use the variations API endpoint for reference-based generation
                    const response = await openai.images.createVariation({
                        image: referenceBuffer,
                        n: 1,
                        size: "1024x1024",
                        response_format: "url"
                    });

                    const imageUrl = response.data[0].url;
                    const filename = adventureId ? 
                        this.generateImageFilename(adventureId, type, referenceKey) :
                        this.generateImageFilename(type, prompt.substring(0, 50));
                    filepath = await this.downloadAndStoreImage(imageUrl, filename);

                } catch (error) {
                    console.warn('Failed to generate variation from reference image:', error);
                    console.log('Falling back to standard image generation...');
                    return this.generateStandardImage(type, prompt, finalStyle, adventureId, referenceKey);
                }
            } else {
                filepath = await this.generateStandardImage(type, prompt, finalStyle, adventureId, referenceKey);
            }

            if (!filepath) {
                throw new Error('Failed to store image locally');
            }

            // Store metadata if we have an adventure ID
            if (adventureId) {
                await this.storeImageMetadata(
                    adventureId,
                    type,
                    referenceKey,
                    filepath,
                    {
                        ...finalStyle,
                        referenceImage: referenceOptions?.referenceImage,
                        referenceType: referenceOptions?.referenceType,
                        styleWeight: referenceOptions?.styleWeight
                    }
                );
            }

            return filepath;
        } catch (error) {
            console.error('Failed to generate image:', error);
            throw new Error('Failed to generate image');
        }
    }

    // Helper method for standard image generation
    async generateStandardImage(type, prompt, finalStyle, adventureId = null, referenceKey = null) {
        // Convert style parameters into a prompt suffix
        const stylePrompt = Object.values(finalStyle).join(', ');
        const fullPrompt = `${prompt}, ${stylePrompt}`;

        // Prepare image generation options
        const generateOptions = {
            model: adventureConfig.IMAGES.GENERATION.model,
            prompt: fullPrompt,
            size: adventureConfig.IMAGES.GENERATION.size,
            quality: adventureConfig.IMAGES.GENERATION.quality,
            style: adventureConfig.IMAGES.GENERATION.style,
            n: 1,
        };

        // Generate image using OpenAI
        const response = await openai.images.generate(generateOptions);
        const imageUrl = response.data[0].url;
        const filename = adventureId ? 
            this.generateImageFilename(adventureId, type, referenceKey) :
            this.generateImageFilename(type, prompt.substring(0, 50));
        
        return await this.downloadAndStoreImage(imageUrl, filename);
    }

    /**
     * Generate a filename for an image
     */
    generateImageFilename(adventureId, type, reference) {
        const sanitizedRef = reference.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        return adventureId ? 
            `${adventureId}_${type.toLowerCase()}_${sanitizedRef}_${Date.now()}.png` :
            `${type.toLowerCase()}_${sanitizedRef}_${Date.now()}.png`;
    }

    /**
     * Get existing image by type and reference
     */
    async getExistingImage(adventureId, type, referenceKey) {
        try {
            const metadataPath = path.join(IMAGE_STORAGE_DIR, `${adventureId}_metadata.json`);
            const data = await fs.readFile(metadataPath, 'utf8');
            const metadata = JSON.parse(data);

            const image = metadata.images.find(img => 
                img.type === type && 
                img.referenceKey === referenceKey
            );

            return image || null;
        } catch (error) {
            console.error('Failed to retrieve image metadata:', error.message);
            return null;
        }
    }

    /**
     * Check if an adventure has reached its image generation limit
     */
    async hasReachedImageLimit(adventureId) {
        try {
            const metadataPath = path.join(IMAGE_STORAGE_DIR, `${adventureId}_metadata.json`);
            const data = await fs.readFile(metadataPath, 'utf8');
            const metadata = JSON.parse(data);

            const recentImages = metadata.images.filter(img => {
                const generatedAt = new Date(img.generatedAt);
                const oneMinuteAgo = new Date(Date.now() - 60000);
                return generatedAt > oneMinuteAgo;
            });

            return recentImages.length >= adventureConfig.IMAGES.RATE_LIMIT.maxImagesPerAdventure;
        } catch (error) {
            console.error('Failed to check image limit:', error.message);
            return true; // Fail safe: assume limit reached if we can't check
        }
    }

    /**
     * Generate a character portrait
     */
    async generateCharacterPortrait(adventureId, character) {
        const prompt = `Fantasy character portrait of ${character.adventurerName}, ${character.backstory || 'a brave adventurer'}`;
        return this.generateImage(
            adventureConfig.IMAGES.TYPES.CHARACTER,
            prompt,
            null,  // no reference for initial portraits
            adventureId,
            character.adventurerName
        );
    }

    /**
     * Generate a location image
     */
    async generateLocationImage(adventureId, location, setting) {
        const prompt = `Fantasy location: ${location.place} in ${setting.geography}, ${setting.culture} style`;
        return this.generateImage(
            adventureConfig.IMAGES.TYPES.LOCATION,
            prompt,
            null,  // no reference for initial location
            adventureId,
            location.place
        );
    }

    /**
     * Generate a scene image
     */
    async generateSceneImage(adventureId, scene, characters = [], referenceOptions = null) {
        const characterNames = characters.map(c => c.adventurerName).join(' and ');
        const prompt = `Fantasy scene: ${scene}, featuring ${characterNames}`;
        return this.generateImage(
            adventureConfig.IMAGES.TYPES.SCENE,
            prompt,
            referenceOptions,
            adventureId,
            scene.substring(0, 50)
        );
    }

    /**
     * Generate an item image
     */
    async generateItemImage(adventureId, item) {
        const prompt = `Fantasy item: ${item}`;
        return this.generateImage(
            adventureConfig.IMAGES.TYPES.ITEM,
            prompt,
            null,  // no reference for items
            adventureId,
            item.substring(0, 50)
        );
    }
}

module.exports = new ImageGenerator(); 