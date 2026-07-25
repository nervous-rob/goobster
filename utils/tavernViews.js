const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { STATS, CALLINGS } = require('../services/tavern/content');

const TAVERN_COLOR = 0xc27c2b;   // hearth-light amber
const SCENE_COLOR = 0x2b6cb0;    // storm-glass blue
const SUCCESS_COLOR = 0x2f855a;
const FAILURE_COLOR = 0x9b2c2c;
const ENDING_COLOR = 0x6b46c1;

/**
 * Presentation for the Goobster Tavern: embeds and button rows. No game
 * logic lives here - views render what the services decided.
 */

/** ▰▰▱▱ style clock bar. */
function clockBar(value, size) {
    return '▰'.repeat(value) + '▱'.repeat(Math.max(0, size - value));
}

/** Render every quest clock for a running adventure. */
function renderClocks(adventure, quest) {
    return (quest.clocks || []).map(clock => {
        const value = adventure.state.clocks?.[clock.id] || 0;
        const face = clock.kind === 'danger' ? '⚠️' : '🕰️';
        return `${face} **${clock.name}**: ${clockBar(value, clock.size)} ${value}/${clock.size}`;
    }).join('\n');
}

/** One-line party roster with health and Spark. */
function renderParty(members) {
    return members
        .map(m => m.character
            ? `**${m.character.name}** (<@${m.userId}>) ❤️ ${m.character.health}/${m.character.maxHealth} ✨ ${m.character.spark}`
            : `<@${m.userId}>`)
        .join('\n');
}

/** A quest board line: title, players, duration, difficulty, tags. */
function questSummary(quest) {
    const solo = quest.players.min === 1 ? ' · solo-friendly' : '';
    return [
        `*${quest.hook.trim().split('\n')[0]}*`,
        `👥 ${quest.players.recommended || `${quest.players.min}-${quest.players.max}`} players · ⏱️ ${quest.duration}` +
        ` · 🎯 ${quest.difficulty}${solo}`,
        `🏷️ ${quest.tags.join(', ')}${quest.affectsWorld ? ' · 🌍 affects the shared world' : ''}`
    ].join('\n');
}

/** The /tavern status Common Room embed. */
function tavernStatus(status, guildName) {
    const embed = new EmbedBuilder()
        .setColor(TAVERN_COLOR)
        .setTitle('🍺 The Goobster Tavern')
        .setDescription(
            `The Goobster Tavern is lively tonight. ${status.weather}\n\n` +
            `🗣️ **Rumor of the day:** ${status.rumor}`
        )
        .addFields(
            {
                name: '📜 The Quest Board',
                value: status.quests.map(q =>
                    `• **${q.title}** — ${q.players.recommended || `${q.players.min}-${q.players.max}`} players, ${q.duration}`
                ).join('\n') + '\n*Join one with `/adventure join`.*'
            },
            {
                name: '🧑‍🤝‍🧑 In residence',
                value: status.npcs.map(npc => `${npc.emoji} **${npc.name}**, ${npc.title} — “${npc.line}”`).join('\n')
            }
        )
        .setFooter({
            text: `${status.characterCount} adventurer(s) drink here · /character create to join them` +
                (guildName ? ` · ${guildName}` : '')
        });

    if (status.openAdventures.length > 0) {
        embed.addFields({
            name: '⚔️ At the tables',
            value: status.openAdventures.map(a =>
                `• **${a.title}** in <#${a.channelId}> — ${a.status === 'RECRUITING' ? `recruiting (${a.partySize} so far)` : `underway (party of ${a.partySize})`}`
            ).join('\n')
        });
    }
    return embed;
}

/** The full quest board embed. */
function questBoard(quests) {
    return new EmbedBuilder()
        .setColor(TAVERN_COLOR)
        .setTitle('📜 The Quest Board')
        .setDescription('Pinned notices, in Marnie\'s tidy hand. Start one with `/adventure join quest:<name>`.')
        .addFields(quests.map(quest => ({
            name: `${quest.type === 'tavern-tale' ? '🍻' : '🗺️'} ${quest.title}`,
            value: questSummary(quest)
        })));
}

