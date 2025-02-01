const { 
    joinVoiceChannel,
    VoiceConnectionStatus,
    entersState,
    EndBehaviorType
} = require('@discordjs/voice');
const { EventEmitter } = require('events');

class VoiceConnectionService extends EventEmitter {
    constructor() {
        super();
        this.connections = new Map();
        this.reconnectAttempts = new Map();
        this.MAX_RECONNECT_ATTEMPTS = 5;
        this.RECONNECT_INTERVAL = 2000;
    }

    async createConnection(channel, options = {}) {
        console.log(`Creating voice connection for channel ${channel.id}`);
        
        // Cleanup any existing connection
        const existingConnection = this.connections.get(channel.id);
        if (existingConnection) {
            console.log(`Cleaning up existing connection for channel ${channel.id}`);
            try {
                existingConnection.destroy();
            } catch (error) {
                console.error('Error destroying existing connection:', error);
            }
            this.connections.delete(channel.id);
            this.reconnectAttempts.delete(channel.id);
        }
        
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
            debug: true,  // Enable debug logging
            ...options
        });

        try {
            // Wait for the connection to be ready with timeout
            console.log(`Waiting for connection to be ready in channel ${channel.id}`);
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
            console.log(`Voice Connection established in channel ${channel.id}`);
            
            // Reset reconnect attempts on successful connection
            this.reconnectAttempts.delete(channel.id);
        } catch (error) {
            console.error(`Failed to establish voice connection in channel ${channel.id}:`, error);
            connection.destroy();
            throw new Error(`Failed to establish voice connection: ${error.message}`);
        }

        // Enhanced connection state handling
        connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
            console.log(`Voice Connection disconnected in channel ${channel.id}`);
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                ]);
                console.log(`Voice Connection reconnecting in channel ${channel.id}`);
            } catch (error) {
                const attempts = this.reconnectAttempts.get(channel.id) || 0;
                console.log(`Reconnection attempt ${attempts + 1}/${this.MAX_RECONNECT_ATTEMPTS} for channel ${channel.id}`);
                
                if (attempts < this.MAX_RECONNECT_ATTEMPTS) {
                    this.reconnectAttempts.set(channel.id, attempts + 1);
                    setTimeout(() => {
                        try {
                            console.log(`Attempting to rejoin channel ${channel.id}`);
                            connection.rejoin();
                        } catch (rejoinError) {
                            console.error(`Error rejoining channel ${channel.id}:`, rejoinError);
                            this.handleConnectionFailure(channel.id, connection, rejoinError);
                        }
                    }, this.RECONNECT_INTERVAL);
                } else {
                    console.log(`Max reconnection attempts reached for channel ${channel.id}`);
                    this.handleConnectionFailure(channel.id, connection, new Error('Max reconnection attempts reached'));
                }
            }
        });

        // Track connection state changes
        connection.on(VoiceConnectionStatus.Ready, () => {
            console.log(`Voice Connection ready in channel ${channel.id}`);
            this.reconnectAttempts.delete(channel.id);
            this.emit('connectionReady', { 
                channelId: channel.id,
                timestamp: new Date().toISOString()
            });
        });

        connection.on(VoiceConnectionStatus.Signalling, () => {
            console.log(`Voice Connection signalling in channel ${channel.id}`, {
                timestamp: new Date().toISOString()
            });
        });

        connection.on(VoiceConnectionStatus.Connecting, () => {
            console.log(`Voice Connection connecting in channel ${channel.id}`, {
                timestamp: new Date().toISOString()
            });
        });

        connection.on('error', (error) => {
            console.error(`Voice Connection error in channel ${channel.id}:`, {
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            this.emit('connectionError', { channelId: channel.id, error });
        });

        connection.on('stateChange', (oldState, newState) => {
            console.log(`Voice Connection state changed in channel ${channel.id}:`, {
                from: oldState.status,
                to: newState.status,
                timestamp: new Date().toISOString()
            });
        });

        this.connections.set(channel.id, connection);
        return connection;
    }

    handleConnectionFailure(channelId, connection, error) {
        console.error(`Connection failure in channel ${channelId}:`, error);
        connection.destroy();
        this.connections.delete(channelId);
        this.reconnectAttempts.delete(channelId);
        this.emit('connectionError', { 
            channelId, 
            error,
            timestamp: new Date().toISOString()
        });
    }

    async destroyConnection(channelId) {
        console.log(`Destroying voice connection for channel ${channelId}`);
        const connection = this.connections.get(channelId);
        if (connection) {
            try {
                // Cleanup any subscribers
                if (connection.receiver) {
                    console.log(`Cleaning up subscribers for channel ${channelId}`);
                    connection.receiver.subscriptions.forEach(sub => {
                        try {
                            sub.unsubscribe();
                        } catch (error) {
                            console.error(`Error unsubscribing in channel ${channelId}:`, error);
                        }
                    });
                }
                
                // Destroy the connection
                connection.destroy();
                console.log(`Connection destroyed for channel ${channelId}`);
            } catch (error) {
                console.error(`Error during connection cleanup for channel ${channelId}:`, error);
            } finally {
                this.connections.delete(channelId);
                this.reconnectAttempts.delete(channelId);
            }
        }
    }

    getConnection(channelId) {
        return this.connections.get(channelId);
    }
}

module.exports = VoiceConnectionService; 