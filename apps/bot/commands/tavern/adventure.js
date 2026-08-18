const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const adventureService = require('@goobster/core/services/tavern/adventureService');
const questLoader = require('@goobster/core/services/tavern/questLoader');
const narrator = require('@goobster/core/services/tavern/narrator');
const { TavernError } = require('@goobster/core/services/tavern/tavernError');
const { CALLINGS } = require('@goobster/core/services/tavern/content');
const views = require('@goobster/core/utils/tavernViews');
const { buildSceneView, sendEnding } = require('@goobster/core/services/tavern/interactionHandler');
const usageTracker = require('@goobster/core/services/usageTracker');

/**
 * Adventure Mode: browse the quest board, form and join parties, play scenes
 * (freeform actions welcome - the buttons are only the visible options), fire
 * your Calling's big move, and read automatic recaps.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('adventure')
        .setDescription('Adventure Mode - accept a rumor, bounty, or terrible idea.')
        .addSubcommand(sub =>
            sub.setName('browse')
                .setDescription('Browse the Quest Board'))
        .addSubcommand(sub =>
            sub.setName('join')
                .setDescription('Join the party forming here, or post a new one for a quest')
                .addStringOption(opt =>
                    opt.setName('quest').setDescription('Quest to post a new party for (omit to join the one forming here)')
                        .setAutocomplete(true)))
        .addSubcommand(sub =>
            sub.setName('invite-goobster')
                .setDescription('Invite Goobster himself to play in your forming party'))
        .addSubcommand(sub =>
            sub.setName('begin')
                .setDescription('Begin this channel\'s adventure once the party is ready'))
        .addSubcommand(sub =>
            sub.setName('act')
                .setDescription('Do something else entirely - describe your action in your own words')
                .addStringOption(opt =>
                    opt.setName('action').setDescription('What do you do?').setRequired(true).setMaxLength(300)))
        .addSubcommand(sub =>
            sub.setName('attack')
                .setDescription('Attack a foe in the current encounter')
                .addStringOption(opt =>
                    opt.setName('enemy').setDescription('Which foe').setRequired(true).setAutocomplete(true))
                .addStringOption(opt =>
                    opt.setName('stat').setDescription('Attack with which stat (default: your best of Might/Finesse)')
                        .addChoices(
                            { name: 'Might', value: 'might' }, { name: 'Finesse', value: 'finesse' },
                            { name: 'Wits', value: 'wits' }, { name: 'Heart', value: 'heart' }
                        )))
        .addSubcommand(sub =>
            sub.setName('twist')
                .setDescription('Bend the story: Goobster writes new scenes that tie your idea back into the campaign')
                .addStringOption(opt =>
                    opt.setName('description').setDescription('What should happen instead?').setRequired(true).setMaxLength(400)))
        .addSubcommand(sub =>
            sub.setName('bigmove')
                .setDescription('Fire your Calling\'s once-per-adventure big moment: your next check succeeds'))
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Where were we? Re-post the current scene or party card'))
        .addSubcommand(sub =>
            sub.setName('recap')
                .setDescription('The recap of the last completed adventure here'))
        .addSubcommand(sub =>
            sub.setName('leave')
                .setDescription('Leave your current party (no penalty, ever)'))
        .addSubcommand(sub =>
            sub.setName('abandon')
                .setDescription('Abandon this channel\'s adventure (party founder or Manage Server)')),

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const focused = String(focusedOption.value).toLowerCase();

        if (focusedOption.name === 'enemy') {
            const open = adventureService.getOpenAdventureInChannel(interaction.channelId);
            if (!open || open.status !== 'ACTIVE') {
                await interaction.respond([]);
                return;
            }
            const quest = questLoader.getQuest(open.questId);
            const enemies = quest ? adventureService.livingEnemies(open, quest) : [];
            await interaction.respond(enemies
                .filter(enemy => enemy.name.toLowerCase().includes(focused))
                .slice(0, 25)
                .map(enemy => ({ name: `${enemy.name} (${enemy.currentHealth}/${enemy.health})`, value: enemy.id })));
            return;
        }

        const quests = questLoader.getVisibleQuests()
            .filter(quest => quest.title.toLowerCase().includes(focused) || quest.id.includes(focused))
            .slice(0, 25)
            .map(quest => ({ name: `${quest.title} (${quest.duration})`, value: quest.id }));
        await interaction.respond(quests);
    },

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'Adventures set out from servers - the Tavern needs a table.', ephemeral: true });
            return;
        }
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;
        const userId = interaction.user.id;
        const subcommand = interaction.options.getSubcommand();
        usageTracker.logCommand({ command: 'adventure', guildId, userId });

        try {
            if (subcommand === 'browse') {
                const quests = questLoader.getVisibleQuests();
                const locks = {};
                for (const quest of quests) {
                    if (!adventureService.isQuestUnlocked(guildId, quest)) {
                        locks[quest.id] = questLoader.getQuest(quest.requires)?.title || quest.requires;
                    }
                }
                await interaction.reply({ embeds: [views.questBoard(quests, locks)] });
            } else if (subcommand === 'join') {
                await this._join(interaction, { guildId, channelId, userId });
            } else if (subcommand === 'invite-goobster') {
                const open = this._requireChannelAdventure(channelId);
                const botId = interaction.client.user.id;
                const { adventure, quest, members } = adventureService.inviteBot(open.id, userId, botId);
                await interaction.reply({
                    content: `🍻 Goobster wipes his hands on his apron and pulls up a chair. *"Someone say adventure?"* He plays when the spotlight reaches him.`,
                    ...views.partyMessage(adventure, quest, members)
                });
            } else if (subcommand === 'begin') {
                const open = this._requireChannelAdventure(channelId);
                const { adventure, quest, members } = adventureService.begin(open.id, userId);
                await interaction.reply({
                    content: `🗡️ **${quest.title}** begins! (Party of ${members.length}: ${members.map(m => m.character?.name).filter(Boolean).join(', ')})`
                });
                await interaction.channel.send(buildSceneView(adventure.id, '*The tale begins.*'));
                require('@goobster/core/services/tavern/botAdventurer').maybeTakeTurn(adventure.id, interaction.channel);
            } else if (subcommand === 'act') {
                await this._act(interaction, { guildId, channelId, userId });
            } else if (subcommand === 'attack') {
                const open = this._requireChannelAdventure(channelId);
                const result = adventureService.attack(
                    open.id, userId,
                    interaction.options.getString('enemy'),
                    interaction.options.getString('stat')
                );
                await interaction.reply(views.checkResultMessage(result, open.id));
                if (result.ended) {
                    const quest = questLoader.getQuest(result.adventure.questId);
                    await sendEnding(interaction.channel, quest, result.ended, guildId);
                } else if (result.sceneChanged) {
                    await interaction.channel.send(buildSceneView(open.id));
                }
                require('@goobster/core/services/tavern/botAdventurer').maybeTakeTurn(open.id, interaction.channel);
            } else if (subcommand === 'twist') {
                await this._twist(interaction, { guildId, channelId, userId });
            } else if (subcommand === 'bigmove') {
                const open = this._requireChannelAdventure(channelId);
                const { calling } = adventureService.useBigMove(open.id, userId);
                const move = CALLINGS[calling]?.bigMove;
                await interaction.reply(
                    `✨ **${move?.name || 'Big moment'}!** ${move?.text || ''}\n*Your next check automatically succeeds.*`
                );
            } else if (subcommand === 'status') {
                await this._status(interaction, channelId);
            } else if (subcommand === 'recap') {
                const recap = adventureService.getLatestRecap(guildId, channelId) || adventureService.getLatestRecap(guildId);
                if (!recap) {
                    await interaction.reply({ content: 'No tales concluded here yet - the recap book is blank.', ephemeral: true });
                    return;
                }
                const questTitle = questLoader.getQuest(recap.questId)?.title || recap.questId;
                await interaction.reply({ embeds: [views.recapEmbed(recap, questTitle)] });
            } else if (subcommand === 'leave') {
                const open = adventureService.getOpenAdventureForUser(guildId, userId);
                if (!open) {
                    await interaction.reply({ content: 'You are not in an open adventure here.', ephemeral: true });
                    return;
                }
                const { remaining, abandoned } = adventureService.leave(open.id, userId);
                await interaction.reply(
                    abandoned
                        ? '👋 You slip away, and with that the table empties. The tale is shelved for another night.'
                        : `👋 You slip away from the table. ${remaining} adventurer(s) fight on.`
                );
            } else if (subcommand === 'abandon') {
                const open = this._requireChannelAdventure(channelId);
                const force = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || false;
                adventureService.abandon(open.id, userId, { force });
                await interaction.reply('🕯️ The adventure is set aside. Marnie marks the page and pours a round for effort.');
            }
        } catch (error) {
            const message = error instanceof TavernError ? `🍺 ${error.message}` : '❌ The adventure hit a snag outside the story.';
            if (!(error instanceof TavernError)) console.error('Adventure command error:', error);
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(message);
            } else {
                await interaction.reply({ content: message, ephemeral: true });
            }
        }
    },

    _requireChannelAdventure(channelId) {
        const open = adventureService.getOpenAdventureInChannel(channelId);
        if (!open) {
            throw new TavernError('NO_ADVENTURE', 'No adventure at this table. `/adventure join quest:<name>` posts one.');
        }
        return open;
    },

    /** Join the channel's forming party, or post a new one for a quest. */
    async _join(interaction, { guildId, channelId, userId }) {
        const questId = interaction.options.getString('quest');
        const open = adventureService.getOpenAdventureInChannel(channelId);

        if (!questId) {
            if (!open) {
                throw new TavernError('NO_ADVENTURE', 'No party is forming here. `/adventure join quest:<name>` posts one, or `/adventure browse` to shop first.');
            }
            const { adventure, quest, members } = adventureService.join(open.id, userId);
            await interaction.reply({
                content: `🍻 You pull up a chair at the **${quest.title}** table.`,
                ...views.partyMessage(adventure, quest, members)
            });
            return;
        }

        // Posting a new party - if this exact quest is already forming here, just join it.
        if (open && open.status === 'RECRUITING' && open.questId === questId) {
            const { adventure, quest, members } = adventureService.join(open.id, userId);
            await interaction.reply({
                content: `🍻 That table is already forming - you pull up a chair for **${quest.title}**.`,
                ...views.partyMessage(adventure, quest, members)
            });
            return;
        }

        const { adventure, quest } = adventureService.createParty({ guildId, channelId, questId, userId });
        const members = adventureService.getMembers(adventure.id);
        await interaction.reply({
            content: `📜 A notice goes up: **${quest.title}** seeks a party!`,
            ...views.partyMessage(adventure, quest, members)
        });
    },

    /** Freeform action: optional AI interpretation + narration, deterministic engine. */
    async _act(interaction, { guildId, channelId, userId }) {
        const open = this._requireChannelAdventure(channelId);
        const actionText = interaction.options.getString('action');

        // Narration can take a few seconds - defer publicly
        await interaction.deferReply();

        const usageContext = { guildId, userId };
        let interpretation = null;
        try {
            const { quest, scene } = adventureService.describe(open.id);
            const characterServiceRef = require('@goobster/core/services/tavern/characterService');
            const character = characterServiceRef.getCharacter(guildId, userId);
            if (quest && scene && character) {
                interpretation = await narrator.interpretAction(actionText, { scene, character }, usageContext);
            }
        } catch {
            interpretation = null;
        }

        const result = adventureService.freeform(open.id, userId, actionText, interpretation);

        // Optional AI narration replaces the scene's stock freeform line
        try {
            const { quest, scene } = adventureService.describe(open.id);
            const narration = await narrator.narrateOutcome({
                quest,
                scene: scene || { title: 'the end of the tale', text: '' },
                character: result.character,
                actionText,
                stat: result.stat, dc: result.dc, roll: result.roll, total: result.total,
                success: result.success,
                happenings: result.happenings
            }, usageContext);
            if (narration) result.outcomeText = narration;
        } catch {
            // keep the stock line
        }

        await interaction.editReply(views.checkResultMessage(result, open.id));

        if (result.ended) {
            const quest = questLoader.getQuest(result.adventure.questId);
            await sendEnding(interaction.channel, quest, result.ended, guildId);
        } else if (result.sceneChanged) {
            await interaction.channel.send(buildSceneView(open.id));
        }
        require('@goobster/core/services/tavern/botAdventurer').maybeTakeTurn(open.id, interaction.channel);
    },

    /**
     * Story surgery: Goobster forges new scenes for the players' twist,
     * guaranteed to tie back into the campaign's existing endings.
     */
    async _twist(interaction, { guildId, channelId, userId }) {
        const campaignForge = require('@goobster/core/services/tavern/campaignForge');
        const open = this._requireChannelAdventure(channelId);
        if (open.status !== 'ACTIVE') {
            throw new TavernError('NOT_ACTIVE', 'The story can only bend once it is being told - `/adventure begin` first.');
        }
        const members = adventureService.getMembers(open.id);
        if (!members.some(m => m.userId === userId)) {
            throw new TavernError('NOT_MEMBER', 'Only party members may bend this story.');
        }
        if (open.state.twistUsed) {
            throw new TavernError('TWIST_USED', 'This tale has already bent once - one big narrative detour per adventure keeps the spine intact.');
        }

        const twist = interaction.options.getString('description');
        await interaction.deferReply();
        await interaction.editReply('🌀 Goobster narrows his eyes, flips his notebook to a fresh page, and starts rewriting fate. *(This takes a moment.)*');

        const { quest, scene } = adventureService.describe(open.id);
        const db = require('@goobster/core/db');
        const recentLog = db.all(
            `SELECT content FROM tavern_adventure_log WHERE adventureId = @id ORDER BY id DESC LIMIT 8`,
            { id: open.id }
        ).map(row => `- ${row.content}`).reverse().join('\n');

        const { forkQuestId, entrySceneId, note } = await campaignForge.forgeTwist({
            adventure: open, quest, scene, recentLog, twist, guildId, userId
        });
        adventureService.applyTwist(open.id, forkQuestId, entrySceneId, note);

        await interaction.editReply(`🌀 **The story bends.** ${note}\n*(New scenes forged; the thread still leads back to how this tale can end.)*`);
        await interaction.channel.send(buildSceneView(open.id));
        require('@goobster/core/services/tavern/botAdventurer').maybeTakeTurn(open.id, interaction.channel);
    },

    /** Re-post the actionable card for wherever the story stands. */
    async _status(interaction, channelId) {
        const open = adventureService.getOpenAdventureInChannel(channelId);
        if (!open) {
            await interaction.reply({
                content: 'No adventure at this table right now. `/tavern status` shows what\'s on across the server.',
                ephemeral: true
            });
            return;
        }
        if (open.status === 'RECRUITING') {
            const quest = questLoader.getQuest(open.questId);
            const members = adventureService.getMembers(open.id);
            await interaction.reply(views.partyMessage(open, quest, members));
            return;
        }
        await interaction.reply(buildSceneView(open.id, '*Where were we? Ah, yes -*'));
    }
};