/** An NPC card. */
function npcCard(npc) {
    return new EmbedBuilder()
        .setColor(TAVERN_COLOR)
        .setTitle(`${npc.emoji} ${npc.name} — ${npc.title}`)
        .setDescription(`${npc.description}\n\n*“${npc.line}”*`)
        .addFields({ name: 'Ask them about', value: npc.role });
}

/** A character sheet / tavern profile embed. */
function characterSheet(character, { asProfile = false } = {}) {
    const calling = CALLINGS[character.calling];
    const statLine = Object.values(STATS)
        .map(stat => `${stat.emoji} **${stat.name}** +${character[stat.key]}`)
        .join('  ');
    const embed = new EmbedBuilder()
        .setColor(TAVERN_COLOR)
        .setTitle(`${calling?.emoji || '🎲'} ${character.name}`)
        .setDescription(
            `*${character.origin}*${character.pronouns ? ` (${character.pronouns})` : ''}\n` +
            `**Calling:** ${calling?.name || character.calling}` +
            (calling ? ` — ${calling.blurb}` : '')
        )
        .addFields(
            { name: 'Stats', value: statLine },
            {
                name: 'Condition',
                value: `❤️ Health ${character.health}/${character.maxHealth} · ✨ Spark ${character.spark} · ` +
                    `🏅 Milestones ${character.milestones - character.advancesSpent} unspent / ${character.milestones} earned`
            },
            { name: 'Complication', value: `⚡ *${character.complication}*` }
        );

    if (calling) {
        embed.addFields({
            name: 'Moves',
            value: `**${calling.alwaysMove.name}** (always): ${calling.alwaysMove.text}\n` +
                `**${calling.bigMove.name}** (once per adventure, \`/adventure bigmove\`): ${calling.bigMove.text}`
        });
    }
    embed.addFields({
        name: `🎒 Inventory (${character.inventory.length})`,
        value: character.inventory.length > 0
            ? character.inventory.map(item => `• ${item}`).join('\n').slice(0, 1024)
            : '*Empty pockets, big dreams.*'
    });
    if (asProfile) {
        embed.setFooter({ text: `Adventures survived: ${character.adventuresCompleted}` });
    }
    return embed;
}

/** The recruiting message for a party, with Join/Begin buttons. */
function partyMessage(adventure, quest, members) {
    const embed = new EmbedBuilder()
        .setColor(TAVERN_COLOR)
        .setTitle(`⚔️ Party forming: ${quest.title}`)
        .setDescription(quest.hook.trim())
        .addFields(
            {
                name: 'The notice reads',
                value: `👥 ${quest.players.recommended || `${quest.players.min}-${quest.players.max}`} players · ⏱️ ${quest.duration} · 🎯 ${quest.difficulty}\n` +
                    `🏷️ ${quest.tags.join(', ')}\n🎁 ${quest.reward || 'A story worth telling.'}`
            },
            {
                name: `Party (${members.length}/${quest.players.max})`,
                value: members.length > 0 ? renderParty(members) : '*Nobody yet - be first!*'
            }
        )
        .setFooter({ text: 'You need a character to join: /character create' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`join_tavern_${adventure.id}`)
            .setLabel('Join the party')
            .setEmoji('🍻')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`begin_tavern_${adventure.id}`)
            .setLabel('Begin the adventure')
            .setEmoji('🗡️')
            .setStyle(ButtonStyle.Success)
            .setDisabled(members.length < quest.players.min)
    );
    return { embeds: [embed], components: [row] };
}

