const { joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const { EventEmitter } = require('events');
const AudioService = require('./audioService');
const SpeechRecognitionService = require('./speechRecognitionService');
const aiService = require('../aiService');

/**
 * VoiceSessionManager controls a single voice-chat session in one guild.
 * It listens to users, transcribes their speech via Azure STT, feeds it to the LLM,
 * then speaks the response back using the shared TTS service on voiceService.
 */
class VoiceSessionManager extends EventEmitter {
    /**
     * @param {import('discord.js').VoiceChannel} voiceChannel Caller’s channel
     * @param {import('../voice').default} voiceService Shared voiceService (contains TTS)
     * @param {object} config Bot config
     */
    constructor(voiceChannel, voiceService, config) {
        super();
        this.voiceChannel = voiceChannel;
        this.voiceService = voiceService;
        this.config = config;

        this.audioService = new AudioService();
        this.sttService = new SpeechRecognitionService(config);
        this.connection = null;
        this.activeUserPipelines = new Map(); // userId ➜ { opus, pcmTransformer }
        this.busy = false; // prevent overlapping ask/answer cycles
    }

    async start() {
        this.connection = joinVoiceChannel({
            channelId: this.voiceChannel.id,
            guildId: this.voiceChannel.guild.id,
            adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
        });
        await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);

        // Listen for user streams
        this.connection.receiver.speaking.on('start', (userId) => this._handleUserSpeaking(userId));

        // Clean up on disconnect
        this.connection.on(VoiceConnectionStatus.Disconnected, () => this.stop());
    }

    async stop() {
        try {
            for (const { opus, pcm } of this.activeUserPipelines.values()) {
                opus.destroy();
                pcm.destroy();
            }
            this.activeUserPipelines.clear();
            this.connection?.destroy();
            this.audioService.removeAllListeners();
            this.emit('stopped');
        } catch (err) {
            console.error('[VoiceSessionManager] Error while stopping:', err);
        }
    }

    _handleUserSpeaking(userId) {
        if (this.activeUserPipelines.has(userId)) return; // already set up

        const opusStream = this.connection.receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 500,
            },
        });

        const { opusDecoder, pcmTransformer } = this.audioService.createAudioStream(userId);

        opusStream.pipe(opusDecoder).pipe(pcmTransformer);

        // Handle complete audio segment
        pcmTransformer.on('audioComplete', async (audioBuffer) => {
            try {
                if (this.busy) return; // simple throttle
                this.busy = true;
                const transcript = await this.sttService.transcribeBuffer(audioBuffer);
                console.log(`[VoiceSession] User ${userId} said:`, transcript);
                this.emit('transcript', { userId, text: transcript });

                // Ask LLM for a response
                const aiResponse = await aiService.chat([
                    { role: 'user', content: transcript }
                ], { preset: 'chat' });

                console.log('[VoiceSession] AI response:', aiResponse);
                this.emit('aiResponse', aiResponse);

                // Speak back using shared TTS if available
                if (this.voiceService.tts) {
                    await this.voiceService.tts.textToSpeech(aiResponse, this.voiceChannel, this.connection);
                }
            } catch (err) {
                console.error('[VoiceSession] Error handling audioComplete:', err);
            } finally {
                this.busy = false;
            }
        });

        // Store so we can clean later
        this.activeUserPipelines.set(userId, { opus: opusStream, pcm: pcmTransformer });
    }
}

module.exports = VoiceSessionManager; 