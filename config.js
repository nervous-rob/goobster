require('dotenv').config();

module.exports = {
    replicate: {
        apiKey: process.env.REPLICATE_API_KEY,
        models: {
            musicgen: {
                version: "7a76a8258b23fae65c5a22debb8841d1d7e816b75c2f24218cd2bd8573787906",
                defaults: {
                    model_version: "melody",
                    duration: 30,
                    temperature: 1,
                    top_k: 250,
                    top_p: 0,
                    classifier_free_guidance: 3
                },
                ambient: {
                    model_version: "large",  // Use large model for better environmental sounds
                    duration: 30,
                    temperature: 0.7,  // Lower temperature for more consistent output
                    top_k: 50,         // Lower top_k for more focused sampling
                    top_p: 0.9,        // Higher top_p for more natural sounds
                    classifier_free_guidance: 4  // Stronger guidance for ambient sounds
                }
            }
        }
    },
    // Perplexity API key
    perplexity: {
        apiKey: process.env.PERPLEXITY_API_KEY
    },

    // Voice and audio settings

    audio: {
        music: {
            volume: 0.3,  // Background music volume (0.0 to 1.0)
            fadeInDuration: 2000,  // Fade in duration in milliseconds
            fadeOutDuration: 2000,  // Fade out duration in milliseconds
            crossfadeDuration: 3000,  // Duration of crossfade for looping
            loopFadeStart: 5000    // Start fading this many ms before the end for loop
        },
        ambient: {
            volume: 0.2,
            fadeInDuration: 1000,
            fadeOutDuration: 1000,
            crossfadeDuration: 2000,
            loopFadeStart: 3000
        }
    }
} 