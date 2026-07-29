const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const economyService = require('../../services/economyService');
const { EconomyError } = require('../../services/economyService');
const { StockError } = require('../../services/stockService');
const exchangeConfig = require('../../services/exchange/exchangeConfig');
const exchangeEvents = require('../../services/exchange/exchangeEvents');
const auditService = require('../../services/exchange/auditService');
const RiskEngine = require('../../services/exchange/riskEngine');
const { ExchangeError } = require('../../services/exchange/errors');
const usageTracker = require('../../services/usageTracker');

const ADMIN_SUBCOMMANDS = new Set(['settings', 'reconcile', 'tick']);

function money(value, currencyName) {
    return `${Math.round(Number(value)).toLocaleString()} ${currencyName}`;
}

/** Resolve display names for a batch of user ids, falling back to the id. */
async function resolveNames(guild, userIds) {
    const names = new Map();
    for (const userId of userIds) {
        try {
            const member = guild.members.cache.get(userId) || await guild.members.fetch(userId);
            names.set(userId, member.displayName || member.user.username);
        } catch {
            names.set(userId, `user ${userId}`);
        }
    }
    return names;
}

/**
 * The exchange's control room: audits anyone can read, integrity checks and
 * market rules for admins, and a manual risk-engine tick for when something
 * needs settling right now.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('exchange')
        .setDescription('Audit the exchange: accounts, the whole market, the engine log, and the rules.')
        .addSubcommand(sub =>
            sub.setName('audit')
                .setDescription('Server-wide audit: money supply, exposure, open interest, concentration'))
        .addSubcommand(sub =>
            sub.setName('account')
                .setDescription("A full audit of one trader's exchange account")
                .addUserOption(opt => opt.setName('user').setDescription('Whose account (default: you)')))
        .addSubcommand(sub =>
            sub.setName('leaderboard')
                .setDescription('Traders ranked by equity - wallet plus positions, minus debt'))
        .addSubcommand(sub =>
            sub.setName('events')
                .setDescription('What the risk engine has been doing')
                .addUserOption(opt => opt.setName('user').setDescription('Only this trader'))
                .addIntegerOption(opt => opt.setName('limit').setDescription('How many entries (1-25)').setMinValue(1).setMaxValue(25)))
        .addSubcommand(sub =>
            sub.setName('reconcile')
                .setDescription('Integrity checks: prove the books add up (Manage Server)'))
        .addSubcommand(sub =>
            sub.setName('tick')
                .setDescription('Run the risk engine now: settle, fill, and mark every account (Manage Server)'))
        .addSubcommand(sub =>
            sub.setName('settings')
                .setDescription('Turn instruments on or off and set the house rules (Manage Server)')
                .addBooleanOption(opt => opt.setName('margin').setDescription('Allow margin accounts, leverage, and short selling'))
                .addBooleanOption(opt => opt.setName('options').setDescription('Allow long calls and puts'))
                .addBooleanOption(opt => opt.setName('zero_dte').setDescription('Allow same-day expiry contracts (needs options on)'))
                .addBooleanOption(opt => opt.setName('predictions').setDescription('Allow event contracts'))
                .addBooleanOption(opt => opt.setName('futures').setDescription('Allow perpetual futures (isolated margin)'))
                .addBooleanOption(opt => opt.setName('optin_override').setDescription('Group events: treat everyone as opted in unless they opted out (default on)'))
                .addBooleanOption(opt => opt.setName('corporate_actions').setDescription('Apply real dividends and splits (default on)'))
                .addNumberOption(opt => opt.setName('max_leverage').setDescription('Highest leverage tier (1-10)').setMinValue(1).setMaxValue(10))
                .addNumberOption(opt => opt.setName('max_perp_leverage').setDescription('Highest perp leverage (1-50)').setMinValue(1).setMaxValue(50))
                .addNumberOption(opt => opt.setName('funding_rate').setDescription('Daily perp funding on notional, e.g. 0.0003').setMinValue(0).setMaxValue(0.05))
                .addNumberOption(opt => opt.setName('interest_rate').setDescription('Annual margin interest, e.g. 0.08 for 8%').setMinValue(0).setMaxValue(2))
                .addNumberOption(opt => opt.setName('borrow_fee').setDescription('Annual short borrow fee, e.g. 0.05').setMinValue(0).setMaxValue(2))
                .addNumberOption(opt => opt.setName('maintenance').setDescription('Maintenance margin on longs, e.g. 0.25').setMinValue(0.05).setMaxValue(1))
                .addNumberOption(opt => opt.setName('short_maintenance').setDescription('Maintenance margin on shorts, e.g. 0.35').setMinValue(0.05).setMaxValue(2))
                .addIntegerOption(opt => opt.setName('grace_minutes').setDescription('Minutes a margin call may sit before liquidation').setMinValue(0).setMaxValue(1440))),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'The exchange only works in servers.', ephemeral: true });
            return;
        }

        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const subcommand = interaction.options.getSubcommand();
        const { currencyName } = economyService.getSettings(guildId);
        usageTracker.logCommand({ command: 'exchange', guildId, userId });

        if (ADMIN_SUBCOMMANDS.has(subcommand) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '❌ That needs the Manage Server permission.', ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: subcommand === 'reconcile' });

        try {
            if (subcommand === 'audit') {
                const audit = await auditService.auditGuild({ guildId });
                const names = await resolveNames(interaction.guild, audit.traders.slice(0, 5).map(trader => trader.userId));
                await interaction.editReply({ embeds: [guildAuditEmbed(audit, names, currencyName)] });

            } else if (subcommand === 'account') {
                const target = interaction.options.getUser('user') || interaction.user;
                const audit = await auditService.auditAccount({ guildId, userId: target.id });
                await interaction.editReply({ embeds: [accountAuditEmbed(audit, target, currencyName)] });

            } else if (subcommand === 'leaderboard') {
                const board = await auditService.leaderboard({ guildId, limit: 10 });
                if (board.length === 0) {
                    await interaction.editReply('Nobody is trading yet.');
                    return;
                }
                const names = await resolveNames(interaction.guild, board.map(trader => trader.userId));
                const lines = board.map((trader, index) =>
                    `**${index + 1}.** ${names.get(trader.userId)} — **${money(trader.equity, currencyName)}** equity ` +
                    `(cash ${Math.round(trader.cash).toLocaleString()}, exposure ${Math.round(trader.exposure).toLocaleString()}` +
                    `${trader.debt > 0 ? `, debt ${Math.round(trader.debt).toLocaleString()}` : ''})` +
                    `${trader.accountType === 'MARGIN' ? ` · ${trader.leverage}x` : ''}${trader.goblinMode ? ' 👺' : ''}` +
                    `${trader.marginCall ? ' 🚨' : ''}`);
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('🏆 Exchange leaderboard')
                        .setColor(0xfaa61a)
                        .setDescription(lines.join('\n'))
                        .setFooter({ text: 'Ranked by equity, so a big wallet funded by a big loan is not a big account.' })]
                });

            } else if (subcommand === 'events') {
                const target = interaction.options.getUser('user');
                const events = exchangeEvents.list({
                    guildId,
                    userId: target?.id || null,
                    limit: interaction.options.getInteger('limit') ?? 15
                });
                if (events.length === 0) {
                    await interaction.editReply('The engine has not done anything here yet.');
                    return;
                }
                const names = await resolveNames(interaction.guild, [...new Set(events.map(event => event.userId).filter(Boolean))]);
                const lines = events.map(event =>
                    `\`${event.createdAt}\` **${event.eventType}**${event.symbol ? ` ${event.symbol}` : ''}` +
                    `${event.userId ? ` · ${names.get(event.userId)}` : ''}` +
                    `${event.amount === null ? '' : ` · ${event.amount >= 0 ? '+' : ''}${event.amount.toLocaleString()}`}`);
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle(`🧾 Exchange event log${target ? ` — ${target.username}` : ''}`)
                        .setColor(0x5865f2)
                        .setDescription(lines.join('\n'))
                        .setFooter({ text: 'Every automatic action the exchange took, and why.' })]
                });

            } else if (subcommand === 'reconcile') {
                const report = auditService.reconcile({ guildId });
                const lines = report.checks.map(check =>
                    `${check.ok ? '✅' : '❌'} **${check.name}** — ${check.description}` +
                    `${check.ok ? '' : `\n  ${check.count} problem(s), e.g. \`${JSON.stringify(check.sample[0])}\``}`);
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle(report.ok ? '✅ The books add up' : '❌ Reconciliation found problems')
                        .setColor(report.ok ? 0x3ba55d : 0xed4245)
                        .setDescription(lines.join('\n').slice(0, 4000))]
                });

            } else if (subcommand === 'tick') {
                const engine = new RiskEngine(interaction.client);
                const result = await engine.runGuild({ guildId });
                await interaction.editReply(
                    '⚙️ Risk engine ran for this server.\n' +
                    `Interest capitalized: **${Math.round(result.interest).toLocaleString()}** · borrow fees: **${Math.round(result.borrowFees).toLocaleString()}**\n` +
                    `Contracts settled: **${result.optionsSettled.length}** · event markets settled: **${result.marketsSettled.length}**\n` +
                    `Orders checked: **${result.orders.checked}** (filled ${result.orders.filled.length}, rejected ${result.orders.rejected.length}, expired ${result.orders.expired.length})\n` +
                    `Margin calls raised: **${result.marginCalls.length}** · forced liquidations: **${result.liquidations.length}**`
                );

            } else if (subcommand === 'settings') {
                const updates = {
                    marginEnabled: interaction.options.getBoolean('margin'),
                    optionsEnabled: interaction.options.getBoolean('options'),
                    zeroDteEnabled: interaction.options.getBoolean('zero_dte'),
                    predictionsEnabled: interaction.options.getBoolean('predictions'),
                    futuresEnabled: interaction.options.getBoolean('futures'),
                    optInOverride: interaction.options.getBoolean('optin_override'),
                    corporateActionsEnabled: interaction.options.getBoolean('corporate_actions'),
                    maxLeverage: interaction.options.getNumber('max_leverage'),
                    maxPerpLeverage: interaction.options.getNumber('max_perp_leverage'),
                    fundingRateDaily: interaction.options.getNumber('funding_rate'),
                    interestRate: interaction.options.getNumber('interest_rate'),
                    borrowFeeRate: interaction.options.getNumber('borrow_fee'),
                    maintenanceMargin: interaction.options.getNumber('maintenance'),
                    shortMaintenanceMargin: interaction.options.getNumber('short_maintenance'),
                    marginCallGraceMinutes: interaction.options.getInteger('grace_minutes')
                };
                const provided = Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== null));
                const settings = Object.keys(provided).length > 0
                    ? exchangeConfig.set(guildId, provided)
                    : exchangeConfig.get(guildId);

                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('⚙️ Exchange rules')
                        .setColor(0x5865f2)
                        .setDescription(
                            `Margin & shorts: **${onOff(settings.marginEnabled)}** · Options: **${onOff(settings.optionsEnabled)}** · ` +
                            `0DTE: **${onOff(settings.zeroDteEnabled)}** · Event contracts: **${onOff(settings.predictionsEnabled)}** · ` +
                            `Perps: **${onOff(settings.futuresEnabled)}**\n` +
                            `Group-event opt-in override: **${onOff(settings.optInOverride)}** (everyone in unless they opt out) · ` +
                            `Corporate actions: **${onOff(settings.corporateActionsEnabled)}**`
                        )
                        .addFields(
                            {
                                name: 'Leverage & financing',
                                value: `Max leverage **${settings.maxLeverage}x** (perps **${settings.maxPerpLeverage}x**)\n` +
                                    `Margin interest **${(settings.interestRate * 100).toFixed(1)}%/yr**\n` +
                                    `Short borrow fee **${(settings.borrowFeeRate * 100).toFixed(1)}%/yr**\n` +
                                    `Perp funding **${(settings.fundingRateDaily * 100).toFixed(3)}%/day**`,
                                inline: true
                            },
                            {
                                name: 'Maintenance',
                                value: `Longs **${(settings.maintenanceMargin * 100).toFixed(0)}%**\nShorts **${(settings.shortMaintenanceMargin * 100).toFixed(0)}%**\n` +
                                    `Call grace **${settings.marginCallGraceMinutes} min**`,
                                inline: true
                            }
                        )
                        .setFooter({ text: Object.keys(provided).length > 0 ? 'Updated.' : 'Nothing changed - pass an option to update a rule.' })]
                });
            }
        } catch (error) {
            const friendly = error instanceof ExchangeError || error instanceof EconomyError || error instanceof StockError;
            if (!friendly) console.error('Exchange command error:', error);
            await interaction.editReply(friendly ? `❌ ${error.message}` : '❌ Something went wrong in the control room.');
        }
    }
};

function onOff(value) {
    return value ? 'on' : 'off';
}

function accountAuditEmbed(audit, target, currencyName) {
    const { snapshot } = audit;
    const embed = new EmbedBuilder()
        .setTitle(`🔍 Account audit — ${target.username}`)
        .setColor(snapshot.marginCall ? 0xed4245 : 0x5865f2)
        .setDescription(
            `**${snapshot.account.accountType}**${snapshot.account.accountType === 'MARGIN' ? ` at ${snapshot.account.leverage}x` : ''}` +
            `${snapshot.account.goblinMode ? ' · 👺 Goblin Mode' : ''}` +
            `${snapshot.account.liquidations > 0 ? ` · ${snapshot.account.liquidations} lifetime liquidation(s)` : ''}\n` +
            `Equity **${money(snapshot.equity, currencyName)}** · buying power **${money(snapshot.buyingPower, currencyName)}** · ` +
            `debt **${money(snapshot.debt, currencyName)}**`
        )
        .addFields(
            {
                name: 'Positions',
                value: [
                    `Longs: ${snapshot.longs.length} (${money(snapshot.longValue, currencyName)})`,
                    `Shorts: ${snapshot.shorts.length} (${money(snapshot.shortValue, currencyName)})`,
                    `Options: ${snapshot.options.length} (${money(snapshot.optionValue, currencyName)})`,
                    `Working orders: ${audit.openOrders.length}`,
                    `Event contracts: ${audit.predictions.length}`
                ].join('\n'),
                inline: true
            },
            {
                name: 'Realized',
                value: [
                    `Options ${signed(audit.realized.options)}`,
                    `Shorts ${signed(audit.realized.shorts)}`,
                    `Events ${signed(audit.realized.predictions)}`,
                    `Financing paid ${Math.round(audit.realized.financingPaid).toLocaleString()}`,
                    `${audit.realized.optionsExpiredWorthless} contract(s) expired worthless`
                ].join('\n'),
                inline: true
            },
            {
                name: 'Ledger',
                value: `${audit.ledger.byType.length} entry types · net ${signed(audit.ledger.net)} · ` +
                    `${audit.ledger.reconciles ? '✅ reconciles with the wallet' : '❌ **does not reconcile**'}`
            }
        );

    if (audit.risks.length > 0) {
        embed.addFields({ name: '⚠️ Risk flags', value: audit.risks.join('\n').slice(0, 1000) });
    }
    if (audit.events.length > 0) {
        embed.addFields({
            name: 'Recent engine activity',
            value: audit.events.slice(0, 5)
                .map(event => `\`${event.createdAt}\` ${event.eventType}${event.symbol ? ` ${event.symbol}` : ''}`)
                .join('\n')
        });
    }
    embed.setFooter({ text: `As of ${audit.asOf} UTC` });
    return embed;
}

function guildAuditEmbed(audit, names, currencyName) {
    const embed = new EmbedBuilder()
        .setTitle('🔍 Exchange audit')
        .setColor(0x5865f2)
        .setDescription(
            `Margin **${onOff(audit.settings.marginEnabled)}** · options **${onOff(audit.settings.optionsEnabled)}** · ` +
            `0DTE **${onOff(audit.settings.zeroDteEnabled)}** · event contracts **${onOff(audit.settings.predictionsEnabled)}**`
        )
        .addFields(
            {
                name: 'Money supply',
                value: `${money(audit.moneySupply.circulating, currencyName)} across ${audit.moneySupply.wallets} wallets\n` +
                    `${money(audit.moneySupply.outstandingLoans, currencyName)} lent out\n` +
                    `Net of debt: ${money(audit.moneySupply.netOfDebt, currencyName)}`,
                inline: true
            },
            {
                name: 'Accounts',
                value: `${audit.accounts.total} on the exchange\n${audit.accounts.margin} on margin · ${audit.accounts.goblinMode} in goblin mode\n` +
                    `${audit.accounts.underMarginCall} under margin call\n${audit.accounts.lifetimeLiquidations} lifetime liquidations`,
                inline: true
            }
        );

    if (audit.longBook.length > 0) {
        embed.addFields({
            name: 'Most-held longs',
            value: audit.longBook.slice(0, 5).map(row => `**${row.symbol}** ${row.holders} holder(s), ${money(row.costBasis, currencyName)} invested`).join('\n'),
            inline: true
        });
    }
    if (audit.shortBook.length > 0) {
        embed.addFields({
            name: 'Most-shorted',
            value: audit.shortBook.slice(0, 5).map(row => `**${row.symbol}** ${row.shorts} short(s), ${money(row.proceeds, currencyName)} credited`).join('\n'),
            inline: true
        });
    }
    if (audit.optionOpenInterest.length > 0) {
        embed.addFields({
            name: 'Option open interest',
            value: audit.optionOpenInterest.slice(0, 5)
                .map(row => `**${row.underlying}** ${row.expiry} ${row.optionType} ×${row.contracts} (${row.traders} trader(s))`).join('\n')
        });
    }
    if (audit.zeroDteOpenInterest.length > 0) {
        const contracts = audit.zeroDteOpenInterest.reduce((sum, row) => sum + row.contracts, 0);
        const premium = audit.zeroDteOpenInterest.reduce((sum, row) => sum + row.premium, 0);
        embed.addFields({
            name: '🔥 Expiring today',
            value: `${contracts} same-day contract(s) with ${money(premium, currencyName)} of premium riding on the close.`
        });
    }
    if (audit.traders.length > 0) {
        embed.addFields({
            name: 'Top traders by equity',
            value: audit.traders.slice(0, 5)
                .map(trader => `${names.get(trader.userId) || trader.userId}: ${money(trader.equity, currencyName)}${trader.marginCall ? ' 🚨' : ''}`)
                .join('\n') +
                `\nConcentration (HHI) **${audit.concentration.hhi}** · top account holds **${(audit.concentration.topShare * 100).toFixed(1)}%**`
        });
    }
    embed.setFooter({
        text: `${audit.workingOrders} working order(s) · ${audit.predictionMarkets.length} open event market(s) · ` +
            `${money(audit.predictionExposure.staked, currencyName)} staked on events`
    });
    return embed;
}

function signed(value) {
    return `${value >= 0 ? '+' : ''}${Math.round(value).toLocaleString()}`;
}
