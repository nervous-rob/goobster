/**
 * Shared NL → 5-part cron converter for /automation and /digest schedule.
 * Prompt text lives in promptFragments so the two commands cannot drift.
 */
const { CronExpressionParser } = require('cron-parser');
const aiService = require('../services/aiService');
const { CRON_FROM_NL_SYSTEM } = require('./chat/promptFragments');

/**
 * Convert a natural-language schedule into a validated 5-part cron expression.
 * @param {string} schedule
 * @returns {Promise<string>}
 */
async function cronFromNaturalLanguage(schedule) {
    const cronText = await aiService.chatText([
        { role: 'system', content: CRON_FROM_NL_SYSTEM },
        { role: 'user', content: String(schedule || '') }
    ], {
        preset: 'deterministic',
        max_tokens: 20
    });

    const cronExpression = String(cronText || '').trim().replace(/^["']|["']$/g, '');
    if (!cronExpression || cronExpression === 'INVALID') {
        throw new Error('Could not understand the schedule description. Please try rephrasing it.');
    }

    const cronParts = cronExpression.split(/\s+/).filter(Boolean);
    if (cronParts.length !== 5) {
        throw new Error('Failed to create a valid schedule format. Please try rephrasing your request.');
    }

    const formattedCron = cronParts.join(' ');
    try {
        CronExpressionParser.parse(formattedCron);
    } catch (cronError) {
        throw new Error('Failed to create a valid schedule. Please try rephrasing your request.', { cause: cronError });
    }
    return formattedCron;
}

module.exports = { cronFromNaturalLanguage };
