require('dotenv').config();

module.exports = {
    // ElevenLabs (TTS, music generation, ambient sound effects)
    elevenlabs: {
        apiKey: process.env.ELEVENLABS_API_KEY,
        voiceId: process.env.ELEVENLABS_VOICE_ID
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