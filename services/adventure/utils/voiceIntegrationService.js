/**
 * Voice Integration Service
 * Handles voice channel integration, narration, and background music
 */

const { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource,
    VoiceConnectionStatus,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    entersState
} = require('@discordjs/voice');
const path = require('path');
const logger = require('./logger');

class VoiceIntegrationService {
    constructor() {
        this.connections = new Map();
        this.players = new Map();
        this.defaultSettings = {
            musicVolume: 0.3,
            narrationVolume: 1.0,
            connectionTimeout: 30000,
            moodMusicPath: path.join(process.cwd(), 'data', 'music'),
        };
    }

    /**
     * Initialize voice connection for a channel
     * @param {Object} channel Discord voice channel
     * @returns {Promise<Object>} Voice connection and players
     */
    async initializeVoiceConnection(channel) {
        try {
            // Check permissions
            const permissions = channel.permissionsFor(channel.client.user);
            if (!permissions.has('Connect') || !permissions.has('Speak')) {
                throw new Error('Missing voice channel permissions');
            }

            // Create or get existing connection
            let connection = this.connections.get(channel.id);
            if (!connection) {
                connection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: channel.guild.id,
                    adapterCreator: channel.guild.voiceAdapterCreator,
                    selfDeaf: false
                });

                // Wait for connection to be ready
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Ready, this.defaultSettings.connectionTimeout),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Voice connection timeout')), this.defaultSettings.connectionTimeout)
                    )
                ]);

                this.connections.set(channel.id, connection);
            }

            // Create or get existing players
            let players = this.players.get(channel.id);
            if (!players) {
                const musicPlayer = createAudioPlayer({
                    behaviors: {
                        noSubscriber: NoSubscriberBehavior.Play
                    }
                });

                const narrationPlayer = createAudioPlayer({
                    behaviors: {
                        noSubscriber: NoSubscriberBehavior.Play
                    }
                });

                connection.subscribe(musicPlayer);
                connection.subscribe(narrationPlayer);

                players = { musicPlayer, narrationPlayer };
                this.players.set(channel.id, players);

                // Set up error handlers
                musicPlayer.on('error', error => {
                    logger.error('Background music error', { error });
                });

                narrationPlayer.on('error', error => {
                    logger.error('Narration error', { error });
                });
            }

            return { connection, ...players };
        } catch (error) {
            logger.error('Failed to initialize voice connection', { error });
            throw error;
        }
    }

    /**
     * Play background music based on mood
     * @param {string} channelId Voice channel ID
     * @param {string} mood Current mood/atmosphere
     * @returns {Promise<void>}
     */
    async playBackgroundMusic(channelId, mood) {
        try {
            const players = this.players.get(channelId);
            if (!players?.musicPlayer) {
                throw new Error('No music player available');
            }

            const musicPath = path.join(this.defaultSettings.moodMusicPath, `${mood}.mp3`);
            const musicResource = createAudioResource(musicPath, {
                inputType: 'file',
                inlineVolume: true
            });

            musicResource.volume.setVolume(this.defaultSettings.musicVolume);
            players.musicPlayer.play(musicResource);
        } catch (error) {
            logger.error('Failed to play background music', { error });
            throw error;
        }
    }

    /**
     * Play narration
     * @param {string} channelId Voice channel ID
     * @param {string} text Text to narrate
     * @param {Object} options Narration options
     * @returns {Promise<void>}
     */
    async playNarration(channelId, text, options = {}) {
        try {
            const players = this.players.get(channelId);
            if (!players?.narrationPlayer) {
                throw new Error('No narration player available');
            }

            // Generate narration audio stream
            const narrationStream = await this.generateNarration(text, options);
            const narrationResource = createAudioResource(narrationStream, {
                inputType: 'arbitrary',
                inlineVolume: true
            });

            narrationResource.volume.setVolume(this.defaultSettings.narrationVolume);
            players.narrationPlayer.play(narrationResource);

            // Wait for narration to finish
            return new Promise((resolve) => {
                players.narrationPlayer.on(AudioPlayerStatus.Idle, () => {
                    resolve();
                });
            });
        } catch (error) {
            logger.error('Failed to play narration', { error });
            throw error;
        }
    }

    /**
     * Generate narration audio stream
     * @param {string} text Text to narrate
     * @param {Object} options Narration options
     * @returns {Promise<ReadableStream>} Audio stream
     * @private
     */
    async generateNarration(text, options = {}) {
        // Implementation depends on your text-to-speech service
        // This is a placeholder for the actual implementation
        throw new Error('Narration generation not implemented');
    }

    /**
     * Clean up voice resources
     * @param {string} channelId Voice channel ID
     */
    cleanup(channelId) {
        try {
            const players = this.players.get(channelId);
            if (players) {
                players.musicPlayer?.stop();
                players.narrationPlayer?.stop();
                this.players.delete(channelId);
            }

            const connection = this.connections.get(channelId);
            if (connection) {
                connection.destroy();
                this.connections.delete(channelId);
            }
        } catch (error) {
            logger.error('Error during voice cleanup', { error });
        }
    }

    /**
     * Clean up all voice resources
     */
    cleanupAll() {
        for (const channelId of this.connections.keys()) {
            this.cleanup(channelId);
        }
    }
}

module.exports = new VoiceIntegrationService(); 