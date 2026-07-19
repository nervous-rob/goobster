const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const economyService = require('../../services/economyService');
const { EconomyError } = require('../../services/economyService');
const usageTracker = require('../../services/usageTracker');

/**
 * The guild point currency: balances, daily claims, transfers, leaderboard,
 * ledger history, and admin knobs (currency name, starting balance, daily
 * amount, grants). The currency can be named anything (e.g. "Jimmy points").
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('points')
        .setDescription('Your server point currency - balance, daily claim, transfers, leaderboard.')
        .addSubcommand(sub =>
            sub.setName('balance')
                .setDescription('Check a balance')
                .addUserOption(opt => opt.setName('user').setDescription('Whose balance (default: you)')))
        .addSubcommand(sub =>
            sub.setName('daily')
                .setDescription('Claim your daily allowance'))
        .addSubcommand(sub =>
            sub.setName('give')
                .setDescription('Send points to another member')
                .addUserOption(opt => opt.setName('user').setDescription('Recipient').setRequired(true))
                .addIntegerOption(opt => opt.setName('amount').setDescription('How much to send').setRequired(true).setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('leaderboard')
                .setDescription('Richest members in this server'))
        .addSubcommand(sub =>
            sub.setName('history')
                .setDescription('Your recent transactions (ephemeral)'))
        .addSubcommandGroup(group =>
            group.setName('admin')
                .setDescription('Economy administration (Manage Server)')
                .addSubcommand(sub =>
                    sub.setName('name')
                        .setDescription('Rename the currency (e.g. "Jimmy points")')
                        .addStringOption(opt => opt.setName('name').setDescription('New currency name').setRequired(true).setMaxLength(32)))
                .addSubcommand(sub =>
                    sub.setName('grant')
                        .setDescription('Grant (or remove, with a negative amount) points')
                        .addUserOption(opt => opt.setName('user').setDescription('Member').setRequired(true))
                        .addIntegerOption(opt => opt.setName('amount').setDescription('Points to add (negative to remove)').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('config')
                        .setDescription('Set starting balance and/or daily amount')
                        .addIntegerOption(opt => opt.setName('starting_balance').setDescription('Balance new wallets start with').setMinValue(0))
                        .addIntegerOption(opt => opt.setName('daily_amount').setDescription('Points per daily claim (0 disables)').setMinValue(0)))),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'The point economy only works in servers.', ephemeral: true });
            return;
        }

        const guildId = interaction.guildId;
        const group = interaction.options.getSubcommandGroup(false);
        const subcommand = interaction.options.getSubcommand();
        const { currencyName } = economyService.getSettings(guildId);

        usageTracker.logCommand({ command: 'points', guildId, userId: interaction.user.id });

        try {
            if (group === 'admin') {
                if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                    await interaction.reply({ content: '❌ You need Manage Server permission for economy admin.', ephemeral: true });
                    return;
                }

                if (subcommand === 'name') {
                    const name = economyService.setCurrencyName(guildId, interaction.options.getString('name'));
                    await interaction.reply(`💱 This server's currency is now called **${name}**.`);
                } else if (subcommand === 'grant') {
                    const target = interaction.options.getUser('user');
                    const amount = interaction.options.getInteger('amount');
                    const balance = economyService.adjust({
                        guildId, userId: target.id, amount,
                        type: 'admin-grant', detail: JSON.stringify({ by: interaction.user.id })
                    });
                    await interaction.reply(
                        `${amount >= 0 ? '🎁 Granted' : '🧾 Removed'} **${Math.abs(amount).toLocaleString()} ${currencyName}** ` +
                        `${amount >= 0 ? 'to' : 'from'} ${target}. New balance: **${balance.toLocaleString()}**.`
                    );
                } else if (subcommand === 'config') {
                    const startingBalance = interaction.options.getInteger('starting_balance');
                    const dailyAmount = interaction.options.getInteger('daily_amount');
                    if (startingBalance === null && dailyAmount === null) {
                        await interaction.reply({ content: 'Provide `starting_balance` and/or `daily_amount`.', ephemeral: true });
                        return;
                    }
                    economyService.setAmounts({ guildId, startingBalance, dailyAmount });
                    const updated = economyService.getSettings(guildId);
                    await interaction.reply(
                        `⚙️ Economy updated: starting balance **${updated.startingBalance.toLocaleString()}**, ` +
                        `daily claim **${updated.dailyAmount.toLocaleString()} ${updated.currencyName}**.`
                    );
                }
                return;
            }

            if (subcommand === 'balance') {
                const target = interaction.options.getUser('user') || interaction.user;
                const balance = economyService.getBalance(guildId, target.id);
                await interaction.reply(`💰 ${target.id === interaction.user.id ? 'You have' : `${target} has`} **${balance.toLocaleString()} ${currencyName}**.`);
            } else if (subcommand === 'daily') {
                const { amount, balance } = economyService.claimDaily(guildId, interaction.user.id);
                await interaction.reply(`🗓️ Daily claimed: **+${amount.toLocaleString()} ${currencyName}**! You now have **${balance.toLocaleString()}**.`);
            } else if (subcommand === 'give') {
                const target = interaction.options.getUser('user');
                const amount = interaction.options.getInteger('amount');
                if (target.bot) {
                    await interaction.reply({ content: `Bots have no use for ${currencyName}.`, ephemeral: true });
                    return;
                }
                const { fromBalance } = economyService.transfer({
                    guildId, fromUserId: interaction.user.id, toUserId: target.id, amount
                });
                await interaction.reply(`💸 Sent **${amount.toLocaleString()} ${currencyName}** to ${target}. You have **${fromBalance.toLocaleString()}** left.`);
            } else if (subcommand === 'leaderboard') {
                const rows = economyService.leaderboard(guildId, 10);
                if (rows.length === 0) {
                    await interaction.reply(`Nobody has any ${currencyName} yet. Run \`/points daily\` to get started!`);
                    return;
                }
                const medals = ['🥇', '🥈', '🥉'];
                const lines = rows.map((row, i) =>
                    `${medals[i] || `**${i + 1}.**`} <@${row.userId}> - **${row.balance.toLocaleString()}**`);
                const embed = new EmbedBuilder()
                    .setTitle(`🏆 ${currencyName} leaderboard`)
                    .setColor(0xf1c40f)
                    .setDescription(lines.join('\n'));
                await interaction.reply({ embeds: [embed] });
            } else if (subcommand === 'history') {
                const rows = economyService.getHistory({ guildId, userId: interaction.user.id, limit: 10 });
                if (rows.length === 0) {
                    await interaction.reply({ content: `No transactions yet.`, ephemeral: true });
                    return;
                }
                const lines = rows.map(row =>
                    `\`${row.createdAt}\` ${row.amount >= 0 ? '+' : ''}${row.amount.toLocaleString()} (${row.type}) → ${row.balanceAfter.toLocaleString()}`);
                const embed = new EmbedBuilder()
                    .setTitle(`🧾 Your recent ${currencyName} transactions`)
                    .setColor(0x5865f2)
                    .setDescription(lines.join('\n'));
                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
        } catch (error) {
            const message = error instanceof EconomyError ? `❌ ${error.message}` : '❌ Something went wrong with the economy.';
            if (!(error instanceof EconomyError)) console.error('Points command error:', error);
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(message);
            } else {
                await interaction.reply({ content: message, ephemeral: true });
            }
        }
    }
};
