const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const SpotDLService = require('../../services/spotdl/spotdlService');

const spotdlService = new SpotDLService();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('spotdl')
        .setDescription('Download and manage Spotify tracks')
        .addSubcommand(subcommand =>
            subcommand
                .setName('download')
                .setDescription('Download a track from Spotify')
                .addStringOption(option =>
                    option.setName('url')
                        .setDescription('Spotify track, playlist, or album URL')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all downloaded tracks'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Delete a downloaded track')
                .addStringOption(option =>
                    option.setName('track')
                        .setDescription('Name of the track to delete')
                        .setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (subcommand) {
                case 'download': {
                    await interaction.deferReply();
                    const url = interaction.options.getString('url');
                    
                    try {
                        const result = await spotdlService.downloadTrack(url);
                        
                        const embed = new EmbedBuilder()
                            .setColor('#00ff00')
                            .setTitle('Track Downloaded')
                            .setDescription(`Successfully downloaded: ${result.name}`)
                            .setTimestamp();
                        
                        await interaction.editReply({ embeds: [embed] });
                    } catch (error) {
                        // Handle rate limit specifically
                        if (error.message.includes('rate limit')) {
                            const embed = new EmbedBuilder()
                                .setColor('#ff9900')
                                .setTitle('Rate Limit Reached')
                                .setDescription('Spotify API rate limit reached. Please try again in a few minutes.')
                                .setTimestamp();
                            
                            await interaction.editReply({ embeds: [embed], ephemeral: true });
                            return;
                        }
                        throw error;
                    }
                    break;
                }

                case 'list': {
                    await interaction.deferReply();
                    const tracks = await spotdlService.listTracks();
                    
                    if (tracks.length === 0) {
                        await interaction.editReply('No tracks found.');
                        return;
                    }

                    const embed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Downloaded Tracks')
                        .setDescription(tracks.map((track, index) => 
                            `${index + 1}. ${track.name} (Added: ${new Date(track.lastModified).toLocaleDateString()})`
                        ).join('\n'))
                        .setTimestamp();
                    
                    await interaction.editReply({ embeds: [embed] });
                    break;
                }

                case 'delete': {
                    await interaction.deferReply();
                    const trackName = interaction.options.getString('track');
                    
                    await spotdlService.deleteTrack(trackName);
                    
                    const embed = new EmbedBuilder()
                        .setColor('#ff0000')
                        .setTitle('Track Deleted')
                        .setDescription(`Successfully deleted: ${trackName}`)
                        .setTimestamp();
                    
                    await interaction.editReply({ embeds: [embed] });
                    break;
                }
            }
        } catch (error) {
            console.error('SpotDL command error:', error);
            const errorMessage = error.message || 'An error occurred while processing your request.';
            
            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('Error')
                .setDescription(`❌ ${errorMessage}`)
                .setTimestamp();
            
            if (interaction.deferred) {
                await interaction.editReply({ embeds: [embed], ephemeral: true });
            } else {
                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
        }
    },
}; 