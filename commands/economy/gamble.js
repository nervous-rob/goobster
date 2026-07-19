const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const gamblingService = require('../../services/gamblingService');
const { EconomyError } = require('../../services/economyService');
const { formatHand } = require('../../utils/pokerHands');
const usageTracker = require('../../services/usageTracker');

const OUTCOME_COLORS = { win: 0x3ba55d, lose: 0xed4245, push: 0x99aab5 };

function outcomeLine(outcome, net, currencyName, balance) {
    const head = outcome === 'win' ? '🎉 **You win!**' : outcome === 'lose' ? '💀 **You lose.**' : '🤝 **Push** - bet returned.';
    const delta = net === 0 ? '±0' : `${net > 0 ? '+' : ''}${net.toLocaleString()}`;
    return `${head} ${delta} ${currencyName} → balance **${balance.toLocaleString()}**`;
}

/**
 * Point gambling: coin flips, d20 showdowns, and 5-card poker against the
 * dealer. All games pay even money and settle through the economy ledger.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('gamble')
        .setDescription('Gamble your points: coin flips, d20 rolls, poker hands.')
        .addSubcommand(sub =>
            sub.setName('coinflip')
                .setDescription('Call heads or tails for even money')
                .addIntegerOption(opt => opt.setName('bet').setDescription('Points to wager').setRequired(true).setMinValue(1))
                .addStringOption(opt => opt.setName('call').setDescription('Your call').setRequired(true)
                    .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })))
        .addSubcommand(sub =>
            sub.setName('d20')
                .setDescription('Roll a d20 against Goobster - higher roll wins')
                .addIntegerOption(opt => opt.setName('bet').setDescription('Points to wager').setRequired(true).setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('poker')
                .setDescription('Five-card showdown against the dealer')
                .addIntegerOption(opt => opt.setName('bet').setDescription('Points to wager').setRequired(true).setMinValue(1))),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'Gambling only works in servers.', ephemeral: true });
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        const bet = interaction.options.getInteger('bet');
        const base = { guildId: interaction.guildId, userId: interaction.user.id, bet };

        usageTracker.logCommand({ command: 'gamble', guildId: interaction.guildId, userId: interaction.user.id });

        try {
            if (subcommand === 'coinflip') {
                const game = gamblingService.coinflip({ ...base, choice: interaction.options.getString('call') });
                const embed = new EmbedBuilder()
                    .setTitle(`🪙 Coin flip - ${game.result}!`)
                    .setColor(OUTCOME_COLORS[game.won ? 'win' : 'lose'])
                    .setDescription(
                        `You called **${interaction.options.getString('call')}**, the coin landed **${game.result}**.\n` +
                        outcomeLine(game.won ? 'win' : 'lose', game.net, game.currencyName, game.balance)
                    );
                await interaction.reply({ embeds: [embed] });
            } else if (subcommand === 'd20') {
                const game = gamblingService.d20(base);
                const embed = new EmbedBuilder()
                    .setTitle('🎲 D20 showdown')
                    .setColor(OUTCOME_COLORS[game.outcome])
                    .setDescription(
                        `You rolled **${game.playerRoll}** 🆚 Goobster rolled **${game.botRoll}**.\n` +
                        outcomeLine(game.outcome, game.net, game.currencyName, game.balance)
                    );
                await interaction.reply({ embeds: [embed] });
            } else if (subcommand === 'poker') {
                const game = gamblingService.poker(base);
                const embed = new EmbedBuilder()
                    .setTitle('🃏 Poker showdown')
                    .setColor(OUTCOME_COLORS[game.outcome])
                    .addFields(
                        { name: `Your hand - ${game.playerHandName}`, value: formatHand(game.playerHand) },
                        { name: `Dealer's hand - ${game.dealerHandName}`, value: formatHand(game.dealerHand) }
                    )
                    .setDescription(outcomeLine(game.outcome, game.net, game.currencyName, game.balance));
                await interaction.reply({ embeds: [embed] });
            }
        } catch (error) {
            const message = error instanceof EconomyError ? `❌ ${error.message}` : '❌ The game hit an error - your points are safe.';
            if (!(error instanceof EconomyError)) console.error('Gamble command error:', error);
            await interaction.reply({ content: message, ephemeral: true });
        }
    }
};
