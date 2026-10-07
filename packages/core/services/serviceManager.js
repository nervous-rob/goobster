const { EventEmitter } = require('events');
const { features } = require('../features/featureState');

/**
 * The shared voice stack (TTS, Discord music playback, ambience).
 *
 * `voiceService` is a lazy export: the VoiceService is constructed and
 * initialised the first time something reads it, never when this module is
 * required. When the `voice` feature is enforced off (`features.enforcedOff`,
 * documentation/feature_state.md "Reported versus enforced") the read returns
 * an inert stand-in instead, so a disabled installation never builds the voice stack
 * (no MusicService, no ffmpeg probe, no memory-monitor timer, no SpotDL
 * wrapper, no ElevenLabs client) and every `voiceService?.tts` /
 * `voiceService?.musicService` consumer simply sees "not available".
 */

class InactiveVoiceService extends EventEmitter {
    constructor() {
        super();
        this.config = {};
        this.connections = new Map();
        this.tts = null;
        this.musicService = null;
        this.ambientService = null;
        this._isInitialized = true;
        this.unavailable = true;
    }

    async initialize() {}

    async cleanup() {}
}

let instance = null;

function getVoiceService() {
    if (instance) return instance;
    if (features.enforcedOff('voice')) {
        instance = new InactiveVoiceService();
        return instance;
    }

    const VoiceService = require('./voice');
    const config = require('../config/configJson').load();
    instance = new VoiceService(config);
    instance.initialize().catch(error => {
        console.error('Failed to initialize voice service during startup:', error);
    });
    return instance;
}

module.exports = {
    getVoiceService,
    InactiveVoiceService,
    /** Drop the cached instance (tests only). */
    _resetForTests() {
        instance = null;
    }
};

Object.defineProperty(module.exports, 'voiceService', {
    enumerable: true,
    get: getVoiceService
});
