const { SlashCommandBuilder } = require('discord.js');
const worldService = require('../../services/tavern/worldService');
const views = require('../../utils/tavernViews');
const usageTracker = require('../../services/usageTracker');

/**
 * The Map Room: the shared world record this server's adventures have
 * written - locations, factions, events, artifacts, and figures.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('world')
        .setDescription('The living shared world your adventures have written.')
        .addSubcommand(sub =>
            sub.setName('map')
                .setDescription('The Map Room: everything this server has discovered'))
        .addSubcommand(sub =>
            sub.setName('lore')
                .setDescription('Read one lore entry in full')
                .addStringOption(opt =>
                    opt.setName('name').setDescription('Which entry').setRequired(true).setAutocomplete(true))),

    async autocomplete(interaction) {
        if (!interaction.guildId) {
            await interaction.respond([]);
            return;
        }
        const names = worldService.listLoreNames(interaction.guildId, interaction.options.getFocused());
        await interaction.respond(names.map(name => ({ name, value: name })));
    },

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'The shared world lives inside servers.', ephemeral: true });
            return;
        }
        const guildId = interaction.guildId;
        const subcommand = interaction.options.getSubcommand();
        usageTracker.logCommand({ command: 'world', guildId, userId: interaction.user.id });

        try {
            if (subcommand === 'map') {
                await interaction.reply({ embeds: [views.worldEmbed(worldService.getWorld(guildId), interaction.guild?.name)] });
            } else if (subcommand === 'lore') {
                const lore = worldService.getLore(guildId, interaction.options.getString('name'));
                if (!lore) {
                    await interaction.reply({ content: 'The cartographer\'s ghost finds no such entry. `/world map` shows what is known.', ephemeral: true });
                    return;
                }
                await interaction.reply({ embeds: [views.loreEmbed(lore)] });
            }
        } catch (error) {
            console.error('World command error:', error);
            const message = '❌ The Map Room hit a snag.';
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(message);
            } else {
                await interaction.reply({ content: message, ephemeral: true });
            }
        }
    }
};
