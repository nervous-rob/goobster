const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const economyService = require('@goobster/core/services/economyService');
const { EconomyError } = require('@goobster/core/services/economyService');
const { StockError } = require('@goobster/core/services/stockService');
const predictionService = require('@goobster/core/services/exchange/predictionService');
const { ExchangeError } = require('@goobster/core/services/exchange/errors');
const usageTracker = require('@goobster/core/services/usageTracker');

/**
 * Event contracts: binary markets on a real price at a real time, settled by
 * reading the underlying rather than by anybody's judgement. Each contract
 * pays 100 points if its side is right and nothing if it is wrong.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('predict')
        .setDescription('Event contracts - bet on where a price lands, settled automatically from the market.')
        .addSubcommand(sub =>
            sub.setName('markets')
                .setDescription('Open markets and their current prices'))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Buy contracts on one side of a market')
                .addIntegerOption(opt => opt.setName('market').setDescription('Market id from /predict markets').setRequired(true))
                .addStringOption(opt => opt.setName('side').setDescription('Which side').setRequired(true)
                    .addChoices({ name: 'yes', value: 'YES' }, { name: 'no', value: 'NO' }))
                .addIntegerOption(opt => opt.setName('contracts').setDescription('How many (each pays 100 if right)').setRequired(true).setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('positions')
                .setDescription('Your event contracts')
                .addUserOption(opt => opt.setName('user').setDescription('Whose positions (default: you)')))
        .addSubcommand(sub =>
            sub.setName('create')
                .setDescription('Open a new market (Manage Server)')
                .addStringOption(opt => opt.setName('symbol').setDescription('Ticker the market settles against, e.g. RKLB').setRequired(true))
                .addStringOption(opt => opt.setName('comparator').setDescription('Above or below the threshold').setRequired(true)
                    .addChoices({ name: 'above', value: 'ABOVE' }, { name: 'below', value: 'BELOW' }))
                .addNumberOption(opt => opt.setName('threshold').setDescription('Price threshold').setRequired(true).setMinValue(0.01))
                .addStringOption(opt => opt.setName('resolves').setDescription('When it settles, YYYY-MM-DD HH:MM UTC').setRequired(true))
                .addStringOption(opt => opt.setName('question').setDescription('Custom wording (optional)'))
                .addIntegerOption(opt => opt.setName('cap').setDescription('Max contracts per trader per side (default 500)').setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('void')
                .setDescription('Void a market and refund every contract (Manage Server)')
                .addIntegerOption(opt => opt.setName('market').setDescription('Market id').setRequired(true))
                .addStringOption(opt => opt.setName('reason').setDescription('Why'))),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'The exchange only works in servers.', ephemeral: true });
            return;
        }

        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const subcommand = interaction.options.getSubcommand();
        const { currencyName } = economyService.getSettings(guildId);
        usageTracker.logCommand({ command: 'predict', guildId, userId });

        if ((subcommand === 'create' || subcommand === 'void')
            && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '❌ That needs the Manage Server permission.', ephemeral: true });
            return;
        }

        await interaction.deferReply();

        try {
            if (subcommand === 'markets') {
                const markets = predictionService.listMarkets({ guildId, status: 'OPEN' });
                if (markets.length === 0) {
                    await interaction.editReply('No open markets. An admin can open one with `/predict create`.');
                    return;
                }
                const lines = [];
                for (const market of markets) {
                    let pricing = null;
                    try {
                        pricing = await predictionService.quote({ market });
                    } catch {
                        // A market we cannot price is still worth listing
                    }
                    lines.push(
                        `\`#${market.id}\` **${market.question}**\n` +
                        (pricing
                            ? `  YES **${pricing.yesPrice}** / NO **${pricing.noPrice}** ${currencyName} · ` +
                              `${market.symbol} at $${pricing.spot.toFixed(2)} · resolves ${market.resolvesAt} UTC`
                            : `  *price unavailable* · resolves ${market.resolvesAt} UTC`)
                    );
                }
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('🔮 Event contracts')
                        .setColor(0x5865f2)
                        .setDescription(lines.join('\n'))
                        .setFooter({ text: 'Each contract pays 100 points if its side is right, 0 if it is wrong. Prices are the risk-neutral probability plus the house edge.' })]
                });

            } else if (subcommand === 'buy') {
                const fill = await predictionService.buy({
                    guildId, userId,
                    marketId: interaction.options.getInteger('market'),
                    side: interaction.options.getString('side'),
                    contracts: interaction.options.getInteger('contracts')
                });
                await interaction.editReply(
                    `🔮 Bought **${fill.contracts}x ${fill.side}** on *${fill.market.question}* at **${fill.price} ${currencyName}** each ` +
                    `(total **${fill.cost.toLocaleString()}**).\n` +
                    `Pays **${fill.maxPayout.toLocaleString()}** if you are right, **0** if you are not. ` +
                    `Implied odds at purchase: ${(fill.pricing.probability * 100).toFixed(1)}% YES. Balance: **${fill.balance.toLocaleString()}**.`
                );

            } else if (subcommand === 'positions') {
                const target = interaction.options.getUser('user') || interaction.user;
                const positions = predictionService.listPositions({ guildId, userId: target.id, status: 'all', limit: 20 });
                if (positions.length === 0) {
                    await interaction.editReply(`${target.id === userId ? 'You have' : `${target.username} has`} no event contracts.`);
                    return;
                }
                const lines = positions.map(position => {
                    const settled = position.status === 'SETTLED';
                    const result = settled
                        ? position.side === position.outcome
                            ? `✅ won **${Number(position.payout).toLocaleString()}**`
                            : `❌ lost **${position.cost.toLocaleString()}**`
                        : '⏳ open';
                    return `\`#${position.marketId}\` **${position.side} x${position.contracts}** @ ${Math.round(position.avgPrice)} — ${position.question}\n  ${result}`;
                });
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setTitle(`🔮 ${target.username}'s event contracts`).setColor(0x5865f2).setDescription(lines.join('\n'))]
                });

            } else if (subcommand === 'create') {
                const resolves = interaction.options.getString('resolves');
                const market = predictionService.createMarket({
                    guildId,
                    symbol: interaction.options.getString('symbol'),
                    comparator: interaction.options.getString('comparator'),
                    threshold: interaction.options.getNumber('threshold'),
                    closesAt: resolves,
                    resolvesAt: resolves,
                    question: interaction.options.getString('question'),
                    positionCap: interaction.options.getInteger('cap') ?? 500,
                    createdBy: userId
                });
                await interaction.editReply(
                    `🔮 Market \`#${market.id}\` open: **${market.question}**\n` +
                    `Settles from ${market.symbol}'s price at \`${market.resolvesAt}\` UTC. ` +
                    `Cap: ${market.positionCap.toLocaleString()} contracts per trader per side. Trade it with \`/predict buy market:${market.id}\`.`
                );

            } else if (subcommand === 'void') {
                const result = predictionService.voidMarket({
                    guildId,
                    id: interaction.options.getInteger('market'),
                    reason: interaction.options.getString('reason')
                });
                await interaction.editReply(
                    `↩️ Market \`#${result.market.id}\` voided. Refunded **${result.refunded.toLocaleString()} ${currencyName}** ` +
                    `across ${result.positions} position(s).`
                );
            }
        } catch (error) {
            const friendly = error instanceof ExchangeError || error instanceof EconomyError || error instanceof StockError;
            if (!friendly) console.error('Predict command error:', error);
            await interaction.editReply(friendly ? `❌ ${error.message}` : '❌ Something went wrong with that market.');
        }
    }
};
