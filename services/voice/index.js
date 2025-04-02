const { EventEmitter } = require('events');
const TTSService = require('./ttsService');
const MusicService = require('./musicService');
const AmbientService = require('./ambientService');
const { joinVoiceChannel, VoiceConnectionStatus } = require('@discordjs/voice');

class VoiceService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = config;
        this.connections = new Map();
        this.tts = null;
        this.musicService = null;
        this.ambientService = null;
        this._isInitialized = false;
    }

    async initialize() {
        if (this._isInitialized) return;

        try {
            // Initialize TTS only if Azure Speech credentials are present
            if (this.config.azure?.speech?.subscriptionKey && this.config.azure?.speech?.region) {
                this.tts = new TTSService(this.config);
            }
            
            // Initialize music service for SpotDL playback (required)
            this.musicService = new MusicService(this.config);
            
            // Initialize Replicate-dependent services if configured (optional)
            if (this.config.replicate?.apiKey) {
                this.ambientService = new AmbientService(this.config);
            }
            
            this._isInitialized = true;
            console.log('Voice service initialized successfully' + 
                (this.tts ? ' (TTS)' : '') + 
                (this.musicService ? ' (SpotDL Music)' : '') + 
                (this.ambientService ? ' (Ambient)' : ''));
            
        } catch (error) {
            console.error('Failed to initialize voice service:', error);
            throw error;
        }
    }

    // Simple method to clean up connections
    async cleanup() {
        try {
            console.log('Cleaning up voice service...');
            
            // Stop music and ambient sounds if active
            if (this.musicService) {
                try {
                    this.musicService.stopMusic();
                } catch (error) {
                    console.error('Error stopping music service:', error);
                }
            }
            
            if (this.ambientService) {
                try {
                    this.ambientService.stopAmbience();
                } catch (error) {
                    console.error('Error stopping ambient service:', error);
                }
            }
            
            // Destroy all connections
            for (const connection of this.connections.values()) {
                try {
                    connection.destroy();
                } catch (error) {
                    console.error('Error destroying connection:', error);
                }
            }
            this.connections.clear();

            console.log('Voice service cleanup complete');
        } catch (error) {
            console.error('Error during voice service cleanup:', error);
        }
    }
}

module.exports = VoiceService; 