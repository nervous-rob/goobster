const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionFlagsBits } = require('discord.js');
const { voiceService } = require('../../services/serviceManager');
const VoiceSessionManager = require('../../services/voice/voiceSessionManager');

// In-memory registry of active sessions per guild
const activeSessions = new Map(); // guildId -> VoiceSessionManager

module.exports = {
    data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Start or stop interactive voice chat with the bot')
        .addSubcommand(sub =>
            sub.setName('start')
                .setDescription('Begin voice interaction in your current channel'))
        .addSubcommand(sub =>
            sub.setName('stop')
                .setDescription('Stop voice interaction and make the bot leave'))
        .setDefaultMemberPermissions(null)
        .setDMPermission(false),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        // Validate user is in a voice channel when starting
        if (sub === 'start') {
            const userChannel = interaction.member.voice.channel;
            if (!userChannel) {
                return interaction.reply({ content: '❌ You must be in a voice channel first.', ephemeral: true });
            }

            if (activeSessions.has(guildId)) {
                return interaction.reply({ content: '⚠️ A voice session is already running in this server.', ephemeral: true });
            }

            await interaction.deferReply();
            try {
                const session = new VoiceSessionManager(userChannel, voiceService, require('../../config.json'));
                activeSessions.set(guildId, session);
                session.on('stopped', () => activeSessions.delete(guildId));
                await session.start();

                await interaction.editReply('🎙️ Voice interaction started! Speak and I will reply. Use `/voice stop` to end.');
            } catch (err) {
                console.error('[voice command] Failed to start session:', err);
                activeSessions.delete(guildId);
                await interaction.editReply('❌ Failed to start voice session. Check logs.');
            }
            return;
        }

        if (sub === 'stop') {
            const session = activeSessions.get(guildId);
            if (!session) {
                return interaction.reply({ content: 'There is no active voice session.', ephemeral: true });
            }
            await interaction.deferReply();
            await session.stop();
            activeSessions.delete(guildId);
            await interaction.editReply('🛑 Voice interaction stopped.');
            return;
        }
    }
}; 