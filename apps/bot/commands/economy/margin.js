const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const economyService = require('@goobster/core/services/economyService');
const { EconomyError } = require('@goobster/core/services/economyService');
const { StockError } = require('@goobster/core/services/stockService');
const exchangeConfig = require('@goobster/core/services/exchange/exchangeConfig');
const accountService = require('@goobster/core/services/exchange/accountService');
const { ExchangeError } = require('@goobster/core/services/exchange/errors');
const usageTracker = require('@goobster/core/services/usageTracker');

function money(value) {
    return Math.round(Number(value)).toLocaleString();
}

/**
 * The leverage desk: switch between a cash and a margin account, pick a
 * leverage tier, repay the loan, and read the risk numbers - including the
 * price at which the exchange starts selling for you.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('margin')
        .setDescription('Margin account: leverage, buying power, loans, and your liquidation levels.')
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Equity, buying power, debt, and how far the market can move against you')
                .addUserOption(opt => opt.setName('user').setDescription('Whose account (default: you)')))
        .addSubcommand(sub =>
            sub.setName('account')
                .setDescription('Switch between a cash and a margin account')
                .addStringOption(opt => opt.setName('type').setDescription('Account type').setRequired(true)
                    .addChoices({ name: 'cash', value: 'CASH' }, { name: 'margin', value: 'MARGIN' })))
        .addSubcommand(sub =>
            sub.setName('leverage')
                .setDescription('Set your leverage tier')
                .addNumberOption(opt => opt.setName('multiple').setDescription('e.g. 2 for 2x').setRequired(true).setMinValue(1).setMaxValue(10)))
        .addSubcommand(sub =>
            sub.setName('borrow')
                .setDescription('Draw points from your margin loan')
                .addIntegerOption(opt => opt.setName('points').setDescription('How many points').setRequired(true).setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('repay')
                .setDescription('Repay your margin loan')
                .addIntegerOption(opt => opt.setName('points').setDescription('How many points (omit to repay as much as you can)').setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('goblin')
                .setDescription('Goblin Mode: deliberately unlock same-day (0DTE) contracts')
                .addBooleanOption(opt => opt.setName('enabled').setDescription('On or off').setRequired(true))),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'The exchange only works in servers.', ephemeral: true });
            return;
        }

        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const subcommand = interaction.options.getSubcommand();
        const { currencyName } = economyService.getSettings(guildId);
        usageTracker.logCommand({ command: 'margin', guildId, userId });

        await interaction.deferReply();

        try {
            if (subcommand === 'status') {
                const target = interaction.options.getUser('user') || interaction.user;
                const snapshot = await accountService.getSnapshot({ guildId, userId: target.id });
                await interaction.editReply({ embeds: [statusEmbed(snapshot, target, currencyName)] });

            } else if (subcommand === 'account') {
                const type = interaction.options.getString('type');
                const account = accountService.setAccountType({ guildId, userId, accountType: type });
                const settings = exchangeConfig.get(guildId);
                await interaction.editReply(
                    type === 'MARGIN'
                        ? `🏦 Margin account enabled at **${account.leverage}x** (server maximum ${settings.maxLeverage}x). ` +
                          `Borrowing costs **${(settings.interestRate * 100).toFixed(1)}%/yr**, and the exchange liquidates you if equity falls below ` +
                          `**${(settings.maintenanceMargin * 100).toFixed(0)}%** of your stock exposure. Check \`/margin status\` before every leveraged order.`
                        : '💵 Switched back to a cash account. You can only spend points you actually have - which is a perfectly respectable way to live.'
                );

            } else if (subcommand === 'leverage') {
                const account = accountService.setLeverage({
                    guildId, userId, leverage: interaction.options.getNumber('multiple')
                });
                const snapshot = await accountService.getSnapshot({ guildId, userId });
                await interaction.editReply(
                    `⚙️ Leverage set to **${account.leverage}x**. Buying power: **${money(snapshot.buyingPower)} ${currencyName}** ` +
                    `on **${money(snapshot.equity)}** of equity.`
                );

            } else if (subcommand === 'borrow') {
                const points = interaction.options.getInteger('points');
                const snapshot = await accountService.getSnapshot({ guildId, userId });
                if (snapshot.buyingPower < points) {
                    await interaction.editReply(
                        `❌ That exceeds your buying power (**${money(snapshot.buyingPower)} ${currencyName}** at ${snapshot.account.leverage}x).`
                    );
                    return;
                }
                const loan = accountService.borrow({ guildId, userId, amount: points, reason: 'manual draw' });
                await interaction.editReply(
                    `🏦 Borrowed **${points.toLocaleString()} ${currencyName}**. Outstanding loan: **${loan.toLocaleString()}**. ` +
                    'Interest accrues continuously and capitalizes into the loan - it does not wait for you to have the points.'
                );

            } else if (subcommand === 'repay') {
                const result = accountService.repay({ guildId, userId, amount: interaction.options.getInteger('points') });
                await interaction.editReply(
                    `✅ Repaid **${result.repaid.toLocaleString()} ${currencyName}**. ` +
                    `${result.loan > 0 ? `Loan remaining: **${result.loan.toLocaleString()}**.` : 'Loan cleared.'} ` +
                    `Balance: **${result.balance.toLocaleString()}**.`
                );

            } else if (subcommand === 'goblin') {
                const enabled = interaction.options.getBoolean('enabled');
                accountService.setGoblinMode({ guildId, userId, enabled });
                await interaction.editReply(
                    enabled
                        ? '👺 **Goblin Mode on.** Same-day (0DTE) contracts are unlocked.\n' +
                          'You are acknowledging that these expire today, that the most likely value at the bell is **0**, ' +
                          'and that gamma cuts both ways. Every 0DTE purchase will still show you the max loss and the odds before it fills.'
                        : '😇 Goblin Mode off. Same-day contracts are locked again; existing positions are untouched.'
                );
            }
        } catch (error) {
            const friendly = error instanceof ExchangeError || error instanceof EconomyError || error instanceof StockError;
            if (!friendly) console.error('Margin command error:', error);
            await interaction.editReply(friendly ? `❌ ${error.message}` : '❌ Something went wrong at the leverage desk.');
        }
    }
};

function statusEmbed(snapshot, target, currencyName) {
    const embed = new EmbedBuilder()
        .setTitle(`🏦 ${target.username}'s exchange account`)
        .setColor(snapshot.marginCall ? 0xed4245 : snapshot.account.accountType === 'MARGIN' ? 0xfaa61a : 0x3ba55d)
        .setDescription(
            `**${snapshot.account.accountType}** account${snapshot.account.accountType === 'MARGIN' ? ` at **${snapshot.account.leverage}x**` : ''}` +
            `${snapshot.account.goblinMode ? ' · 👺 Goblin Mode' : ''}` +
            `${snapshot.marginCall ? '\n🚨 **MARGIN CALL** - equity is below the maintenance requirement.' : ''}`
        )
        .addFields(
            {
                name: 'Balance sheet',
                value:
                    `Cash **${money(snapshot.cash)}**\nLongs **${money(snapshot.longValue)}**\n` +
                    `Options **${money(snapshot.optionValue)}**\nShorts **-${money(snapshot.shortValue)}**\n` +
                    `Debt **-${money(snapshot.debt)}**`,
                inline: true
            },
            {
                name: 'Risk',
                value:
                    `Equity **${money(snapshot.equity)}**\nBuying power **${money(snapshot.buyingPower)}**\n` +
                    `Maintenance **${money(snapshot.maintenance)}**\nExcess **${money(snapshot.excessLiquidity)}**\n` +
                    `Leverage used **${snapshot.leverageUsed === null ? 'n/a' : `${snapshot.leverageUsed.toFixed(2)}x`}**`,
                inline: true
            }
        );

    if (snapshot.marginMove && snapshot.marginMove.drop > 0) {
        embed.addFields({
            name: 'Distance to a margin call',
            value: `A **${(snapshot.marginMove.drop * 100).toFixed(1)}%** adverse move across this book triggers one. ` +
                '(First-order estimate - option convexity means a fast move bites sooner.)'
        });
    }
    if (snapshot.liquidationLevels.length > 0) {
        embed.addFields({
            name: 'Liquidation levels',
            value: snapshot.liquidationLevels
                .map(level => `${level.symbol} ${level.direction === 'LONG' ? 'below' : 'above'} **$${level.price.toFixed(2)}**`)
                .join(' · ')
        });
    }
    if (snapshot.pricingGaps > 0) {
        embed.setFooter({ text: `${snapshot.pricingGaps} position(s) could not be priced - these numbers are incomplete.` });
    } else {
        embed.setFooter({ text: `1 point = $1 · all values in ${currencyName}` });
    }
    return embed;
}
