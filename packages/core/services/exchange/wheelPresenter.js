/**
 * Presentation helpers for the Ballistic Goblin Wheel, shared by the /wheel
 * command and the daily automation (`__GOBLIN_WHEEL__`). Lives in core so
 * `automationService` never has to reach into an app's command modules.
 */

const { EmbedBuilder } = require('discord.js');

/** promptText marker for the scheduled daily dedication automation row. */
const WHEEL_MARKER = '__GOBLIN_WHEEL__';

/**
 * Resolve display names for a set of guild member ids (best effort - an
 * unfetchable member falls back to a readable "user <id>" label).
 * @param {import('discord.js').Guild} guild
 * @param {string[]} userIds
 * @returns {Promise<Map<string, string>>}
 */
async function resolveNames(guild, userIds) {
    const names = new Map();
    for (const userId of new Set(userIds)) {
        try {
            const member = guild.members.cache.get(userId) || await guild.members.fetch(userId);
            names.set(userId, member.displayName || member.user.username);
        } catch {
            names.set(userId, `user ${userId}`);
        }
    }
    return names;
}

/** The ritual announcement, shared by /wheel spin and the daily automation. */
function buildWheelEmbed(result, currencyName, names) {
    const deployed = result.deployments.filter(d => !d.skipped);
    const skipped = result.deployments.filter(d => d.skipped);
    const lines = deployed.map(d =>
        `🚀 ${names.get(d.userId) || d.userId}: **${d.contracts}** contract(s) for **${d.cost.toLocaleString()}** (${d.percent}% of wallet)`);
    if (skipped.length > 0) {
        lines.push(...skipped.slice(0, 5).map(d => `💤 ${names.get(d.userId) || d.userId}: ${d.reason}`));
        if (skipped.length > 5) lines.push(`💤 ...and ${skipped.length - 5} more who could not ride`);
    }

    return new EmbedBuilder()
        .setTitle('🎡 THE WHEEL HAS SPOKEN 🎡')
        .setColor(result.zeroDte ? 0xed4245 : 0xfaa61a)
        .setDescription(
            `**Wheel 1** rolled **${result.strikeSpin.roll}/100** → ${result.strikeSpin.label} → **+${result.strikeSpin.targetPercent}% target**\n` +
            `**Wheel 2** rolled **${result.allocationSpin.roll}/100** → **${result.allocationSpin.percent}%** of every rider's wallet\n\n` +
            `🎯 Coordinates revealed: **${result.label} ${result.strike} CALL ${result.expiry}**${result.zeroDte ? ' **(0DTE)**' : ''}\n` +
            `Spot $${result.spot.toFixed(2)} · premium $${result.premium.toFixed(2)}/share · ` +
            `${(result.probabilityItm * 100).toFixed(1)}% ITM odds · break-even $${result.breakEven.toFixed(2)}`
        )
        .addFields({
            name: `Deployments (${deployed.length} of ${result.participants} riders)`,
            value: lines.length > 0 ? lines.join('\n').slice(0, 1020) : '*Nobody could afford a single contract. The Wheel is displeased.*'
        })
        .setFooter({
            text: `${result.totalContracts} contracts · ${result.totalPoints.toLocaleString()} ${currencyName} deployed · ` +
                `${result.zeroDte ? 'most likely value at the bell: 0 · ' : ''}simulated premiums · /wheel optout to sit out`
        });
}

module.exports = { WHEEL_MARKER, resolveNames, buildWheelEmbed };
