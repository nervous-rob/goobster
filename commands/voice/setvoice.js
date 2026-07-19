const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { voiceService } = require('../../services/serviceManager');

const CONFIG_PATH = path.resolve(__dirname, '../../config.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setvoice')
    .setDescription('Globally set the ElevenLabs voice ID used for TTS across all servers')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option.setName('voice_id')
        .setDescription('The ElevenLabs voice ID to use (e.g., "Rachel" or a UUID)')
        .setRequired(true)
    ),

  async execute(interaction) {
    const requestedVoice = interaction.options.getString('voice_id');

    if (!voiceService?.tts) {
      await interaction.reply({
        content: '❌ ElevenLabs TTS is not configured (set `ELEVENLABS_API_KEY`).',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    // 1. Resolve the name/ID against the account's voice library so typos
    //    and unavailable voices fail here, not at speak time.
    let resolved;
    try {
      resolved = await voiceService.tts.resolveVoice(requestedVoice);
    } catch (error) {
      await interaction.editReply(`❌ ${error.message}`);
      return;
    }

    try {
      // 2. Persist the resolved ID (+ display name) to config.json
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(raw);

      if (!config.elevenlabs) {
        config.elevenlabs = {};
      }
      config.elevenlabs.voiceId = resolved.id;
      config.elevenlabs.voiceName = resolved.name;

      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

      // 3. Update the running voice service
      voiceService.tts.voiceId = resolved.id;
      voiceService.tts.voiceName = resolved.name;
      if (voiceService.config && voiceService.config.elevenlabs) {
        voiceService.config.elevenlabs.voiceId = resolved.id;
        voiceService.config.elevenlabs.voiceName = resolved.name;
      }

      await interaction.editReply(
        `✅ ElevenLabs voice has been updated globally to **${resolved.name || resolved.id}** (\`${resolved.id}\`). This will take effect immediately for all new TTS requests.`
      );
    } catch (error) {
      console.error('Failed to update ElevenLabs voice ID:', error);
      await interaction.editReply('❌ Failed to update the ElevenLabs voice ID. Please check the logs and try again.');
    }
  }
};