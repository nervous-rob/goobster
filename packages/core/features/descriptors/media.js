/** Descriptor text for the media and game features. See adapters.js for the rules. */
module.exports = {
    music: {
        title: 'Music',
        summary: 'Music Lab and Song Studio, music and ambience generation, the library and downloads. Discord playback additionally needs Voice and Discord.',
        apiKeys: [
            {
                name: 'ELEVENLABS_API_KEY',
                configPath: 'elevenlabs.apiKey',
                purpose: 'ElevenLabs Music and sound-effect generation; the rest of Music works without it.',
                obtainUrl: 'https://elevenlabs.io',
                required: false
            },
            {
                name: 'SPOTIFY_CLIENT_ID',
                configPath: 'spotify.clientId',
                purpose: 'Spotify application id for spotdl track downloads (needs the secret as well).',
                obtainUrl: 'https://developer.spotify.com/dashboard',
                required: false
            },
            {
                name: 'SPOTIFY_CLIENT_SECRET',
                configPath: 'spotify.clientSecret',
                purpose: 'Spotify application secret for spotdl track downloads.',
                obtainUrl: 'https://developer.spotify.com/dashboard',
                required: false
            }
        ],
        configKeys: ['spotdl.path', 'ytdlp.path'],
        docs: ['documentation/music_lab.md', 'documentation/music_system.md']
    },
    voice: {
        title: 'Voice',
        summary: 'Voice chat, text-to-speech, speech-to-text and live voice in Discord and the portal. Owns ffmpeg.',
        apiKeys: [
            {
                name: 'ELEVENLABS_API_KEY',
                configPath: 'elevenlabs.apiKey',
                purpose: 'ElevenLabs text-to-speech and realtime transcription; without it the TTS commands report that the engine is not configured.',
                obtainUrl: 'https://elevenlabs.io',
                required: false
            },
            {
                name: 'ELEVENLABS_VOICE_ID',
                configPath: 'elevenlabs.voiceId',
                purpose: 'Default voice for servers that have not chosen one.',
                required: false
            }
        ],
        configKeys: ['elevenlabs.modelId'],
        requiredSystemDependencies: ['ffmpeg'],
        docs: ['documentation/voice_commands.md', 'documentation/audio_system.md']
    },
    tavern: {
        title: 'Tavern',
        summary: 'Adventure mode: deterministic tabletop rules and authored campaigns, with AI narration when a provider is configured.',
        apiKeys: [],
        configKeys: [],
        docs: ['documentation/tavern_adventure_mode.md']
    },
    economy: {
        title: 'Economy',
        summary: 'Points and accounting: balances, transfers and the ledger the Exchange and Gambling build on.',
        apiKeys: [],
        configKeys: [],
        docs: ['documentation/jimbucks_exchange.md']
    },
    exchange: {
        title: 'Exchange',
        summary: 'The trading game: stocks, margin, options, futures, perpetuals and the risk engine. Depends on Economy.',
        apiKeys: [],
        configKeys: [],
        docs: ['documentation/jimbucks_exchange.md']
    },
    gambling: {
        title: 'Gambling',
        summary: 'The wheel, prediction markets, /gamble and the casino table games. Depends on Economy; the wheel and predictions also need Exchange.',
        apiKeys: [],
        configKeys: [],
        docs: ['documentation/jimbucks_exchange.md', 'documentation/activity_setup.md']
    }
};
