const openaiService = require('../services/openaiService');
const imageConfig = require('../config/imageConfig');
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');

// Configure image storage
const IMAGE_STORAGE_DIR = path.join(__dirname, '..', 'data', 'images');

/**
 * Prepare a reference image: square PNG, no alpha, under 4MB.
 */
async function prepareImageBuffer(imagePath) {
    try {
        let buffer = await sharp(imagePath)
            .resize(1024, 1024, {
                fit: 'contain',
                background: { r: 255, g: 255, b: 255 }
            })
            .flatten({ background: { r: 255, g: 255, b: 255 } }) // Remove alpha channel
            .png({ compressionLevel: 9 })
            .toBuffer();

        // If still too large, reduce size while maintaining square aspect
        let size = 768;
        while (buffer.length > 4 * 1024 * 1024 && size >= 256) {
            buffer = await sharp(imagePath)
                .resize(size, size, {
                    fit: 'contain',
                    background: { r: 255, g: 255, b: 255 }
                })
                .flatten({ background: { r: 255, g: 255, b: 255 } })
                .png({ compressionLevel: 9 })
                .toBuffer();

            size = Math.floor(size * 0.75);
        }

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

    /**
     * Throws when a rate limit is exceeded; otherwise records the request.
     */
    assertCanMakeRequest(contextId) {
        const now = Date.now();

        // Reset counters if cooldown period has passed
        if (now - this.lastReset >= imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod) {
            this.requests.clear();
            this.globalRequests = [];
            this.lastReset = now;
        }

        const timestamps = this.requests.get(contextId) || [];
        const recentTimestamps = timestamps.filter(
            ts => now - ts < imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod
        );
        this.globalRequests = this.globalRequests.filter(
            ts => now - ts < imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod
        );

        if (recentTimestamps.length >= imageConfig.IMAGES.RATE_LIMIT.maxImagesPerContext) {
            throw new Error(`Rate limit exceeded for context ${contextId}. Please wait ${Math.ceil((imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod - (now - recentTimestamps[0])) / 1000)} seconds.`);
        }

        if (this.globalRequests.length >= imageConfig.IMAGES.RATE_LIMIT.maxRequestsPerMinute) {
            throw new Error(`Global rate limit exceeded. Please wait ${Math.ceil((imageConfig.IMAGES.RATE_LIMIT.cooldownPeriod - (now - this.globalRequests[0])) / 1000)} seconds.`);
        }

        this.requests.set(contextId, [...recentTimestamps, now]);
        this.globalRequests.push(now);
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
    generateImageFilename(contextId, type, reference) {
        const sanitizedRef = String(reference || 'image').replace(/[^a-z0-9]/gi, '_').toLowerCase();
        return contextId ?
            `${contextId}_${type.toLowerCase()}_${sanitizedRef}_${Date.now()}.png` :
            `${type.toLowerCase()}_${sanitizedRef}_${Date.now()}.png`;
    }

    /**
     * Persist a generated image buffer and return its path.
     */
    async storeImageBuffer(buffer, filename) {
        const filepath = path.join(IMAGE_STORAGE_DIR, filename);
        await fs.writeFile(filepath, buffer);
        return filepath;
    }

    /**
     * Store image metadata in a JSON file
     */
    async storeImageMetadata(contextId, type, referenceKey, filepath, styleParameters) {
        try {
            const metadataPath = path.join(IMAGE_STORAGE_DIR, `${contextId}_metadata.json`);
            let metadata = {};

            try {
                const existingData = await fs.readFile(metadataPath, 'utf8');
                metadata = JSON.parse(existingData);
            } catch (error) {
                // File doesn't exist or is invalid, start fresh
                metadata = { images: [] };
            }

            metadata.images.push({
                type,
                referenceKey,
                filepath,
                styleParameters,
                generatedAt: new Date().toISOString()
            });

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
     * Core generation: standard text-to-image via the GPT Image model.
     */
    async generateStandardImage(prompt, finalStyle, contextId, referenceKey, type) {
        const stylePrompt = Object.values(finalStyle).join(', ');
        const fullPrompt = `${prompt}, ${stylePrompt}`;

        const buffer = await openaiService.generateImage(fullPrompt, {
            model: imageConfig.IMAGES.GENERATION.model,
            size: imageConfig.IMAGES.GENERATION.size,
            quality: imageConfig.IMAGES.GENERATION.quality
        });

        const filename = this.generateImageFilename(contextId, type, referenceKey || prompt.substring(0, 50));
        return await this.storeImageBuffer(buffer, filename);
    }

    /**
     * Core generation: reference-guided via the image edits endpoint
     * (replaces the retired DALL-E 2 variations endpoint).
     */
    async generateFromReference(referenceImagePath, prompt, finalStyle, contextId, referenceKey, type) {
        const referenceBuffer = await prepareImageBuffer(referenceImagePath);
        const stylePrompt = Object.values(finalStyle).join(', ');
        const fullPrompt = `${prompt}, ${stylePrompt}`;

        const buffer = await openaiService.editImage(referenceBuffer, fullPrompt, {
            model: imageConfig.IMAGES.GENERATION.model,
            size: imageConfig.IMAGES.GENERATION.size
        });

        const filename = this.generateImageFilename(contextId, type, referenceKey || prompt.substring(0, 50));
        return await this.storeImageBuffer(buffer, filename);
    }

    /**
     * Shared generation flow with optional reference image and metadata.
     */
    async _generate({ contextId, type, referenceKey, prompt, finalStyle, referenceOptions }) {
        let filepath;

        if (referenceOptions?.referenceImage) {
            try {
                filepath = await this.generateFromReference(
                    referenceOptions.referenceImage, prompt, finalStyle, contextId, referenceKey, type
                );
            } catch (error) {
                if (error.message.includes('Rate limit')) {
                    throw error;
                }
                console.warn('Failed to generate from reference image, falling back to standard generation:', error.message);
                filepath = await this.generateStandardImage(prompt, finalStyle, contextId, referenceKey, type);
            }
        } else {
            filepath = await this.generateStandardImage(prompt, finalStyle, contextId, referenceKey, type);
        }

        if (!filepath) {
            throw new Error('Failed to store image locally');
        }

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
    }

    /**
     * Generate an image with rate limiting, storage, and metadata.
     */
    async generateAndStoreImage(contextId, type, referenceKey, prompt, styleParams = {}, referenceOptions = null) {
        try {
            this.rateLimiter.assertCanMakeRequest(contextId);

            const typeSettings = imageConfig.IMAGES[type] || {};
            const finalStyle = {
                ...this.defaultStyle,
                ...typeSettings,
                ...styleParams
            };

            return await this._generate({ contextId, type, referenceKey, prompt, finalStyle, referenceOptions });
        } catch (error) {
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

    /**
     * Generate a generic image with optional reference
     */
    async generateImage(type, prompt, referenceOptions = null, contextId = null, referenceKey = null) {
        try {
            if (contextId) {
                this.rateLimiter.assertCanMakeRequest(contextId);
            }

            const typeSettings = imageConfig.IMAGES[type] || {};
            const finalStyle = {
                ...this.defaultStyle,
                ...typeSettings
            };

            return await this._generate({ contextId, type, referenceKey, prompt, finalStyle, referenceOptions });
        } catch (error) {
            console.error('Failed to generate image:', error);
            throw error;
        }
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
