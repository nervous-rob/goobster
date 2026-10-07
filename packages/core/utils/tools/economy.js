/**
 * Chat tools: the point economy (balances).
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 */

const { resolveEconomyAccount } = require('./helpers');

module.exports = {
    checkPoints: {
        definition: {
            name: 'checkPoints',
            description: 'Check a point-currency balance in this server (the currency may have a custom name like "Jimmy points"). Defaults to the requesting user\'s wallet; pass owner="bot" for your own (Goobster\'s) wallet, e.g. when someone asks about YOUR points.',
            parameters: {
                type: 'object',
                properties: {
                    owner: {
                        type: 'string',
                        enum: ['user', 'bot'],
                        description: 'Whose wallet: "user" (default) = the human you are talking to, "bot" = Goobster\'s own account.'
                    }
                }
            }
        },
        execute: async ({ owner = 'user', interactionContext }) => {
            const economyService = require('../../services/economyService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const balance = await economyService.getBalance(account.guildId, account.userId);
            const { currencyName } = await economyService.getSettings(account.guildId);
            return `💰 Balance (${account.whose} wallet): ${balance.toLocaleString()} ${currencyName}.`;
        }
    }
};
