const { createLogger } = require('./logger');
const aiService = require('../services/ai/instance');
const path = require('path');
const fs = require('fs').promises;
const { getPromptWithGuildPersonality } = require('./memeMode');
const adventureConfig = require('../config/adventureConfig');

const logger = createLogger('ImageDetectionHandler');

// Configure image storage
const IMAGE_STORAGE_DIR = path.join(__dirname, '..', 'data', 'images');

/**
 * Detect if a message contains a request to generate an image
 * @param {string} message - The message to analyze
 * @returns {Promise<Object>} - Object with needsImage flag and image details if needed
 */
async function detectImageGenerationRequest(message) {
    try {
        const detectionPrompt = `
Analyze this message and determine if it requires image generation:
"${message}"

Consider:
1. Does it explicitly ask for an image, drawing, or visual?
2. Does it describe something that would benefit from visual representation?
3. Does it use words like "show", "draw", "create", "generate", "picture", "image"?

Respond with ONLY "true" if image generation is needed, or "false" if not needed.`;

        const needsImageResponse = await aiService.generateResponse({
            messages: [
                { role: 'system', content: 'You are an expert at detecting when users want images generated.' },
                { role: 'user', content: detectionPrompt }
            ],
            model: 'o1-mini', // Use O1 Mini for detection
            temperature: 0.1,
            maxTokens: 10
        });

        const needsImage = needsImageResponse.content.trim().toLowerCase() === 'true';

        if (needsImage) {
            const detailsPrompt = `
Extract image generation details from this message:
"${message}"

Provide a JSON response with:
1. prompt: A detailed description of what to generate
2. type: One of "CHARACTER", "SCENE", "LOCATION", or "ITEM"
3. style: One of "fantasy", "realistic", "anime", "comic", "watercolor", or "oil_painting"

Example response:
{
    "prompt": "majestic dragon with iridescent scales",
    "type": "CHARACTER",
    "style": "fantasy"
}

Return ONLY the JSON object, nothing else.`;

            const imageDetailsResponse = await aiService.generateResponse({
                messages: [
                    { role: 'system', content: 'You are an expert at extracting image generation details from user requests.' },
                    { role: 'user', content: detailsPrompt }
                ],
                model: 'o1-mini', // Use O1 Mini for details extraction
                temperature: 0.3,
                maxTokens: 200
            });

            const imageDetails = JSON.parse(imageDetailsResponse.content);
            return {
                needsImage: true,
                imageDetails
            };
        }

        return { needsImage: false };
    } catch (error) {
        logger.error('Error detecting image generation request:', error);
        return { needsImage: false };
    }
}

/**
 * Generate an image based on a prompt
 * @param {string} prompt - The image description
 * @param {string} type - The type of image (CHARACTER, SCENE, LOCATION, ITEM)
 * @param {string} style - The style preference
 * @returns {Promise<string>} - The path to the generated image
 */
async function generateImage(prompt, type = 'SCENE', style = 'fantasy') {
    try {
        // Ensure image directory exists
        await fs.mkdir(IMAGE_STORAGE_DIR, { recursive: true });

        // Get style parameters based on selected style and type
        const typeSettings = adventureConfig.IMAGES[type] || {};
        const styleMap = {
            'fantasy': { artStyle: 'digital fantasy art', colorPalette: 'vibrant and rich', mood: 'epic and adventurous' },
            'realistic': { artStyle: 'photorealistic', colorPalette: 'natural', mood: 'authentic' },
            'anime': { artStyle: 'anime style', colorPalette: 'bright and colorful', mood: 'expressive' },
            'comic': { artStyle: 'comic book style', colorPalette: 'bold', mood: 'dynamic' },
            'watercolor': { artStyle: 'watercolor painting', colorPalette: 'soft and blended', mood: 'serene' },
            'oil_painting': { artStyle: 'oil painting', colorPalette: 'rich and textured', mood: 'classical' }
        };

        const finalStyle = {
            ...adventureConfig.IMAGES.DEFAULT_STYLE,
            ...typeSettings,
            ...(styleMap[style] || styleMap['fantasy'])
        };

        // Convert style parameters into a prompt suffix
        const stylePrompt = Object.values(finalStyle).join(', ');
        const fullPrompt = `${prompt}, ${stylePrompt}`;

        // Generate image using AI service
        const imageUrl = await aiService.generateImage({
            model: adventureConfig.IMAGES.GENERATION.model,
            prompt: fullPrompt,
            size: adventureConfig.IMAGES.GENERATION.size,
            quality: adventureConfig.IMAGES.GENERATION.quality,
            style: adventureConfig.IMAGES.GENERATION.style
        });
        
        // Generate a unique filename
        const timestamp = Date.now();
        const sanitizedPrompt = prompt.substring(0, 30).replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const filename = `chat_${sanitizedPrompt}_${timestamp}.png`;
        
        // Download and store the image
        const filepath = path.join(IMAGE_STORAGE_DIR, filename);
        const imageResponse = await fetch(imageUrl);
        const arrayBuffer = await imageResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        await fs.writeFile(filepath, buffer);

        return filepath;
    } catch (error) {
        console.error('Error generating image:', error);
        throw error;
    }
}

module.exports = {
    detectImageGenerationRequest,
    generateImage
}; 