const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const economyService = require('../../services/economyService');
const { EconomyError } = require('../../services/economyService');
const { StockError } = require('../../services/stockService');
const exchangeConfig = require('../../services/exchange/exchangeConfig');
const perpsService = require('../../services/exchange/perpsService');
const { ExchangeError } = require('../../services/exchange/errors');
const usageTracker = require('../../services/usageTracker');

function money(value) {
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Perpetual futures: isolated-margin leveraged longs and shorts on any USD
 * symbol, crypto pairs included. The posted margin is the whole maximum loss.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('futures')
        .setDescription('Perpetual futures - leveraged longs and shorts, isolated margin, crypto included.')
        .addSubcommand(sub =>
            sub.setName('open')
                .setDescription('Open a perp (the margin you post is the most you can lose)')
                .addStringOption(opt => opt.setName('symbol').setDescription('Ticker, e.g. BTC-USD, ETH-USD, TSLA').setRequired(true))
                .addStringOption(opt => opt.setName('direction').setDescription('Long or short').setRequired(true)
                    .addChoices({ name: 'long', value: 'LONG' }, { name: 'short', value: 'SHORT' }))
                .addIntegerOption(opt => opt.setName('margin').setDescription('Points to post as margin').setRequired(true).setMinValue(1))
                .addNumberOption(opt => opt.setName('leverage').setDescription('e.g. 5 for 5x').setRequired(true).setMinValue(1).setMaxValue(50)))
        .addSubcommand(sub =>
            sub.setName('close')
                .setDescription('Close a perp at the current mark')
                .addIntegerOption(opt => opt.setName('id').setDescription('Position id from /futures positions').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('positions')
                .setDescription('Open perps with live marks and liquidation prices')
                .addUserOption(opt => opt.setName('user').setDescription('Whose positions (default: you)'))),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'The exchange only works in servers.', ephemeral: true });
            return;
        }

        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const subcommand = interaction.options.getSubcommand();
        const { currencyName } = economyService.getSettings(guildId);
        usageTracker.logCommand({ command: 'futures', guildId, userId });

        await interaction.deferReply();

        try {
            if (subcommand === 'open') {
                const settings = exchangeConfig.get(guildId);
                const position = await perpsService.open({
                    guildId, userId,
                    symbol: interaction.options.getString('symbol'),
                    direction: interaction.options.getString('direction'),
                    margin: interaction.options.getInteger('margin'),
                    leverage: interaction.options.getNumber('leverage')
                });
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle(`⚡ ${position.direction} perp on ${position.alias || position.symbol} at ${position.leverage}x`)
                        .setColor(position.direction === 'LONG' ? 0x3ba55d : 0xed4245)
                        .setDescription(
                            `Entry **$${money(position.entryPrice)}** · notional **${position.notional.toLocaleString()} ${currencyName}** ` +
                            `on **${position.margin.toLocaleString()}** of margin\n` +
                            `💀 Liquidation at **$${money(position.liquidationPrice)}** - cross it and the margin is gone.\n` +
                            `Funding rent: **${(settings.fundingRateDaily * 100).toFixed(3)}%/day** of notional, paid out of the margin.\n` +
                            `Max loss: **${position.margin.toLocaleString()} ${currencyName}** (isolated - it can never touch the rest of your account).`
                        )
                        .setFooter({ text: `Position #${position.id} · close with /futures close id:${position.id} · balance ${position.balance.toLocaleString()}` })]
                });

            } else if (subcommand === 'close') {
                const result = await perpsService.close({
                    guildId, userId, id: interaction.options.getInteger('id')
                });
                await interaction.editReply(
                    `🏁 Closed the **${result.position.direction}** perp on **${result.position.symbol}** at **$${money(result.exitPrice)}** ` +
                    `(entry $${money(result.position.entryPrice)}).\n` +
                    `Margin returned: **${result.payout.toLocaleString()} ${currencyName}** · realized **${result.realized >= 0 ? '+' : ''}${result.realized.toLocaleString()}**` +
                    `${result.funding >= 1 ? ` · funding paid ${Math.round(result.funding).toLocaleString()}` : ''}.`
                );

            } else if (subcommand === 'positions') {
                const target = interaction.options.getUser('user') || interaction.user;
                const accountService = require('../../services/exchange/accountService');
                const snapshot = await accountService.getSnapshot({ guildId, userId: target.id });
                if (snapshot.perps.length === 0) {
                    await interaction.editReply(`${target.id === userId ? 'You have' : `${target.username} has`} no open perps.`);
                    return;
                }
                const lines = snapshot.perps.map(perp => {
                    const mark = perp.priced ? `$${money(perp.price)}` : '*(unpriced)*';
                    const pl = perp.unrealized === null ? '' : ` · P/L **${perp.unrealized >= 0 ? '+' : ''}${Math.round(perp.unrealized).toLocaleString()}**`;
                    return `\`#${perp.id}\` **${perp.direction} ${perp.symbol}** ${perp.leverage}x — entry $${money(perp.entryPrice)}, now ${mark}${pl}\n` +
                        `  margin ${perp.margin.toLocaleString()} · 💀 liq $${money(perp.liquidationPrice)}` +
                        `${perp.fundingAccrued >= 1 ? ` · funding owed ${Math.round(perp.fundingAccrued).toLocaleString()}` : ''}`;
                });
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle(`⚡ ${target.username}'s perps`)
                        .setColor(0x5865f2)
                        .setDescription(lines.join('\n'))
                        .setFooter({ text: `Perp book value ${Math.round(snapshot.perpValue).toLocaleString()} ${currencyName} (isolated margin)` })]
                });
            }
        } catch (error) {
            const friendly = error instanceof ExchangeError || error instanceof EconomyError || error instanceof StockError;
            if (!friendly) console.error('Futures command error:', error);
            await interaction.editReply(friendly ? `❌ ${error.message}` : '❌ Something went wrong at the futures desk.');
        }
    }
};
