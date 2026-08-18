const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const economyService = require('@goobster/core/services/economyService');
const { EconomyError } = require('@goobster/core/services/economyService');
const { StockError } = require('@goobster/core/services/stockService');
const optionsMarket = require('@goobster/core/services/exchange/optionsMarket');
const optionsService = require('@goobster/core/services/exchange/optionsService');
const accountService = require('@goobster/core/services/exchange/accountService');
const { ExchangeError } = require('@goobster/core/services/exchange/errors');
const usageTracker = require('@goobster/core/services/usageTracker');

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
            sub.setName('write')
                .setDescription('Sell to open (write) a call or put - collects premium, owes the settlement')
                .addStringOption(opt => opt.setName('symbol').setDescription('Ticker or index, e.g. SPX').setRequired(true))
                .addStringOption(opt => opt.setName('type').setDescription('Call or put').setRequired(true)
                    .addChoices({ name: 'call', value: 'CALL' }, { name: 'put', value: 'PUT' }))
                .addNumberOption(opt => opt.setName('strike').setDescription('Strike price').setRequired(true).setMinValue(0.01))
                .addStringOption(opt => opt.setName('expiry').setDescription('Expiry date YYYY-MM-DD').setRequired(true))
                .addIntegerOption(opt => opt.setName('contracts').setDescription('How many contracts (100 shares each)').setRequired(true).setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('buyback')
                .setDescription('Buy to close a contract you wrote')
                .addIntegerOption(opt => opt.setName('id').setDescription('Position id from /options positions').setRequired(true))
                .addIntegerOption(opt => opt.setName('contracts').setDescription('How many (omit to close all)').setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('spread')
                .setDescription('Multi-leg order with a pre-trade receipt - verticals, condors, straddles, butterflies')
                .addStringOption(opt => opt.setName('symbol').setDescription('Underlying, e.g. SPCX').setRequired(true))
                .addStringOption(opt => opt.setName('legs').setDescription('e.g. "buy 100p, sell 76p, buy 130c, sell 155c"').setRequired(true))
                .addStringOption(opt => opt.setName('expiry').setDescription('Expiry date YYYY-MM-DD for all legs').setRequired(true))
                .addIntegerOption(opt => opt.setName('contracts').setDescription('Contracts per leg (default 1; "x2" in a leg overrides)').setMinValue(1))
                .addBooleanOption(opt => opt.setName('fire').setDescription('true = execute; default false shows the receipt only')))
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

            } else if (subcommand === 'write') {
                const fill = await optionsService.sellToOpen({
                    guildId, userId,
                    symbol: interaction.options.getString('symbol'),
                    optionType: interaction.options.getString('type'),
                    strike: interaction.options.getNumber('strike'),
                    expiry: interaction.options.getString('expiry'),
                    contracts: interaction.options.getInteger('contracts')
                });
                const { contract } = fill;
                const embed = new EmbedBuilder()
                    .setTitle(`✍️ Wrote ${fill.contracts}x ${contract.underlyingAlias || contract.underlying} ${contract.strike} ${contract.optionType} ${contract.expiry}`)
                    .setColor(0xed4245)
                    .setDescription(
                        `Collected **$${money(contract.bid)}**/share = **${fill.credit.toLocaleString()} ${currencyName}** · balance **${fill.balance.toLocaleString()}**\n` +
                        `Margin requirement: **${Math.ceil(fill.requirement).toLocaleString()}** ` +
                        `${fill.requirement === 0 ? '(covered)' : ''}\n` +
                        `⚠️ Max loss: **${fill.maxLoss === null ? 'UNBOUNDED - the underlying has no ceiling' : `${fill.maxLoss.toLocaleString()} ${currencyName}`}**. ` +
                        `At the ${contract.expiry} bell you pay the intrinsic value (assignment), borrowed onto your loan if the wallet can't.`
                    )
                    .addFields({ name: 'Position id', value: `\`${fill.positionId}\` (close with \`/options buyback id:${fill.positionId}\`)` });
                await interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'buyback') {
                const close = await optionsService.buyToClose({
                    guildId, userId,
                    positionId: interaction.options.getInteger('id'),
                    contracts: interaction.options.getInteger('contracts')
                });
                await interaction.editReply(
                    `🧾 Bought back **${close.contracts}x ${close.contract.underlying} ${close.contract.strike} ${close.contract.optionType}** at ` +
                    `$${money(close.contract.ask)} for **${close.cost.toLocaleString()} ${currencyName}** ` +
                    `(realized **${close.realized >= 0 ? '+' : ''}${close.realized.toLocaleString()}** vs the premium collected). ` +
                    `${close.position && close.position.status === 'OPEN' ? `Still short ${close.position.contracts}.` : 'Contract retired.'} ` +
                    `Balance: **${close.balance.toLocaleString()}**.`
                );

            } else if (subcommand === 'spread') {
                const spreadService = require('@goobster/core/services/exchange/spreadService');
                const { parseLegText } = require('@goobster/core/services/exchange/spreadService');
                const legs = parseLegText(interaction.options.getString('legs'), {
                    expiry: interaction.options.getString('expiry'),
                    contracts: interaction.options.getInteger('contracts') ?? 1
                });
                const symbol = interaction.options.getString('symbol');
                const fire = interaction.options.getBoolean('fire') ?? false;

                if (!fire) {
                    const receipt = await spreadService.quote({ guildId, symbol, legs });
                    await interaction.editReply({ embeds: [spreadReceiptEmbed(receipt, currencyName, { fired: false })] });
                    return;
                }
                const result = await spreadService.execute({ guildId, userId, symbol, legs });
                const embed = spreadReceiptEmbed(result.receipt, currencyName, { fired: true });
                embed.addFields({
                    name: '🔥 FIRED',
                    value: result.fills.map(fill =>
                        `${fill.action === 'BUY' ? '🟢' : '🔴'} ${fill.action.toLowerCase()} ${fill.contracts}x ${fill.strike} ${fill.optionType} → position \`#${fill.positionId}\``).join('\n') +
                        `\nNet **${Math.abs(result.netPoints).toLocaleString()} ${currencyName} ${result.receipt.netLabel}** · balance **${result.balance.toLocaleString()}**`
                });
                await interaction.editReply({ embeds: [embed] });

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
                    const header = `\`#${option.id}\` **${option.side === 'SHORT' ? '✍️ short ' : ''}${option.contracts}x ${option.underlying} ${option.strike} ${option.optionType}** ${option.expiry}${option.zeroDte ? ' 🔥0DTE' : ''}`;
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

/** Jimbo's pre-trade receipt: every leg, the net, the outcomes, the caveats. */
function spreadReceiptEmbed(receipt, currencyName, { fired }) {
    const legLines = receipt.legs.map(leg =>
        `${leg.action === 'BUY' ? '🟢 buy' : '🔴 sell'} **${leg.contracts}x ${leg.strike} ${leg.optionType}** ${leg.expiry}` +
        `${leg.zeroDte ? ' 🔥0DTE' : ''} @ $${money(leg.premium)} → ${leg.points >= 0 ? `-${leg.points.toLocaleString()}` : `+${Math.abs(leg.points).toLocaleString()}`} ${currencyName}`);
    const embed = new EmbedBuilder()
        .setTitle(`${fired ? '🧾' : '📋'} ${receipt.structure} on ${receipt.label} — ${fired ? 'order ticket' : 'pre-trade receipt'}`)
        .setColor(fired ? 0x3ba55d : 0xfaa61a)
        .setDescription(
            `Spot **$${money(receipt.spot)}** · priced ${receipt.pricedAt} UTC *(simulated premiums)*\n${legLines.join('\n')}\n` +
            `**Net ${Math.abs(receipt.netPoints).toLocaleString()} ${currencyName} ${receipt.netLabel}**`
        )
        .addFields(
            {
                name: 'Outcomes at expiry',
                value:
                    `Max gain: **${receipt.unboundedGain ? 'unbounded' : `${receipt.maxGain.toLocaleString()}`}**\n` +
                    `Max loss: **${receipt.unboundedLoss ? 'UNBOUNDED' : `${Math.abs(receipt.maxLoss).toLocaleString()}`}**\n` +
                    `Break-even${receipt.breakEvens.length === 1 ? '' : 's'}: **${receipt.breakEvens.length > 0 ? receipt.breakEvens.map(be => `$${money(be)}`).join(' and ') : 'none - one side always wins'}**`,
                inline: true
            },
            {
                name: 'Requirements',
                value:
                    `Collateral: **${receipt.collateralRequired.toLocaleString()} ${currencyName}**\n` +
                    `${receipt.needsMarginAccount ? 'Needs a **margin account** (written legs)' : 'Cash account is fine (all legs long)'}`,
                inline: true
            }
        );
    if (receipt.zeroDte) {
        embed.addFields({
            name: '⚠️ Same-day legs',
            value: 'At least one leg expires TODAY and is most likely worth 0 at the bell. Goblin Mode required.'
        });
    }
    if (!fired) {
        embed.setFooter({ text: 'This was a preview - nothing moved. Re-run with fire:true to hit the big red button.' });
    } else {
        embed.setFooter({ text: 'Settlement and assignment run automatically at each expiry; every leg is in the immutable ledger.' });
    }
    return embed;
}

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
