const { SlashCommandBuilder } = require('discord.js');
const MusicService = require('../../services/voice/musicService');
const config = require('../../config.json');
const path = require('path');
const fs = require('fs').promises;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('generateallmusic')
        .setDescription('Generate and cache music for all moods (Admin only)')
        .addBooleanOption(option =>
            option.setName('force')
                .setDescription('Force regeneration even if files exist')
                .setRequired(false)),

    async execute(interaction) {
        // Check if user has admin permission
        if (!interaction.member.permissions.has('ADMINISTRATOR')) {
            await interaction.reply({ content: 'This command is only available to administrators.', ephemeral: true });
            return;
        }

        await interaction.deferReply();

        const force = interaction.options.getBoolean('force') || false;
        
        try {
            // Verify config has required properties before creating service
            if (!config?.replicate?.apiKey) {
                await interaction.editReply(`Error: Replicate API key is missing from the configuration.\n\nDebug info: Config has replicate object: ${config.replicate ? 'Yes' : 'No'}`);
                console.error('Missing Replicate API key in config. Config structure:', JSON.stringify({
                    hasReplicate: !!config.replicate,
                    hasReplicateApiKey: !!(config.replicate && config.replicate.apiKey)
                }));
                return;
            }
            
            const musicService = new MusicService(config);
            const moods = Object.keys(musicService.getMoodMap());
            
            await interaction.editReply(`Starting generation of ${moods.length} mood tracks...`);
            
            let successCount = 0;
            let failCount = 0;
            let skipCount = 0;
            
            for (const mood of moods) {
                try {
                    const exists = await musicService.doesMoodMusicExist(mood);
                    if (exists && !force) {
                        skipCount++;
                        await interaction.editReply(
                            `Generating mood tracks... ${successCount} completed, ${failCount} failed, ${skipCount} skipped\n` +
                            `Current: Skipped ${mood} (already exists)`
                        );
                        continue;
                    }

                    await interaction.editReply(
                        `Generating mood tracks... ${successCount} completed, ${failCount} failed, ${skipCount} skipped\n` +
                        `Current: Generating ${mood}...`
                    );

                    await musicService.generateAndCacheMoodMusic(mood);
                    successCount++;

                } catch (error) {
                    console.error(`Error generating music for mood ${mood}:`, error);
                    failCount++;
                }

                await interaction.editReply(
                    `Generating mood tracks... ${successCount} completed, ${failCount} failed, ${skipCount} skipped\n` +
                    `Current: Finished ${mood}`
                );
            }

            const finalMessage = 
                `Music generation complete!\n` +
                `✅ Successfully generated: ${successCount}\n` +
                `⏭️ Skipped (already exists): ${skipCount}\n` +
                `❌ Failed: ${failCount}`;

            await interaction.editReply(finalMessage);
        } catch (error) {
            console.error('Error in generateallmusic command:', error);
            await interaction.editReply(`Error: ${error.message}\n\nDebug info: Replicate API key available in config: ${config.replicate?.apiKey ? 'Yes (key length: ' + config.replicate.apiKey.length + ')' : 'No'}`);
        }
    },
}; 