const { EventEmitter } = require('events');
const {
    SpeechConfig,
    AudioConfig,
    AudioStreamFormat,
    AudioInputStream,
    SpeechRecognizer,
    ResultReason
} = require('microsoft-cognitiveservices-speech-sdk');

class SpeechRecognitionService extends EventEmitter {
    constructor(config = {}) {
        super();

        // Support both config formats (align with TTSService)
        const speechKey = config.azure?.speech?.key || config.azureSpeech?.key;
        const speechRegion = config.azure?.speech?.region || config.azureSpeech?.region;

        if (!speechKey || !speechRegion) {
            console.warn('[SpeechRecognitionService] Azure Speech credentials not found – STT disabled');
            this.disabled = true;
            return;
        }

        this.speechConfig = SpeechConfig.fromSubscription(speechKey, speechRegion);

        // Default language (can be overridden per call)
        this.defaultLanguage = config.azure?.speech?.language || 'en-US';
    }

    /**
     * Transcribe a PCM 16-bit mono 16 kHz buffer (the format emitted by AudioService)
     * @param {Buffer} audioBuffer Raw PCM buffer
     * @param {string} [language] BCP-47 tag (e.g. "en-US")
     * @returns {Promise<string>} Recognized text
     */
    async transcribeBuffer(audioBuffer, language = this.defaultLanguage) {
        if (this.disabled) {
            throw new Error('Speech recognition is disabled – missing credentials');
        }
        if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
            throw new Error('transcribeBuffer requires a non-empty Buffer');
        }

        // Create push stream matching AudioService output (16 kHz mono, 16-bit)
        const format = AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
        const pushStream = AudioInputStream.createPushStream(format);
        pushStream.write(audioBuffer);
        pushStream.close();

        // Prepare recognizer
        const audioConfig = AudioConfig.fromStreamInput(pushStream);
        const recognizer = new SpeechRecognizer(this.speechConfig, audioConfig);
        recognizer.speechRecognitionLanguage = language;

        return new Promise((resolve, reject) => {
            recognizer.recognizeOnceAsync(result => {
                recognizer.close();
                if (result.reason === ResultReason.RecognizedSpeech) {
                    resolve(result.text);
                } else if (result.reason === ResultReason.NoMatch) {
                    reject(new Error('Speech could not be recognized'));
                } else {
                    reject(new Error(`Recognition failed: ${result.reason}`));
                }
            }, err => {
                recognizer.close();
                reject(err);
            });
        });
    }
}

module.exports = SpeechRecognitionService;