/**
 * Image generation configuration.
 * Extracted from the retired adventure system config; used by /generate and
 * the chat image-generation tools.
 */
module.exports = {
    IMAGES: {
        // Types of images that can be generated
        TYPES: {
            CHARACTER: 'CHARACTER',
            LOCATION: 'LOCATION',
            ITEM: 'ITEM',
            SCENE: 'SCENE'
        },

        // Default style parameters for consistent image generation
        DEFAULT_STYLE: {
            artStyle: 'digital fantasy art',
            colorPalette: 'vibrant and rich',
            lighting: 'dramatic',
            perspective: 'portrait view',
            quality: 'highly detailed',
            mood: 'epic and adventurous'
        },

        // Character portrait specific settings
        CHARACTER_PORTRAIT: {
            viewpoint: 'upper body portrait',
            background: 'subtle fantasy background',
            pose: 'heroic stance',
            detailLevel: 'high detail on face and clothing'
        },

        // Location image specific settings
        LOCATION: {
            viewpoint: 'wide establishing shot',
            perspective: 'epic scale',
            detailLevel: 'high environmental detail',
            lighting: 'atmospheric'
        },

        // Scene image specific settings
        SCENE: {
            viewpoint: 'dynamic action view',
            perspective: 'cinematic',
            detailLevel: 'high detail on key elements',
            lighting: 'dramatic and atmospheric'
        },

        // Item image specific settings
        ITEM: {
            viewpoint: 'close-up detail shot',
            background: 'subtle environmental context',
            lighting: 'focused highlight',
            detailLevel: 'extremely high detail'
        },

        // Generation settings
        GENERATION: {
            model: 'dall-e-3',
            variation_model: 'dall-e-2',
            size: '1024x1024',
            quality: 'standard',
            style: 'vivid',
            maxRetries: 3,
            retryDelay: 1000 // ms
        },

        // Rate limiting settings
        RATE_LIMIT: {
            maxRequestsPerMinute: 5,
            maxImagesPerContext: 5,
            cooldownPeriod: 60000 // ms (1 minute)
        }
    }
};
