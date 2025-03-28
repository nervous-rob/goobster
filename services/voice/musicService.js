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

class MusicService extends EventEmitter {
    constructor(config) {
        super();
        
        // Check for API key in config or environment variables
        let apiKey = config?.replicate?.apiKey;
        
        // Fall back to environment variable if not in config
        if (!apiKey) {
            apiKey = process.env.REPLICATE_API_KEY;
            console.log('Replicate API key not found in config, falling back to environment variable');
            
            // Save it to the config object for later use
            if (!config.replicate) config.replicate = {};
            config.replicate.apiKey = apiKey;
        }
        
        if (!apiKey) {
            throw new Error('Replicate API key is missing from both config object and environment variables. Please ensure it is properly set.');
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
        this.wasRateLimited = false; // Flag to track rate limiting
        
        // Cache system for prediction results
        this.predictionCache = new Map();
        // Cache TTL in ms (10 minutes)
        this.cacheTTL = 10 * 60 * 1000;
        
        // Initialize axios instance with default config
        this.api = axios.create({
            baseURL: 'https://api.replicate.com/v1',
            headers: {
                'Authorization': `Token ${apiKey}`,
                'Content-Type': 'application/json'
            },
            // Add timeout to prevent hanging requests
            timeout: 30000 // 30 seconds timeout for initial requests
        });

        // Add request and response interceptors for better error handling
        this.api.interceptors.response.use(
            response => response,
            async error => {
                // Check if we should retry the request
                if (this.shouldRetryRequest(error)) {
                    return this.retryRequest(error);
                }
                return Promise.reject(error);
            }
        );

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
    }
    
    startMemoryMonitoring() {
        // Monitor memory usage every 30 seconds
        this.memoryMonitorInterval = setInterval(() => {
            const memoryUsage = process.memoryUsage();
            console.debug('Memory usage:', {
                rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
                heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
                heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
                external: `${Math.round(memoryUsage.external / 1024 / 1024)} MB`
            });
            
            // Clean up prediction cache if too large
            if (this.predictionCache.size > 50) {
                this.cleanupPredictionCache();
            }
        }, 30000);
    }
    
    cleanupPredictionCache() {
        const now = Date.now();
        for (const [key, cacheEntry] of this.predictionCache.entries()) {
            if (now - cacheEntry.timestamp > this.cacheTTL) {
                this.predictionCache.delete(key);
            }
        }
    }
    
    shouldRetryRequest(error) {
        // Retry on network errors, 5xx responses, and rate limiting (429)
        return (error.code === 'ECONNABORTED' || 
                error.code === 'ECONNRESET' || 
                error.code === 'ETIMEDOUT' ||
                (error.response && (error.response.status >= 500 || error.response.status === 429)));
    }
    
    async retryRequest(error) {
        const config = error.config;
        
        // Set max retries
        if (!config.retryCount) {
            config.retryCount = 0;
        }
        
        if (config.retryCount >= 3) {
            return Promise.reject(error);
        }
        
        config.retryCount += 1;
        
        // Implement exponential backoff
        const delay = Math.pow(2, config.retryCount) * 1000;
        console.log(`Retrying request (${config.retryCount}/3) after ${delay}ms...`);
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Create new request
        return this.api(config);
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
            const context = { atmosphere: mood };
            const audioUrl = await this.generateBackgroundMusic(context);
            
            // Get the file extension from the URL (typically .mp3 or .wav)
            const extension = path.extname(new URL(audioUrl).pathname) || '.mp3';
            
            // Create a directory for mood music if it doesn't exist
            const musicDir = path.join(process.cwd(), 'cache', 'music');
            await fs.mkdir(musicDir, { recursive: true });
            
            // Download the file
            const response = await axios({
                method: 'get',
                url: audioUrl,
                responseType: 'arraybuffer'
            });
            
            // Save to disk
            const filePath = path.join(musicDir, `${mood}${extension}`);
            await fs.writeFile(filePath, Buffer.from(response.data));
            
            console.log(`Generated and cached music for mood ${mood} at ${filePath}`);
            
            // Check if any rate limiting was detected during generateBackgroundMusic
            return { rateLimited: this.wasRateLimited, filePath };
        } catch (error) {
            console.error(`Error generating/caching music for mood ${mood}:`, error);
            throw error;
        }
    }

