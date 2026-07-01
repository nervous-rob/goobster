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

const openaiService = require('../services/openaiService');
const imageConfig = require('../config/imageConfig');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');

const openai = openaiService.client;

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
        this.requests = new Map(); // contextId -> timestamp[]
        this.lastReset = Date.now();
        this.globalRequests = []; // Track all requests across contexts
    }

    canMakeRequest(contextId) {
        const now = Date.now();
        
        // Reset counters if cooldown period has passed
        if (now - this.lastReset >= imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod) {
            this.requests.clear();
            this.globalRequests = [];
            this.lastReset = now;
        }

        // Get or initialize request timestamps for this context
        const timestamps = this.requests.get(contextId) || [];
        
        // Remove old timestamps
        const recentTimestamps = timestamps.filter(
            ts => now - ts < imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod
        );

        // Remove old global timestamps
        this.globalRequests = this.globalRequests.filter(
            ts => now - ts < imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod
        );

        // Check both context-specific and global limits
        if (recentTimestamps.length >= imageConfig.IMAGES.RATE_LIMIT.maxImagesPerContext) {
            throw new Error(`Rate limit exceeded for context ${contextId}. Please wait ${Math.ceil((imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod - (now - recentTimestamps[0])) / 1000)} seconds.`);
        }

        if (this.globalRequests.length >= imageConfig.IMAGES.RATE_LIMIT.maxRequestsPerMinute) {
            throw new Error(`Global rate limit exceeded. Please wait ${Math.ceil((imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod - (now - this.globalRequests[0])) / 1000)} seconds.`);
        }

        // Update timestamps
        this.requests.set(contextId, [...recentTimestamps, now]);
        this.globalRequests.push(now);
        return true;
    }

    // Helper method to get remaining requests
    getRemainingRequests(contextId) {
        const now = Date.now();
        const timestamps = this.requests.get(contextId) || [];
        const recentTimestamps = timestamps.filter(
            ts => now - ts < imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod
        );
        const globalRecent = this.globalRequests.filter(
            ts => now - ts < imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod
        );

        return {
            context: imageConfig.IMAGES.RATE_LIMIT.maxImagesPerContext - recentTimestamps.length,
            global: imageConfig.IMAGES.RATE_LIMIT.maxRequestsPerMinute - globalRecent.length,
            resetIn: Math.ceil((imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod - (now - this.lastReset)) / 1000)
        };
    }
}

