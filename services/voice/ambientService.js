// TODO: Add proper handling for ambient transitions
// TODO: Add proper handling for ambient layering
// TODO: Add proper handling for ambient effects
// TODO: Add proper handling for ambient persistence
// TODO: Add proper handling for ambient state
// TODO: Add proper handling for ambient cleanup
// TODO: Add proper handling for ambient errors
// TODO: Add proper handling for ambient recovery
// TODO: Add proper handling for ambient synchronization
// TODO: Add proper handling for ambient mixing

const { EventEmitter } = require('events');
const { 
    createAudioPlayer,
    createAudioResource,
    StreamType,
    NoSubscriberBehavior,
    AudioPlayerStatus
} = require('@discordjs/voice');
const { Readable } = require('stream');
const prism = require('prism-media');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;

class AmbientService extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.activeResources = new Set();
        this.currentAmbience = null;
        
        // Create audio player with proper configuration
        this.player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
                maxMissedFrames: 50
            }
        });

        this.player.on('error', this.handlePlayerError.bind(this));
        this.ensureAmbienceDir();
    }

    handlePlayerError(error) {
        console.error('Ambient player error:', error);
        this.emit('playerError', error);
    }

    async ensureAmbienceDir() {
        try {
            await fs.mkdir(path.join(process.cwd(), 'data', 'ambience'), { recursive: true });
        } catch (error) {
            console.error('Error creating ambience directory:', error);
        }
    }

    getAmbienceMap() {
        return {
            forest: "Forest ambience with birds chirping, leaves rustling, and gentle wind",
            cave: "Dark cave ambience with water drops, distant echoes, and subtle wind",
            tavern: "Medieval tavern ambience with murmuring crowds, clinking glasses, and distant music",
            ocean: "Ocean waves crashing, seagulls, and wind over water",
            city: "Medieval city ambience with distant crowds, horse carriages, and street vendors",
            dungeon: "Dark dungeon ambience with chains, distant moans, and eerie sounds",
            camp: "Nighttime campfire ambience with crackling fire and nocturnal creatures",
            storm: "Thunder, heavy rain, and howling wind ambience"
        };
    }

    async doesAmbienceExist(type) {
        try {
            const filePath = path.join(process.cwd(), 'data', 'ambience', `${type}.mp3`);
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async generateAndCacheAmbience(type, forceRegenerate = false) {
        const filePath = path.join(process.cwd(), 'data', 'ambience', `${type}.mp3`);
        
        if (!forceRegenerate) {
            try {
                await fs.access(filePath);
                return filePath;
            } catch {} // File doesn't exist, continue with generation
        }

        try {
            const audioUrl = await this.generateAmbience(type);
            const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
            await fs.writeFile(filePath, Buffer.from(response.data));
            return filePath;
        } catch (error) {
            console.error(`Error generating/caching ambience for type ${type}:`, error);
            throw error;
        }
    }

    async generateAmbience(type) {
        try {
            const ambienceMap = this.getAmbienceMap();
            const prompt = `${ambienceMap[type]}, high quality environmental sound effects, ultra-realistic ambience, no music, no melody, pure atmospheric sounds, immersive 3D audio space`;
            
            const prediction = await axios.post('https://api.replicate.com/v1/predictions', {
                version: this.config.replicate.models.musicgen.version,
                input: {
                    model_version: this.config.replicate.models.musicgen.ambient.model_version,
                    prompt: prompt,
                    duration: this.config.replicate.models.musicgen.ambient.duration,
                    temperature: this.config.replicate.models.musicgen.ambient.temperature,
                    top_k: this.config.replicate.models.musicgen.ambient.top_k,
                    top_p: this.config.replicate.models.musicgen.ambient.top_p,
                    classifier_free_guidance: this.config.replicate.models.musicgen.ambient.classifier_free_guidance
                }
            }, {
                headers: {
                    'Authorization': `Token ${this.config.replicate.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            const predictionId = prediction.data.id;
            let audioUrl = null;
            let attempts = 0;
            const maxAttempts = 180; // 3 minutes maximum wait
            
            while (!audioUrl && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const status = await axios.get(`https://api.replicate.com/v1/predictions/${predictionId}`, {
                    headers: {
                        'Authorization': `Token ${this.config.replicate.apiKey}`
                    }
                });
                attempts++;
                
                if (status.data.status === 'succeeded') {
                    audioUrl = status.data.output;
                    break;
                } else if (status.data.status === 'failed') {
                    throw new Error(`Ambience generation failed: ${status.data.error}`);
                }
                
                // Log progress every 5 seconds
                if (attempts % 5 === 0) {
                    console.log(`Waiting for ambience generation... Attempt ${attempts}/${maxAttempts}`);
                }
            }

            if (!audioUrl) {
                throw new Error('Ambience generation timed out after 3 minutes');
            }

            console.log('Ambience generation completed:', { type, audioUrl });
            return audioUrl;
        } catch (error) {
            console.error('Error generating ambience:', error);
            throw error;
        }
    }

    async playAmbience(type, connection, volume = 0.2) {
        try {
            let audioBuffer;
            const filePath = path.join(process.cwd(), 'data', 'ambience', `${type}.mp3`);
            
            try {
                audioBuffer = await fs.readFile(filePath);
            } catch (error) {
                const generatedPath = await this.generateAndCacheAmbience(type);
                audioBuffer = await fs.readFile(generatedPath);
            }

            // Create audio stream from buffer
            const audioStream = new Readable();
            audioStream.push(audioBuffer);
            audioStream.push(null);

            // Create FFmpeg transcoder with proper settings
            const transcoder = new prism.FFmpeg({
                args: [
                    '-i', '-',
                    '-analyzeduration', '0',
                    '-loglevel', '0',
                    '-acodec', 'pcm_s16le',
                    '-f', 's16le',
                    '-ar', '48000',
                    '-ac', '2',
                    '-af', [
                        `volume=${volume}`,
                        'afade=t=in:st=0:d=2',
                        'aloop=loop=-1:size=2e8'  // Loop indefinitely
                    ].filter(Boolean).join(',')
                ],
            });

            transcoder.on('error', error => {
                console.error('Ambience transcoder error:', error);
                this.emit('transcoderError', error);
            });

            // Create audio resource
            const resource = createAudioResource(audioStream.pipe(transcoder), {
                inputType: StreamType.Raw,
                inlineVolume: true
            });

            if (!resource) {
                throw new Error('Failed to create ambience resource');
            }

            // Set volume and add to active resources
            resource.volume?.setVolume(volume);
            this.activeResources.add(resource);

            // Play the resource
            this.player.play(resource);
            connection.subscribe(this.player);

            // Set up player state monitoring
            this.player.on(AudioPlayerStatus.Playing, () => {
                console.log(`Now playing ${type} ambient sounds`);
            });

            this.player.on(AudioPlayerStatus.Idle, () => {
                console.log(`Ambient sounds stopped: ${type}`);
            });

            return this.player;

        } catch (error) {
            console.error('Error playing ambience:', error);
            this.emit('playbackError', error);
            throw error;
        }
    }

    stopAmbience() {
        if (this.player) {
            this.player.stop();
        }
        this.activeResources.forEach(resource => {
            try {
                resource.audioPlayer?.stop();
            } catch (error) {
                console.warn('Error stopping ambience resource:', error);
            }
        });
        this.activeResources.clear();
    }
}

module.exports = AmbientService; 