    // Generate a cache key for the prediction
    getPredictionCacheKey(contextMood, modelVersion) {
        return `${contextMood}:${modelVersion}`;
    }

    async generateBackgroundMusic(context) {
        try {
            const prompt = this.createMusicPrompt(context);
            console.log('Generating music with prompt:', prompt);
            
            // Ensure config has necessary structure with fallbacks
            if (!this.config.replicate) this.config.replicate = {};
            if (!this.config.replicate.models) this.config.replicate.models = {};
            if (!this.config.replicate.models.musicgen) {
                console.log('Missing musicgen configuration, using defaults');
                this.config.replicate.models.musicgen = {
                    version: "671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb",
                    defaults: {
                        model_version: "stereo-large",  // Always use stereo-large
                        duration: 30,
                        temperature: 1.0,
                        top_k: 250,
                        top_p: 0.95,
                        classifier_free_guidance: 3.0
                    }
                };
            }
            
            // Always ensure model_version is stereo-large
            if (!this.config.replicate.models.musicgen.defaults) {
                this.config.replicate.models.musicgen.defaults = {};
            }
            this.config.replicate.models.musicgen.defaults.model_version = "stereo-large";
            
            // Ensure audio config has necessary structure with fallbacks
            if (!this.config.audio) this.config.audio = {};
            if (!this.config.audio.music) {
                this.config.audio.music = {
                    volume: 1.0,
                    crossfadeDuration: 3000,
                    loopFadeStart: 5000
                };
            }
            
            // Use updated input format for the latest API
            const input = {
                prompt: prompt,
                model_version: "stereo-large", // Always use stereo-large regardless of config
                duration: this.config.replicate.models.musicgen.defaults.duration,
                temperature: this.config.replicate.models.musicgen.defaults.temperature,
                top_k: this.config.replicate.models.musicgen.defaults.top_k,
                top_p: this.config.replicate.models.musicgen.defaults.top_p,
                classifier_free_guidance: this.config.replicate.models.musicgen.defaults.classifier_free_guidance,
                output_format: "mp3",
                normalization_strategy: "peak"
            };
            
            // Check cache first
            const cacheKey = this.getPredictionCacheKey(context.atmosphere, input.model_version);
            if (this.predictionCache.has(cacheKey)) {
                const cachedResult = this.predictionCache.get(cacheKey);
                if (Date.now() - cachedResult.timestamp < this.cacheTTL) {
                    console.log('Using cached prediction result');
                    return cachedResult.audioUrl;
                } else {
                    // Cache expired, remove it
                    this.predictionCache.delete(cacheKey);
                }
            }
            
            // First try with the configured version
            try {
                console.log('Attempting to use configured model version:', this.config.replicate.models.musicgen.version);
                const { audioUrl, rateLimited } = await this.runPredictionWithPolling(this.config.replicate.models.musicgen.version, input);
                
                // Cache the result
                this.predictionCache.set(cacheKey, {
                    audioUrl,
                    timestamp: Date.now()
                });
                
                this.wasRateLimited = rateLimited;
                return audioUrl;
            } catch (versionError) {
                // If we get a 422 error (invalid version), try with the public model
                if (versionError.response && versionError.response.status === 422) {
                    console.warn('Configured model version not available, trying public model fallback.');
                    // Fallback to the latest public model
                    const publicVersion = "671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb";
                    
                    // Ensure we're using a valid model_version for the public model
                    input.model_version = "stereo-large";
                    
                    const { audioUrl: publicAudioUrl, rateLimited: publicRateLimited } = await this.runPredictionWithPolling(publicVersion, input);
                    
                    // Cache the result with the fallback version
                    this.predictionCache.set(cacheKey, {
                        audioUrl: publicAudioUrl,
                        timestamp: Date.now()
                    });
                    
                    this.wasRateLimited = publicRateLimited;
                    return publicAudioUrl;
                } else {
                    // Re-throw for other errors
                    throw versionError;
                }
            }
        } catch (error) {
            console.error('Error generating background music:', error);
            if (error.response) {
                console.error('API Response:', error.response.data);
            }
            throw new Error(`Failed to generate background music: ${error.message}`);
        }
    }
    
