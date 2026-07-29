const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const economyService = require('../../services/economyService');
const { EconomyError } = require('../../services/economyService');
const { StockError } = require('../../services/stockService');
const optionsMarket = require('../../services/exchange/optionsMarket');
const optionsService = require('../../services/exchange/optionsService');
const accountService = require('../../services/exchange/accountService');
const { ExchangeError } = require('../../services/exchange/errors');
const usageTracker = require('../../services/usageTracker');

function money(value) {
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function percent(value) {
    return `${(value * 100).toFixed(1)}%`;
}

/** The warning every contract purchase carries, sized to how doomed it is. */
function riskLine(contract, cost) {
    const odds = `${percent(contract.probabilityOfProfit)} chance of finishing past break-even ($${money(contract.breakEven)})`;
    if (contract.zeroDte) {
        return `⚠️ **Same-day contract.** This expires in ${(contract.daysToExpiry * 24).toFixed(1)} hours and the most likely value at the bell is **0**. ` +
            `Max loss: **${cost.toLocaleString()}** points. ${odds}. Are you here for a thesis, or a thunderstorm?`;
    }
    return `Max loss: **${cost.toLocaleString()}** points (the premium). ${odds}.`;
}

/**
 * The options wing of the Jimbucks Exchange: browse simulated chains off real
 * underlyings, buy long calls and puts, watch the greeks, and close early.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('options')
        .setDescription('Options trading - long calls and puts on real underlyings, priced in points.')
        .addSubcommand(sub =>
            sub.setName('chain')
                .setDescription('Option chain for a symbol (calls and puts around the money)')
                .addStringOption(opt => opt.setName('symbol').setDescription('Ticker or index, e.g. AAPL or SPX').setRequired(true))
                .addStringOption(opt => opt.setName('expiry').setDescription('Expiry date YYYY-MM-DD (default: the nearest one)'))
                .addIntegerOption(opt => opt.setName('depth').setDescription('Strikes each side of the money (1-8)').setMinValue(1).setMaxValue(8)))
        .addSubcommand(sub =>
            sub.setName('quote')
                .setDescription('Price one contract, with greeks and probabilities')
                .addStringOption(opt => opt.setName('symbol').setDescription('Ticker or index, e.g. SPX').setRequired(true))
                .addStringOption(opt => opt.setName('type').setDescription('Call or put').setRequired(true)
                    .addChoices({ name: 'call', value: 'CALL' }, { name: 'put', value: 'PUT' }))
                .addNumberOption(opt => opt.setName('strike').setDescription('Strike price').setRequired(true).setMinValue(0.01))
                .addStringOption(opt => opt.setName('expiry').setDescription('Expiry date YYYY-MM-DD').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('expiries')
                .setDescription('Which expiries are tradable right now'))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Buy to open a long call or put')
                .addStringOption(opt => opt.setName('symbol').setDescription('Ticker or index, e.g. SPX').setRequired(true))
                .addStringOption(opt => opt.setName('type').setDescription('Call or put').setRequired(true)
                    .addChoices({ name: 'call', value: 'CALL' }, { name: 'put', value: 'PUT' }))
                .addNumberOption(opt => opt.setName('strike').setDescription('Strike price').setRequired(true).setMinValue(0.01))
                .addStringOption(opt => opt.setName('expiry').setDescription('Expiry date YYYY-MM-DD').setRequired(true))
                .addIntegerOption(opt => opt.setName('contracts').setDescription('How many contracts (100 shares each)').setRequired(true).setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('close')
                .setDescription('Sell to close a contract you hold')
                .addIntegerOption(opt => opt.setName('id').setDescription('Position id from /options positions').setRequired(true))
                .addIntegerOption(opt => opt.setName('contracts').setDescription('How many (omit to close all)').setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('positions')
                .setDescription('Your open contracts with live greeks and P/L')
                .addUserOption(opt => opt.setName('user').setDescription('Whose positions (default: you)')))
        .addSubcommand(sub =>
            sub.setName('history')
                .setDescription('Your recent option fills and settlements (ephemeral)')),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'The exchange only works in servers.', ephemeral: true });
            return;
        }

        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const subcommand = interaction.options.getSubcommand();
        const { currencyName } = economyService.getSettings(guildId);
        usageTracker.logCommand({ command: 'options', guildId, userId });

        await interaction.deferReply({ ephemeral: subcommand === 'history' });

        try {
            if (subcommand === 'chain') {
                const chain = await optionsMarket.buildChain({
                    symbol: interaction.options.getString('symbol'),
                    expiry: interaction.options.getString('expiry'),
                    depth: interaction.options.getInteger('depth') ?? 4,
                    guildId
                });
                const lines = chain.rows.map(row => {
                    const marker = Math.abs(row.strike - chain.spot) < optionsMarket.strikeIncrement(chain.spot) / 2 ? '**' : '';
                    return `${marker}${row.strike}${marker} · call $${money(row.call.ask)} (Δ${row.call.greeks.delta.toFixed(2)}) · put $${money(row.put.ask)} (Δ${row.put.greeks.delta.toFixed(2)})`;
                });
                const embed = new EmbedBuilder()
                    .setTitle(`⛓️ ${chain.label} option chain · ${chain.expiry}${chain.zeroDte ? ' · 0DTE' : ''}`)
                    .setColor(chain.zeroDte ? 0xed4245 : 0x5865f2)
                    .setDescription(`Spot **$${money(chain.spot)}**${chain.stale ? ' ⚠️ *stale*' : ''}\n${lines.join('\n')}`)
                    .addFields({
                        name: 'Other expiries',
                        value: chain.expiries.map(entry => `\`${entry.expiry}\` ${entry.label}`).join(' · ')
                    })
                    .setFooter({ text: 'Premiums are simulated from the real underlying (Black-Scholes). Ask prices shown; 1 contract = 100 shares.' });
                await interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'quote') {
                const contract = await optionsMarket.quoteContract({
                    symbol: interaction.options.getString('symbol'),
                    optionType: interaction.options.getString('type'),
                    strike: interaction.options.getNumber('strike'),
                    expiry: interaction.options.getString('expiry'),
                    guildId
                });
                await interaction.editReply({ embeds: [contractEmbed(contract, currencyName)] });

            } else if (subcommand === 'expiries') {
                const expiries = optionsMarket.listExpiries({});
                await interaction.editReply(
                    `📅 Tradable expiries: ${expiries.map(entry => `\`${entry.expiry}\` (${entry.label})`).join(', ')}\n` +
                    'Same-day contracts need the server switch **and** Goblin Mode (`/margin goblin`).'
                );

            } else if (subcommand === 'buy') {
                const fill = await optionsService.buyToOpen({
                    guildId, userId,
                    symbol: interaction.options.getString('symbol'),
                    optionType: interaction.options.getString('type'),
                    strike: interaction.options.getNumber('strike'),
                    expiry: interaction.options.getString('expiry'),
                    contracts: interaction.options.getInteger('contracts')
                });
                const { contract } = fill;
                const embed = new EmbedBuilder()
                    .setTitle(`🎟️ Bought ${fill.contracts}x ${contract.underlyingAlias || contract.underlying} ${contract.strike} ${contract.optionType} ${contract.expiry}`)
                    .setColor(contract.zeroDte ? 0xed4245 : 0x3ba55d)
                    .setDescription(
                        `Premium **$${money(contract.ask)}**/share · cost **${fill.cost.toLocaleString()} ${currencyName}** · balance **${fill.balance.toLocaleString()}**\n` +
                        riskLine(contract, fill.cost)
                    )
                    .addFields(
                        { name: 'Greeks', value: greekText(contract), inline: true },
                        { name: 'Spot / IV', value: `$${money(contract.spot)} · ${percent(contract.iv)}`, inline: true },
                        { name: 'Position id', value: `\`${fill.positionId}\` (close with \`/options close id:${fill.positionId}\`)`, inline: false }
                    );
                await interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'close') {
                const close = await optionsService.sellToClose({
                    guildId, userId,
                    positionId: interaction.options.getInteger('id'),
                    contracts: interaction.options.getInteger('contracts')
                });
                await interaction.editReply(
                    `💵 Closed **${close.contracts}x ${close.contract.underlying} ${close.contract.strike} ${close.contract.optionType}** at ` +
                    `$${money(close.contract.bid)} for **${close.proceeds.toLocaleString()} ${currencyName}** ` +
                    `(realized **${close.realized >= 0 ? '+' : ''}${close.realized.toLocaleString()}**). ` +
                    `${close.position && close.position.status === 'OPEN' ? `Still holding ${close.position.contracts}.` : 'Position closed.'} ` +
                    `Balance: **${close.balance.toLocaleString()}**.`
                );

            } else if (subcommand === 'positions') {
                const target = interaction.options.getUser('user') || interaction.user;
                const snapshot = await accountService.getSnapshot({ guildId, userId: target.id });
                if (snapshot.options.length === 0) {
                    await interaction.editReply(
                        `${target.id === userId ? 'You have' : `${target.username} has`} no open contracts. Start with \`/options chain\`.`
                    );
                    return;
                }
                const lines = snapshot.options.map(option => {
                    const header = `\`#${option.id}\` **${option.contracts}x ${option.underlying} ${option.strike} ${option.optionType}** ${option.expiry}${option.zeroDte ? ' 🔥0DTE' : ''}`;
                    if (!option.priced) return `${header} — paid $${money(option.openPremium)} *(price unavailable)*`;
                    return `${header}\n  paid $${money(option.openPremium)} → now $${money(option.mark)} · ` +
                        `P/L **${option.profitLoss >= 0 ? '+' : ''}${money(option.profitLoss)}** · ` +
                        `Δ${option.greeks.delta.toFixed(2)} Θ${option.greeks.theta.toFixed(2)}/day · ${percent(option.probabilityItm)} ITM odds`;
                });
                const embed = new EmbedBuilder()
                    .setTitle(`🎟️ ${target.username}'s contracts`)
                    .setColor(snapshot.options.some(option => option.zeroDte) ? 0xed4245 : 0x5865f2)
                    .setDescription(lines.join('\n'))
                    .setFooter({ text: `Option book value ${Math.round(snapshot.optionValue).toLocaleString()} ${currencyName} · premium at risk ${snapshot.options.reduce((sum, o) => sum + o.costBasis, 0).toLocaleString()}` });
                await interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'history') {
                const trades = optionsService.listTrades({ guildId, userId, limit: 12 });
                if (trades.length === 0) {
                    await interaction.editReply('No option activity yet.');
                    return;
                }
                const lines = trades.map(trade =>
                    `\`${trade.createdAt}\` ${trade.action.replace(/_/g, ' ').toLowerCase()} ${trade.contracts}x **${trade.underlying} ${trade.strike} ${trade.optionType}** ` +
                    `${trade.expiry} @ $${money(trade.premium)} (${trade.points.toLocaleString()} ${currencyName})`);
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setTitle('🧾 Option history').setColor(0x5865f2).setDescription(lines.join('\n'))]
                });
            }
        } catch (error) {
            const friendly = error instanceof ExchangeError || error instanceof EconomyError || error instanceof StockError;
            if (!friendly) console.error('Options command error:', error);
            await interaction.editReply(friendly ? `❌ ${error.message}` : '❌ Something went wrong in the options wing.');
        }
    }
};

