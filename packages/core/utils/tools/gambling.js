/**
 * Chat tools: the point games (/gamble in chat).
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 */

const { resolveEconomyAccount } = require('./helpers');

module.exports = {
    gamblePoints: {
        definition: {
            name: 'gamblePoints',
            description: 'Gamble points on a game: a coin flip (call heads or tails), a d20 roll against the bot, or a five-card poker showdown. All games pay even money. Always plays with the requesting user\'s wallet - you cannot gamble your own (bot) points.',
            parameters: {
                type: 'object',
                properties: {
                    game: { type: 'string', enum: ['coinflip', 'd20', 'poker'], description: 'Which game to play' },
                    bet: { type: 'integer', description: 'Points to wager (whole number, at least 1)' },
                    call: { type: 'string', enum: ['heads', 'tails'], description: 'Coin-flip call (required for coinflip)' }
                },
                required: ['game', 'bet']
            }
        },
        execute: async ({ game, bet, call, interactionContext }) => {
            const gamblingService = require('../../services/gamblingService');
            const { formatHand } = require('../pokerHands');
            // Deliberately user-only: the games are framed as player-vs-bot,
            // so wagering Goobster's own wallet would be self-play.
            const account = resolveEconomyAccount(interactionContext, 'user');
            if (account.error) return account.error;
            const { guildId, userId } = account;

            try {
                const base = { guildId, userId, bet: Number(bet) };
                if (game === 'coinflip') {
                    const r = await gamblingService.coinflip({ ...base, choice: call });
                    return `🪙 The coin landed ${r.result} - you ${r.won ? 'won' : 'lost'} ${bet.toLocaleString()} ${r.currencyName}. New balance: ${r.balance.toLocaleString()}.`;
                }
                if (game === 'd20') {
                    const r = await gamblingService.d20(base);
                    return `🎲 You rolled ${r.playerRoll}, Goobster rolled ${r.botRoll} - ${r.outcome === 'push' ? 'a tie, bet returned' : r.outcome === 'win' ? `you won ${bet.toLocaleString()}` : `you lost ${bet.toLocaleString()}`} ${r.currencyName}. New balance: ${r.balance.toLocaleString()}.`;
                }
                if (game === 'poker') {
                    const r = await gamblingService.poker(base);
                    return `🃏 Your hand: ${formatHand(r.playerHand)} (${r.playerHandName}) vs dealer: ${formatHand(r.dealerHand)} (${r.dealerHandName}) - ${r.outcome === 'push' ? 'a tie, bet returned' : r.outcome === 'win' ? `you won ${bet.toLocaleString()}` : `you lost ${bet.toLocaleString()}`} ${r.currencyName}. New balance: ${r.balance.toLocaleString()}.`;
                }
                return `❌ Unknown game "${game}". Choose coinflip, d20, or poker.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    }
};
