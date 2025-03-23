const Replicate = require('replicate');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const writeFileAsync = promisify(fs.writeFile);
const { createAudioResource, createAudioPlayer } = require('@discordjs/voice');
const fetch = require('node-fetch');

class BarkTTSService {
    constructor(config) {
        if (!config.replicate || !config.replicate.apiKey) {
            throw new Error('Replicate API key not found in config');
        }
        
        // Store the API key directly
        this.apiKey = config.replicate.apiKey;
        
        // Keep this for backward compatibility, but we'll use direct API calls
        this.replicate = { auth: this.apiKey };
        
        // Flag to track if model is currently booting
        this.isModelBooting = false;
        
        this.cacheDir = path.join(process.cwd(), 'cache', 'tts');
        this.ensureCacheDirectory();
        
        // Log initialization but not the key
        console.log('BarkTTSService initialized with Replicate API');
    }

    ensureCacheDirectory() {
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    static applyStyle(text, style) {
        const styles = {
            'sing': (text) => `♪ ${text} ♪`,
            'happy': (text) => `[HAPPY] ${text} [laughter]`,
            'sad': (text) => `[SAD] ${text} [sigh]`,
            'angry': (text) => `[ANGRY] ${text}!`,
            'thinking': (text) => `[THOUGHTFUL] Hmm... ${text}`,
            'dramatic': (text) => `[DRAMATIC PAUSE] ... ${text} ...`,
            'movie_trailer': (text) => `[EPIC] In a world... where ${text}`,
            'radio_host': (text) => `[RADIO VOICE] Goooood morning listeners! ${text}`,
            'game_announcer': (text) => `[ANNOUNCER] Ladies and gentlemen... ${text}!`,
            'enthusiastic': (text) => `[EXCITED] WOW! ${text}!`,
            'whisper': (text) => `[whispers] ${text}`,
            'circus': (text) => `[RINGMASTER] Step right up! ${text}!`
        };

        return styles[style] ? styles[style](text) : text;
    }

    static addRandomEffects(text) {
        const effects = [
            '[laughter]',
            '[sigh]',
            '[clears throat]',
            '[gasp]',
            '[hmm]',
            '[whispers]',
            '[music]',
            '[chuckles]',
            '[yawns]',
            '[sniffs]',
            '[coughs]',
            '[whistles]'
        ];

        const emotions = [
            '[HAPPY]',
            '[EXCITED]',
            '[CURIOUS]',
            '[SURPRISED]',
            '[AMUSED]',
            '[MYSTERIOUS]',
            '[CONFIDENT]',
            '[PLAYFUL]',
            '[ENERGETIC]',
            '[CALM]'
        ];

        const backgrounds = [
            '[crowd murmuring]',
            '[birds chirping]',
            '[rain falling]',
            '[wind blowing]',
            '[crickets chirping]',
            '[distant thunder]',
            '[waves crashing]',
            '[fire crackling]'
        ];

        // Add 1-2 random effects
        const numEffects = Math.floor(Math.random() * 2) + 1;
        for (let i = 0; i < numEffects; i++) {
            const effect = effects[Math.floor(Math.random() * effects.length)];
            const position = Math.random() > 0.5 ? 'start' : 'end';
            text = position === 'start' ? `${effect} ${text}` : `${text} ${effect}`;
        }

        // Maybe add an emotion (30% chance)
        if (Math.random() < 0.3) {
            const emotion = emotions[Math.floor(Math.random() * emotions.length)];
            text = `${emotion} ${text}`;
        }

        // Maybe add background sound (20% chance)
        if (Math.random() < 0.2) {
            const background = backgrounds[Math.floor(Math.random() * backgrounds.length)];
            text = `${text} ${background}`;
        }

        return text;
    }

    static addEmphasis(text) {
        // Split text into words
        const words = text.split(' ');
        
        // Randomly capitalize 15-30% of words
        const numToCapitalize = Math.floor(words.length * (Math.random() * 0.15 + 0.15));
        const indexesToCapitalize = new Set();
        
        while (indexesToCapitalize.size < numToCapitalize) {
            const index = Math.floor(Math.random() * words.length);
            // Don't capitalize words that are already part of effects/emotions
            if (!words[index].includes('[') && !words[index].includes(']')) {
                indexesToCapitalize.add(index);
            }
        }

        // Apply capitalization
        const modifiedWords = words.map((word, index) => 
            indexesToCapitalize.has(index) ? word.toUpperCase() : word
        );

        return modifiedWords.join(' ');
    }

    static addHesitation(text) {
        // Split text into sentences
        const sentences = text.split(/([.!?]+)/);
        
        // Add hesitation marks with 30% chance per sentence
        const modifiedSentences = sentences.map(sentence => {
            if (sentence.length < 2 || sentence.match(/[.!?]+/)) return sentence;
            
            if (Math.random() < 0.3) {
                // Randomly choose between different hesitation marks
                const hesitation = Math.random() < 0.5 ? '...' : '—';
                // Insert hesitation at random position
                const words = sentence.split(' ');
                const position = Math.floor(Math.random() * words.length);
                words.splice(position, 0, hesitation);
                return words.join(' ');
            }
            return sentence;
        });

        return modifiedSentences.join('');
    }

    async textToSpeech(text, voiceChannel, connection, voiceOption = 'en_speaker_6') {
        try {
            // Generate a unique filename based on text content and voice
            const filename = `${Buffer.from(text + voiceOption).toString('base64').substring(0, 32)}.wav`;
            const outputPath = path.join(this.cacheDir, filename);

            // Check if we have a cached version
            if (fs.existsSync(outputPath)) {
                console.log('Using cached TTS audio');
                return this.playAudio(outputPath, connection);
            }

            console.log(`Generating TTS audio with Bark using voice: ${voiceOption}...`);
            
            // Determine temperature based on text content
            const hasEffects = text.includes('[') && text.includes(']');
            const hasEmphasis = text.match(/[A-Z]{2,}/);
            const hasHesitation = text.includes('...') || text.includes('—');
            
            // Adjust temperature based on various factors
            let temperature = 0.7;
            if (hasEffects) temperature += 0.1;
            if (hasEmphasis) temperature += 0.05;
            if (hasHesitation) temperature += 0.05;
            
            // Cap temperature at 0.9 for stability
            temperature = Math.min(temperature, 0.9);

            try {
                // Direct API call to Replicate using fetch
                const apiUrl = 'https://api.replicate.com/v1/predictions';
                const apiKey = this.apiKey;
                
                // Log the request we're about to make
                console.log('Making API request to Replicate with params:', {
                    version: "b76242b40d67c76ab6742e987628a2a9ac019e11d56ab96c4e91ce03b79b2787",
                    input: {
                        prompt: text,
                        history_prompt: voiceOption,
                        temperature: temperature
                    }
                });
                
                // STEP 1: Create prediction
                console.log('Creating prediction...');
                const createResponse = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Token ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        version: "b76242b40d67c76ab6742e987628a2a9ac019e11d56ab96c4e91ce03b79b2787",
                        input: {
                            prompt: text,
                            history_prompt: voiceOption,
                            temperature: temperature
                        }
                    })
                });
                
