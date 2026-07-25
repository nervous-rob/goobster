const { SlashCommandBuilder } = require('discord.js');
const characterService = require('../../services/tavern/characterService');
const { STATS, DIFFICULTY } = require('../../services/tavern/content');
const usageTracker = require('../../services/usageTracker');

const MAX_DICE = 20;
const MAX_SIDES = 1000;
const DICE_PATTERN = /^(\d*)d(\d+)([+-]\d+)?$/i;

const statChoices = Object.values(STATS).map(stat => ({ name: stat.name, value: stat.key }));
const dcChoices = Object.entries(DIFFICULTY).map(([name, value]) => ({ name: `${name} (${value})`, value }));

/**
 * Dice: stat checks (d20 + your character's stat vs an optional DC) and
 * free dice expressions like 2d6+1.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('roll')
        .setDescription('Roll dice - stat checks or free expressions.')
        .addSubcommand(sub =>
            sub.setName('check')
                .setDescription('d20 + your character\'s stat, optionally against a difficulty')
                .addStringOption(opt => opt.setName('stat').setDescription('Which stat').setRequired(true).addChoices(...statChoices))
                .addIntegerOption(opt => opt.setName('dc').setDescription('Difficulty to beat').addChoices(...dcChoices)))
        .addSubcommand(sub =>
            sub.setName('dice')
                .setDescription('Roll a dice expression')
                .addStringOption(opt => opt.setName('expression').setDescription('e.g. d20, 2d6+1, 4d8-2').setRequired(true).setMaxLength(20))),

    async execute(interaction) {
        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const subcommand = interaction.options.getSubcommand();
        usageTracker.logCommand({ command: 'roll', guildId, userId });

        if (subcommand === 'check') {
            const statKey = interaction.options.getString('stat');
            const dc = interaction.options.getInteger('dc');
            const stat = STATS[statKey];

            const character = guildId ? characterService.getCharacter(guildId, userId) : null;
            const bonus = character ? character[statKey] : 0;
            const roll = 1 + Math.floor(Math.random() * 20);
            const total = roll + bonus;

            const who = character ? `**${character.name}**` : `**${interaction.user.displayName || interaction.user.username}**`;
            let line = `🎲 ${who} rolls ${stat.emoji} **${stat.name}**: ${roll} + ${bonus} = **${total}**`;
            if (dc !== null) {
                line += ` vs DC ${dc} → **${total >= dc ? 'Success' : 'Failure'}**`;
            }
            if (roll === 20) line += '\n🌟 *Natural 20 - the dice sing.*';
            if (roll === 1) line += '\n💫 *Natural 1 - a complication blooms.*';
            if (!character && guildId) line += '\n*(No character sheet here - rolled flat. `/character create` to add your stats.)*';
            await interaction.reply(line);
            return;
        }

        const expression = interaction.options.getString('expression').trim();
        const match = expression.match(DICE_PATTERN);
        if (!match) {
            await interaction.reply({ content: 'That\'s not a dice expression I recognize - try `d20`, `2d6+1`, or `4d8-2`.', ephemeral: true });
            return;
        }
        const count = Math.max(1, Number(match[1] || 1));
        const sides = Number(match[2]);
        const modifier = Number(match[3] || 0);
        if (count > MAX_DICE || sides < 2 || sides > MAX_SIDES) {
            await interaction.reply({ content: `Keep it to at most ${MAX_DICE} dice with 2-${MAX_SIDES} sides.`, ephemeral: true });
            return;
        }

        const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
        const total = rolls.reduce((sum, r) => sum + r, 0) + modifier;
        const breakdown = count > 1 || modifier !== 0
            ? ` (${rolls.join(' + ')}${modifier !== 0 ? (modifier > 0 ? ` + ${modifier}` : ` - ${Math.abs(modifier)}`) : ''})`
            : '';
        await interaction.reply(`🎲 **${expression}** → **${total}**${breakdown}`);
    }
};
