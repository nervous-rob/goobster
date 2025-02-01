const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionFlagsBits, ThreadAutoArchiveDuration, ChannelType } = require('discord.js');
const VoiceService = require('../../services/voice');
const config = require('../../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('transcribe')
        .setDescription('Start or stop transcribing voice to text')
        .addBooleanOption(option =>
            option.setName('enabled')
                .setDescription('Enable or disable transcription')
                .setRequired(true))
        .setDefaultMemberPermissions(null)
        .setDMPermission(false),

    voiceService: null, // Will be initialized on first use

    async execute(interaction) {
        try {
            await interaction.deferReply();
            const enabled = interaction.options.getBoolean('enabled');

            // Initialize voice service if needed
            if (!this.voiceService) {
                try {
                    console.log('Initializing voice service...');
                    this.voiceService = new VoiceService({
                        azure: config.azure,
                        debug: true,
                        audio: {
                            // Add hysteresis thresholds from analysis
                            voiceThreshold: -35,
                            silenceThreshold: -45,
                            voiceReleaseThreshold: -40,
                            silenceDuration: 300
                        }
                    });

                    // Store textChannel reference for event handlers
                    let activeTextChannel = null;

                    // Update the startListening call to store the channel
                    const originalStartListening = this.voiceService.startListening.bind(this.voiceService);
                    this.voiceService.startListening = async (voiceChannel, user, messageCallback, textChannel) => {
                        activeTextChannel = textChannel;
                        return await originalStartListening(voiceChannel, user, messageCallback, textChannel);
                    };

                    this.voiceService.on('stateChange', async ({ userId, oldState, newState }) => {
                        console.log('Voice state change:', {
                            userId,
                            from: oldState,
                            to: newState,
                            timestamp: new Date().toISOString()
                        });

                        // Handle state transitions
                        if (newState === 'error') {
                            try {
                                await this.voiceService.stopListening(userId);
                                const user = await interaction.client.users.fetch(userId);
                                if (user) {
                                    await user.send('Voice transcription stopped due to an error. Please try again.').catch(() => {});
                                }
                            } catch (error) {
                                console.error('Error handling error state:', error);
                            }
                        }
                    });

                    this.voiceService.on('recognized', async ({ userId, text, confidence }) => {
                        console.log('Recognition event:', {
                            userId,
                            text,
                            confidence,
                            timestamp: new Date().toISOString()
                        });

                        if (!activeTextChannel) {
                            console.error('No active text channel found for transcription');
                            return;
                        }

                        try {
                            const thread = await getOrCreateTranscriptionThread(activeTextChannel, userId);
                            // Only send messages with sufficient confidence
                            if (confidence >= 0.6) {
                                await thread.send(`<@${userId}>: ${text}`);
                            } else {
                                console.log('Low confidence recognition ignored:', {
                                    confidence,
                                    text
                                });
                            }
                        } catch (error) {
                            console.error('Error sending recognized text:', error);
                            this.emit('transcriptionError', { userId, error });
                        }
                    });

                    // Add more detailed error handling
                    this.voiceService.on('recognizing', ({ userId, text }) => {
                        console.log(`Interim recognition for ${userId}: ${text}`);
                    });

                    // Add error handling for the pipeline
                    this.voiceService.on('pipelineError', ({ userId, error }) => {
                        console.error('Pipeline error:', error);
                    });

                    this.voiceService.on('streamError', ({ userId, error }) => {
                        console.error('Stream error:', error);
                    });

                    // Add voice activity monitoring
                    this.voiceService.on('voiceActivity', ({ userId, level }) => {
                        console.log('Voice activity:', {
                            userId,
                            level,
                            timestamp: new Date().toISOString()
                        });
                        
                        // Update session activity timestamp
                        this.voiceService.sessionManager.updateSessionActivity(userId);
                    });

                    // Add enhanced error recovery
                    this.voiceService.on('recognitionError', async ({ userId, error }) => {
                        console.error('Recognition error:', {
                            userId,
                            error: error.message,
                            stack: error.stack,
                            timestamp: new Date().toISOString()
                        });

                        try {
                            // Attempt to recover the recognition service
                            await this.voiceService.handleRecognitionError(userId);
                        } catch (recoveryError) {
                            console.error('Recovery failed:', recoveryError);
                            // If recovery fails, stop the session
                            await this.voiceService.stopListening(userId);
                        }
                    });

                    // Set up error handling for voice service
                    this.voiceService.on('voiceError', async ({ userId, error }) => {
                        console.error('Voice service error:', {
                            userId,
                            error: error.message,
                            stack: error.stack,
                            timestamp: new Date().toISOString()
                        });
                        try {
                            // Stop monitoring before cleanup
                            this.voiceService.sessionManager.clearMonitoring(userId);
                            await this.voiceService.stopListening(userId);
                            const user = await interaction.client.users.fetch(userId);
                            if (user) {
                                await user.send('Voice transcription stopped due to an error. Please try again.').catch(() => {});
                            }
                        } catch (stopError) {
                            console.error('Error stopping voice service after error:', stopError);
                        }
                    });

                    this.voiceService.on('noAudioWarning', async ({ userId }) => {
                        try {
                            const user = await interaction.client.users.fetch(userId);
                            if (user) {
                                await user.send('No audio detected for a while. Please check your microphone.').catch(() => {});
                            }
                        } catch (error) {
                            console.error('Error sending no audio warning:', error);
                        }
                    });

                    // Add session timeout handling
                    this.voiceService.sessionManager.startSessionMonitoring();

                    this.voiceService.sessionManager.on('sessionTimeout', async ({ userId }) => {
                        console.log('Session timeout detected:', {
                            userId,
                            timestamp: new Date().toISOString()
                        });
                        try {
                            await this.voiceService.stopListening(userId);
                            const user = await interaction.client.users.fetch(userId);
                            if (user) {
                                await user.send('Voice transcription stopped due to inactivity.').catch(() => {});
                            }
                        } catch (error) {
                            console.error('Error handling session timeout:', error);
                        }
                    });

                    // Add audio level logging
                    this.voiceService.on('audioLevel', ({ userId, level }) => {
                        // Log every 1 second to avoid spam
                        const now = Date.now();
                        if (!this._lastLevelLog || now - this._lastLevelLog > 1000) {
                            console.log('Audio level:', {
                                userId,
                                level,
                                threshold: -40,
                                timestamp: new Date().toISOString()
                            });
                            this._lastLevelLog = now;
                        }
                    });

                    // Update the log message to be more specific
                    console.log('Voice command service setup complete');
                } catch (error) {
                    console.error('Failed to initialize voice service:', error);
                    await interaction.editReply('Failed to initialize voice service. Please try again later.');
                    return;
                }
            }

            if (!enabled) {
                try {
                    await this.voiceService.stopListening(interaction.user.id);
                    await interaction.editReply('Transcription stopped.');
                    return;
                } catch (error) {
                    console.error('Error stopping transcription:', error);
                    await interaction.editReply('Failed to stop transcription properly. Please try again.');
                    return;
                }
            }

            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                return await interaction.editReply('You need to be in a voice channel to use this command.');
            }

            // Check if user is already being transcribed
            if (this.voiceService.sessionManager.isUserInSession(interaction.user.id)) {
                return await interaction.editReply('You already have an active transcription session. Stop it first before starting a new one.');
            }

            // Try to find the general channel first, then fall back to command channel
            let textChannel = interaction.guild.channels.cache
                .find(channel => 
                    channel.name.toLowerCase() === 'general' && 
                    channel.isTextBased() && 
                    !channel.isVoiceBased() && 
                    channel.type === ChannelType.GuildText
                );

            // If no general channel found, use the command's channel if it's suitable
            if (!textChannel) {
                if (interaction.channel.isTextBased() && 
                    !interaction.channel.isVoiceBased() && 
                    interaction.channel.type === ChannelType.GuildText) {
                    textChannel = interaction.channel;
                } else {
                    return await interaction.editReply('Please use this command in a text channel that supports threads.');
                }
            }

            // Check voice permissions
            const voicePermissions = voiceChannel.permissionsFor(interaction.client.user);
            if (!voicePermissions.has(PermissionFlagsBits.Connect) || !voicePermissions.has(PermissionFlagsBits.Speak)) {
                return await interaction.editReply('I need permissions to join and speak in your voice channel.');
            }

            // Check text channel permissions
            const textPermissions = textChannel.permissionsFor(interaction.client.user);
            if (!textPermissions.has(PermissionFlagsBits.CreatePrivateThreads) || 
                !textPermissions.has(PermissionFlagsBits.SendMessagesInThreads)) {
                return await interaction.editReply('I need permissions to create and send messages in private threads in the text channel.');
            }

            try {
                // Get or create thread with timeout
                const threadPromise = getOrCreateTranscriptionThread(textChannel, interaction.user.id);
                const thread = await Promise.race([
                    threadPromise,
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Thread creation timed out')), 10000)
                    )
                ]);
                
                try {
                    // Start transcription with timeouts on operations
                    await this.voiceService.startListening(
                        voiceChannel,
                        interaction.user,
                        async (text) => {
                            if (text.trim()) {
                                try {
                                    await Promise.race([
                                        thread.send(`${interaction.user}: ${text}`),
                                        new Promise((_, reject) => 
                                            setTimeout(() => reject(new Error('Message send timed out')), 5000)
                                        )
                                    ]);
                                    // No response needed for transcription
                                    return null;
                                } catch (error) {
                                    console.error('Error sending transcription:', {
                                        error: error.message,
                                        userId: interaction.user.id,
                                        timestamp: new Date().toISOString()
                                    });
                                    this.emit('transcriptionError', { 
                                        userId: interaction.user.id, 
                                        error 
                                    });
                                }
                            }
                        },
                        textChannel,
                        {
                            // Add enhanced voice detection options
                            voiceDetection: {
                                useHysteresis: true,
                                voiceThreshold: -35,
                                silenceThreshold: -45,
                                voiceReleaseThreshold: -40,
                                silenceDuration: 300,
                                minVoiceDuration: 250
                            },
                            // Add recognition options
                            recognition: {
                                continuous: true,
                                punctuation: true,
                                profanityFilter: true,
                                maxAlternatives: 1
                            }
                        }
                    );

                    await interaction.editReply(`Transcription started! Check the thread in ${textChannel} for transcriptions.`);

                } catch (error) {
                    console.error('Error in voice connection:', {
                        error: error.message,
                        stack: error.stack,
                        userId: interaction.user.id,
                        timestamp: new Date().toISOString()
                    });
                    
                    // Enhanced cleanup
                    await this.voiceService.stopListening(interaction.user.id);
                    
                    // Provide specific error messages
                    if (error.message.includes('Voice connection timeout')) {
                        await interaction.editReply('Failed to establish voice connection. Please try again.');
                    } else if (error.message.includes('voice connection')) {
                        await interaction.editReply('Failed to join voice channel. Please check permissions and try again.');
                    } else {
                        await interaction.editReply('Failed to start transcription. Please try again.');
                    }
                    throw error;
                }

            } catch (error) {
                console.error('Error starting transcription:', error);
                
                // Clean up any partial setup
                try {
                    await this.voiceService.stopListening(interaction.user.id);
                } catch (cleanupError) {
                    console.error('Error during cleanup:', cleanupError);
                }

                if (error.message.includes('thread')) {
                    await interaction.editReply('Failed to create or access the transcription thread. Please make sure I have the correct permissions.');
                } else if (error.message.includes('voice')) {
                    await interaction.editReply('Failed to join voice channel. Please make sure I have the correct permissions and try again.');
                } else {
                    await interaction.editReply('Failed to start transcription. Please try again.');
                }
            }

        } catch (error) {
            console.error('Error in transcribe command:', error);
            try {
                // Ensure we clean up on any error
                if (this.voiceService) {
                    await this.voiceService.stopListening(interaction.user.id);
                }
            } catch (cleanupError) {
                console.error('Error during cleanup:', cleanupError);
            }

            if (interaction.deferred) {
                await interaction.editReply('An error occurred while processing the transcribe command.');
            } else {
                await interaction.reply({
                    content: 'An error occurred while processing the transcribe command.',
                    ephemeral: true
                });
            }
        }
    }
};

