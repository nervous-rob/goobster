const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const tavernService = require('../../services/tavern/tavernService');
const questLoader = require('../../services/tavern/questLoader');
const { NPCS } = require('../../services/tavern/content');
const views = require('../../utils/tavernViews');
const usageTracker = require('../../services/usageTracker');

/**
 * The Goobster Tavern's Common Room: the status embed (daily rumor, NPCs,
 * quest board summary, open parties), the full quest board, NPC cards,
 * member profiles, and the admin campaign reload.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('tavern')
        .setDescription('The Goobster Tavern - a magical inn between worlds.')
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Step into the Common Room: rumors, quests, and who\'s around'))
        .addSubcommand(sub =>
            sub.setName('board')
                .setDescription('Read the full Quest Board'))
        .addSubcommand(sub =>
            sub.setName('rumor')
                .setDescription('Today\'s rumor, fresh from the bar'))
        .addSubcommand(sub =>
            sub.setName('npc')
                .setDescription('Chat up one of the Tavern\'s residents')
                .addStringOption(opt =>
                    opt.setName('name').setDescription('Who to talk to').setRequired(true)
                        .addChoices(...Object.values(NPCS).map(npc => ({ name: npc.name, value: npc.key })))))
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription('A member\'s tavern profile (their character and trophies)')
                .addUserOption(opt => opt.setName('user').setDescription('Whose profile (default: you)')))
        .addSubcommand(sub =>
            sub.setName('reload-quests')
                .setDescription('Reload campaign YAML files from disk (Manage Server)')),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'The Tavern only manifests inside servers.', ephemeral: true });
            return;
        }
        const guildId = interaction.guildId;
        const subcommand = interaction.options.getSubcommand();
        usageTracker.logCommand({ command: 'tavern', guildId, userId: interaction.user.id });

        try {
            if (subcommand === 'status') {
                const status = tavernService.getStatus(guildId);
                await interaction.reply({ embeds: [views.tavernStatus(status, interaction.guild?.name)] });
            } else if (subcommand === 'board') {
                await interaction.reply({ embeds: [views.questBoard(tavernService.getQuestBoard())] });
            } else if (subcommand === 'rumor') {
                const status = tavernService.getStatus(guildId);
                await interaction.reply(`🗣️ *Leaning over the bar, Marnie murmurs:* ${status.rumor}`);
            } else if (subcommand === 'npc') {
                const npc = tavernService.getNpc(guildId, interaction.options.getString('name'));
                if (!npc) {
                    await interaction.reply({ content: 'Nobody by that name drinks here.', ephemeral: true });
                    return;
                }
                await interaction.reply({ embeds: [views.npcCard(npc)] });
            } else if (subcommand === 'profile') {
                const target = interaction.options.getUser('user') || interaction.user;
                const character = tavernService.getProfile(guildId, target.id);
                if (!character) {
                    await interaction.reply({
                        content: target.id === interaction.user.id
                            ? 'You have no character here yet - `/character create` takes about a minute.'
                            : `${target} hasn't pulled up a chair at the Tavern yet.`,
                        ephemeral: true
                    });
                    return;
                }
                await interaction.reply({ embeds: [views.characterSheet(character, { asProfile: true })] });
            } else if (subcommand === 'reload-quests') {
                if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                    await interaction.reply({ content: '❌ You need Manage Server permission to reload campaigns.', ephemeral: true });
                    return;
                }
                const { count, problems } = questLoader.reload();
                const lines = [`📜 Reloaded the quest board: **${count}** campaign(s) available.`];
                if (problems.length > 0) {
                    lines.push('', '⚠️ Skipped invalid custom campaigns:', ...problems.map(p => `- ${p.split('\n')[0]}`));
                }
                await interaction.reply({ content: lines.join('\n'), ephemeral: true });
            }
        } catch (error) {
            console.error('Tavern command error:', error);
            const message = '❌ The Tavern hit a snag. Marnie is glaring at the offending gear.';
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(message);
            } else {
                await interaction.reply({ content: message, ephemeral: true });
            }
        }
    }
};
