const { toFile } = require('openai');
const aiConfig = require('../config/aiConfig');
const openaiService = require('./openaiService');

/**
 * Speech-to-text via OpenAI's transcription API.
 *
 * Input is a WAV buffer (the voice session records 48kHz stereo 16-bit PCM
 * from Discord and wraps it in a RIFF header before calling this).
 */
class TranscriptionService {
    isConfigured() {
        return openaiService.isConfigured();
    }

    /**
     * Transcribe a WAV audio buffer to text.
     * @param {Buffer} wavBuffer
     * @param {Object} options - { model, prompt }
     * @returns {Promise<string>} transcribed text (may be empty)
     */
    async transcribe(wavBuffer, options = {}) {
        if (!this.isConfigured()) {
            throw new Error('OpenAI API key not configured; speech-to-text is unavailable.');
        }

        const file = await toFile(wavBuffer, 'audio.wav', { type: 'audio/wav' });
        const response = await openaiService.client.audio.transcriptions.create({
            file,
            model: options.model || aiConfig.openai.transcriptionModel,
            // Context prompt improves recognition of bot/server-specific terms
            prompt: options.prompt || 'Goobster, a Discord bot, is being spoken to in a voice channel.'
        });

        return (response.text || '').trim();
    }
}

module.exports = new TranscriptionService();
