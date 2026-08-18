const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const characterService = require('@goobster/core/services/tavern/characterService');
const { TavernError } = require('@goobster/core/services/tavern/tavernError');
const { CALLINGS, STATS, STAT_POOL, STAT_MAX } = require('@goobster/core/services/tavern/content');
const views = require('@goobster/core/utils/tavernViews');
const usageTracker = require('@goobster/core/services/usageTracker');

const RETIRE_TIMEOUT_MS = 60 * 1000;

const callingChoices = Object.values(CALLINGS).map(calling => ({
    name: `${calling.name} — ${calling.blurb}`,
    value: calling.key
}));
const statChoices = Object.values(STATS).map(stat => ({ name: stat.name, value: stat.key }));

/**
 * Tavern character sheets: create, view, edit descriptive fields, spend
 * milestones on stat advances, and retire. One character per user per guild.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('character')
        .setDescription('Your Tavern character - create and manage your sheet.')
        .addSubcommand(sub =>
            sub.setName('create')
                .setDescription(`Make a character: distribute ${STAT_POOL} points across four stats (each 0-${STAT_MAX})`)
                .addStringOption(opt => opt.setName('name').setDescription('Character name').setRequired(true).setMaxLength(40))
                .addStringOption(opt => opt.setName('origin').setDescription('Background in one flavorful phrase, e.g. "Retired goblin tax collector"').setRequired(true).setMaxLength(100))
                .addStringOption(opt => opt.setName('calling').setDescription('Your broad archetype').setRequired(true).addChoices(...callingChoices))
                .addStringOption(opt => opt.setName('complication').setDescription('Your flaw/hook, e.g. "Cannot resist a dare" - it earns you Spark').setRequired(true).setMaxLength(120))
                .addIntegerOption(opt => opt.setName('might').setDescription(`Might 0-${STAT_MAX}: force, endurance, fighting`).setRequired(true).setMinValue(0).setMaxValue(STAT_MAX))
                .addIntegerOption(opt => opt.setName('finesse').setDescription(`Finesse 0-${STAT_MAX}: stealth, reflexes, precision`).setRequired(true).setMinValue(0).setMaxValue(STAT_MAX))
                .addIntegerOption(opt => opt.setName('wits').setDescription(`Wits 0-${STAT_MAX}: knowledge, investigation, planning`).setRequired(true).setMinValue(0).setMaxValue(STAT_MAX))
                .addIntegerOption(opt => opt.setName('heart').setDescription(`Heart 0-${STAT_MAX}: charm, courage, empathy`).setRequired(true).setMinValue(0).setMaxValue(STAT_MAX))
                .addStringOption(opt => opt.setName('pronouns').setDescription('Optional pronouns').setMaxLength(30)))
        .addSubcommand(sub =>
            sub.setName('sheet')
                .setDescription('View a character sheet')
                .addUserOption(opt => opt.setName('user').setDescription('Whose sheet (default: you)')))
        .addSubcommand(sub =>
            sub.setName('edit')
                .setDescription('Edit your character\'s descriptive fields')
                .addStringOption(opt => opt.setName('name').setDescription('New name').setMaxLength(40))
                .addStringOption(opt => opt.setName('origin').setDescription('New origin phrase').setMaxLength(100))
                .addStringOption(opt => opt.setName('complication').setDescription('New complication').setMaxLength(120))
                .addStringOption(opt => opt.setName('pronouns').setDescription('New pronouns (empty text clears)').setMaxLength(30)))
        .addSubcommand(sub =>
            sub.setName('advance')
                .setDescription('Spend a milestone to raise a stat by one')
                .addStringOption(opt => opt.setName('stat').setDescription('Which stat to raise').setRequired(true).addChoices(...statChoices)))
        .addSubcommand(sub =>
            sub.setName('inventory')
                .setDescription('Your pack: view it, use a consumable, hand something over, or drop it')
                .addStringOption(opt =>
                    opt.setName('action').setDescription('What to do').setRequired(true)
                        .addChoices(
                            { name: 'view', value: 'view' },
                            { name: 'use (during an adventure)', value: 'use' },
                            { name: 'give to a party member', value: 'give' },
                            { name: 'drop', value: 'drop' }
                        ))
                .addStringOption(opt =>
                    opt.setName('item').setDescription('Which item (for use/give/drop)').setAutocomplete(true))
                .addUserOption(opt =>
                    opt.setName('user').setDescription('Recipient (for give)')))
        .addSubcommand(sub =>
            sub.setName('retire')
                .setDescription('Retire your character permanently (asks for confirmation)')),

    async autocomplete(interaction) {
        if (!interaction.guildId) {
            await interaction.respond([]);
            return;
        }
        const character = characterService.getCharacter(interaction.guildId, interaction.user.id);
        const focused = interaction.options.getFocused().toLowerCase();
        const items = [...new Set(character?.inventory || [])]
            .filter(item => item.toLowerCase().includes(focused))
            .slice(0, 25);
        await interaction.respond(items.map(item => ({ name: item, value: item })));
    },

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'Characters live in servers - the Tavern needs a table.', ephemeral: true });
            return;
        }
        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const subcommand = interaction.options.getSubcommand();
        usageTracker.logCommand({ command: 'character', guildId, userId });

        try {
            if (subcommand === 'create') {
                const character = characterService.createCharacter({
                    guildId, userId,
                    name: interaction.options.getString('name'),
                    origin: interaction.options.getString('origin'),
                    calling: interaction.options.getString('calling'),
                    complication: interaction.options.getString('complication'),
                    pronouns: interaction.options.getString('pronouns'),
                    stats: {
                        might: interaction.options.getInteger('might'),
                        finesse: interaction.options.getInteger('finesse'),
                        wits: interaction.options.getInteger('wits'),
                        heart: interaction.options.getInteger('heart')
                    }
                });
                await interaction.reply({
                    content: `🍺 Marnie slides a drink down the bar to **${character.name}**. Welcome to the Tavern - the Quest Board is \`/adventure browse\`.`,
                    embeds: [views.characterSheet(character)]
                });
            } else if (subcommand === 'sheet') {
                const target = interaction.options.getUser('user') || interaction.user;
                const character = characterService.getCharacter(guildId, target.id);
                if (!character) {
                    await interaction.reply({
                        content: target.id === userId
                            ? 'You have no character here yet - `/character create` takes about a minute.'
                            : `${target} has no character here yet.`,
                        ephemeral: true
                    });
                    return;
                }
                await interaction.reply({ embeds: [views.characterSheet(character)] });
            } else if (subcommand === 'edit') {
                const name = interaction.options.getString('name');
                const origin = interaction.options.getString('origin');
                const complication = interaction.options.getString('complication');
                const pronouns = interaction.options.getString('pronouns');
                if (name === null && origin === null && complication === null && pronouns === null) {
                    await interaction.reply({ content: 'Provide at least one field to edit.', ephemeral: true });
                    return;
                }
                const character = characterService.editCharacter({ guildId, userId, name, origin, complication, pronouns });
                await interaction.reply({ content: '✏️ Sheet updated.', embeds: [views.characterSheet(character)] });
            } else if (subcommand === 'advance') {
                const stat = interaction.options.getString('stat');
                const character = characterService.advance(guildId, userId, stat);
                await interaction.reply({
                    content: `🏅 **${character.name}** grows: ${STATS[stat].name} is now +${character[stat]}. ` +
                        `(${character.milestones - character.advancesSpent} milestone(s) left to spend.)`,
                    embeds: [views.characterSheet(character)]
                });
            } else if (subcommand === 'inventory') {
                await this._inventory(interaction, guildId, userId);
            } else if (subcommand === 'retire') {
                await this._retire(interaction, guildId, userId);
            }
        } catch (error) {
            const message = error instanceof TavernError ? `🍺 ${error.message}` : '❌ Something went wrong at the character desk.';
            if (!(error instanceof TavernError)) console.error('Character command error:', error);
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(message);
            } else {
                await interaction.reply({ content: message, ephemeral: true });
            }
        }
    },

    /** Inventory management: view, use (mid-adventure), give, drop. */
    async _inventory(interaction, guildId, userId) {
        const adventureService = require('@goobster/core/services/tavern/adventureService');
        const views = require('@goobster/core/utils/tavernViews');
        const action = interaction.options.getString('action');
        const item = interaction.options.getString('item');
        const character = characterService.getCharacter(guildId, userId);
        if (!character) {
            await interaction.reply({ content: 'You have no character here yet - `/character create` takes about a minute.', ephemeral: true });
            return;
        }

        if (action === 'view') {
            const open = adventureService.getOpenAdventureForUser(guildId, userId);
            const quest = open ? require('@goobster/core/services/tavern/questLoader').getQuest(open.questId) : null;
            const usable = new Set(Object.keys(quest?.items || {}).map(name => name.toLowerCase()));
            const lines = character.inventory.length > 0
                ? character.inventory.map(entry => `• ${entry}${usable.has(entry.toLowerCase()) ? ' — *usable here (`use`)*' : ''}`)
                : ['*Empty pockets, big dreams.*'];
            await interaction.reply({ content: `🎒 **${character.name}'s pack (${character.inventory.length})**\n${lines.join('\n').slice(0, 1800)}` });
            return;
        }

        if (!item) {
            await interaction.reply({ content: 'Which item? (The `item` option autocompletes from your pack.)', ephemeral: true });
            return;
        }

        if (action === 'use') {
            const open = adventureService.getOpenAdventureForUser(guildId, userId);
            if (!open || open.status !== 'ACTIVE') {
                throw new TavernError('NOT_ACTIVE', 'Consumables only work mid-adventure - at the Tavern, Sister Caldra handles recovery.');
            }
            if (open.channelId !== interaction.channelId) {
                throw new TavernError('WRONG_TABLE', `Your adventure is at another table: <#${open.channelId}>. Use it there.`);
            }
            const result = adventureService.useItem(open.id, userId, item);
            await interaction.reply(views.checkResultMessage(result, open.id));
            require('@goobster/core/services/tavern/botAdventurer').maybeTakeTurn(open.id, interaction.channel);
            return;
        }

        if (action === 'give') {
            const target = interaction.options.getUser('user');
            if (!target) {
                await interaction.reply({ content: 'Give to whom? Set the `user` option.', ephemeral: true });
                return;
            }
            const { item: given, to } = characterService.transferItem({ guildId, fromUserId: userId, toUserId: target.id, item });
            await interaction.reply(`🤝 **${character.name}** hands **${given}** to **${to.name}**.`);
            return;
        }

        if (action === 'drop') {
            const removed = characterService.removeItem(character.id, item);
            if (!removed) {
                await interaction.reply({ content: `You are not carrying "${item}".`, ephemeral: true });
                return;
            }
            await interaction.reply(`🗑️ **${character.name}** leaves **${removed}** behind. Bix will have it labeled within the hour.`);
        }
    },

    /** Confirmation flow for permanent retirement. */
    async _retire(interaction, guildId, userId) {
        const character = characterService.getCharacter(guildId, userId);
        if (!character) {
            await interaction.reply({ content: 'You have no character here to retire.', ephemeral: true });
            return;
        }
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tavernretire_confirm').setLabel('Yes, retire them').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('tavernretire_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );
        const reply = await interaction.reply({
            content: `⚠️ Retire **${character.name}** permanently? Their sheet, inventory, and trophies are deleted. This cannot be undone.`,
            components: [row],
            ephemeral: true,
            fetchReply: true
        });

        let confirmation;
        try {
            confirmation = await reply.awaitMessageComponent({
                componentType: ComponentType.Button,
                filter: i => i.user.id === userId,
                time: RETIRE_TIMEOUT_MS
            });
        } catch {
            await interaction.editReply({ content: 'Timed out - nobody retired.', components: [] });
            return;
        }
        if (confirmation.customId === 'tavernretire_cancel') {
            await confirmation.update({ content: 'Cancelled - the adventure continues.', components: [] });
            return;
        }
        try {
            const retired = characterService.retireCharacter(guildId, userId);
            await confirmation.update({
                content: `🕯️ **${retired.name}** hangs up their gear. Sister Caldra records the name in the hearth-book: ` +
                    `${retired.adventuresCompleted} adventure(s) survived. A new \`/character create\` awaits whenever you are.`,
                components: []
            });
        } catch (error) {
            const message = error instanceof TavernError ? `🍺 ${error.message}` : '❌ Retirement failed.';
            if (!(error instanceof TavernError)) console.error('Character retire error:', error);
            await confirmation.update({ content: message, components: [] });
        }
    }
};