async function getOrCreateTranscriptionThread(channel, userId) {
    const threadName = `Voice Transcription - ${userId}`;
    
    try {
        // First check cache for active threads
        let thread = channel.threads.cache.find(t => 
            t.name === threadName && 
            !t.archived
        );

        // If not in cache, fetch all threads including archived ones
        if (!thread) {
            const fetchedThreads = await channel.threads.fetch();
            thread = fetchedThreads.threads.find(t => t.name === threadName);
        }

        if (thread) {
            console.log('Found existing transcription thread:', {
                threadId: thread.id,
                userId,
                archived: thread.archived,
                timestamp: new Date().toISOString()
            });

            // If thread exists but is archived, unarchive it
            if (thread.archived) {
                console.log('Unarchiving existing thread:', thread.id);
                await thread.setArchived(false);
            }

            // Ensure thread is active and accessible
            try {
                await thread.send('Resuming voice transcription session...');
            } catch (error) {
                console.error('Error accessing thread, creating new one:', error);
                // If we can't access the thread, create a new one
                return await createNewThread();
            }

            return thread;
        }

        // Create new thread if none exists
        return await createNewThread();

    } catch (error) {
        console.error('Error in getOrCreateTranscriptionThread:', {
            error: error.message,
            userId,
            channelId: channel.id,
            timestamp: new Date().toISOString()
        });
        throw error;
    }

    async function createNewThread() {
        console.log('Creating new transcription thread for user:', userId);
        return await channel.threads.create({
            name: threadName,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
            reason: 'Voice transcription session',
            type: ChannelType.PrivateThread
        });
    }
} 