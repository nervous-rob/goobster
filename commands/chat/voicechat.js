const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const voiceSessionService = require('../../services/voice/voiceSessionService');
const { voiceService } = require('../../services/serviceManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('voicechat')
        .setDescription('Have a live voice conversation with Goobster in your voice channel.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('Goobster joins your voice channel and starts listening')
                .addStringOption(option =>
                    option.setName('mode')
                        .setDescription('When Goobster replies (default: polite)')
                        .addChoices(
                            { name: 'Polite - only when addressed or clearly needed', value: 'polite' },
                            { name: 'Open - replies to every turn', value: 'open' }
                        ))
                .addStringOption(option =>
                    option.setName('engine')
                        .setDescription('Voice pipeline (default: realtime)')
                        .addChoices(
                            { name: 'Realtime - low latency, interruptible (ElevenLabs STT+TTS)', value: 'realtime' },
                            { name: 'Classic - batch pipeline (OpenAI STT + ElevenLabs TTS)', value: 'classic' }
                        ))
                .addBooleanOption(option =>
                    option.setName('transcript')
                        .setDescription('Post a live transcript in this text channel (default: true)')))
        .addSubcommand(subcommand =>
            subcommand
                .setName('stop')
                .setDescription('End the voice conversation'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show whether a voice conversation is active')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (!interaction.guildId) {
            await interaction.reply({ content: 'Voice conversations only work in servers.', ephemeral: true });
            return;
        }

        if (subcommand === 'start') {
            await interaction.deferReply();

            const voiceChannel = interaction.member?.voice?.channel;
            if (!voiceChannel) {
                await interaction.editReply('❌ You need to be in a voice channel first.');
                return;
            }

            const permissions = voiceChannel.permissionsFor(interaction.client.user);
            if (!permissions?.has(PermissionFlagsBits.Connect) || !permissions?.has(PermissionFlagsBits.Speak)) {
                await interaction.editReply('❌ I need permission to connect and speak in your voice channel.');
                return;
            }

            try {
                await voiceService.initialize(); // no-op when already initialized

                if (!voiceService.tts) {
                    await interaction.editReply('❌ Voice conversations require ElevenLabs TTS (set ELEVENLABS_API_KEY).');
                    return;
                }

                const wantTranscript = interaction.options.getBoolean('transcript') ?? true;
                const mode = interaction.options.getString('mode') ?? 'polite';
                const engine = interaction.options.getString('engine') ?? 'realtime';
                const session = await voiceSessionService.startSession({
                    voiceChannel,
                    textChannel: wantTranscript ? interaction.channel : null,
                    client: interaction.client,
                    ttsService: voiceService.tts,
                    mode,
                    engine
                });

                const preferredName = session.botNames?.find(n => n !== 'goobster') || 'Goobster';
                const modeInfo = mode === 'polite'
                    ? `I'm in **polite mode**: I'll only chime in when you say my name ("${preferredName}"), when you're replying to me, or when it's clear you need me.`
                    : 'I\'m in **open mode**: I\'ll reply after every turn.';
                const engineInfo = engine === 'realtime'
                    ? 'Realtime engine: I reply fast, and you can just start talking to interrupt me.'
                    : 'Classic engine: I wait for a clear pause before replying.';

                await interaction.editReply(
                    `🎙️ **Voice conversation started in ${voiceChannel.name}!**\n\n` +
                    `${modeInfo}\n${engineInfo}\n` +
                    'You can also ask me to do things by voice: search the web, remember or forget facts, ' +
                    'change nicknames, generate images, or schedule follow-ups.\n' +
                    'Use `/voicechat stop` when you\'re done.'
                );
            } catch (error) {
                console.error('Failed to start voice session:', error);
                await interaction.editReply(`❌ ${error.message}`);
            }
        } else if (subcommand === 'stop') {
            const stopped = voiceSessionService.stopSession(interaction.guildId);
            await interaction.reply(stopped
                ? '👋 Voice conversation ended. That was fun!'
                : 'There\'s no active voice conversation in this server.');
        } else if (subcommand === 'status') {
            const session = voiceSessionService.getSession(interaction.guildId);
            await interaction.reply({
                content: session
                    ? `🎙️ Voice conversation active in **${session.voiceChannel.name}** (${session.mode} mode, ${session.engine} engine, ${session.history.length} turns so far).`
                    : 'No active voice conversation. Start one with `/voicechat start`.',
                ephemeral: true
            });
        }
    }
};