/** A live scene: narration, clocks, party, spotlight, and option buttons. */
function sceneMessage({ adventure, quest, scene, members, options, spotlightUserId, lead }) {
    const embed = new EmbedBuilder()
        .setColor(SCENE_COLOR)
        .setTitle(`📖 ${quest.title} — ${scene.title}`)
        .setDescription((lead ? `${lead}\n\n` : '') + scene.text.trim());

    const clocks = renderClocks(adventure, quest);
    if (clocks) embed.addFields({ name: 'Clocks', value: clocks });
    embed.addFields({ name: 'Party', value: renderParty(members) });
    if (spotlightUserId) {
        embed.addFields({ name: 'Spotlight', value: `<@${spotlightUserId}> — the scene turns to you (anyone may act).` });
    }
    embed.setFooter({ text: 'Or do something else entirely: /adventure act' });

    const rows = [];
    for (let i = 0; i < options.length; i += 4) {
        rows.push(new ActionRowBuilder().addComponents(
            options.slice(i, i + 4).map(option => {
                const button = new ButtonBuilder()
                    .setCustomId(`opt_tavern_${adventure.id}-${option.key}`)
                    .setLabel(option.label.slice(0, 80))
                    .setStyle(option.goto !== undefined || option.end !== undefined
                        ? ButtonStyle.Secondary
                        : ButtonStyle.Primary);
                if (option.emoji) button.setEmoji(option.emoji);
                return button;
            })
        ));
    }
    return { embeds: [embed], components: rows };
}

/** The outcome of a check (or travel beat), with an optional Spark reroll button. */
function checkResultMessage(result, adventureId) {
    let header;
    if (result.kind === 'travel') {
        header = `🎬 **${result.character.name}** — *${result.actionLabel}*`;
    } else {
        const statName = STATS[result.stat]?.name || result.stat;
        const rollText = result.auto
            ? '✨ auto-success'
            : `🎲 ${result.roll} + ${result.total - result.roll} = **${result.total}** vs DC ${result.dc}`;
        header =
            `${result.success ? '✅' : '❌'} **${result.character.name}** — *${result.actionLabel}*\n` +
            `${statName} check: ${rollText} → **${result.success ? 'Success' : 'Failure'}**`;
    }

    const parts = [header];
    if (result.outcomeText) parts.push(`\n${result.outcomeText}`);
    if (result.happenings.length > 0) parts.push('\n' + result.happenings.join('\n'));

    const message = { content: parts.join('\n'), components: [] };
    if (result.canReroll) {
        message.components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`spark_tavern_${adventureId}`)
                .setLabel('Spend 1 Spark to reroll')
                .setEmoji('✨')
                .setStyle(ButtonStyle.Secondary)
        ));
    }
    return message;
}

/** The completion embed for an ending. */
function endingMessage(quest, ended, { polishedRecap = null } = {}) {
    const ending = ended.ending || { title: ended.endingId, text: '' };
    const embed = new EmbedBuilder()
        .setColor(ENDING_COLOR)
        .setTitle(`🏁 ${quest.title} — ${ending.title}`)
        .setDescription(ending.text.trim() || '*The tale ends, as tales do, in the telling.*');
    if (ending.trophy) {
        embed.addFields({ name: '🏆 Trophy', value: `Each survivor carries away **${ending.trophy}**.` });
    }
    embed.addFields({
        name: 'Back at the Tavern',
        value: 'The hearth restores you: full health, +1 Spark, and a milestone to spend (`/character advance`). ' +
            'The tale is now on record: `/adventure recap`.'
    });
    if (polishedRecap) {
        embed.addFields({ name: '🍺 As told across the bar', value: polishedRecap.slice(0, 1024) });
    }
    return embed;
}

/** A stored recap embed. */
function recapEmbed(recap, questTitle) {
    return new EmbedBuilder()
        .setColor(ENDING_COLOR)
        .setTitle(`📚 Recap: ${questTitle}`)
        .setDescription(recap.content.slice(0, 4000))
        .setFooter({ text: `Concluded ${recap.createdAt} UTC` });
}

module.exports = {
    tavernStatus,
    questBoard,
    npcCard,
    characterSheet,
    partyMessage,
    sceneMessage,
    checkResultMessage,
    endingMessage,
    recapEmbed,
    renderClocks,
    renderParty,
    clockBar,
    TAVERN_COLOR,
    SCENE_COLOR,
    SUCCESS_COLOR,
    FAILURE_COLOR
};