                if (!createResponse.ok) {
                    const errorData = await createResponse.json();
                    console.error('Error creating prediction:', errorData);
                    throw new Error(`Failed to create prediction: ${createResponse.status} ${createResponse.statusText}`);
                }
                
                const prediction = await createResponse.json();
                console.log('Prediction created:', prediction.id);
                
                // STEP 2: Poll until the prediction is complete
                console.log('Waiting for prediction to complete...');
                let completedPrediction;
                let attempts = 0;
                const maxAttempts = 120; // Increase to 10 minutes
                let pollingInterval = 5000; // Default polling interval (5 seconds)
                
                while (attempts < maxAttempts) {
                    const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
                        headers: {
                            'Authorization': `Token ${apiKey}`
                        }
                    });
                    
                    if (!pollResponse.ok) {
                        const errorData = await pollResponse.json();
                        console.error('Error polling prediction:', errorData);
                        throw new Error(`Failed to poll prediction: ${pollResponse.status} ${pollResponse.statusText}`);
                    }
                    
                    completedPrediction = await pollResponse.json();
                    console.log('Prediction status:', completedPrediction.status);
                    
                    if (completedPrediction.status === 'succeeded') {
                        break;
                    } else if (completedPrediction.status === 'failed') {
                        throw new Error(`Prediction failed: ${completedPrediction.error || 'Unknown error'}`);
                    } else if (completedPrediction.status === 'starting' || completedPrediction.status === 'processing') {
                        // Standard processing - continue with regular polling
                        pollingInterval = 5000; // 5 seconds
                    } else if (completedPrediction.status === 'booting') {
                        // Booting status - use longer polling to give the model time to boot
                        console.log('Model is booting up, this may take several minutes...');
                        pollingInterval = 15000; // 15 seconds for booting status
                        this.isModelBooting = true; // Set the booting flag
                    }
                    
                    // Wait before polling again
                    console.log(`Waiting ${pollingInterval/1000} seconds before checking again...`);
                    await new Promise(resolve => setTimeout(resolve, pollingInterval));
                    attempts++;
                }
                
                // Reset booting flag when done
                this.isModelBooting = false;
                
                if (attempts >= maxAttempts) {
                    throw new Error('Prediction timed out after 10 minutes');
                }
                
                // STEP 3: Process the output
                console.log('Prediction succeeded:', JSON.stringify(completedPrediction.output).substring(0, 200) + '...');
                
                if (!completedPrediction.output) {
                    console.error('Empty output from Replicate API');
                    throw new Error('No audio output received from Bark API');
                }
                
                // Get the audio URL from the output
                let audioUrl;
                
                // Handle different response formats
                if (typeof completedPrediction.output === 'string') {
                    audioUrl = completedPrediction.output;
                } else if (Array.isArray(completedPrediction.output)) {
                    audioUrl = completedPrediction.output[0];
                } else if (completedPrediction.output.audio_out) {
                    // This is the format we're actually getting
                    audioUrl = completedPrediction.output.audio_out;
                } else {
                    console.error('Unexpected API response format:', completedPrediction.output);
                    throw new Error('Unexpected API response format');
                }
                
                console.log('Audio URL from API:', audioUrl);
                
                // STEP 4: Download the audio file
                console.log('Downloading audio file...');
                const audioResponse = await fetch(audioUrl);
                
                if (!audioResponse.ok) {
                    throw new Error(`Failed to download audio file: ${audioResponse.status} ${audioResponse.statusText}`);
                }
                
                const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
                await writeFileAsync(outputPath, audioBuffer);
                console.log(`Audio file saved to ${outputPath}`);
                
                // STEP 5: Play the audio
                return this.playAudio(outputPath, connection);
            } catch (apiError) {
                console.error('Bark API Error:', {
                    message: apiError.message,
                    stack: apiError.stack
                });
                
                // Reset booting flag in case of errors
                this.isModelBooting = false;
                
                throw apiError;
            }
        } catch (error) {
            console.error('Error in Bark TTS:', error);
            throw error;
        }
    }

    playAudio(audioPath, connection) {
        try {
            const resource = createAudioResource(audioPath);
            let player = connection.state.subscription?.player;
            
            // Create a new player if one doesn't exist
            if (!player) {
                player = createAudioPlayer();
                connection.subscribe(player);
            }
            
            player.play(resource);
            return new Promise((resolve) => {
                player.on('stateChange', (oldState, newState) => {
                    if (newState.status === 'idle') {
                        resolve();
                    }
                });
            });
        } catch (error) {
            console.error('Error playing audio:', error);
            throw error;
        }
    }
}

module.exports = BarkTTSService; 