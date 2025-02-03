const { SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const AmbientService = require('../../services/voice/ambientService');
const config = require('../../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playambience')
        .setDescription('Play ambient sound effects')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('The type of ambient sound to play')
                .setRequired(true)
                .addChoices(
                    { name: 'Forest', value: 'forest' },
                    { name: 'Cave', value: 'cave' },
                    { name: 'Tavern', value: 'tavern' },
                    { name: 'Ocean', value: 'ocean' },
                    { name: 'City', value: 'city' },
                    { name: 'Dungeon', value: 'dungeon' },
                    { name: 'Camp', value: 'camp' },
                    { name: 'Storm', value: 'storm' }
                ))
        .addNumberOption(option =>
            option.setName('volume')
                .setDescription('Volume of the ambient sound (0.1 to 1.0)')
                .setRequired(false)
                .setMinValue(0.1)
                .setMaxValue(1.0)),

    async execute(interaction) {
        try {
            await interaction.deferReply();

            // Check if user is in a voice channel
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.editReply('You need to be in a voice channel to play ambient sounds!');
                return;
            }

            // Check bot permissions
            const permissions = voiceChannel.permissionsFor(interaction.client.user);
            if (!permissions.has('Connect') || !permissions.has('Speak')) {
                await interaction.editReply('I need permissions to join and speak in your voice channel!');
                return;
            }

            // Initialize ambient service
            const ambientService = new AmbientService(config);

            // Create voice connection
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false
            });

            try {
                // Wait for connection to be ready
                await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

                // Get the selected type and volume
                const type = interaction.options.getString('type');
                const volume = interaction.options.getNumber('volume') ?? 0.3;

                await interaction.editReply(`🎧 Loading ${type} ambient sounds...`);

                // Check if ambience exists in cache
                const exists = await ambientService.doesAmbienceExist(type);
                if (!exists) {
                    await interaction.editReply(`🎧 Generating ${type} ambient sounds for the first time... This may take a few minutes.`);
                }

                // Play the ambience
                const resource = await ambientService.playAmbience(type, connection, volume);

                if (resource) {
                    await interaction.editReply(
                        `🎧 Now playing ${type} ambient sounds! ` +
                        `Use \`/stopambience\` to stop.`
                    );

                    // Set up cleanup when the bot is disconnected
                    connection.on(VoiceConnectionStatus.Disconnected, async () => {
                        try {
                            await Promise.race([
                                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                            ]);
                            // Seems to be reconnecting to a new channel - ignore disconnect
                        } catch (error) {
                            // Seems to be a real disconnect which SHOULDN'T be recovered from
                            connection.destroy();
                            ambientService.stopAmbience();
                        }
                    });
                } else {
                    await interaction.editReply('Failed to play ambient sounds. Please try again.');
                    connection.destroy();
                }
            } catch (error) {
                console.error('Error playing ambient sounds:', error);
                await interaction.editReply('Failed to play ambient sounds. Please try again.');
                connection.destroy();
            }
        } catch (error) {
            console.error('Error in playambience command:', error);
            try {
                await interaction.editReply('An error occurred while executing the command.');
            } catch (replyError) {
                console.error('Failed to send error message:', replyError);
            }
        }
    },
}; 