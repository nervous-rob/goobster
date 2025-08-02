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
    const newVoiceId = interaction.options.getString('voice_id');

    try {
      // 1. Persist change to config.json
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(raw);

      if (!config.elevenlabs) {
        config.elevenlabs = {};
      }
      config.elevenlabs.voiceId = newVoiceId;

      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

      // 2. Update the running voice service (if ElevenLabs is enabled)
      if (voiceService && voiceService.tts) {
        voiceService.tts.voiceId = newVoiceId;
        if (voiceService.config && voiceService.config.elevenlabs) {
          voiceService.config.elevenlabs.voiceId = newVoiceId;
        }
      }

      await interaction.reply({
        content: `✅ ElevenLabs voice ID has been updated globally to \`${newVoiceId}\`. This will take effect immediately for all new TTS requests.`,
        ephemeral: true
      });
    } catch (error) {
      console.error('Failed to update ElevenLabs voice ID:', error);
      await interaction.reply({
        content: '❌ Failed to update the ElevenLabs voice ID. Please check the logs and try again.',
        ephemeral: true
      });
    }
  }
};