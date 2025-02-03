const { SlashCommandBuilder } = require('discord.js');
const MusicService = require('../../services/voice/musicService');
const config = require('../../config');
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
    },
}; 