// TODO: Add proper handling for music stream errors
// TODO: Add proper handling for playlist management
// TODO: Add proper handling for track transitions
// TODO: Add proper handling for volume normalization
// TODO: Add proper handling for audio effects
// TODO: Add proper handling for music caching
// TODO: Add proper handling for stream buffering
// TODO: Add proper handling for playback state
// TODO: Add proper handling for music metadata
// TODO: Add proper handling for resource cleanup

const { 
    createAudioPlayer,
    createAudioResource,
    StreamType,
    NoSubscriberBehavior,
    AudioPlayerStatus
} = require('@discordjs/voice');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const prism = require('prism-media');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const config = require('../../config.json');
const SpotDLService = require('../spotdl/spotdlService');
const { parseTrackName } = require('../../utils/musicUtils');
const { EmbedBuilder } = require('discord.js');
const { generateMusic, resolveApiKey } = require('./elevenLabsAudioService');

// Length of generated mood-music tracks; also drives loop crossfade timing.
const GENERATED_MUSIC_SECONDS = 60;

class MusicService extends EventEmitter {
    constructor(config) {
        super();
        
        // Validate required config
        if (!config) {
            throw new Error('Configuration is required for MusicService');
        }

        // Validate audio configuration
        if (!config.audio) {
            config.audio = {
                music: {
                    volume: 1.0,
                    crossfadeDuration: 3000,
                    loopFadeStart: 5000
                }
            };
        }

        // Store config
        this.config = config;
        
        // Initialize SpotDL service
        this.spotdlService = new SpotDLService();
        
        // Add presence management
        this.statusMessages = [
            "🎵 Jamming to some tunes",
            "🎸 Rocking out",
            "🎹 Playing some sweet melodies",
            "🎼 Conducting the music",
            "🎧 Listening to your requests",
            "🎤 Singing along",
            "🎺 Blowing some jazz",
            "🎪 Running the music circus",
            "🎭 Performing musical theater",
            "🎪 DJing the party"
        ];
        this.currentStatusIndex = 0;
        this.statusUpdateInterval = null;
        
        // Playlists are persisted as JSON files on the local filesystem.
        this.playlistDir = path.join(process.cwd(), 'data', 'playlists');
        
        // Music generation uses the ElevenLabs Music API (optional)
        if (resolveApiKey(config)) {
            console.log('ElevenLabs API key available - background music generation enabled');
        } else {
            console.log('ElevenLabs API key not available - background music generation disabled');
        }
        
        // Check FFmpeg installation (required for all audio playback).
        // Uses the system FFmpeg (apt install ffmpeg) which supports all
        // architectures including ARM64, unlike the ffmpeg-static binary.
        this.ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
        try {
            const { execSync } = require('child_process');
            execSync(`${this.ffmpegPath} -version`, { stdio: 'ignore' });
        } catch (error) {
            console.error('FFmpeg installation check failed:', error.message);
            throw new Error('FFmpeg is required for music playback but was not found. Install it with: sudo apt install ffmpeg', { cause: error });
        }
        
        // Initialize audio player
        this.player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
                maxMissedFrames: 50
            }
        });

        this.player.on('error', this.handlePlayerError.bind(this));
        this.activeResources = new Set();
        this.currentTrack = null;
        this.isPlaying = false;
        this.volume = 1.0;
        this.queue = [];
        this.looping = false;
        this.currentMusicContext = null;
        this.loopingEnabled = false;
        this.nextResource = null;
        this.crossfadeTimeout = null;
        this.currentMood = null;
        this.connection = null; // Store the voice connection
        this.client = null; // <-- ADDED: Store the Discord client instance
        this.guildId = null; // <-- ADDED: Store the Guild ID for context

        // Set up player state change handler for looping
        this.player.on(AudioPlayerStatus.Idle, async () => {
            if (this.loopingEnabled && this.nextResource) {
                await this.prepareNextLoop();
            }
        });

        // Ensure music cache directory exists
        this.ensureMusicCacheDir();
        
        // Track memory usage
        this.startMemoryMonitoring();

        // Add playlist management
        this.playlists = new Map(); // Map<guildId, Map<playlistName, playlistObject>>
        this.currentPlaylist = null;
        this.isShuffleEnabled = false;
        this.isRepeatEnabled = false;
        this.shuffledQueue = [];
        
        // Add event listeners for track completion
        this.player.on(AudioPlayerStatus.Idle, async () => {
            await this.handleTrackCompletion();
        });
    }
    
    startMemoryMonitoring() {
        // Monitor memory usage every 30 seconds (unref: never keeps the process alive)
        this.memoryMonitorInterval = setInterval(() => {
            const memoryUsage = process.memoryUsage();
            console.debug('Memory usage:', {
                rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
                heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
                heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
                external: `${Math.round(memoryUsage.external / 1024 / 1024)} MB`
            });
        }, 30000);
        this.memoryMonitorInterval.unref?.();
    }

    async ensureMusicCacheDir() {
        try {
            await fs.mkdir(path.join(process.cwd(), 'cache', 'music'), { recursive: true });
            console.log('Music cache directory created at:', path.join(process.cwd(), 'cache', 'music'));
        } catch (error) {
            console.error('Error creating music cache directory:', error);
        }
    }

    getMoodMap() {
        return {
            battle: "Epic orchestral battle music with intense drums, brass fanfares, and dramatic string ostinatos. Fantasy game style with heroic themes and powerful percussion. Evokes legendary conflicts.",
            exploration: "Ambient fantasy exploration music with soft strings, ethereal woodwinds, and gentle harp arpeggios. Open soundscape with subtle percussion and a sense of wonder. Peaceful yet adventurous.",
            mystery: "Dark mysterious music with subtle tension, ethereal pads, and haunting melodies. Minor tonality with sparse instrumentation and occasional dissonance. Fantasy RPG style with enigmatic qualities.",
            celebration: "Triumphant victory fanfare with uplifting brass, jubilant strings, and festive percussion. Major key orchestral fantasy style with memorable melodic themes and rich harmonies.",
            danger: "Tense suspenseful music with low drones, percussion ostinatos, and unsettling string textures. Dark fantasy style with building tension and occasional stingers. Creates a sense of impending threat.",
            peaceful: "Gentle pastoral fantasy music with flowing flutes, delicate harps, and warm strings. Medieval style with folk-like melodies in major keys. Serene atmosphere with natural ambience.",
            sad: "Melancholic emotional music with sorrowful solo violin, piano motifs, and subtle cello lines. Fantasy ballad style with minor harmonies and expressive rubato. Evokes deep reflection and loss.",
            dramatic: "Grand dramatic orchestral music with full symphony, powerful choir, and epic percussion. Sweeping melodic themes with rich harmonies and dynamic contrasts. Cinematic fantasy style with emotional impact."
        };
    }

    handlePlayerError(error) {
        console.error('Music player error:', error);
        this.emit('playerError', error);
    }

    async doesMoodMusicExist(mood) {
        try {
            const filePath = path.join(process.cwd(), 'cache', 'music', `${mood}.mp3`);
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async generateAndCacheMoodMusic(mood, force = false) {
        try {
            // Check if mood exists first
            const moodExists = await this.doesMoodMusicExist(mood);
            
            if (moodExists && !force) {
                console.log(`Mood music for ${mood} already exists, skipping generation`);
                return { rateLimited: false };
            }
            
            if (moodExists && force) {
                console.log(`Forcing regeneration of mood music for ${mood}`);
            }
            
            // Generate music for the mood
            const audioBuffer = await this.generateBackgroundMusic({ atmosphere: mood });
            
            // Create a directory for mood music if it doesn't exist
            const musicDir = path.join(process.cwd(), 'cache', 'music');
            await fs.mkdir(musicDir, { recursive: true });
            
            // Save to disk
            const filePath = path.join(musicDir, `${mood}.mp3`);
            await fs.writeFile(filePath, audioBuffer);
            
            console.log(`Generated and cached music for mood ${mood} at ${filePath}`);
            return { rateLimited: false, filePath };
        } catch (error) {
            console.error(`Error generating/caching music for mood ${mood}:`, error);
            throw error;
        }
    }

    /**
     * Generate an instrumental mood track via the ElevenLabs Music API.
     * Returns an MP3 buffer.
     */
    async generateBackgroundMusic(context) {
        if (!resolveApiKey(this.config)) {
            console.log('ElevenLabs API key not available - background music generation disabled');
            return null;
        }
        try {
            const prompt = this.createMusicPrompt(context);
            console.log('Generating music with prompt:', prompt);
            return await generateMusic(prompt, this.config, GENERATED_MUSIC_SECONDS * 1000);
        } catch (error) {
            console.error('Error generating background music:', error);
            throw new Error(`Failed to generate background music: ${error.message}`, { cause: error });
        }
    }

    createMusicPrompt(context) {
        const moodMap = this.getMoodMap();
        
        // Determine the mood from context
        let mood = 'exploration'; // default
        if (context.atmosphere) {
            const atmosphere = context.atmosphere.toLowerCase();
            if (atmosphere.includes('battle') || atmosphere.includes('combat')) {
                mood = 'battle';
            } else if (atmosphere.includes('mystery') || atmosphere.includes('enigma')) {
                mood = 'mystery';
            } else if (atmosphere.includes('victory') || atmosphere.includes('triumph')) {
                mood = 'celebration';
            } else if (atmosphere.includes('danger') || atmosphere.includes('threat')) {
                mood = 'danger';
            } else if (atmosphere.includes('peaceful') || atmosphere.includes('calm')) {
                mood = 'peaceful';
            } else if (atmosphere.includes('sad') || atmosphere.includes('sorrow')) {
                mood = 'sad';
            } else if (atmosphere.includes('dramatic') || atmosphere.includes('intense')) {
                mood = 'dramatic';
            }
        }

        // Create a detailed prompt with musical terms to guide the AI
        const basePrompt = moodMap[mood];
        const enhancers = [
            "high quality stereo recording",
            "clear instrument separation",
            "professional composition",
            "dynamic range",
            "no vocals",
            "fantasy orchestral arrangement"
        ];
        
        // Add specific musical instructions based on mood
        let musicalTerms = [];
        switch(mood) {
            case 'battle':
                musicalTerms = ["heroic brass", "percussion hits", "6/8 time signature", "marcato strings"];
                break;
            case 'exploration':
                musicalTerms = ["flowing arpeggios", "legato melodies", "ambient pads", "lydian mode"];
                break;
            case 'mystery':
                musicalTerms = ["whole tone scale", "diminished chords", "tremolo strings", "chromatic movement"];
                break;
            case 'celebration':
                musicalTerms = ["fanfare", "major key", "dotted rhythms", "jubilant woodwinds"];
                break;
            case 'danger':
                musicalTerms = ["ostinato", "dissonant harmonies", "minor key", "low register"];
                break;
            case 'peaceful':
                musicalTerms = ["aeolian mode", "legato phrasing", "gentle dynamics", "pastoral themes"];
                break;
            case 'sad':
                musicalTerms = ["adagio tempo", "minor key", "suspended chords", "expressive rubato"];
                break;
            case 'dramatic':
                musicalTerms = ["crescendo", "timpani", "full orchestra", "key modulation"];
                break;
        }
        
        // Combine everything into a detailed prompt
        return `${basePrompt} ${musicalTerms.join(", ")}. ${enhancers.join(", ")}.`;
    }

    async playBackgroundMusic(moodOrUrl, connection, shouldLoop = false) {
        try {
            console.log('Starting playBackgroundMusic:', { moodOrUrl, shouldLoop });
            
            // Validate connection
            if (!connection) {
                throw new Error('No voice connection provided');
            }
            console.log('Voice connection state:', connection.state.status);

            this.loopingEnabled = shouldLoop;
            let audioBuffer;
            
            // Store the current mood if it's a mood-based playback
            if (!moodOrUrl.startsWith('http')) {
                this.currentMood = moodOrUrl;
                console.log('Set current mood:', this.currentMood);
            }
            
            // Check if input is a mood or URL
            if (moodOrUrl.startsWith('http')) {
                // It's a URL, download it
                console.log('Downloading audio from:', moodOrUrl);
                const response = await axios.get(moodOrUrl, { 
                    responseType: 'arraybuffer',
                    timeout: 10000 // 10 second timeout
                });
                audioBuffer = Buffer.from(response.data);
            } else {
                // It's a mood, try to get from cache first
                const cacheFilePath = path.join(process.cwd(), 'cache', 'music', `${moodOrUrl}.mp3`);
                console.log('Attempting to load from cache:', cacheFilePath);
                try {
                    audioBuffer = await fs.readFile(cacheFilePath);
                    console.log('Successfully loaded from cache');
                } catch (cacheError) {
                    console.log('Cache miss, generating new audio');
                    // If file doesn't exist, generate and cache it
                    const result = await this.generateAndCacheMoodMusic(moodOrUrl);
                    if (!result.filePath) {
                        throw new Error('No file path returned from music generation', { cause: cacheError });
                    }
                    audioBuffer = await fs.readFile(result.filePath);
                    console.log('Successfully loaded newly generated audio');
                }
            }
            
            console.log('Audio loaded, size:', audioBuffer.length);

            // Create the initial resource
            console.log('Creating initial audio resource');
            const resource = await this.createAudioResource(audioBuffer, true);
            if (!resource) {
                throw new Error('Failed to create audio resource');
            }
            console.log('Initial resource created');

            // If looping is enabled, prepare the next resource
            if (shouldLoop) {
                console.log('Preparing loop resources');
                this.nextResource = await this.createAudioResource(audioBuffer, false);
                this.setupLoopTransition(audioBuffer);
                console.log('Loop resources prepared');
            }

            // Play the music
            console.log('Starting playback');
            this.player.play(resource);
            
            // Subscribe connection to player with error handling
            try {
                const subscription = connection.subscribe(this.player);
                if (!subscription) {
                    throw new Error('Failed to subscribe connection to player');
                }
                console.log('Successfully subscribed connection to player');
            } catch (error) {
                console.error('Error subscribing connection:', error);
                throw error;
            }

            // Set up player state monitoring with more detailed logging
            this.player.on(AudioPlayerStatus.Playing, () => {
                console.log('Player status: Playing', {
                    volume: resource.volume?.volume,
                    playbackDuration: resource.playbackDuration,
                    audioResource: !!resource
                });
            });

            this.player.on(AudioPlayerStatus.Idle, () => {
                console.log('Player status: Idle');
            });

            this.player.on(AudioPlayerStatus.Buffering, () => {
                console.log('Player status: Buffering');
            });

            this.player.on(AudioPlayerStatus.AutoPaused, () => {
                console.log('Player status: AutoPaused - This usually means no voice connection is subscribed');
                // Try to resubscribe
                try {
                    connection.subscribe(this.player);
                    console.log('Attempted to resubscribe connection');
                } catch (error) {
                    console.error('Failed to resubscribe after AutoPause:', error);
                }
            });

            // Return the player for external control
            return this.player;

        } catch (error) {
            console.error('Error playing background music:', error);
            this.emit('playbackError', error);
            return null;
        }
    }

    async createAudioResource(audioBuffer, isInitial = true, volume = 1.0) {
        console.log('Creating audio resource:', { isInitial, volume });
        
        // Ensure necessary configuration exists
        if (!this.config.audio) this.config.audio = {};
        if (!this.config.audio.music) {
            this.config.audio.music = {
                crossfadeDuration: 3000,
                volume: 1.0
            };
        }
        
        // Create a readable stream from the buffer
        const audioStream = new Readable();
        audioStream.push(audioBuffer);
        audioStream.push(null);
        console.log('Created readable stream');

        // Get crossfade duration with fallback
        const crossfadeDuration = this.config.audio.music.crossfadeDuration || 3000;
        const musicDuration = GENERATED_MUSIC_SECONDS;

        // Create FFmpeg transcoder with crossfade filters
        const filterArgs = [
            `volume=${volume}`,  // Use dynamic volume parameter
            isInitial ? 'afade=t=in:st=0:d=2' : '',  // Initial fade in
            this.loopingEnabled ? `afade=t=in:st=0:d=${crossfadeDuration/1000}` : '',  // Crossfade in
            this.loopingEnabled ? `afade=t=out:st=${musicDuration - crossfadeDuration/1000}:d=${crossfadeDuration/1000}` : ''  // Crossfade out
        ].filter(Boolean);

        console.log('FFmpeg filter chain:', filterArgs.join(','));

        const transcoder = new prism.FFmpeg({
            args: [
                '-i', '-',
                '-analyzeduration', '0',
                '-loglevel', '0',
                '-acodec', 'pcm_s16le',
                '-f', 's16le',
                '-ar', '48000',
                '-ac', '2',
                '-af', filterArgs.join(',')
            ],
        });

        // Handle transcoder errors
        transcoder.on('error', error => {
            console.error('Transcoder error:', error);
            this.emit('transcoderError', error);
        });

        // Add data event handler to monitor audio flow
        transcoder.on('data', chunk => {
            if (!this.lastChunkTime) {
                console.log('First audio chunk received');
            }
            this.lastChunkTime = Date.now();
        });

        console.log('Creating audio resource from transcoded stream');
        // Create audio resource
        const resource = createAudioResource(audioStream.pipe(transcoder), {
            inputType: StreamType.Raw,
            inlineVolume: true
        });

        if (!resource) {
            throw new Error('Failed to create audio resource');
        }

        console.log('Audio resource created successfully');
        this.activeResources.add(resource);
        
        if (resource.volume) {
            resource.volume.setVolume(volume);
            console.log('Set resource volume:', volume);
        } else {
            console.warn('Resource volume control not available');
        }

        return resource;
    }

    setupLoopTransition(audioBuffer) {
        // Ensure audio config exists with fallbacks
        if (!this.config.audio) this.config.audio = {};
        if (!this.config.audio.music) {
            this.config.audio.music = {
                volume: 1.0,
                crossfadeDuration: 3000,
                loopFadeStart: 5000
            };
        }
        
        // Calculate when to start preparing the next loop
        const loopStartTime = (GENERATED_MUSIC_SECONDS * 1000) - 
                            this.config.audio.music.loopFadeStart;

        // Clear any existing timeout
        if (this.crossfadeTimeout) {
            clearTimeout(this.crossfadeTimeout);
        }

        // Set up the next loop preparation
        this.crossfadeTimeout = setTimeout(async () => {
            if (this.loopingEnabled) {
                // Create the next resource for seamless transition
                this.nextResource = await this.createAudioResource(audioBuffer, false);
            }
        }, loopStartTime);
    }

    async prepareNextLoop() {
        if (!this.loopingEnabled || !this.nextResource) {
            console.log('Skipping loop preparation:', { loopingEnabled: this.loopingEnabled, hasNextResource: !!this.nextResource });
            return;
        }
        
        try {
            console.log('Preparing next loop');
            // The current resource becomes the next resource
            const currentResource = this.nextResource;
            
            // Start playing the current resource
            console.log('Playing next resource in loop');
            this.player.play(currentResource);
            
            // Prepare the next resource for the following loop
            let audioBuffer;
            if (this.currentMood) {
                const filePath = path.join(process.cwd(), 'cache', 'music', `${this.currentMood}.mp3`);
                console.log('Loading next loop audio from:', filePath);
                audioBuffer = await fs.readFile(filePath);
                console.log('Loaded next loop audio, size:', audioBuffer.length);
            } else {
                console.warn('No current mood set for looping');
                return;
            }
            
            console.log('Creating next loop resource');
            this.nextResource = await this.createAudioResource(audioBuffer, false);
            
            // Set up the next transition
            console.log('Setting up next loop transition');
            this.setupLoopTransition(audioBuffer);
            console.log('Loop preparation complete');
        } catch (error) {
            console.error('Error preparing next loop:', error);
            this.emit('loopError', error);
        }
    }

    async fadeOutAndStop(duration = 2000) {
        try {
            // Disable looping first
            this.loopingEnabled = false;
            
            // Clear any pending timeouts
            if (this.crossfadeTimeout) {
                clearTimeout(this.crossfadeTimeout);
                this.crossfadeTimeout = null;
            }

            // Get all active resources
            const resources = Array.from(this.activeResources);
            
            // Gradually decrease volume over duration
            const startTime = Date.now();
            const initialVolume = this.config.audio.music.volume;
            
            const fadeInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const currentVolume = initialVolume * (1 - progress);

                resources.forEach(resource => {
                    if (resource.volume) {
                        resource.volume.setVolume(currentVolume);
                    }
                });

                if (progress >= 1) {
                    clearInterval(fadeInterval);
                    this.stopMusic();
                }
            }, 50); // Update every 50ms for smooth fade

            // Return a promise that resolves when fade is complete
            return new Promise(resolve => {
                setTimeout(() => {
                    clearInterval(fadeInterval);
                    this.stopMusic();
                    resolve();
                }, duration);
            });
        } catch (error) {
            console.error('Error during fade out:', error);
            // If fade fails, stop immediately
            this.stopMusic();
        }
    }

    stopMusic() {
        this.loopingEnabled = false;
        if (this.crossfadeTimeout) {
            clearTimeout(this.crossfadeTimeout);
            this.crossfadeTimeout = null;
        }
        this.nextResource = null;
        this.player.stop();
        this.activeResources.forEach(resource => {
            try {
                resource.audioPlayer?.stop();
            } catch (error) {
                console.warn('Error stopping resource:', error);
            }
        });
        this.activeResources.clear();
        this.isPlaying = false;
        this.currentTrack = null;
        this.emit('stateUpdate', { isPlaying: false, currentTrack: null });
        
        // Stop presence if client is available
        if (this.config.client) {
            this.stopPresence(this.config.client);
        }
    }

    async crossfadeToTrack(newAudioBuffer, fadeOutDuration = 2000, fadeInDuration = 2000, targetVolume = 1.0) {
        try {
            // Create new resource with initial volume of 0
            const newResource = await this.createAudioResource(newAudioBuffer, true, 0);
            
            // Start playing the new track silently
            this.player.play(newResource);
            
            // Get all current resources
            const currentResources = Array.from(this.activeResources);
            
            // Gradually fade out current tracks while fading in new track
            const startTime = Date.now();
            const fadeInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const fadeOutProgress = Math.min(elapsed / fadeOutDuration, 1);
                const fadeInProgress = Math.min(elapsed / fadeInDuration, 1);
                
                // Fade out existing tracks
                currentResources.forEach(resource => {
                    if (resource !== newResource && resource.volume) {
                        const volume = Math.max(0, this.config.audio.music.volume * (1 - fadeOutProgress));
                        resource.volume.setVolume(volume);
                    }
                });
                
                // Fade in new track
                if (newResource.volume) {
                    const volume = targetVolume * fadeInProgress;
                    newResource.volume.setVolume(volume);
                }
                
                // When fade is complete
                if (fadeOutProgress >= 1 && fadeInProgress >= 1) {
                    clearInterval(fadeInterval);
                    
                    // Stop and cleanup old resources
                    currentResources.forEach(resource => {
                        if (resource !== newResource) {
                            this.activeResources.delete(resource);
                            try {
                                resource.audioPlayer?.stop();
                            } catch (error) {
                                console.warn('Error stopping old resource:', error);
                            }
                        }
                    });
                }
            }, 50); // Update every 50ms for smooth fade
            
            // Return the new resource
            return newResource;
        } catch (error) {
            console.error('Error during crossfade:', error);
            throw error;
        }
    }

    async setVolume(level) {
        try {
            // Ensure level is within 0-100
            const newLevel = Math.max(0, Math.min(100, level)); 
            // Store volume as a value between 0 and 1
            this.volume = newLevel / 100;
            console.log(`Setting volume to ${newLevel}% (Internal: ${this.volume})`);

            // Adjust volume of the currently playing resource, if any
            if (this.player.state.status === AudioPlayerStatus.Playing && this.player.state.resource?.volume) {
                this.player.state.resource.volume.setVolume(this.volume);
                console.log(`Adjusted volume of active resource.`);
            } else {
                console.log(`No active resource or resource does not support volume adjustment.`);
            }
            
            // Note: The volume for *future* resources is set when they are created in createAudioResource
            
            this.emit('volumeUpdate', newLevel); // Emit an event if needed
            return true;
        } catch (error) {
            console.error('Error setting volume:', error);
            throw error;
        }
    }

    // Make sure to clean up resources properly when the bot is shutting down
    dispose() {
        // Clear all intervals
        if (this.memoryMonitorInterval) {
            clearInterval(this.memoryMonitorInterval);
        }
        
        if (this.statusUpdateInterval) {
            clearInterval(this.statusUpdateInterval);
        }
        
        if (this.crossfadeTimeout) {
            clearTimeout(this.crossfadeTimeout);
        }
        
        // Stop any playing music
        this.stopMusic();
        
        // Clear all active resources
        this.activeResources.forEach(resource => {
            try {
                resource.audioPlayer?.stop();
            } catch (error) {
                console.warn('Error stopping resource during cleanup:', error);
            }
        });
        this.activeResources.clear();
        
        // Clear playlists
        this.playlists.clear();
        
        // Reset state
        this.currentTrack = null;
        this.isPlaying = false;
        this.volume = 1.0;
        this.queue = [];
        this.looping = false;
        this.currentMusicContext = null;
        this.loopingEnabled = false;
        this.nextResource = null;
        this.currentMood = null;
        this.connection = null;
        
        // Clear any remaining event listeners
        this.removeAllListeners();
    }

    async joinChannel(channel) {
        try {
            console.log('Joining voice channel:', channel.id, 'in guild:', channel.guild.id);
            this.guildId = channel.guild.id; // <-- Store Guild ID

            // If we're already in a channel, leave it first
            if (this.connection) {
                console.log('Leaving existing channel');
                this.connection.destroy();
            }
            
            // Join the new channel
            this.connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });
            
            // Set up connection state monitoring
            this.connection.on(VoiceConnectionStatus.Ready, () => {
                console.log('Voice connection ready');
            });
            
            this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
                console.log('Voice connection disconnected');
                try {
                    await Promise.race([
                        entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
                    ]);
                    // Seems to be reconnecting to a new channel - ignore disconnect
                } catch (error) {
                    // Seems to be a real disconnect which SHOULDN'T be recovered from
                    this.connection.destroy();
                }
            });
            
            this.connection.on(VoiceConnectionStatus.Destroyed, () => {
                console.log('Voice connection destroyed');
                this.connection = null;
            });
            
            return this.connection;
        } catch (error) {
            console.error('Error joining voice channel:', error);
            throw error;
        }
    }

    async playAudio(track) {
        try {
            if (!this.connection) {
                throw new Error('Not connected to a voice channel');
            }
            if (!track || !track.name || !track.url) {
                 throw new Error('Invalid track object provided to playAudio. Must include name and url.');
            }

            console.log(`Playing audio for track: ${track.name} from:`, track.url, `in guild: ${this.guildId}`);

            // track.url is a local file path with local storage (the normal
            // case since the Azure Blob layer was removed); http(s) URLs are
            // still supported for any remote source.
            let audioBuffer;
            if (/^https?:\/\//i.test(track.url)) {
                const response = await axios.get(track.url, {
                    responseType: 'arraybuffer',
                    timeout: 60000 // 60-second timeout to avoid premature abort
                });
                audioBuffer = Buffer.from(response.data);
            } else {
                audioBuffer = await fs.readFile(track.url);
            }
            
            // Create and play the audio resource
            const resource = await this.createAudioResource(audioBuffer, true, this.volume);
            if (!resource) {
                throw new Error('Failed to create audio resource');
            }
            
            // Set volume
            if (resource.volume) {
                resource.volume.setVolume(this.volume);
            }
            
            // Play the audio
            this.player.play(resource);
            
            // Subscribe the connection to the player
            this.connection.subscribe(this.player);
            
            // Store the full track object
            this.currentTrack = track;
            this.isPlaying = true;
            this.emit('stateUpdate', { isPlaying: true, currentTrack: this.currentTrack });

            // --> MODIFIED: Emit event instead of updating presence <--
            if (this.client && this.guildId && this.currentTrack) {
                 this.client.emit('musicTrackStarted', this.guildId, this.currentTrack);
            } else {
                 console.warn('Could not emit musicTrackStarted event: Missing client, guildId, or currentTrack');
            }

            return true;
        } catch (error) {
            console.error('Error playing audio:', error);
            // If playback fails, reset the state and emit end event
            this.isPlaying = false;
            this.currentTrack = null;
            // --> MODIFIED: Emit end event on error <--
            if (this.client && this.guildId) {
                this.client.emit('musicTrackEnded', this.guildId);
            }
            this.emit('stateUpdate', { isPlaying: false, currentTrack: null });
            throw error;
        }
    }

    // Add missing methods for playback control
    getVolume() {
        return Math.round(this.volume * 100);
    }

    async pause() {
        try {
            if (this.player.state.status === AudioPlayerStatus.Playing) {
                this.player.pause();
                this.isPlaying = false;
                this.emit('stateUpdate', { isPlaying: false, currentTrack: this.currentTrack });
                // --> MODIFIED: Emit end event on pause <--
                if (this.client && this.guildId) {
                    this.client.emit('musicTrackEnded', this.guildId);
                }
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error pausing playback:', error);
            throw error;
        }
    }

    async resume() {
        try {
            if (this.player.state.status === AudioPlayerStatus.Paused) {
                this.player.unpause();
                this.isPlaying = true;
                this.emit('stateUpdate', { isPlaying: true, currentTrack: this.currentTrack });
                // --> MODIFIED: Emit start event on resume <--
                if (this.client && this.guildId && this.currentTrack) {
                     this.client.emit('musicTrackStarted', this.guildId, this.currentTrack);
                }
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error resuming playback:', error);
            throw error;
        }
    }

    async skip() {
        try {
            // Stop the player, which triggers the 'idle' state, handled by handleTrackCompletion
            this.player.stop();
            // --> NOTE: musicTrackEnded will be emitted by handleTrackCompletion <--
            // Resetting local state immediately might be okay, but completion handler is more robust
            this.isPlaying = false;
            // Let handleTrackCompletion clear currentTrack and decide next action
            // this.currentTrack = null; // Let completion handler manage this
            return true;
        } catch (error) {
            console.error('Error skipping track:', error);
            throw error;
        }
    }

    async stop() {
        try {
            // Stop the player, which triggers the 'idle' state, handled by handleTrackCompletion
            this.player.stop();
            // --> NOTE: musicTrackEnded will be emitted by handleTrackCompletion if it stops fully <--
            // Clear the manual queue immediately
            this.queue = [];
            this.emit('queueUpdate', this.queue);
            // Clear playlist context
            this.currentPlaylist = null;
            this.currentTrackIndex = 0;
            this.isShuffleEnabled = false;
            this.isRepeatEnabled = false;
            this.shuffledQueue = [];
            // Stop presence update is handled by the track completion logic now
            // Resetting local state immediately
            this.isPlaying = false;
            this.currentTrack = null; // Clear immediately on explicit stop
            // Explicit stop should also signal the end
            if (this.client && this.guildId) {
                this.client.emit('musicTrackEnded', this.guildId);
            }
            this.emit('stateUpdate', { isPlaying: false, currentTrack: null });
            return true;
        } catch (error) {
            console.error('Error stopping playback:', error);
            throw error;
        }
    }

    getQueue() {
        // If shuffle is enabled for a playlist AND the manual queue is empty,
        // show the upcoming tracks from the shuffled list.
        // Note: this.shuffledQueue contains the remaining tracks after popping.
        if (this.isShuffleEnabled && this.currentPlaylist && this.queue.length === 0) {
            // Return a copy of the remaining shuffled tracks
            // The UI will handle pagination if this list is long.
            return [...this.shuffledQueue].reverse(); // Reverse so the *next* track is #1
        }
        // Otherwise, show the standard manual queue
        return this.queue;
    }

    // Add new playlist management methods
    async createPlaylist(guildId, name, initialTracks = []) { // <-- Add optional initialTracks parameter
        const playlist = {
            id: Date.now(), // Consider using UUID?
            name,
            // Map initialTracks to the required format, ensuring no duplicates (based on name)
            tracks: initialTracks
                .filter((track, index, self) => 
                    track && track.name && self.findIndex(t => t.name === track.name) === index
                )
                .map(track => ({
                    name: track.name,
                    artist: parseTrackName(track.name).artist,
                    title: parseTrackName(track.name).title,
                    addedAt: Date.now() // Use current time for initially added tracks
                })),
            createdAt: Date.now(),
            lastModified: Date.now()
        };

        // --> MODIFIED: Use nested map for memory cache <--
        if (!this.playlists.has(guildId)) {
            this.playlists.set(guildId, new Map());
        }
        const guildPlaylists = this.playlists.get(guildId);
        if (guildPlaylists.has(name)) {
            throw new Error(`Playlist with name '${name}' already exists.`);
        }
        guildPlaylists.set(name, playlist);

        // Save to blob storage (this logic likely remains the same)
        await this.savePlaylist(guildId, playlist);

        return playlist;
    }

    async addToPlaylist(guildId, playlistName, track) {
        // --> Load the specific playlist first <--
        const playlist = await this.loadPlaylist(guildId, playlistName);
        if (!playlist) {
            throw new Error(`Playlist '${playlistName}' not found.`);
        }

        // Ensure track has necessary info
         if (!track || !track.name) {
            throw new Error('Invalid track data provided.');
        }
        
        // Check for duplicates (optional, based on name)
        if (playlist.tracks.some(t => t.name === track.name)) {
            console.log(`Track ${track.name} already exists in playlist ${playlistName}`);
            // Optionally throw an error or just return successfully
             throw new Error(`Track '${parseTrackName(track.name).title}' already exists in this playlist.`);
            // return;
        }

        playlist.tracks.push({
            name: track.name,
            artist: parseTrackName(track.name).artist,
            title: parseTrackName(track.name).title,
            addedAt: Date.now()
        });
        playlist.lastModified = Date.now();

        // Save to blob storage (or memory)
        await this.savePlaylist(guildId, playlist);

        // If this playlist is currently playing, this change won't affect the immediate playback
        // If nothing is playing *and* no specific playlist was active, adding might trigger queue playback
        // Consider if adding to a playlist should interrupt/start playback if idle.
        // For now, it just adds silently unless the bot is completely idle.
        if (!this.isPlaying && !this.currentPlaylist && this.player.state.status !== AudioPlayerStatus.Playing) {
            console.log('Player idle, starting playlist playback after adding track.');
            await this.playPlaylist(guildId, playlistName); // Play the playlist we just added to
        }
    }

    async playPlaylist(guildId, playlistName, startFromIndex = 0) {
        // --> Load the specific playlist <--
        const playlist = await this.loadPlaylist(guildId, playlistName);
        if (!playlist || playlist.tracks.length === 0) {
            throw new Error(`Playlist '${playlistName}' not found or is empty.`);
        }

        console.log(`Starting playback for playlist: ${playlistName}`);
        this.currentPlaylist = playlist;
        this.currentTrackIndex = startFromIndex;
        this.isShuffleEnabled = false; // Default to no shuffle when playing a specific playlist
        this.isRepeatEnabled = false;
        this.queue = []; // Clear the manual queue when starting a playlist

        await this.playNextTrack(); // Play the first track according to playlist logic

         return {
            totalTracks: playlist.tracks.length,
            currentTrack: this.currentTrack // Will be set by playNextTrack
        };
    }

    async playAllTracks() {
        try {
            const tracks = await this.spotdlService.listTracks();
            if (!tracks || tracks.length === 0) {
                throw new Error('No tracks available to play');
            }

            const allTracksPlaylist = {
                id: 'all_tracks_playlist', // Use a consistent ID maybe?
                name: 'All Tracks',
                tracks: tracks.map(track => ({
                    name: track.name,
                    artist: parseTrackName(track.name).artist,
                    title: parseTrackName(track.name).title,
                    lastModified: track.lastModified // <-- Add lastModified here
                })),
                createdAt: Date.now(),
                lastModified: Date.now()
            };

            this.currentPlaylist = allTracksPlaylist;
            this.currentTrackIndex = 0; // Index doesn't matter much for shuffle initially
            this.isShuffleEnabled = false; // <-- Ensure shuffle is off
            this.isRepeatEnabled = false;
            this.shuffledQueue = []; // Will be populated by playNextTrack
            this.queue = []; // Clear the manual queue

            await this.playNextTrack();

            return {
                totalTracks: tracks.length,
                currentTrack: this.currentTrack // Will be set by playNextTrack
            };
        } catch (error) {
            console.error('Error playing all tracks:', error);
            throw error;
        }
    }

    // --> ADDED: Method to shuffle and play all tracks <--
    async shuffleAllTracks() {
        try {
            const tracks = await this.spotdlService.listTracks();
            if (!tracks || tracks.length === 0) {
                throw new Error('No tracks available to play');
            }

            // Create a valid playlist object with required properties
            const allTracksPlaylist = {
                id: Date.now(), // Generate a unique ID
                name: 'All Tracks (Shuffled)',
                tracks: tracks.map(track => ({
                    name: track.name,
                    artist: parseTrackName(track.name).artist,
                    title: parseTrackName(track.name).title,
                    lastModified: track.lastModified || Date.now()
                })),
                createdAt: Date.now(),
                lastModified: Date.now()
            };

            // Validate playlist structure
            if (!allTracksPlaylist.id || !allTracksPlaylist.name || !Array.isArray(allTracksPlaylist.tracks)) {
                throw new Error('Failed to create valid playlist structure');
            }

            console.log(`Created shuffled playlist with ${allTracksPlaylist.tracks.length} tracks`);

            this.currentPlaylist = allTracksPlaylist;
            this.currentTrackIndex = 0;
            this.isShuffleEnabled = true;
            this.isRepeatEnabled = false;
            this.shuffledQueue = [];
            this.queue = [];

            // Start playing the first shuffled track
            await this.playNextTrack();

            return {
                totalTracks: tracks.length,
                currentTrack: this.currentTrack
            };
        } catch (error) {
            console.error('Error shuffling all tracks:', error);
            throw error;
        }
    }

    async playNextTrack() {
        if (!this.currentPlaylist || this.currentPlaylist.tracks.length === 0) {
            this.isPlaying = false;
            this.currentTrack = null;
            this.emit('playlistEnded');
            return;
        }

        let nextTrack;
        if (this.isShuffleEnabled) {
            if (this.shuffledQueue.length === 0) {
                this.shuffledQueue = [...this.currentPlaylist.tracks];
                // Fisher-Yates shuffle
                for (let i = this.shuffledQueue.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [this.shuffledQueue[i], this.shuffledQueue[j]] = [this.shuffledQueue[j], this.shuffledQueue[i]];
                }
            }
            nextTrack = this.shuffledQueue.pop();
        } else {
            nextTrack = this.currentPlaylist.tracks[this.currentTrackIndex];
            this.currentTrackIndex = (this.currentTrackIndex + 1) % this.currentPlaylist.tracks.length;
        }

        try {
            // Validate track data
            if (!nextTrack || !nextTrack.name) {
                console.error('Invalid track data:', nextTrack);
                throw new Error('Invalid track data: missing name property');
            }

            console.log(`Attempting to play track: ${nextTrack.name}`);
            
            // Get a fresh URL for the track
            const trackUrl = await this.spotdlService.getTrackUrl(nextTrack.name);
            if (!trackUrl) {
                throw new Error(`Failed to get URL for track: ${nextTrack.name}`);
            }
            
            // Construct the full track object required by playAudio
            const playableTrack = { 
                name: nextTrack.name, 
                url: trackUrl,
                artist: nextTrack.artist || parseTrackName(nextTrack.name).artist,
                title: nextTrack.title || parseTrackName(nextTrack.name).title
            };
            
            console.log(`Playing track: ${playableTrack.title} by ${playableTrack.artist}`);
            await this.playAudio(playableTrack);
            
            // Keep track of the core track info
            this.currentTrack = nextTrack; 
            this.emit('trackChanged', nextTrack);
            
        } catch (error) {
            console.error('Error playing next track:', error);
            // Try to play the next track if there's an error
            // Add a small delay or limit retries to prevent potential tight loops in other error scenarios
            await new Promise(resolve => setTimeout(resolve, 500)); // Small delay before retrying
            await this.playNextTrack();
        }
    }

    async handleTrackCompletion() {
        const previousTrackGuildId = this.guildId; // Store guildId before potential state changes

        // Prioritize the manual queue
        if (this.queue.length > 0) {
            console.log('Track completed, playing next from manual queue.');
            await this.playNextInQueue(); // This will emit musicTrackStarted for the new track
        }
        // If manual queue is empty, check for playlist logic (repeat/shuffle)
        else if (this.isRepeatEnabled && this.currentTrack) {
            console.log('Track completed, repeating current track.');
            const trackUrl = await this.spotdlService.getTrackUrl(this.currentTrack.name);
            const playableTrack = { ...this.currentTrack, url: trackUrl };
            await this.playAudio(playableTrack); // This will emit musicTrackStarted for the same track
        } else if (this.currentPlaylist) {
            console.log('Track completed, playing next from playlist.');
            await this.playNextTrack(); // This handles shuffle/normal order and emits musicTrackStarted
        } else {
            // If no manual queue, not repeating, and no playlist, stop
            console.log(`Track completed, queue/playlist finished in guild ${previousTrackGuildId}.`);
            this.isPlaying = false;
            this.currentTrack = null;
            // --> MODIFIED: Emit end event when playback truly stops <--
            if (this.client && previousTrackGuildId) {
                this.client.emit('musicTrackEnded', previousTrackGuildId);
            }
            this.emit('queueEmpty'); // Or a more specific event like 'playbackFinished'
            this.emit('stateUpdate', { isPlaying: false, currentTrack: null });
            // Note: stopMusic() is not called here to avoid redundant events if called elsewhere
        }
    }

    async shufflePlaylist() {
        this.isShuffleEnabled = !this.isShuffleEnabled;
        this.shuffledQueue = [];
        if (this.isShuffleEnabled) {
            this.shuffledQueue = [...this.currentPlaylist.tracks];
            // Fisher-Yates shuffle
            for (let i = this.shuffledQueue.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.shuffledQueue[i], this.shuffledQueue[j]] = [this.shuffledQueue[j], this.shuffledQueue[i]];
            }
        }
        this.emit('shuffleToggled', this.isShuffleEnabled);
    }

    async toggleRepeat() {
        this.isRepeatEnabled = !this.isRepeatEnabled;
        this.emit('repeatToggled', this.isRepeatEnabled);
    }

    getCurrentPlaylist() {
        return this.currentPlaylist;
    }

    getQueueStatus() {
        if (!this.currentPlaylist) return null;

        return {
            currentTrack: this.currentTrack,
            isShuffleEnabled: this.isShuffleEnabled,
            isRepeatEnabled: this.isRepeatEnabled,
            totalTracks: this.currentPlaylist.tracks.length,
            remainingTracks: this.isShuffleEnabled ? 
                this.shuffledQueue.length : 
                this.currentPlaylist.tracks.length - this.currentTrackIndex
        };
    }

    // Helper: sanitized path for a playlist JSON file
    getPlaylistFilePath(guildId, playlistName) {
        const safeGuild = String(guildId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeName = String(playlistName).replace(/[^a-zA-Z0-9 _-]/g, '_');
        return path.join(this.playlistDir, safeGuild, `${safeName}.json`);
    }

    // Save playlist to local disk
    async savePlaylist(guildId, playlist) {
        try {
            // Update memory cache
            if (!this.playlists.has(guildId)) {
                this.playlists.set(guildId, new Map());
            }
            this.playlists.get(guildId).set(playlist.name, playlist);

            const filePath = this.getPlaylistFilePath(guildId, playlist.name);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, JSON.stringify(playlist, null, 2), 'utf8');
            console.log(`Saved playlist ${playlist.name} for guild ${guildId} to disk`);
        } catch (error) {
            console.error('Error saving playlist:', error);
            throw error;
        }
    }

    // Load playlist from local disk
    async loadPlaylist(guildId, playlistName) {
        try {
            // Check memory cache first
            const guildPlaylists = this.playlists.get(guildId);
            if (guildPlaylists && guildPlaylists.has(playlistName)) {
                console.log(`Loaded playlist ${playlistName} for guild ${guildId} from memory cache`);
                return guildPlaylists.get(playlistName);
            }

            const filePath = this.getPlaylistFilePath(guildId, playlistName);
            let raw;
            try {
                raw = await fs.readFile(filePath, 'utf8');
            } catch {
                throw new Error(`Playlist '${playlistName}' not found.`);
            }

            const playlist = JSON.parse(raw);

            // Validate playlist structure
            if (!playlist.name || !playlist.tracks || !Array.isArray(playlist.tracks)) {
                throw new Error('Invalid playlist format loaded from storage');
            }

            // Ensure each track has the required properties
            playlist.tracks = playlist.tracks.map(track => {
                if (!track.name) {
                    console.error('Found track without name:', track);
                    return null;
                }
                return {
                    name: track.name,
                    artist: track.artist || parseTrackName(track.name).artist,
                    title: track.title || parseTrackName(track.name).title,
                    addedAt: track.addedAt || Date.now(),
                    lastModified: track.lastModified || Date.now()
                };
            }).filter(track => track !== null); // Remove any invalid tracks

            // Store in memory cache
            if (!this.playlists.has(guildId)) {
                this.playlists.set(guildId, new Map());
            }
            this.playlists.get(guildId).set(playlistName, playlist);
            console.log(`Loaded and cached playlist ${playlistName} for guild ${guildId} with ${playlist.tracks.length} tracks`);

            return playlist;
        } catch (error) {
            if (error.message.includes('not found')) {
                console.log(`Playlist ${playlistName} for guild ${guildId} not found.`);
                throw new Error(`Playlist '${playlistName}' not found.`, { cause: error });
            }
            console.error(`Error loading playlist ${playlistName} for guild ${guildId}:`, error);
            throw error;
        }
    }

    // Delete playlist from local disk
    async deletePlaylist(guildId, playlistName) {
        try {
            // Remove from memory cache
            const guildPlaylists = this.playlists.get(guildId);
            if (guildPlaylists) {
                guildPlaylists.delete(playlistName);
            }

            const filePath = this.getPlaylistFilePath(guildId, playlistName);
            try {
                await fs.unlink(filePath);
                console.log(`Deleted playlist ${playlistName} for guild ${guildId} from disk and memory`);
            } catch {
                // Not on disk (memory-only playlist) - still considered deleted.
                console.log(`Playlist ${playlistName} for guild ${guildId} not found on disk for deletion.`);
            }
        } catch (error) {
            console.error('Error deleting playlist:', error);
            throw error;
        }
    }

    // List all playlists for a guild
    async listPlaylists(guildId) {
        try {
            const names = new Set();

            // Memory cache
            const guildPlaylists = this.playlists.get(guildId);
            if (guildPlaylists) {
                for (const name of guildPlaylists.keys()) names.add(name);
            }

            // Disk
            const safeGuild = String(guildId).replace(/[^a-zA-Z0-9_-]/g, '_');
            const guildDir = path.join(this.playlistDir, safeGuild);
            try {
                const files = await fs.readdir(guildDir);
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        names.add(file.slice(0, -5));
                    }
                }
            } catch {
                // No playlist directory for this guild yet.
            }

            return Array.from(names);
        } catch (error) {
            console.error('Error listing playlists:', error);
            throw error;
        }
    }

    getState() {
        return {
            isPlaying: this.isPlaying,
            currentTrack: this.currentTrack,
            volume: this.volume,
            isPaused: this.player.state.status === AudioPlayerStatus.Paused
        };
    }

    // --> ADDED: Method to add a track to the manual queue <--
    async addToQueue(track) {
        if (!track) return false;

        // Create a queue item with a timestamp
        const queueItem = { 
            ...track, // Spread existing track properties
            addedAt: new Date() // Add the current timestamp
        };

        this.queue.push(queueItem);
        console.log(`Added to queue: ${parseTrackName(track.name).title}, Queue size: ${this.queue.length}`);
        
        // If nothing is playing, start playing the queued item immediately
        if (!this.isPlaying) {
            await this.playNextInQueue();
        }
        return true;
    }

    // --> ADDED: Method to specifically play the next item from the manual queue <--
    async playNextInQueue() {
        if (this.queue.length === 0) {
            console.log('Manual queue is empty. Stopping playback.');
            this.stopMusic();
            this.emit('queueEmpty');
            return;
        }

        const nextTrack = this.queue.shift();
        this.emit('queueUpdate', this.queue);

        try {
            // Validate track data
            if (!nextTrack || !nextTrack.name) {
                console.error('Invalid track data in queue:', nextTrack);
                throw new Error('Invalid track data: missing name property');
            }

            console.log(`Playing next from queue: ${nextTrack.name}`);
            
            // Get a fresh URL for the track
            const trackUrl = await this.spotdlService.getTrackUrl(nextTrack.name);
            if (!trackUrl) {
                throw new Error(`Failed to get URL for track: ${nextTrack.name}`);
            }

            // Construct the full track object required by playAudio
            const playableTrack = {
                name: nextTrack.name,
                url: trackUrl,
                artist: nextTrack.artist || parseTrackName(nextTrack.name).artist,
                title: nextTrack.title || parseTrackName(nextTrack.name).title
            };

            await this.playAudio(playableTrack);
            this.currentTrack = nextTrack;
            this.emit('trackChanged', nextTrack);
        } catch (error) {
            console.error(`Error playing track ${nextTrack?.name} from queue:`, error);
            // Try to play the next track if there's an error
            await new Promise(resolve => setTimeout(resolve, 500)); // Small delay before retrying
            await this.playNextInQueue();
        }
    }

    // --> ADDED: Helper to create/update playlist from downloaded tracks <--
    async createOrUpdatePlaylistFromTracks(guildId, playlistName, tracks) {
        if (!tracks || tracks.length === 0) {
            throw new Error('No tracks provided to create/update playlist.');
        }
        
        // --- DEBUG LOGGING: Inspect input tracks ---
        console.log(`[DEBUG createOrUpdatePlaylistFromTracks] Input tracks for playlist '${playlistName}':`, JSON.stringify(tracks, null, 2));
        // --- END DEBUG LOGGING ---

        let playlist;
        try {
            // Try to load existing playlist
            playlist = await this.loadPlaylist(guildId, playlistName);
            console.log(`Updating existing playlist: ${playlistName}`);
            // Keep existing tracks and add new ones, avoiding duplicates by name
            const existingTrackNames = new Set(playlist.tracks.map(t => t.name));
            let addedCount = 0;
            tracks.forEach(track => {
                // Add validation: ensure track and track.name exist
                if (track && track.name && !existingTrackNames.has(track.name)) {
                    playlist.tracks.push({
                        name: track.name,
                        artist: parseTrackName(track.name).artist,
                        title: parseTrackName(track.name).title,
                        addedAt: Date.now(),
                        // Default lastModified if missing
                        lastModified: track.lastModified || Date.now() 
                    });
                    existingTrackNames.add(track.name);
                    addedCount++;
                } else if (!track || !track.name) {
                    // Log skipped invalid tracks
                    console.warn(`[createOrUpdatePlaylistFromTracks] Skipping invalid track data: ${JSON.stringify(track)}`);
                }
            });
            playlist.lastModified = Date.now();
            console.log(`Added ${addedCount} new tracks to playlist ${playlistName}. Total tracks: ${playlist.tracks.length}`);
        } catch (error) {
            // If loading failed (likely "not found"), create a new playlist
            if (error.message.includes('not found')) {
                console.log(`Playlist ${playlistName} not found, creating new one.`);
                // Filter invalid tracks *before* mapping
                const validTracks = tracks.filter(track => {
                     if (!track || !track.name) {
                          console.warn(`[createOrUpdatePlaylistFromTracks] Skipping invalid track data during creation: ${JSON.stringify(track)}`);
                          return false;
                     }
                     return true;
                });

                playlist = {
                    id: Date.now(),
                    name: playlistName,
                    tracks: validTracks.map(track => ({ // Map only valid tracks
                        name: track.name,
                        artist: parseTrackName(track.name).artist,
                        title: parseTrackName(track.name).title,
                        addedAt: Date.now(),
                         // Default lastModified if missing
                        lastModified: track.lastModified || Date.now()
                    })),
                    createdAt: Date.now(),
                    lastModified: Date.now()
                };
                console.log(`Created playlist ${playlistName} with ${playlist.tracks.length} tracks.`);
            } else {
                // Re-throw other errors during load
                throw error;
            }
        }
        
        // --- DEBUG LOGGING: Inspect playlist before saving ---
        console.log(`[DEBUG createOrUpdatePlaylistFromTracks] Playlist object before saving '${playlistName}':`, JSON.stringify(playlist, null, 2));
        // --- END DEBUG LOGGING ---

        // Save the created/updated playlist
        await this.savePlaylist(guildId, playlist);
        return playlist;
    }

    // --> ADDED setClient method <--
    setClient(client) {
        this.client = client;
        console.log('Discord client set for MusicService');
    }
}

module.exports = MusicService; 