class ImageGenerator {
    constructor() {
        this.defaultStyle = imageConfig.IMAGES.DEFAULT_STYLE;
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
    generateImageFilename(contextId, type, referenceKey) {
        const sanitizedRef = referenceKey.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        return `${contextId}_${type.toLowerCase()}_${sanitizedRef}_${Date.now()}.png`;
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
    async storeImageMetadata(contextId, type, referenceKey, filepath, styleParameters) {
        try {
            const metadataPath = path.join(IMAGE_STORAGE_DIR, `${contextId}_metadata.json`);
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
    async getMostRecentImage(contextId, type) {
        try {
            const metadataPath = path.join(IMAGE_STORAGE_DIR, `${contextId}_metadata.json`);
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
    async generateAndStoreImage(contextId, type, referenceKey, prompt, styleParams = {}, referenceOptions = null) {
        try {
            // Check rate limits before proceeding
            if (!this.rateLimiter.canMakeRequest(contextId)) {
                const remaining = this.rateLimiter.getRemainingRequests(contextId);
                throw new Error(`Rate limit exceeded. Please wait ${remaining.resetIn} seconds. Remaining requests: ${remaining.adventure} per context, ${remaining.global} global.`);
            }

            // Merge default style with specific type settings and provided params
            const typeSettings = imageConfig.IMAGES[type] || {};
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
                    const filename = this.generateImageFilename(contextId, type, referenceKey);
                    filepath = await this.downloadAndStoreImage(imageUrl, filename);

                } catch (error) {
                    if (error.message.includes('rate limit')) {
                        throw error; // Re-throw rate limit errors
                    }
                    console.warn('Failed to generate variation from reference image:', error);
                    console.log('Falling back to standard image generation...');
                    return this.generateStandardImage(contextId, type, referenceKey, prompt, finalStyle);
                }
            } else {
                filepath = await this.generateStandardImage(contextId, type, referenceKey, prompt, finalStyle);
            }

            if (!filepath) {
                throw new Error('Failed to store image locally');
            }

            // Store metadata with reference info
            await this.storeImageMetadata(
                contextId, 
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
            // Log the error with context
            console.error('Failed to generate image:', {
                error: error.message,
                contextId,
                type,
                referenceKey,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    // Helper method for standard image generation
    async generateStandardImage(contextId, type, referenceKey, prompt, finalStyle) {
        // Convert style parameters into a prompt suffix
        const stylePrompt = Object.values(finalStyle).join(', ');
        const fullPrompt = `${prompt}, ${stylePrompt}`;

        // Prepare image generation options
        const generateOptions = {
            model: imageConfig.IMAGES.GENERATION.model,
            prompt: fullPrompt,
            size: imageConfig.IMAGES.GENERATION.size,
            quality: imageConfig.IMAGES.GENERATION.quality,
            style: imageConfig.IMAGES.GENERATION.style,
            n: 1,
        };

        // Generate image using OpenAI
        const response = await openai.images.generate(generateOptions);
        const imageUrl = response.data[0].url;
        const filename = this.generateImageFilename(contextId, type, referenceKey);
        
        return await this.downloadAndStoreImage(imageUrl, filename);
    }

    /**
     * Generate a generic image with optional reference
     */
    async generateImage(type, prompt, referenceOptions = null, contextId = null, referenceKey = null) {
        try {
            // Get style settings for the type
            const typeSettings = imageConfig.IMAGES[type] || {};
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
                    const filename = contextId ? 
                        this.generateImageFilename(contextId, type, referenceKey) :
                        this.generateImageFilename(type, prompt.substring(0, 50));
                    filepath = await this.downloadAndStoreImage(imageUrl, filename);

                } catch (error) {
                    console.warn('Failed to generate variation from reference image:', error);
                    console.log('Falling back to standard image generation...');
                    return this.generateStandardImage(type, prompt, finalStyle, contextId, referenceKey);
                }
            } else {
                filepath = await this.generateStandardImage(type, prompt, finalStyle, contextId, referenceKey);
            }

            if (!filepath) {
                throw new Error('Failed to store image locally');
            }

            // Store metadata if we have a context ID
            if (contextId) {
                await this.storeImageMetadata(
                    contextId,
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
    async generateStandardImage(type, prompt, finalStyle, contextId = null, referenceKey = null) {
        // Convert style parameters into a prompt suffix
        const stylePrompt = Object.values(finalStyle).join(', ');
        const fullPrompt = `${prompt}, ${stylePrompt}`;

        // Prepare image generation options
        const generateOptions = {
            model: imageConfig.IMAGES.GENERATION.model,
            prompt: fullPrompt,
            size: imageConfig.IMAGES.GENERATION.size,
            quality: imageConfig.IMAGES.GENERATION.quality,
            style: imageConfig.IMAGES.GENERATION.style,
            n: 1,
        };

        // Generate image using OpenAI
        const response = await openai.images.generate(generateOptions);
        const imageUrl = response.data[0].url;
        const filename = contextId ? 
            this.generateImageFilename(contextId, type, referenceKey) :
            this.generateImageFilename(type, prompt.substring(0, 50));
        
        return await this.downloadAndStoreImage(imageUrl, filename);
    }

    /**
     * Generate a filename for an image
     */
    generateImageFilename(contextId, type, reference) {
        const sanitizedRef = reference.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        return contextId ? 
            `${contextId}_${type.toLowerCase()}_${sanitizedRef}_${Date.now()}.png` :
            `${type.toLowerCase()}_${sanitizedRef}_${Date.now()}.png`;
    }

    /**
     * Get existing image by type and reference
     */
    async getExistingImage(contextId, type, referenceKey) {
        try {
            const metadataPath = path.join(IMAGE_STORAGE_DIR, `${contextId}_metadata.json`);
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
     * Check if a context has reached its image generation limit
     */
    async hasReachedImageLimit(contextId) {
        try {
            const metadataPath = path.join(IMAGE_STORAGE_DIR, `${contextId}_metadata.json`);
            const data = await fs.readFile(metadataPath, 'utf8');
            const metadata = JSON.parse(data);

            const recentImages = metadata.images.filter(img => {
                const generatedAt = new Date(img.generatedAt);
                const oneMinuteAgo = new Date(Date.now() - 60000);
                return generatedAt > oneMinuteAgo;
            });

            return recentImages.length >= imageConfig.IMAGES.RATE_LIMIT.maxImagesPerContext;
        } catch (error) {
            console.error('Failed to check image limit:', error.message);
            return true; // Fail safe: assume limit reached if we can't check
        }
    }

    /**
     * Generate a character portrait
     */
    async generateCharacterPortrait(contextId, character) {
        const prompt = `Fantasy character portrait of ${character.adventurerName}, ${character.backstory || 'a brave adventurer'}`;
        return this.generateImage(
            imageConfig.IMAGES.TYPES.CHARACTER,
            prompt,
            null,  // no reference for initial portraits
            contextId,
            character.adventurerName
        );
    }

    /**
     * Generate a location image
     */
    async generateLocationImage(contextId, location, setting) {
        const prompt = `Fantasy location: ${location.place} in ${setting.geography}, ${setting.culture} style`;
        return this.generateImage(
            imageConfig.IMAGES.TYPES.LOCATION,
            prompt,
            null,  // no reference for initial location
            contextId,
            location.place
        );
    }

    /**
     * Generate a scene image
     */
    async generateSceneImage(contextId, scene, characters = [], referenceOptions = null) {
        const characterNames = characters.map(c => c.adventurerName).join(' and ');
        const prompt = `Fantasy scene: ${scene}, featuring ${characterNames}`;
        return this.generateImage(
            imageConfig.IMAGES.TYPES.SCENE,
            prompt,
            referenceOptions,
            contextId,
            scene.substring(0, 50)
        );
    }

    /**
     * Generate an item image
     */
    async generateItemImage(contextId, item) {
        const prompt = `Fantasy item: ${item}`;
        return this.generateImage(
            imageConfig.IMAGES.TYPES.ITEM,
            prompt,
            null,  // no reference for items
            contextId,
            item.substring(0, 50)
        );
    }
}

module.exports = new ImageGenerator(); 