    async runPredictionWithPolling(version, input) {
        // Add retry mechanism for initial request with exponential backoff
        let prediction;
        let retries = 0;
        const maxRetries = 5;
        
        // Always force model_version to be stereo-large
        input.model_version = "stereo-large";
        
        while (retries <= maxRetries) {
            try {
                prediction = await this.api.post('/predictions', {
                    version: version,
                    input: input
                });
                break; // Success, exit the retry loop
            } catch (error) {
                // Handle validation errors (422)
                if (error.response && error.response.status === 422) {
                    // Log the detailed error message
                    console.error('API validation error:', error.response.data);
                    
                    // Check if the error is about model_version
                    if (error.response.data && 
                        error.response.data.detail && 
                        error.response.data.detail.includes('model_version')) {
                        
                        // Ensure model_version is stereo-large and retry
                        console.log('Setting model_version to "stereo-large" and retrying');
                        input.model_version = "stereo-large";
                        retries++;
                        continue;
                    }
                    
                    // For other 422 errors, rethrow
                    throw error;
                }
                
                // Handle rate limiting
                if (error.response && error.response.status === 429) {
                    // Rate limiting detected
                    retries++;
                    if (retries > maxRetries) {
                        throw new Error(`Rate limit exceeded after ${maxRetries} retries. Please try again later.`);
                    }
                    
                    // Calculate backoff time - exponential with jitter
                    const baseDelay = 1000; // Start with 1 second
                    const maxDelay = 60000; // Max 1 minute
                    
                    // Get retry-after header if available or use exponential backoff
                    let delayMs = error.response.headers['retry-after'] 
                        ? parseInt(error.response.headers['retry-after']) * 1000 
                        : Math.min(baseDelay * Math.pow(2, retries), maxDelay);
                    
                    // Add some randomness to prevent all clients retrying simultaneously
                    delayMs = delayMs * (0.75 + Math.random() * 0.5);
                    
                    console.warn(`Rate limited by Replicate API. Retrying in ${Math.round(delayMs/1000)} seconds (retry ${retries}/${maxRetries})...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }
                
                // For other errors, just throw
                throw error;
            }
        }
        
        // Poll for completion
        const predictionId = prediction.data.id;
        let audioUrl = null;
        let attempts = 0;
        const maxAttempts = 1200; // Maximum 20 minutes wait
        
        // Batch status checks - start with quick checks, then slow down
        const getPollingDelay = (attempt) => {
            if (attempt < 10) return 2000; // First 10 attempts - check every 2s (increased from 1s)
            if (attempt < 60) return 5000; // Next 50 attempts - check every 5s
            return 10000; // After that - check every 10s
        };
        
        // Use a circuit breaker to prevent excessive polling
        let consecutiveErrors = 0;
        const maxConsecutiveErrors = 5;
        let rateLimited = false;
        
        while (!audioUrl && attempts < maxAttempts) {
            const delay = getPollingDelay(attempts);
            await new Promise(resolve => setTimeout(resolve, delay));
            
            try {
                // Add rate limiting handling for status checks
                let statusResponse;
                let statusRetries = 0;
                const maxStatusRetries = 3;
                
                while (statusRetries <= maxStatusRetries) {
                    try {
                        statusResponse = await this.api.get(`/predictions/${predictionId}`);
                        break; // Success, exit retry loop
                    } catch (error) {
                        if (error.response && error.response.status === 429) {
                            // Rate limiting detected for status check
                            statusRetries++;
                            rateLimited = true;
                            
                            if (statusRetries > maxStatusRetries) {
                                throw error; // Max retries exceeded, let the outer catch handle it
                            }
                            
                            // Calculate backoff time
                            const baseDelay = 2000;
                            const statusDelayMs = error.response.headers['retry-after'] 
                                ? parseInt(error.response.headers['retry-after']) * 1000 
                                : Math.min(baseDelay * Math.pow(2, statusRetries), 20000);
                                
                            console.warn(`Rate limited during status check. Retrying in ${Math.round(statusDelayMs/1000)} seconds...`);
                            await new Promise(resolve => setTimeout(resolve, statusDelayMs));
                            continue;
                        }
                        
                        // Other errors, throw to outer catch
                        throw error;
                    }
                }
                
                attempts++;
                consecutiveErrors = 0; // Reset error counter on success
                
                if (statusResponse.data.status === 'succeeded') {
                    audioUrl = statusResponse.data.output;
                    break;
                } else if (statusResponse.data.status === 'failed') {
                    throw new Error(`Music generation failed: ${statusResponse.data.error}`);
                }
                
                // Log progress less frequently to reduce log spam
                if (attempts % 15 === 0) {
                    console.log(`Waiting for music generation... Attempt ${attempts}/${maxAttempts} (${statusResponse.data.status})`);
                }
            } catch (error) {
                consecutiveErrors++;
                
                // Special handling for rate limiting errors
                if (error.response && error.response.status === 429) {
                    rateLimited = true;
                    const retryAfter = error.response.headers['retry-after'] 
                        ? parseInt(error.response.headers['retry-after']) 
                        : 5;
                        
                    console.warn(`Rate limited on status check. Waiting ${retryAfter} seconds before retrying...`);
                    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                } else {
                    console.error(`Error checking prediction status (${consecutiveErrors}/${maxConsecutiveErrors}):`, error.message);
                }
                
                // If too many consecutive errors, abort
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    throw new Error('Too many consecutive errors checking prediction status');
                }
                
                attempts++;
            }
        }

        if (!audioUrl) {
            throw new Error('Music generation timed out after 1200 seconds');
        }

        // Return both the audio URL and whether rate limiting was encountered
        console.log('Music generation completed after', attempts, 'status checks');
        return { audioUrl, rateLimited };
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
                } catch (error) {
                    console.log('Cache miss, generating new audio');
                    // If file doesn't exist, generate and cache it
                    const result = await this.generateAndCacheMoodMusic(moodOrUrl);
                    if (!result.filePath) {
                        throw new Error('No file path returned from music generation');
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
        
        if (!this.config.replicate) this.config.replicate = {};
        if (!this.config.replicate.models) this.config.replicate.models = {};
        if (!this.config.replicate.models.musicgen) {
            this.config.replicate.models.musicgen = {
                defaults: {
                    duration: 30
                }
            };
        }
        
        // Create a readable stream from the buffer
        const audioStream = new Readable();
        audioStream.push(audioBuffer);
        audioStream.push(null);
        console.log('Created readable stream');

        // Get crossfade duration with fallback
        const crossfadeDuration = this.config.audio.music.crossfadeDuration || 3000;
        const musicDuration = this.config.replicate.models.musicgen.defaults.duration || 30;

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
        
        // Ensure replicate config exists with fallbacks
        if (!this.config.replicate) this.config.replicate = {};
        if (!this.config.replicate.models) this.config.replicate.models = {};
        if (!this.config.replicate.models.musicgen) {
            this.config.replicate.models.musicgen = {
                defaults: {
                    duration: 30
                }
            };
        } else if (!this.config.replicate.models.musicgen.defaults) {
            this.config.replicate.models.musicgen.defaults = { duration: 30 };
        }
        
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

    // Make sure to clean up resources properly when the bot is shutting down
    dispose() {
        if (this.memoryMonitorInterval) {
            clearInterval(this.memoryMonitorInterval);
        }
        
        this.stopMusic();
        
        // Clear the prediction cache
        this.predictionCache.clear();
    }
}

module.exports = MusicService; 