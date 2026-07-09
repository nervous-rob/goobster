const { EmbedBuilder } = require('discord.js');
const wrappedService = require('../services/wrappedService');
const openaiService = require('../services/openaiService');

// Marker promptText that tells automationService to post a Server Wrapped
// instead of running the chat pipeline.
const WRAPPED_MARKER = '__SERVER_WRAPPED__';

function formatTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

const MEDALS = ['🥇', '🥈', '🥉', '4.', '5.'];

/**
 * Generate the shareable Wrapped stats-card image (gpt-image-2, model
 * resolved through config/aiConfig.js inside openaiService). Returns null on
 * any failure or when OpenAI isn't configured - the embed is the floor, the
 * card is the bonus.
 * @returns {Promise<Buffer|null>}
 */
async function generateWrappedCard(stats, { guildName, periodLabel, usageContext }) {
    if (!openaiService.isConfigured()) return null;

    try {
        const busiest = stats.activity.busiestDay;
        const prompt =
            `A vibrant "Server Wrapped" year-in-review style infographic poster for a Discord community, ` +
            `bold modern flat design with playful gradients and confetti, dark background, large friendly typography. ` +
            `Title text: "${(guildName || 'Server').slice(0, 40)} Wrapped". Subtitle text: "${periodLabel}". ` +
            `Prominently display these exact stats as big numbers with short labels:\n` +
            `- "${stats.activity.totalMessages}" messages\n` +
            `- "${stats.activity.activeUsers}" chatters\n` +
            (busiest ? `- busiest day "${busiest.day}"\n` : '') +
            `- "${stats.memory.memoriesStored}" memories made\n` +
            `- "${stats.ai.calls}" AI conversations\n` +
            `No other text. No watermarks. Poster layout, crisp and screenshot-worthy.`;

        return await openaiService.generateImage(prompt, { quality: 'medium', usageContext });
    } catch (error) {
        console.warn('[ServerWrapped] Card generation failed, falling back to embed only:', error.message);
        return null;
    }
}

/**
 * Build the full Wrapped message payload (embed + optional AI image card)
 * for a guild and period. Shared by /wrapped show and the monthly
 * automation.
 *
 * @param {Object} params - { guild, period: {label, startDate, endDate}, usageContext }
 * @returns {Promise<{embeds: Array, files: Array}>}
 */
async function buildWrappedMessage({ guild, period, usageContext }) {
    const stats = wrappedService.getWrappedStats({
        guildId: guild.id,
        startDate: period.startDate,
        endDate: period.endDate
    });

    const embed = new EmbedBuilder()
        .setColor('#EB459E')
        .setTitle(`🎁 ${guild.name} Wrapped - ${period.label}`)
        .setTimestamp();

    const blurb = await wrappedService.buildBlurb(stats, {
        guildId: guild.id,
        guildName: guild.name,
        periodLabel: period.label,
        usageContext
    });
    if (blurb) embed.setDescription(blurb);

    if (stats.activity.totalMessages > 0) {
        const busiest = stats.activity.busiestDay;
        embed.addFields({
            name: '💬 Activity',
            value: [
                `**${stats.activity.totalMessages}** messages from **${stats.activity.activeUsers}** ${stats.activity.activeUsers === 1 ? 'person' : 'people'}`,
                busiest ? `Busiest day: **${busiest.day}** (${busiest.messages} messages)` : null
            ].filter(Boolean).join('\n'),
            inline: false
        });

        if (stats.activity.topMembers.length > 0) {
            embed.addFields({
                name: '🏆 Top chatters',
                value: stats.activity.topMembers
                    .map((m, i) => `${MEDALS[i]} <@${m.userId}> - ${m.messages} messages`)
                    .join('\n'),
                inline: true
            });
        }

        if (stats.activity.topChannels.length > 0) {
            embed.addFields({
                name: '📍 Hot channels',
                value: stats.activity.topChannels
                    .map(c => `<#${c.channelId}> - ${c.messages} messages`)
                    .join('\n'),
                inline: true
            });
        }
    } else {
        embed.addFields({
            name: '💬 Activity',
            value: 'No activity counted in this window yet - counters started with this feature, so early Wrappeds run thin.',
            inline: false
        });
    }

    embed.addFields({
        name: '🧠 Goobster\'s brain',
        value: [
            `**${stats.memory.memoriesStored}** new long-term memories`,
            `**${stats.memory.factsLearned}** facts learned`,
            `**${stats.memory.followupsDelivered}** follow-ups delivered`,
            `\`/recall\` used **${stats.commands.recall.calls}** ${stats.commands.recall.calls === 1 ? 'time' : 'times'}` +
                (stats.commands.recall.uniqueUsers > 0 ? ` by ${stats.commands.recall.uniqueUsers} ${stats.commands.recall.uniqueUsers === 1 ? 'person' : 'people'}` : '')
        ].join('\n'),
        inline: false
    });

    embed.addFields({
        name: '🤖 AI usage',
        value: `**${stats.ai.calls}** AI calls, **${formatTokens(stats.ai.totalTokens)}** tokens | **${stats.commands.total}** commands run`,
        inline: false
    });

    embed.setFooter({ text: 'All stats live in a local SQLite file - counts only, no message content.' });

    const files = [];
    const card = await generateWrappedCard(stats, {
        guildName: guild.name,
        periodLabel: period.label,
        usageContext
    });
    if (card) {
        files.push({ attachment: card, name: 'wrapped.png' });
        embed.setImage('attachment://wrapped.png');
    }

    return { embeds: [embed], files };
}

module.exports = { WRAPPED_MARKER, buildWrappedMessage };
