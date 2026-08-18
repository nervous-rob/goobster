const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const tavernService = require('@goobster/core/services/tavern/tavernService');
const questLoader = require('@goobster/core/services/tavern/questLoader');
const worldService = require('@goobster/core/services/tavern/worldService');
const characterService = require('@goobster/core/services/tavern/characterService');
const adventureService = require('@goobster/core/services/tavern/adventureService');
const { NPCS } = require('@goobster/core/services/tavern/content');
const views = require('@goobster/core/utils/tavernViews');
const usageTracker = require('@goobster/core/services/usageTracker');

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
            sub.setName('room')
                .setDescription('Visit a Guest Room upstairs (trophies, standing, decor)')
                .addUserOption(opt => opt.setName('user').setDescription('Whose room (default: yours)')))
        .addSubcommand(sub =>
            sub.setName('room-edit')
                .setDescription('Describe your Guest Room (empty text moves you back out)')
                .addStringOption(opt =>
                    opt.setName('description').setDescription('Your room, in your words').setRequired(true).setMaxLength(500)))
        .addSubcommand(sub =>
            sub.setName('generate-art')
                .setDescription('Generate scene art for a quest into data/tavern/assets (Manage Server, needs OpenAI)')
                .addStringOption(opt =>
                    opt.setName('quest').setDescription('Which quest').setRequired(true).setAutocomplete(true))
                .addBooleanOption(opt =>
                    opt.setName('force').setDescription('Regenerate scenes that already have art')))
        .addSubcommand(sub =>
            sub.setName('forge')
                .setDescription('Have Goobster write a whole new campaign onto the quest board (Manage Server, needs AI)')
                .addStringOption(opt =>
                    opt.setName('prompt').setDescription('What should the adventure be about?').setRequired(true).setMaxLength(600)))
        .addSubcommand(sub =>
            sub.setName('reload-quests')
                .setDescription('Reload campaign YAML files from disk (Manage Server)')),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused().toLowerCase();
        const quests = questLoader.getVisibleQuests()
            .filter(quest => quest.title.toLowerCase().includes(focused) || quest.id.includes(focused))
            .slice(0, 25)
            .map(quest => ({ name: quest.title, value: quest.id }));
        await interaction.respond(quests);
    },

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
                const quests = tavernService.getQuestBoard();
                const locks = {};
                for (const quest of quests) {
                    if (!adventureService.isQuestUnlocked(guildId, quest)) {
                        locks[quest.id] = questLoader.getQuest(quest.requires)?.title || quest.requires;
                    }
                }
                await interaction.reply({ embeds: [views.questBoard(quests, locks)] });
            } else if (subcommand === 'rumor') {
                const status = tavernService.getStatus(guildId);
                await interaction.reply(`🗣️ *Leaning over the bar, Marnie murmurs:* ${status.rumor}`);
            } else if (subcommand === 'npc') {
                const npcKey = interaction.options.getString('name');
                const npc = tavernService.getNpc(guildId, npcKey);
                if (!npc) {
                    await interaction.reply({ content: 'Nobody by that name drinks here.', ephemeral: true });
                    return;
                }
                const standing = worldService.getRelationship(guildId, npcKey, interaction.user.id);
                await interaction.reply({ embeds: [views.npcCard(npc, standing)] });
            } else if (subcommand === 'room') {
                const target = interaction.options.getUser('user') || interaction.user;
                await interaction.reply({
                    embeds: [views.roomEmbed({
                        user: target,
                        description: worldService.getRoom(guildId, target.id),
                        character: characterService.getCharacter(guildId, target.id),
                        relationships: worldService.listRelationships(guildId, target.id)
                    })]
                });
            } else if (subcommand === 'room-edit') {
                const description = worldService.setRoom(guildId, interaction.user.id, interaction.options.getString('description'));
                await interaction.reply(description
                    ? '🗝️ Marnie hands you the key. Your room is upstairs: `/tavern room`.'
                    : '🧹 Your room is swept and returned to the house.');
            } else if (subcommand === 'generate-art') {
                await this._generateArt(interaction, guildId);
            } else if (subcommand === 'forge') {
                await this._forge(interaction, guildId);
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
            const { TavernError } = require('@goobster/core/services/tavern/tavernError');
            const message = error instanceof TavernError
                ? `🍺 ${error.message}`
                : '❌ The Tavern hit a snag. Marnie is glaring at the offending gear.';
            if (!(error instanceof TavernError)) console.error('Tavern command error:', error);
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(message);
            } else {
                await interaction.reply({ content: message, ephemeral: true });
            }
        }
    },

    /** Goobster writes a brand-new campaign into data/tavern/campaigns. */
    async _forge(interaction, guildId) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '❌ You need Manage Server permission to commission a campaign.', ephemeral: true });
            return;
        }
        const campaignForge = require('@goobster/core/services/tavern/campaignForge');
        const prompt = interaction.options.getString('prompt');

        await interaction.deferReply();
        await interaction.editReply('📝 Goobster clears a table, sharpens a quill, and starts writing. *(A full campaign takes a minute.)*');

        const quest = await campaignForge.forgeCampaign({ prompt, guildId, userId: interaction.user.id });
        await interaction.editReply(
            `📜 **A new notice goes up on the Quest Board: ${quest.title}**\n` +
            `${quest.hook.trim().split('\n')[0]}\n\n` +
            `👥 ${quest.players.min}-${quest.players.max} players · ⏱️ ${quest.duration} · ${Object.keys(quest.scenes).length} scenes, ${Object.keys(quest.endings).length} endings\n` +
            `Saved to \`data/tavern/campaigns/${quest.id}/\` (editable YAML). Start it: \`/adventure join quest:${quest.id}\``
        );
    },

    /** Generate + cache scene art for a quest into data/tavern/assets. */
    async _generateArt(interaction, guildId) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '❌ You need Manage Server permission to commission art.', ephemeral: true });
            return;
        }
        const assetService = require('@goobster/core/services/tavern/assetService');
        if (!assetService.canGenerate()) {
            await interaction.reply({ content: '🎨 No OpenAI key configured - the Tavern\'s painter is unavailable. Scenes stay text-only (which also works fine).', ephemeral: true });
            return;
        }
        const quest = questLoader.getQuest(interaction.options.getString('quest'));
        if (!quest) {
            await interaction.reply({ content: 'No such quest on the board.', ephemeral: true });
            return;
        }

        await interaction.deferReply();
        const result = await assetService.generateQuestArt(quest, {
            force: interaction.options.getBoolean('force') || false,
            usageContext: { guildId, userId: interaction.user.id }
        });
        const lines = [`🎨 Scene art for **${quest.title}** (stored under \`data/tavern/assets/\`):`];
        if (result.generated.length > 0) lines.push(`- Painted: ${result.generated.join(', ')}`);
        if (result.skipped.length > 0) lines.push(`- Already framed (kept): ${result.skipped.join(', ')}`);
        for (const failure of result.failed) lines.push(`- ⚠️ ${failure.sceneId}: ${failure.error}`);
        lines.push('Scenes now attach their art automatically.');
        await interaction.editReply(lines.join('\n'));
    }
};
