const openaiService = require('../services/openaiService');
const aiService = require('../services/aiService');
const path = require('path');
const fs = require('fs').promises;
const { getPromptWithGuildPersonality } = require('./memeMode');
const adventureConfig = require('../config/adventureConfig');

// Configure image storage
const IMAGE_STORAGE_DIR = path.join(__dirname, '..', 'data', 'images');

// Access raw client for image generation
const openaiClient = openaiService.client;

/**
 * Detect if a message contains a request to generate an image
 * @param {string} message - The message to analyze
 * @returns {Promise<Object>} - Object with needsImage flag and image details if needed
 */
async function detectImageGenerationRequest(message) {
    try {
        // First, determine if message contains an image generation request
        const imageDetectionPrompt = `
You are an AI assistant that determines if a user message is asking for an image to be generated.

User message: "${message}"

Analyze the message and determine if it:
1. Explicitly asks to generate, create, or make an image, picture, drawing, or illustration
2. Asks to visualize something
3. Uses phrases like "show me", "draw", "create an image of", etc. in a way that implies image generation
4. Asks what something looks like in a way that would be best answered with an image

Respond with ONLY "true" if the message is asking for an image to be generated, or "false" if not.
`;

        const detectionResult = await aiService.chat([
            { role: 'user', content: imageDetectionPrompt }
        ], { preset: 'deterministic', max_tokens: 10 });

        const needsImage = detectionResult.trim().toLowerCase() === 'true';

        if (needsImage) {
            // Extract image details if needed
            const imageDetailsPrompt = `
You are an AI assistant that extracts details for image generation from a user message.

User message: "${message}"

Extract the following information:
1. The subject or content of the image (what should be depicted)
2. Any style preferences mentioned (realistic, cartoon, watercolor, etc.)
3. Any other details about composition, colors, mood, etc.

Respond in this exact JSON format:
{
  "prompt": "detailed description of what to generate",
  "type": "SCENE", 
  "style": "preferred style or null if not specified",
  "additional_details": "any other relevant details or null if none"
}

Note: For "type", choose one of: CHARACTER, SCENE, LOCATION, ITEM based on what's being requested.
`;

            const detailsJson = await aiService.chat([
                { role: 'user', content: imageDetailsPrompt }
            ], {
                preset: 'creative',
                max_tokens: 300
            });

            const imageDetails = JSON.parse(detailsJson.trim());

            return {
                needsImage: true,
                imageDetails
            };
        }

        return { needsImage: false };
    } catch (error) {
        console.error('Error in AI-based image detection:', error);
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

        // Prepare image generation options
        const generateOptions = {
            model: 'dall-e-3',
            prompt: fullPrompt,
            size: '1024x1024',
            quality: 'hd',
            n: 1
        };

        // Generate image using OpenAI
        const response = await openaiClient.images.generate(generateOptions);
        const imageUrl = response.data[0].url;
        
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