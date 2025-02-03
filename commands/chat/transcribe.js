// TODO: Add proper handling for transcription timeouts
// TODO: Add proper handling for voice connection failures
// TODO: Add proper handling for transcription errors
// TODO: Add proper handling for thread management
// TODO: Add proper handling for permission validation
// TODO: Add proper handling for session cleanup
// TODO: Add proper handling for concurrent transcriptions
// TODO: Add proper handling for rate limiting
// TODO: Add proper handling for audio quality issues
// TODO: Add proper handling for language detection

const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionFlagsBits, ThreadAutoArchiveDuration, ChannelType } = require('discord.js');
const VoiceService = require('../../services/voice');
const config = require('../../config.json');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');

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

    async execute(interaction, voiceService) {
        if (!voiceService) {
            return await interaction.reply({ 
                content: 'Voice service is not initialized. Please try again later.',
                ephemeral: true 
            });
        }

        try {
            await interaction.deferReply();
            const enabled = interaction.options.getBoolean('enabled');

            if (!enabled) {
                try {
                    // Remove recognition event listener
                    const session = voiceService.sessionManager.getSession(interaction.user.id);
                    if (session && session.recognitionHandler) {
                        voiceService.removeListener('messageReceived', session.recognitionHandler);
                    }
                    
                    await voiceService.stopListening(interaction.user.id);
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
            if (voiceService.sessionManager.isUserInSession(interaction.user.id)) {
                return await interaction.editReply('You already have an active transcription session. Stop it first before starting a new one.');
            }

            // Find appropriate text channel
            let textChannel = interaction.guild.channels.cache
                .find(channel => 
                    channel.name.toLowerCase() === 'general' && 
                    channel.isTextBased() && 
                    !channel.isVoiceBased() && 
                    channel.type === ChannelType.GuildText
                ) || interaction.channel;

            // Check permissions
            const voicePermissions = voiceChannel.permissionsFor(interaction.client.user);
            const textPermissions = textChannel.permissionsFor(interaction.client.user);

            if (!voicePermissions.has(PermissionFlagsBits.Connect) || !voicePermissions.has(PermissionFlagsBits.Speak)) {
                return await interaction.editReply('I need permissions to join and speak in your voice channel.');
            }

            if (!textPermissions.has(PermissionFlagsBits.CreatePrivateThreads) || 
                !textPermissions.has(PermissionFlagsBits.SendMessagesInThreads)) {
                return await interaction.editReply('I need permissions to create and send messages in private threads in the text channel.');
            }

            try {
                // Join voice channel
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: voiceChannel.guild.id,
                    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                    selfDeaf: false
                });

                // Wait for connection to be ready
                try {
                    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
                    console.log('Voice connection ready:', {
                        channelId: voiceChannel.id,
                        guildId: voiceChannel.guild.id,
                        timestamp: new Date().toISOString()
                    });
                } catch (error) {
                    console.error('Failed to establish voice connection:', error);
                    connection.destroy();
                    throw error;
                }

                // Create transcription thread first
                const thread = await getOrCreateTranscriptionThread(textChannel, interaction.user.id);
                await thread.send('Voice transcription started. Speak clearly and I\'ll transcribe your words here!');

                // Add recognition event handler
                const recognitionHandler = async ({ userId, text, confidence }) => {
                    if (userId === interaction.user.id && text && confidence > 0.5) {
                        try {
                            await thread.send(`🎤 ${text}`);
                        } catch (error) {
                            console.error('Error sending transcription to thread:', error);
                        }
                    }
                };
                voiceService.on('messageReceived', recognitionHandler);

                // Store session with text channel and recognition handler
                voiceService.sessionManager.addSession(interaction.user.id, {
                    connection,
                    channelId: voiceChannel.id,
                    guildId: voiceChannel.guild.id,
                    textChannel,
                    interaction,
                    recognitionHandler,
                    thread // Store thread reference in session
                });

                // Start voice recognition AFTER setting up handlers
                await voiceService.startListening(voiceChannel, interaction.user.id);

                // Set up connection state monitoring
                connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    try {
                        await Promise.race([
                            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                        ]);
                    } catch (error) {
                        console.error('Failed to reconnect:', error);
                        await voiceService.handleError(interaction.user.id, error);
                    }
                });

                connection.on(VoiceConnectionStatus.Destroyed, async () => {
                    console.log('Voice connection destroyed:', {
                        userId: interaction.user.id,
                        channelId: voiceChannel.id,
                        timestamp: new Date().toISOString()
                    });
                    await voiceService.stopListening(interaction.user.id);
                });

                await interaction.editReply(`Transcription started! Check ${thread} for your transcriptions.`);

            } catch (error) {
                console.error('Error starting transcription:', error);
                
                // Clean up any partial setup
                try {
                    await voiceService.stopListening(interaction.user.id);
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
                if (voiceService) {
                    await voiceService.stopListening(interaction.user.id);
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