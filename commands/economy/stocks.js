const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const economyService = require('../../services/economyService');
const { EconomyError } = require('../../services/economyService');
const stockService = require('../../services/stockService');
const { StockError } = require('../../services/stockService');
const stockPortfolioService = require('../../services/stockPortfolioService');
const { renderPriceChart, sparkline } = require('../../utils/stockChart');
const usageTracker = require('../../services/usageTracker');

function money(value) {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Build a chart attachment for a symbol's history; falls back to a unicode
 * sparkline string when image rendering fails.
 * @returns {Promise<{attachment: AttachmentBuilder|null, spark: string|null, history}>}
 */
async function buildChart(symbol, range) {
    const history = await stockService.getHistory(symbol, range);
    try {
        const png = await renderPriceChart({
            symbol: history.symbol,
            name: stockService.getSymbolInfo(history.symbol)?.name,
            points: history.points,
            rangeLabel: range
        });
        return { attachment: new AttachmentBuilder(png, { name: `${history.symbol}_${range}.png` }), spark: null, history };
    } catch (error) {
        console.warn('Chart render failed, using sparkline:', error.message);
        return { attachment: null, spark: sparkline(history.points.map(p => p.close)), history };
    }
}

/**
 * The stock trading game: spend guild points on real stocks at live prices
 * (1 point = $1), track buys/sells, and check in on positions with
 * refreshed prices and historical graphs.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('stocks')
        .setDescription('Stock trading game - invest your points at real market prices (1 point = $1).')
        .addSubcommand(sub =>
            sub.setName('quote')
                .setDescription('Current price of a stock')
                .addStringOption(opt => opt.setName('symbol').setDescription('Ticker, e.g. AAPL').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('search')
                .setDescription('Find a ticker by company name')
                .addStringOption(opt => opt.setName('query').setDescription('Company name or ticker fragment').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Buy stock units with your points')
                .addStringOption(opt => opt.setName('symbol').setDescription('Ticker, e.g. AAPL').setRequired(true))
                .addNumberOption(opt => opt.setName('units').setDescription('How many shares (fractions allowed)').setRequired(true).setMinValue(0.0001)))
        .addSubcommand(sub =>
            sub.setName('sell')
                .setDescription('Sell stock units back into points')
                .addStringOption(opt => opt.setName('symbol').setDescription('Ticker you hold').setRequired(true))
                .addNumberOption(opt => opt.setName('units').setDescription('How many shares (omit to sell all)').setMinValue(0.0001)))
        .addSubcommand(sub =>
            sub.setName('portfolio')
                .setDescription('Check in on your positions (refreshes prices)')
                .addUserOption(opt => opt.setName('user').setDescription('Whose portfolio (default: you)')))
        .addSubcommand(sub =>
            sub.setName('chart')
                .setDescription('Historical price graph for a stock')
                .addStringOption(opt => opt.setName('symbol').setDescription('Ticker, e.g. AAPL').setRequired(true))
                .addStringOption(opt => opt.setName('range').setDescription('History window (default 3mo)')
                    .addChoices(
                        { name: '1 month', value: '1mo' },
                        { name: '3 months', value: '3mo' },
                        { name: '6 months', value: '6mo' },
                        { name: '1 year', value: '1y' }
                    )))
        .addSubcommand(sub =>
            sub.setName('trades')
                .setDescription('Your recent buys and sells (ephemeral)')),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'The stock game only works in servers.', ephemeral: true });
            return;
        }

        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const subcommand = interaction.options.getSubcommand();
        const { currencyName } = economyService.getSettings(guildId);

        usageTracker.logCommand({ command: 'stocks', guildId, userId });

        // Everything here can hit the network, so always defer
        const ephemeral = subcommand === 'trades';
        await interaction.deferReply({ ephemeral });

        try {
            if (subcommand === 'quote') {
                const quote = await stockService.getQuote(interaction.options.getString('symbol'));
                const embed = new EmbedBuilder()
                    .setTitle(`📈 ${quote.symbol} - ${quote.name}`)
                    .setColor(0x5865f2)
                    .setDescription(
                        `**$${money(quote.price)}** ${quote.currency && quote.currency !== 'USD' ? `(${quote.currency}) ` : ''}` +
                        `as of ${quote.asOf} UTC${quote.stale ? ' ⚠️ *stale - price source unavailable*' : ''}\n` +
                        `Buying 1 unit costs **${Math.ceil(quote.price).toLocaleString()} ${currencyName}**.`
                    );
                await interaction.editReply({ embeds: [embed] });
            } else if (subcommand === 'search') {
                const results = await stockService.search(interaction.options.getString('query'));
                if (results.length === 0) {
                    await interaction.editReply('No matching symbols found.');
                    return;
                }
                const lines = results.map(r => `**${r.symbol}** - ${r.name}${r.exchange ? ` *(${r.exchange})*` : ''}`);
                const embed = new EmbedBuilder()
                    .setTitle('🔎 Symbol search')
                    .setColor(0x5865f2)
                    .setDescription(lines.join('\n'))
                    .setFooter({ text: 'Buy with /stocks buy symbol:<ticker> units:<n>' });
                await interaction.editReply({ embeds: [embed] });
            } else if (subcommand === 'buy') {
                const trade = await stockPortfolioService.buy({
                    guildId, userId,
                    symbol: interaction.options.getString('symbol'),
                    units: interaction.options.getNumber('units')
                });
                await interaction.editReply(
                    `🛒 Bought **${trade.units} ${trade.symbol}** @ $${money(trade.price)} for ` +
                    `**${trade.cost.toLocaleString()} ${currencyName}**. ` +
                    `You now hold **${trade.holding.units}** units. Balance: **${trade.balance.toLocaleString()}**.`
                );
            } else if (subcommand === 'sell') {
                const trade = await stockPortfolioService.sell({
                    guildId, userId,
                    symbol: interaction.options.getString('symbol'),
                    units: interaction.options.getNumber('units')
                });
                await interaction.editReply(
                    `💵 Sold **${trade.units} ${trade.symbol}** @ $${money(trade.price)} for ` +
                    `**${trade.proceeds.toLocaleString()} ${currencyName}**. ` +
                    `${trade.holding ? `You still hold **${trade.holding.units}** units.` : 'Position closed.'} ` +
                    `Balance: **${trade.balance.toLocaleString()}**.`
                );
            } else if (subcommand === 'portfolio') {
                const target = interaction.options.getUser('user') || interaction.user;
                const portfolio = await stockPortfolioService.getPortfolio({ guildId, userId: target.id });
                if (portfolio.positions.length === 0) {
                    await interaction.editReply(
                        `${target.id === userId ? 'You have' : `${target.username} has`} no stock positions. ` +
                        'Start with `/stocks buy`!'
                    );
                    return;
                }
                const lines = portfolio.positions.map(p => {
                    if (p.price === null) return `**${p.symbol}** - ${p.units} units *(price unavailable)*`;
                    const pl = p.profitLoss;
                    const plText = `${pl >= 0 ? '📈 +' : '📉 '}${money(pl)}`;
                    return `**${p.symbol}** - ${p.units} units @ $${money(p.price)} = **${money(p.value)}** ${currencyName} (${plText})${p.stale ? ' ⚠️' : ''}`;
                });
                const embed = new EmbedBuilder()
                    .setTitle(`💼 ${target.username}'s portfolio`)
                    .setColor(portfolio.totalPL >= 0 ? 0x3ba55d : 0xed4245)
                    .setDescription(lines.join('\n'))
                    .addFields({
                        name: 'Totals',
                        value:
                            `Value: **${money(portfolio.totalValue)} ${currencyName}** · ` +
                            `Invested: **${portfolio.totalCost.toLocaleString()}** · ` +
                            `P/L: **${portfolio.totalPL >= 0 ? '+' : ''}${money(portfolio.totalPL)}**`
                    });
                await interaction.editReply({ embeds: [embed] });
            } else if (subcommand === 'chart') {
                const range = interaction.options.getString('range') || '3mo';
                const { attachment, spark, history } = await buildChart(interaction.options.getString('symbol'), range);
                if (attachment) {
                    await interaction.editReply({ files: [attachment] });
                } else {
                    const first = history.points[0].close;
                    const last = history.points[history.points.length - 1].close;
                    await interaction.editReply(
                        `**${history.symbol}** over ${range}: $${money(first)} → $${money(last)}\n\`${spark}\``
                    );
                }
            } else if (subcommand === 'trades') {
                const trades = stockPortfolioService.getTrades({ guildId, userId, limit: 10 });
                if (trades.length === 0) {
                    await interaction.editReply('No trades yet.');
                    return;
                }
                const lines = trades.map(t =>
                    `\`${t.createdAt}\` ${t.side === 'BUY' ? '🛒' : '💵'} ${t.side} ${t.units} **${t.symbol}** @ $${money(t.price)} (${t.points.toLocaleString()} ${currencyName})`);
                const embed = new EmbedBuilder()
                    .setTitle('🧾 Your recent trades')
                    .setColor(0x5865f2)
                    .setDescription(lines.join('\n'));
                await interaction.editReply({ embeds: [embed] });
            }
        } catch (error) {
            const friendly = error instanceof EconomyError || error instanceof StockError;
            if (!friendly) console.error('Stocks command error:', error);
            await interaction.editReply(friendly ? `❌ ${error.message}` : '❌ Something went wrong with the stock game.');
        }
    }
};
