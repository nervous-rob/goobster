const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const economyService = require('../../services/economyService');
const { EconomyError } = require('../../services/economyService');
const { StockError } = require('../../services/stockService');
const orderService = require('../../services/exchange/orderService');
const { ExchangeError } = require('../../services/exchange/errors');
const usageTracker = require('../../services/usageTracker');

const STATUS_ICONS = {
    OPEN: '⏳', TRIGGERED: '⚡', FILLED: '✅', CANCELLED: '🚫', EXPIRED: '⌛', REJECTED: '❌'
};

/**
 * Resting orders: limit, stop, stop-limit, and trailing stop across the long
 * and short book. The risk engine checks them against fresh prices every few
 * minutes - a stop is a trigger, not a promised price.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('orders')
        .setDescription('Resting orders: limit, stop, stop-limit, and trailing stop.')
        .addSubcommand(sub =>
            sub.setName('place')
                .setDescription('Rest an order until the market comes to it')
                .addStringOption(opt => opt.setName('symbol').setDescription('Ticker, e.g. AAPL').setRequired(true))
                .addStringOption(opt => opt.setName('side').setDescription('What the fill does').setRequired(true)
                    .addChoices(
                        { name: 'buy (open/add a long)', value: 'BUY' },
                        { name: 'sell (close a long)', value: 'SELL' },
                        { name: 'short (open a short)', value: 'SHORT' },
                        { name: 'cover (close a short)', value: 'COVER' }
                    ))
                .addStringOption(opt => opt.setName('type').setDescription('Order type').setRequired(true)
                    .addChoices(
                        { name: 'limit', value: 'LIMIT' },
                        { name: 'stop', value: 'STOP' },
                        { name: 'stop-limit', value: 'STOP_LIMIT' },
                        { name: 'trailing stop', value: 'TRAILING_STOP' }
                    ))
                .addNumberOption(opt => opt.setName('units').setDescription('How many shares').setRequired(true).setMinValue(0.0001))
                .addNumberOption(opt => opt.setName('limit').setDescription('Limit price (limit and stop-limit orders)').setMinValue(0.01))
                .addNumberOption(opt => opt.setName('stop').setDescription('Stop price (stop and stop-limit orders)').setMinValue(0.01))
                .addNumberOption(opt => opt.setName('trail').setDescription('Trail percent (trailing stops)').setMinValue(0.1).setMaxValue(99))
                .addIntegerOption(opt => opt.setName('good_for_hours').setDescription('Cancel automatically after this many hours').setMinValue(1).setMaxValue(720)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Your orders')
                .addStringOption(opt => opt.setName('show').setDescription('Which orders (default: working)')
                    .addChoices({ name: 'working', value: 'working' }, { name: 'all', value: 'all' })))
        .addSubcommand(sub =>
            sub.setName('cancel')
                .setDescription('Cancel a working order')
                .addIntegerOption(opt => opt.setName('id').setDescription('Order id from /orders list').setRequired(true))),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'The exchange only works in servers.', ephemeral: true });
            return;
        }

        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const subcommand = interaction.options.getSubcommand();
        const { currencyName } = economyService.getSettings(guildId);
        usageTracker.logCommand({ command: 'orders', guildId, userId });

        await interaction.deferReply();

        try {
            if (subcommand === 'place') {
                const hours = interaction.options.getInteger('good_for_hours');
                const placed = await orderService.place({
                    guildId, userId,
                    symbol: interaction.options.getString('symbol'),
                    side: interaction.options.getString('side'),
                    orderType: interaction.options.getString('type'),
                    units: interaction.options.getNumber('units'),
                    limitPrice: interaction.options.getNumber('limit'),
                    stopPrice: interaction.options.getNumber('stop'),
                    trailPercent: interaction.options.getNumber('trail'),
                    expiresAt: hours ? new Date(Date.now() + hours * 3_600_000) : null
                });
                const order = placed.order;
                await interaction.editReply(
                    `📌 Order \`#${order.id}\` resting: **${order.side.toLowerCase()} ${order.units} ${order.symbol}** — ${placed.triggerHint}.\n` +
                    `Reference price right now: **$${placed.referencePrice.toFixed(2)}**. ` +
                    `${order.expiresAt ? `Good until \`${order.expiresAt}\` UTC. ` : ''}` +
                    'Nothing is reserved until it fills, and a fast market can fill a stop well past its trigger.'
                );

            } else if (subcommand === 'list') {
                const show = interaction.options.getString('show') || 'working';
                const orders = orderService.list({ guildId, userId, status: show, limit: 20 });
                if (orders.length === 0) {
                    await interaction.editReply(show === 'working' ? 'No working orders.' : 'No orders yet.');
                    return;
                }
                const lines = orders.map(order => {
                    const prices = [
                        order.limitPrice ? `limit $${order.limitPrice}` : null,
                        order.stopPrice ? `stop $${order.stopPrice}` : null,
                        order.trailPercent ? `trail ${order.trailPercent}% from $${Number(order.trailAnchor).toFixed(2)}` : null
                    ].filter(Boolean).join(' · ');
                    const outcome = order.status === 'FILLED'
                        ? ` → filled ${order.filledUnits} @ $${Number(order.filledPrice).toFixed(2)} (${Number(order.points).toLocaleString()} ${currencyName})`
                        : order.note ? ` → ${order.note}` : '';
                    return `${STATUS_ICONS[order.status] || '•'} \`#${order.id}\` **${order.side} ${order.units} ${order.symbol}** ` +
                        `${order.orderType.toLowerCase().replace('_', '-')}${prices ? ` (${prices})` : ''}${outcome}`;
                });
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setTitle('📋 Your orders').setColor(0x5865f2).setDescription(lines.join('\n'))]
                });

            } else if (subcommand === 'cancel') {
                const order = orderService.cancel({ guildId, userId, id: interaction.options.getInteger('id') });
                await interaction.editReply(`🚫 Cancelled order \`#${order.id}\` (${order.side.toLowerCase()} ${order.units} ${order.symbol}).`);
            }
        } catch (error) {
            const friendly = error instanceof ExchangeError || error instanceof EconomyError || error instanceof StockError;
            if (!friendly) console.error('Orders command error:', error);
            await interaction.editReply(friendly ? `❌ ${error.message}` : '❌ Something went wrong with that order.');
        }
    }
};