function greekText(contract) {
    return `Δ ${contract.greeks.delta.toFixed(3)}\nΓ ${contract.greeks.gamma.toFixed(5)}\n` +
        `Θ ${contract.greeks.theta.toFixed(3)}/day\nV ${contract.greeks.vega.toFixed(3)}`;
}

function contractEmbed(contract, currencyName) {
    return new EmbedBuilder()
        .setTitle(`🎯 ${contract.underlyingAlias || contract.underlying} ${contract.strike} ${contract.optionType} ${contract.expiry}${contract.zeroDte ? ' · 0DTE' : ''}`)
        .setColor(contract.zeroDte ? 0xed4245 : 0x5865f2)
        .setDescription(
            `Spot **$${money(contract.spot)}**${contract.stale ? ' ⚠️ *stale*' : ''} · IV **${percent(contract.iv)}** · ` +
            `${contract.daysToExpiry < 1 ? `${(contract.daysToExpiry * 24).toFixed(1)} hours` : `${contract.daysToExpiry.toFixed(1)} days`} to expiry\n` +
            `Bid **$${money(contract.bid)}** / Ask **$${money(contract.ask)}** · one contract costs **${contract.costPerContract.toLocaleString()} ${currencyName}**`
        )
        .addFields(
            { name: 'Greeks', value: greekText(contract), inline: true },
            {
                name: 'Outcomes',
                value: `Break-even $${money(contract.breakEven)}\nMax loss ${contract.costPerContract.toLocaleString()}/contract\n` +
                    `Max profit ${contract.optionType === 'CALL' ? 'unbounded' : `${Math.floor(contract.strike * contract.contractSize).toLocaleString()}/contract`}`,
                inline: true
            },
            {
                name: 'Odds',
                value: `${percent(contract.probabilityItm)} finishes in the money\n${percent(contract.probabilityOfProfit)} finishes profitable`,
                inline: true
            }
        )
        .setFooter({ text: 'Simulated premium: Black-Scholes on the real underlying, with a volatility smile and a house spread.' });
}
