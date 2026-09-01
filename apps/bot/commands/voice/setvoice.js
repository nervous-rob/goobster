const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getTtsVoice, setTtsVoice } = require('@goobster/core/utils/guildSettings');
const { getConversationScopeId } = require('@goobster/core/utils/dmScope');
const { voiceService } = require('@goobster/core/services/serviceManager');

module.exports = {
  // In a DM the voice is per-user (it also drives the web portal's voice
  // chat and read-aloud) - registered globally with DM contexts, see
  // deploy-commands.js.
  dmAllowed: true,
  data: new SlashCommandBuilder()
    .setName('setvoice')
    .setDescription('Configure the ElevenLabs voice Goobster speaks with in this server or DM')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Pick the voice used for this server (or your personal voice in DMs)')
        .addStringOption(option =>
          option.setName('voice')
            .setDescription('An ElevenLabs voice name (e.g. "Rachel") or voice ID')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('clear')
        .setDescription('Go back to the server default voice'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('Show the voice currently in use here')),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    // Guild id in servers, the user's DM scope in direct messages
    const scopeId = getConversationScopeId(interaction);
    const scopeLabel = interaction.guildId ? 'in this server' : 'for you (DMs and the web portal)';

    if (subcommand === 'view') {
      try {
        const voice = await getTtsVoice(scopeId);
        if (voice.voiceId) {
          await interaction.reply({
            content: `🎙️ Voice ${scopeLabel}: **${voice.voiceName || voice.voiceId}** (\`${voice.voiceId}\`).`,
            ephemeral: true
          });
        } else {
          const fallback = voiceService?.tts && !voiceService.tts.disabled
            ? ` The global default is **${voiceService.tts.voiceName || voiceService.tts.voiceId}**.`
            : '';
          await interaction.reply({
            content: `No custom voice is set ${scopeLabel} - Goobster uses the default voice.${fallback}`,
            ephemeral: true
          });
        }
      } catch (error) {
        console.error('Error reading TTS voice setting:', error);
        await interaction.reply({ content: '❌ Failed to read the voice setting.', ephemeral: true });
      }
      return;
    }

    if (subcommand === 'clear') {
      try {
        await setTtsVoice(scopeId, { voiceId: null, voiceName: null });
        await interaction.reply({
          content: `✅ Voice cleared ${scopeLabel} - back to the default voice.`,
          ephemeral: true
        });
      } catch (error) {
        console.error('Error clearing TTS voice setting:', error);
        await interaction.reply({ content: '❌ Failed to clear the voice setting.', ephemeral: true });
      }
      return;
    }

    // set
    const requestedVoice = interaction.options.getString('voice');
    if (!voiceService?.tts || voiceService.tts.disabled) {
      await interaction.reply({
        content: '❌ ElevenLabs TTS is not configured (set `ELEVENLABS_API_KEY`).',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    // Resolve the name/ID against the account's voice library so typos and
    // unavailable voices fail here, not at speak time.
    let resolved;
    try {
      resolved = await voiceService.tts.resolveVoice(requestedVoice);
    } catch (error) {
      await interaction.editReply(`❌ ${error.message}`);
      return;
    }

    try {
      await setTtsVoice(scopeId, { voiceId: resolved.id, voiceName: resolved.name });
      await interaction.editReply(
        `✅ Goobster now speaks with **${resolved.name || resolved.id}** (\`${resolved.id}\`) ${scopeLabel}. ` +
        'This applies to voice chat and read-aloud immediately.'
      );
    } catch (error) {
      console.error('Failed to save the TTS voice setting:', error);
      await interaction.editReply('❌ Failed to save the voice setting. Please check the logs and try again.');
    }
  }
};
