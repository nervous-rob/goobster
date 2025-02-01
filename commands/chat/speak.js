const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionFlagsBits } = require('discord.js');
const TTSService = require('../../services/voice/ttsService');
const { joinVoiceChannel } = require('@discordjs/voice');
const config = require('../../config.json');

// Initialize TTS service
const ttsService = new TTSService(config);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('speak')
        .setDescription('Convert text to speech and play it in your voice channel')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('The text to convert to speech')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(null)
        .setDMPermission(false),

    async execute(interaction) {
        try {
            await interaction.deferReply();

            // Check if user is in a voice channel
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                return await interaction.editReply('You need to be in a voice channel to use this command.');
            }

            // Check bot permissions
            const permissions = voiceChannel.permissionsFor(interaction.client.user);
            if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
                return await interaction.editReply('I need permissions to join and speak in your voice channel.');
            }

            // Get the message text
            const messageText = interaction.options.getString('message');

            // Create voice connection
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false
            });

            // Generate and play TTS
            await ttsService.textToSpeech(messageText, voiceChannel, connection);

            await interaction.editReply('Speaking your message...');

        } catch (error) {
            console.error('Error in speak command:', error);
            if (interaction.deferred) {
                await interaction.editReply('Failed to speak the message. Please try again.');
            } else {
                await interaction.reply({
                    content: 'Failed to speak the message. Please try again.',
                    ephemeral: true
                });
            }
        }
    }
}; 