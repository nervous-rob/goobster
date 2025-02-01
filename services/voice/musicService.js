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

class MusicService extends EventEmitter {
    constructor(config) {
        super();
        
        if (!config?.replicate?.apiKey) {
            throw new Error('Replicate API key is required. Please set REPLICATE_API_KEY in your environment variables.');
        }
        
        // Check FFmpeg installation
        try {
            const ffmpeg = require('ffmpeg-static');
            if (!ffmpeg) {
                throw new Error('ffmpeg-static is not properly installed');
            }
            console.log('FFmpeg installation verified:', ffmpeg);
        } catch (error) {
            console.error('FFmpeg check failed:', error);
            throw new Error('FFmpeg is required for audio processing. Please ensure ffmpeg-static is installed.');
        }
        
        this.config = config;
        this.player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
                maxMissedFrames: 50
            }
        });

        this.player.on('error', this.handlePlayerError.bind(this));
        this.activeResources = new Set();
        this.currentMusicContext = null;
        this.loopingEnabled = false;
        this.nextResource = null;
        this.crossfadeTimeout = null;
        this.currentMood = null;
        
        // Initialize axios instance with default config
        this.api = axios.create({
            baseURL: 'https://api.replicate.com/v1',
            headers: {
                'Authorization': `Token ${this.config.replicate.apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        // Set up player state change handler for looping
        this.player.on(AudioPlayerStatus.Idle, async () => {
            if (this.loopingEnabled && this.nextResource) {
                await this.prepareNextLoop();
            }
        });

        // Ensure music cache directory exists
        this.ensureMusicCacheDir();
    }

    async ensureMusicCacheDir() {
        try {
            await fs.mkdir(path.join(process.cwd(), 'data', 'music'), { recursive: true });
        } catch (error) {
            console.error('Error creating music cache directory:', error);
        }
    }

    getMoodMap() {
        return {
            battle: "Epic orchestral battle music with intense drums and brass, fantasy game style",
            exploration: "Ambient fantasy exploration music with soft strings and wind instruments, peaceful and adventurous",
            mystery: "Dark mysterious music with subtle tension and ethereal sounds, fantasy RPG style",
            celebration: "Triumphant victory fanfare with uplifting melodies, orchestral fantasy style",
            danger: "Tense suspenseful music with low drones and percussion, dark fantasy style",
            peaceful: "Gentle pastoral fantasy music with flutes and harps, medieval style",
            sad: "Melancholic emotional music with solo violin and piano, fantasy ballad style",
            dramatic: "Grand dramatic orchestral music with full symphony, epic fantasy style"
        };
    }

    handlePlayerError(error) {
        console.error('Music player error:', error);
        this.emit('playerError', error);
    }

    async doesMoodMusicExist(mood) {
        try {
            const filePath = path.join(process.cwd(), 'data', 'music', `${mood}.mp3`);
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async generateAndCacheMoodMusic(mood, forceRegenerate = false) {
        const filePath = path.join(process.cwd(), 'data', 'music', `${mood}.mp3`);
        
        // Check if file exists and we're not forcing regeneration
        if (!forceRegenerate) {
            try {
                await fs.access(filePath);
                return filePath;
            } catch {} // File doesn't exist, continue with generation
        }

        try {
            const audioUrl = await this.generateBackgroundMusic({ atmosphere: mood });
            const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
            await fs.writeFile(filePath, Buffer.from(response.data));
            return filePath;
        } catch (error) {
            console.error(`Error generating/caching music for mood ${mood}:`, error);
            throw error;
        }
    }

    async generateBackgroundMusic(context) {
        try {
            const prompt = this.createMusicPrompt(context);
            console.log('Generating music with prompt:', prompt);
            
            // Start the generation
            const prediction = await this.api.post('/predictions', {
                version: this.config.replicate.models.musicgen.version,
                input: {
                    model_version: this.config.replicate.models.musicgen.defaults.model_version,
                    prompt: prompt,
                    duration: this.config.replicate.models.musicgen.defaults.duration,
                    temperature: this.config.replicate.models.musicgen.defaults.temperature,
                    top_k: this.config.replicate.models.musicgen.defaults.top_k,
                    top_p: this.config.replicate.models.musicgen.defaults.top_p,
                    classifier_free_guidance: this.config.replicate.models.musicgen.defaults.classifier_free_guidance
                }
            });

            // Poll for completion
            const predictionId = prediction.data.id;
            let audioUrl = null;
            let attempts = 0;
            const maxAttempts = 1200; // Maximum 20 minutes wait
            
            while (!audioUrl && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between polls
                const status = await this.api.get(`/predictions/${predictionId}`);
                attempts++;
                
                if (status.data.status === 'succeeded') {
                    audioUrl = status.data.output;
                    break;
                } else if (status.data.status === 'failed') {
                    throw new Error(`Music generation failed: ${status.data.error}`);
                }
                // Continue polling for 'starting' or 'processing' status
                if (attempts % 5 === 0) {
                    console.log(`Waiting for music generation... Attempt ${attempts}/${maxAttempts}`);
                }
            }

            if (!audioUrl) {
                throw new Error('Music generation timed out after 1200 seconds');
            }

            console.log('Music generation completed:', { audioUrl });
            return audioUrl;
        } catch (error) {
            console.error('Error generating background music:', error);
            if (error.response) {
                console.error('API Response:', error.response.data);
            }
            throw new Error(`Failed to generate background music: ${error.message}`);
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

        return `${moodMap[mood]}, high quality, no vocals`;
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
                const filePath = path.join(process.cwd(), 'data', 'music', `${moodOrUrl}.mp3`);
                console.log('Attempting to load from cache:', filePath);
                try {
                    audioBuffer = await fs.readFile(filePath);
                    console.log('Successfully loaded from cache');
                } catch (error) {
                    console.log('Cache miss, generating new audio');
                    // If file doesn't exist, generate and cache it
                    const generatedPath = await this.generateAndCacheMoodMusic(moodOrUrl);
                    audioBuffer = await fs.readFile(generatedPath);
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
        
        // Create a readable stream from the buffer
        const audioStream = new Readable();
        audioStream.push(audioBuffer);
        audioStream.push(null);
        console.log('Created readable stream');

        // Create FFmpeg transcoder with crossfade filters
        const filterArgs = [
            `volume=${volume}`,  // Use dynamic volume parameter
            isInitial ? 'afade=t=in:st=0:d=2' : '',  // Initial fade in
            this.loopingEnabled ? `afade=t=in:st=0:d=${this.config.audio.music.crossfadeDuration/1000}` : '',  // Crossfade in
            this.loopingEnabled ? `afade=t=out:st=${this.config.replicate.models.musicgen.defaults.duration - this.config.audio.music.crossfadeDuration/1000}:d=${this.config.audio.music.crossfadeDuration/1000}` : ''  // Crossfade out
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
        // Calculate when to start preparing the next loop
        const loopStartTime = (this.config.replicate.models.musicgen.defaults.duration * 1000) - 
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
                const filePath = path.join(process.cwd(), 'data', 'music', `${this.currentMood}.mp3`);
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

    async setVolume(volume, duration = 1000) {
        try {
            const startTime = Date.now();
            const resources = Array.from(this.activeResources);
            const initialVolumes = new Map(
                resources.map(resource => [resource, resource.volume?.volume || 0])
            );
            
            return new Promise((resolve) => {
                const fadeInterval = setInterval(() => {
                    const elapsed = Date.now() - startTime;
                    const progress = Math.min(elapsed / duration, 1);
                    
                    resources.forEach(resource => {
                        if (resource.volume) {
                            const initialVolume = initialVolumes.get(resource) || 0;
                            const newVolume = initialVolume + (volume - initialVolume) * progress;
                            resource.volume.setVolume(newVolume);
                        }
                    });
                    
                    if (progress >= 1) {
                        clearInterval(fadeInterval);
                        resolve();
                    }
                }, 50);
            });
        } catch (error) {
            console.error('Error setting volume:', error);
            throw error;
        }
    }
}

module.exports = MusicService; 