/**
 * Chat tools: point economy and the exchange.
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 */

const { PermissionFlagsBits } = require('discord.js');
const { resolveEconomyAccount, resolveGuildMember } = require('./helpers');

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
    },
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
    },
    stockQuote: {
        definition: {
            name: 'stockQuote',
            description: 'Look up the current market price of a stock by ticker symbol (e.g. AAPL, TSLA) for the point-powered stock trading game.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Stock ticker symbol, e.g. AAPL' }
                },
                required: ['symbol']
            }
        },
        execute: async ({ symbol }) => {
            const stockService = require('../../services/stockService');
            try {
                const quote = await stockService.getQuote(symbol);
                return `📈 ${quote.symbol} (${quote.name}): $${quote.price.toFixed(2)}${quote.currency && quote.currency !== 'USD' ? ` ${quote.currency}` : ''} as of ${quote.asOf} UTC${quote.stale ? ' (stale - price source unavailable)' : ''}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    tradeStock: {
        definition: {
            name: 'tradeStock',
            description: 'Buy or sell stock units in the point-powered trading game (1 point = $1, prices are live). Selling without units closes the whole position. Defaults to the requesting user\'s wallet; pass owner="bot" to trade with your own (Goobster\'s) wallet, e.g. when asked to invest YOUR points.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['buy', 'sell'], description: 'Trade direction' },
                    symbol: { type: 'string', description: 'Stock ticker symbol, e.g. AAPL' },
                    units: { type: 'number', description: 'How many shares (fractions allowed; omit on sell to sell all)' },
                    owner: {
                        type: 'string',
                        enum: ['user', 'bot'],
                        description: 'Whose wallet trades: "user" (default) = the human you are talking to, "bot" = Goobster\'s own account.'
                    }
                },
                required: ['action', 'symbol']
            }
        },
        execute: async ({ action, symbol, units, owner = 'user', interactionContext }) => {
            const stockPortfolioService = require('../../services/stockPortfolioService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'buy') {
                    if (units === undefined || units === null) return '❌ Say how many units to buy.';
                    const t = await stockPortfolioService.buy({ guildId, userId, symbol, units });
                    return `🛒 Bought ${t.units} ${t.symbol} at $${t.price.toFixed(2)} for ${t.cost.toLocaleString()} points from ${whose} wallet. Balance: ${t.balance.toLocaleString()}.`;
                }
                const t = await stockPortfolioService.sell({ guildId, userId, symbol, units: units ?? null });
                return `💵 Sold ${t.units} ${t.symbol} at $${t.price.toFixed(2)} for ${t.proceeds.toLocaleString()} points into ${whose} wallet. Balance: ${t.balance.toLocaleString()}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    checkPortfolio: {
        definition: {
            name: 'checkPortfolio',
            description: 'Check in on stock positions: refreshed prices, total value, and profit/loss versus cost. Defaults to the requesting user\'s portfolio; pass owner="bot" for your own (Goobster\'s) portfolio.',
            parameters: {
                type: 'object',
                properties: {
                    owner: {
                        type: 'string',
                        enum: ['user', 'bot'],
                        description: 'Whose portfolio: "user" (default) = the human you are talking to, "bot" = Goobster\'s own account.'
                    }
                }
            }
        },
        execute: async ({ owner = 'user', interactionContext }) => {
            const stockPortfolioService = require('../../services/stockPortfolioService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            const { positions, totalValue, totalCost, totalPL } = await stockPortfolioService.getPortfolio({ guildId, userId });
            if (positions.length === 0) return `No stock positions in ${whose} portfolio yet.`;
            const lines = positions.map(p => p.price === null
                ? `${p.symbol}: ${p.units} units (price unavailable)`
                : `${p.symbol}: ${p.units} units @ $${p.price.toFixed(2)} = ${p.value.toFixed(2)} points (${p.profitLoss >= 0 ? '+' : ''}${p.profitLoss.toFixed(2)})`);
            return `💼 Portfolio (${whose}):\n${lines.join('\n')}\nTotal value ${totalValue.toFixed(2)} points on ${totalCost.toLocaleString()} invested (P/L ${totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)}).`;
        }
    },
    optionChain: {
        definition: {
            name: 'optionChain',
            description: 'Look up option prices for a symbol in the Jimbucks Exchange: either a full chain around the money, or one specific contract with its greeks, break-even, and probabilities. Index tickers like SPX, NDX, and VIX work. Premiums are simulated from the real underlying with Black-Scholes - say so if asked.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Underlying ticker or index, e.g. AAPL or SPX' },
                    expiry: { type: 'string', description: 'Expiry date YYYY-MM-DD. Omit for the nearest expiry, or call with listExpiries=true to see what is tradable.' },
                    optionType: { type: 'string', enum: ['CALL', 'PUT'], description: 'Set with strike to price ONE contract instead of a chain.' },
                    strike: { type: 'number', description: 'Strike price, when pricing one contract.' },
                    listExpiries: { type: 'boolean', description: 'Return the tradable expiry calendar instead of prices.' }
                },
                required: ['symbol']
            }
        },
        execute: async ({ symbol, expiry, optionType, strike, listExpiries, interactionContext }) => {
            const optionsMarket = require('../../services/exchange/optionsMarket');
            const guildId = interactionContext?.guildId || null;
            try {
                if (listExpiries) {
                    const expiries = optionsMarket.listExpiries({});
                    return `Tradable expiries: ${expiries.map(entry => `${entry.expiry} (${entry.label})`).join(', ')}. Same-day contracts need Goblin Mode.`;
                }
                if (optionType && strike) {
                    const contract = await optionsMarket.quoteContract({ symbol, optionType, strike, expiry, guildId });
                    return `${contract.underlyingAlias || contract.underlying} ${contract.strike} ${contract.optionType} ${contract.expiry}` +
                        `${contract.zeroDte ? ' (0DTE - expires today)' : ''}: bid $${contract.bid.toFixed(2)} / ask $${contract.ask.toFixed(2)}, ` +
                        `${contract.costPerContract.toLocaleString()} points per contract. Spot $${contract.spot.toFixed(2)}, IV ${(contract.iv * 100).toFixed(1)}%. ` +
                        `Delta ${contract.greeks.delta.toFixed(3)}, gamma ${contract.greeks.gamma.toFixed(5)}, theta ${contract.greeks.theta.toFixed(3)}/day, vega ${contract.greeks.vega.toFixed(3)}. ` +
                        `Break-even $${contract.breakEven.toFixed(2)}, ${(contract.probabilityItm * 100).toFixed(1)}% chance of finishing in the money, ` +
                        `${(contract.probabilityOfProfit * 100).toFixed(1)}% chance of finishing profitable. Max loss is the premium. Premium is simulated (Black-Scholes on the real underlying).`;
                }
                const chain = await optionsMarket.buildChain({ symbol, expiry, depth: 4, guildId });
                const rows = chain.rows.map(row =>
                    `${row.strike}: call $${row.call.ask.toFixed(2)} (Δ${row.call.greeks.delta.toFixed(2)}, ${(row.call.probabilityItm * 100).toFixed(0)}% ITM) / ` +
                    `put $${row.put.ask.toFixed(2)} (Δ${row.put.greeks.delta.toFixed(2)}, ${(row.put.probabilityItm * 100).toFixed(0)}% ITM)`);
                return `${chain.label} chain for ${chain.expiry}${chain.zeroDte ? ' (0DTE)' : ''}, spot $${chain.spot.toFixed(2)} (ask prices, per share; 1 contract = 100 shares):\n` +
                    `${rows.join('\n')}\nOther expiries: ${chain.expiries.map(entry => entry.expiry).join(', ')}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    tradeOption: {
        definition: {
            name: 'tradeOption',
            description: 'Trade options in the point-powered exchange: buy long calls/puts (max loss = premium), close them, WRITE (sell to open) contracts that collect premium but owe the settlement (needs a margin account; naked calls have unbounded loss - always say so), or buy written ones back. Same-day (0DTE) contracts require Goblin Mode. ALWAYS report the max loss and the odds back to the user.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['buy', 'close', 'write', 'buyback', 'positions'], description: 'buy/close a long; write/buyback a short; positions lists what is held' },
                    symbol: { type: 'string', description: 'Underlying ticker or index, e.g. SPX (required to buy)' },
                    optionType: { type: 'string', enum: ['CALL', 'PUT'] },
                    strike: { type: 'number', description: 'Strike price' },
                    expiry: { type: 'string', description: 'Expiry date YYYY-MM-DD' },
                    contracts: { type: 'number', description: 'How many contracts (100 shares each). Omit on close to close the whole position.' },
                    positionId: { type: 'number', description: 'Position id to close (from the positions list)' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) = the human you are talking to, "bot" = Goobster\'s own account.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, symbol, optionType, strike, expiry, contracts, positionId, owner = 'user', interactionContext }) => {
            const optionsService = require('../../services/exchange/optionsService');
            const accountService = require('../../services/exchange/accountService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'positions') {
                    const snapshot = await accountService.getSnapshot({ guildId, userId });
                    if (snapshot.options.length === 0) return `No open contracts in ${whose} account.`;
                    return snapshot.options.map(option =>
                        `#${option.id}: ${option.side === 'SHORT' ? 'WROTE ' : ''}${option.contracts}x ${option.underlying} ${option.strike} ${option.optionType} ${option.expiry}` +
                        `${option.zeroDte ? ' (0DTE)' : ''}, ${option.side === 'SHORT' ? 'collected' : 'paid'} $${option.openPremium.toFixed(2)}` +
                        `${option.mark === null ? ' (unpriced)' : `, now $${(option.side === 'SHORT' ? option.markAsk : option.mark).toFixed(2)}, P/L ${option.profitLoss >= 0 ? '+' : ''}${Math.round(option.profitLoss).toLocaleString()} points` +
                            `, delta ${option.greeks.delta.toFixed(2)}, ${(option.probabilityItm * 100).toFixed(0)}% ITM odds`}`
                    ).join('\n');
                }
                if (action === 'buy' || action === 'write') {
                    if (!symbol || !optionType || !strike || !expiry || !contracts) {
                        return `❌ To ${action} a contract I need the symbol, call or put, strike, expiry, and how many contracts.`;
                    }
                    if (action === 'write') {
                        const fill = await optionsService.sellToOpen({ guildId, userId, symbol, optionType, strike, expiry, contracts });
                        const { contract } = fill;
                        return `Wrote ${fill.contracts}x ${contract.underlyingAlias || contract.underlying} ${contract.strike} ${contract.optionType} ${contract.expiry}` +
                            `${contract.zeroDte ? ' (0DTE - settles TODAY)' : ''}, collecting ${fill.credit.toLocaleString()} points into ${whose} wallet. ` +
                            `Margin requirement ${Math.ceil(fill.requirement).toLocaleString()}${fill.requirement === 0 ? ' (covered)' : ''}. ` +
                            `Max loss: ${fill.maxLoss === null ? 'UNBOUNDED (naked call - say this out loud)' : `${fill.maxLoss.toLocaleString()} points`}. ` +
                            `At expiry the intrinsic value is paid out of this account (assignment). Position id ${fill.positionId}. Balance ${fill.balance.toLocaleString()}.`;
                    }
                    const fill = await optionsService.buyToOpen({ guildId, userId, symbol, optionType, strike, expiry, contracts });
                    const { contract } = fill;
                    return `Bought ${fill.contracts}x ${contract.underlyingAlias || contract.underlying} ${contract.strike} ${contract.optionType} ${contract.expiry}` +
                        `${contract.zeroDte ? ' (0DTE - expires TODAY)' : ''} at $${contract.ask.toFixed(2)}/share from ${whose} wallet. ` +
                        `Cost ${fill.cost.toLocaleString()} points, which is also the maximum loss. Break-even $${contract.breakEven.toFixed(2)}; ` +
                        `${(contract.probabilityOfProfit * 100).toFixed(1)}% chance of finishing profitable. Position id ${fill.positionId}. Balance ${fill.balance.toLocaleString()}.`;
                }
                if (!positionId) return '❌ Tell me which position id to close (list them with action="positions").';
                if (action === 'buyback') {
                    const close = await optionsService.buyToClose({ guildId, userId, positionId, contracts: contracts ?? null });
                    return `Bought back ${close.contracts}x ${close.contract.underlying} ${close.contract.strike} ${close.contract.optionType} at $${close.contract.ask.toFixed(2)} ` +
                        `for ${close.cost.toLocaleString()} points (realized ${close.realized >= 0 ? '+' : ''}${close.realized.toLocaleString()} vs the premium collected). ` +
                        `Balance ${close.balance.toLocaleString()}.`;
                }
                const close = await optionsService.sellToClose({ guildId, userId, positionId, contracts: contracts ?? null });
                return `Closed ${close.contracts}x ${close.contract.underlying} ${close.contract.strike} ${close.contract.optionType} at $${close.contract.bid.toFixed(2)} ` +
                    `for ${close.proceeds.toLocaleString()} points into ${whose} wallet (realized ${close.realized >= 0 ? '+' : ''}${close.realized.toLocaleString()}). ` +
                    `Balance ${close.balance.toLocaleString()}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    shortStock: {
        definition: {
            name: 'shortStock',
            description: 'Sell borrowed shares short, or buy them back to cover, in the point-powered exchange. Requires a margin account. A short\'s loss is unbounded - always say so when opening one.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['short', 'cover', 'positions'], description: 'Open a short, cover one, or list them' },
                    symbol: { type: 'string', description: 'Ticker symbol' },
                    units: { type: 'number', description: 'How many shares (omit on cover to close the whole position)' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) or "bot" for Goobster\'s own account.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, symbol, units, owner = 'user', interactionContext }) => {
            const shortService = require('../../services/exchange/shortService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'positions') {
                    const positions = await shortService.listPositions({ guildId, userId });
                    if (positions.length === 0) return `No short positions in ${whose} account.`;
                    return positions.map(position =>
                        `${position.symbol}: short ${position.units} units from $${position.avgPrice.toFixed(2)} ` +
                        `(${position.proceeds.toLocaleString()} points credited)` +
                        `${position.borrowFeeAccrued >= 1 ? `, ${Math.round(position.borrowFeeAccrued)} points of borrow fees owed` : ''}`
                    ).join('\n');
                }
                if (!symbol) return '❌ Which symbol?';
                if (action === 'short') {
                    if (!units) return '❌ Say how many shares to short.';
                    const short = await shortService.openShort({ guildId, userId, symbol, units });
                    return `Shorted ${short.units} ${short.symbol} at $${short.price.toFixed(2)}, crediting ${short.proceeds.toLocaleString()} points to ${whose} wallet. ` +
                        `${short.units} units are now owed back${short.liquidationPrice ? `; the exchange force-covers above $${short.liquidationPrice.toFixed(2)}` : ''}. ` +
                        'The loss on a short is unbounded - the price can keep rising.';
                }
                const cover = await shortService.cover({ guildId, userId, symbol, units: units ?? null });
                return `Covered ${cover.units} ${cover.symbol} at $${cover.price.toFixed(2)} for ${cover.cost.toLocaleString()} points` +
                    `${cover.borrowFee > 0 ? ` plus ${cover.borrowFee.toLocaleString()} of borrow fees` : ''}. ` +
                    `Realized ${cover.realized >= 0 ? '+' : ''}${cover.realized.toLocaleString()}. Balance ${cover.balance.toLocaleString()}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    marginAccount: {
        definition: {
            name: 'marginAccount',
            description: 'Read or change an exchange account: cash vs margin, leverage tier, Goblin Mode (which unlocks same-day 0DTE contracts), and repaying the margin loan. Changing risk settings requires confirm=true, and you must explain the risk to the user before setting it.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['status', 'set_type', 'set_leverage', 'goblin_on', 'goblin_off', 'repay'],
                        description: 'What to do. "status" is always safe and needs no confirmation.'
                    },
                    accountType: { type: 'string', enum: ['CASH', 'MARGIN'] },
                    leverage: { type: 'number', description: 'Leverage multiple, e.g. 2 for 2x' },
                    points: { type: 'number', description: 'Points to repay (omit to repay as much as possible)' },
                    confirm: { type: 'boolean', description: 'Set true only after the user has explicitly asked for this change and you have explained the risk.' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) or "bot" for Goobster\'s own account.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, accountType, leverage, points, confirm, owner = 'user', interactionContext }) => {
            const accountService = require('../../services/exchange/accountService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'status') {
                    const snapshot = await accountService.getSnapshot({ guildId, userId });
                    return `${whose} account: ${snapshot.account.accountType}` +
                        `${snapshot.account.accountType === 'MARGIN' ? ` at ${snapshot.account.leverage}x` : ''}` +
                        `${snapshot.account.goblinMode ? ', Goblin Mode ON (0DTE unlocked)' : ''}. ` +
                        `Cash ${Math.round(snapshot.cash).toLocaleString()}, equity ${Math.round(snapshot.equity).toLocaleString()}, ` +
                        `buying power ${Math.round(snapshot.buyingPower).toLocaleString()}, debt ${Math.round(snapshot.debt).toLocaleString()}, ` +
                        `maintenance requirement ${Math.round(snapshot.maintenance).toLocaleString()}.` +
                        `${snapshot.marginCall ? ' *** UNDER MARGIN CALL ***' : ''}` +
                        `${snapshot.marginMove && snapshot.marginMove.drop > 0 ? ` A ${(snapshot.marginMove.drop * 100).toFixed(1)}% adverse move triggers a margin call.` : ''}`;
                }

                if (!confirm) {
                    return '❌ That changes how much risk this account can take. Explain the consequences to the user, get an explicit yes, then call again with confirm=true.';
                }
                if (action === 'set_type') {
                    const updated = await accountService.setAccountType({ guildId, userId, accountType: accountType || 'MARGIN' });
                    return `${whose} account is now a ${updated.accountType} account${updated.accountType === 'MARGIN' ? ` at ${updated.leverage}x` : ''}.`;
                }
                if (action === 'set_leverage') {
                    const updated = await accountService.setLeverage({ guildId, userId, leverage });
                    return `Leverage set to ${updated.leverage}x on ${whose} account. Losses scale with it too.`;
                }
                if (action === 'goblin_on' || action === 'goblin_off') {
                    const enabled = action === 'goblin_on';
                    await accountService.setGoblinMode({ guildId, userId, enabled });
                    return enabled
                        ? `Goblin Mode is ON for ${whose} account: same-day (0DTE) contracts are unlocked. Their most likely value at the bell is zero.`
                        : `Goblin Mode is OFF for ${whose} account. Same-day contracts are locked again; open positions are untouched.`;
                }
                const repaid = await accountService.repay({ guildId, userId, amount: points ?? null });
                return `Repaid ${repaid.repaid.toLocaleString()} points. Loan remaining ${repaid.loan.toLocaleString()}, balance ${repaid.balance.toLocaleString()}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    exchangeOrder: {
        definition: {
            name: 'exchangeOrder',
            description: 'Place, list, or cancel a resting order (limit, stop, stop-limit, trailing stop) in the point-powered exchange. Orders fill when the risk engine next checks prices, so a stop is a trigger and not a guaranteed price.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['place', 'list', 'cancel'] },
                    symbol: { type: 'string', description: 'Ticker symbol' },
                    side: { type: 'string', enum: ['BUY', 'SELL', 'SHORT', 'COVER'], description: 'What the fill does' },
                    orderType: { type: 'string', enum: ['LIMIT', 'STOP', 'STOP_LIMIT', 'TRAILING_STOP'] },
                    units: { type: 'number', description: 'How many shares' },
                    limitPrice: { type: 'number' },
                    stopPrice: { type: 'number' },
                    trailPercent: { type: 'number', description: 'Trail distance in percent, for trailing stops' },
                    orderId: { type: 'number', description: 'Order id to cancel' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) or "bot" for Goobster\'s own account.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, symbol, side, orderType, units, limitPrice, stopPrice, trailPercent, orderId, owner = 'user', interactionContext }) => {
            const orderService = require('../../services/exchange/orderService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'list') {
                    const orders = await orderService.list({ guildId, userId, status: 'working' });
                    if (orders.length === 0) return `No working orders in ${whose} account.`;
                    return orders.map(order =>
                        `#${order.id}: ${order.side} ${order.units} ${order.symbol} ${order.orderType}` +
                        `${order.limitPrice ? ` limit $${order.limitPrice}` : ''}${order.stopPrice ? ` stop $${order.stopPrice}` : ''}` +
                        `${order.trailPercent ? ` trailing ${order.trailPercent}%` : ''} [${order.status}]`
                    ).join('\n');
                }
                if (action === 'cancel') {
                    if (!orderId) return '❌ Which order id should I cancel?';
                    const order = await orderService.cancel({ guildId, userId, id: orderId });
                    return `Cancelled order #${order.id} (${order.side} ${order.units} ${order.symbol}).`;
                }
                const placed = await orderService.place({
                    guildId, userId, symbol, side, orderType, units, limitPrice, stopPrice, trailPercent
                });
                return `Order #${placed.order.id} is resting: ${placed.order.side} ${placed.order.units} ${placed.order.symbol} - ${placed.triggerHint}. ` +
                    `The price right now is $${placed.referencePrice.toFixed(2)}. Nothing is reserved until it fills.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    eventContracts: {
        definition: {
            name: 'eventContracts',
            description: 'Binary event contracts in the exchange ("Will AAPL close above $250 on Friday?"). Each pays 100 points if its side is right and nothing if it is wrong; they settle automatically from the real price at the resolution time. Use this to list markets, buy a side, or show what someone holds.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['markets', 'buy', 'positions'] },
                    marketId: { type: 'number', description: 'Which market to trade' },
                    side: { type: 'string', enum: ['YES', 'NO'] },
                    contracts: { type: 'number', description: 'How many contracts' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) or "bot" for Goobster\'s own account.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, marketId, side, contracts, owner = 'user', interactionContext }) => {
            const predictionService = require('../../services/exchange/predictionService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'markets') {
                    const markets = await predictionService.listMarkets({ guildId, status: 'OPEN' });
                    if (markets.length === 0) return 'No open event markets. An admin can open one with /predict create.';
                    const lines = [];
                    for (const market of markets) {
                        try {
                            const pricing = await predictionService.quote({ market });
                            lines.push(`#${market.id} ${market.question} - YES ${pricing.yesPrice} / NO ${pricing.noPrice} points, ` +
                                `${market.symbol} at $${pricing.spot.toFixed(2)}, resolves ${market.resolvesAt} UTC`);
                        } catch {
                            lines.push(`#${market.id} ${market.question} - price unavailable, resolves ${market.resolvesAt} UTC`);
                        }
                    }
                    return lines.join('\n');
                }
                if (action === 'positions') {
                    const positions = await predictionService.listPositions({ guildId, userId, status: 'all' });
                    if (positions.length === 0) return `No event contracts in ${whose} account.`;
                    return positions.map(position =>
                        `#${position.marketId} ${position.side} x${position.contracts} at ${Math.round(position.avgPrice)} - ${position.question}` +
                        `${position.status === 'SETTLED' ? ` [settled ${position.outcome}, paid ${Number(position.payout || 0).toLocaleString()}]` : ' [open]'}`
                    ).join('\n');
                }
                if (!marketId || !side || !contracts) return '❌ I need the market id, the side (YES or NO), and how many contracts.';
                const fill = await predictionService.buy({ guildId, userId, marketId, side, contracts });
                return `Bought ${fill.contracts}x ${fill.side} on "${fill.market.question}" at ${fill.price} points each ` +
                    `(${fill.cost.toLocaleString()} total) from ${whose} wallet. Pays ${fill.maxPayout.toLocaleString()} if right, 0 if wrong. ` +
                    `Implied odds ${(fill.pricing.probability * 100).toFixed(1)}% YES. Balance ${fill.balance.toLocaleString()}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    tradeSpread: {
        definition: {
            name: 'tradeSpread',
            description: 'Quote or execute a multi-leg option spread (vertical, straddle, strangle, butterfly, iron condor, inverse iron condor) on one underlying. ALWAYS quote first (fire=false, the default) and read the pre-trade receipt back to the user - net debit/credit, max gain/loss, break-evens, collateral - then execute with fire=true only after they confirm.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Underlying ticker, e.g. SPCX' },
                    legs: { type: 'string', description: 'Compact leg list, e.g. "buy 100p, sell 76p, buy 130c, sell 155c" (add x2 for 2 contracts on a leg)' },
                    expiry: { type: 'string', description: 'Expiry date YYYY-MM-DD applied to every leg' },
                    contracts: { type: 'number', description: 'Contracts per leg (default 1)' },
                    fire: { type: 'boolean', description: 'false (default) = receipt only; true = execute after the user confirmed' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) or "bot" for Goobster\'s own account.' }
                },
                required: ['symbol', 'legs', 'expiry']
            }
        },
        execute: async ({ symbol, legs, expiry, contracts = 1, fire = false, owner = 'user', interactionContext }) => {
            const spreadService = require('../../services/exchange/spreadService');
            const { parseLegText } = require('../../services/exchange/spreadService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                const parsed = parseLegText(legs, { expiry, contracts });
                const describe = receipt => {
                    const legLines = receipt.legs.map(leg =>
                        `${leg.action} ${leg.contracts}x ${leg.strike} ${leg.optionType} @ $${leg.premium.toFixed(2)}${leg.zeroDte ? ' (0DTE)' : ''}`);
                    return `${receipt.structure} on ${receipt.label}, spot $${receipt.spot.toFixed(2)} (simulated premiums, priced ${receipt.pricedAt} UTC):\n` +
                        `${legLines.join('\n')}\n` +
                        `Net ${Math.abs(receipt.netPoints).toLocaleString()} points ${receipt.netLabel}. ` +
                        `Max gain ${receipt.unboundedGain ? 'unbounded' : receipt.maxGain.toLocaleString()}, ` +
                        `max loss ${receipt.unboundedLoss ? 'UNBOUNDED' : Math.abs(receipt.maxLoss).toLocaleString()}, ` +
                        `break-even${receipt.breakEvens.length === 1 ? '' : 's'} ${receipt.breakEvens.map(be => `$${be}`).join(' and ') || 'none'}. ` +
                        `Collateral required ${receipt.collateralRequired.toLocaleString()}${receipt.needsMarginAccount ? ' (margin account needed)' : ''}.` +
                        `${receipt.zeroDte ? ' At least one leg expires TODAY and is most likely worth 0 at the bell.' : ''}`;
                };

                if (!fire) {
                    const receipt = await spreadService.quote({ guildId, symbol, legs: parsed });
                    return `PRE-TRADE RECEIPT (nothing executed):\n${describe(receipt)}\nRead this back to the user; execute with fire=true only after an explicit yes.`;
                }
                const result = await spreadService.execute({ guildId, userId, symbol, legs: parsed });
                return `🔥 FIRED for ${whose} account:\n${describe(result.receipt)}\n` +
                    `Positions: ${result.fills.map(f => `#${f.positionId} (${f.action} ${f.contracts}x ${f.strike} ${f.optionType})`).join(', ')}. ` +
                    `Balance ${result.balance.toLocaleString()}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    tradePerp: {
        definition: {
            name: 'tradePerp',
            description: 'Perpetual futures: open or close leveraged long/short contracts on any USD symbol including crypto (BTC-USD, ETH-USD). Isolated margin - the posted margin is the maximum loss. Always report the liquidation price back to the user when opening.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['open', 'close', 'positions'] },
                    symbol: { type: 'string', description: 'Ticker, e.g. BTC-USD' },
                    direction: { type: 'string', enum: ['LONG', 'SHORT'] },
                    margin: { type: 'number', description: 'Points to post as margin' },
                    leverage: { type: 'number', description: 'e.g. 5 for 5x' },
                    positionId: { type: 'number', description: 'Which perp to close' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) or "bot" for Goobster\'s own account.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, symbol, direction, margin, leverage, positionId, owner = 'user', interactionContext }) => {
            const perpsService = require('../../services/exchange/perpsService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'positions') {
                    const accountService = require('../../services/exchange/accountService');
                    const snapshot = await accountService.getSnapshot({ guildId, userId });
                    if (snapshot.perps.length === 0) return `No open perps in ${whose} account.`;
                    return snapshot.perps.map(perp =>
                        `#${perp.id}: ${perp.direction} ${perp.symbol} ${perp.leverage}x, entry $${perp.entryPrice.toFixed(2)}` +
                        `${perp.priced ? `, now $${perp.price.toFixed(2)}, P/L ${perp.unrealized >= 0 ? '+' : ''}${Math.round(perp.unrealized).toLocaleString()}` : ' (unpriced)'}` +
                        `, margin ${perp.margin.toLocaleString()}, liquidates at $${perp.liquidationPrice.toFixed(2)}`
                    ).join('\n');
                }
                if (action === 'open') {
                    if (!symbol || !direction || !margin || !leverage) {
                        return '❌ To open a perp I need the symbol, direction (LONG/SHORT), margin in points, and leverage.';
                    }
                    const position = await perpsService.open({ guildId, userId, symbol, direction, margin, leverage });
                    return `Opened ${position.direction} perp #${position.id} on ${position.alias || position.symbol} at ${position.leverage}x: ` +
                        `entry $${position.entryPrice.toFixed(2)}, notional ${position.notional.toLocaleString()} points on ${position.margin.toLocaleString()} of margin. ` +
                        `LIQUIDATION at $${position.liquidationPrice.toFixed(2)} - crossing it forfeits the margin. ` +
                        `Funding ${(position.fundingRateDaily * 100).toFixed(3)}%/day. Max loss: the ${position.margin.toLocaleString()}-point margin (isolated). Balance ${position.balance.toLocaleString()}.`;
                }
                if (!positionId) return '❌ Which perp id should I close? (list them with action="positions")';
                const result = await perpsService.close({ guildId, userId, id: positionId });
                return `Closed perp #${positionId} (${result.position.direction} ${result.position.symbol}) at $${result.exitPrice.toFixed(2)}: ` +
                    `${result.payout.toLocaleString()} points returned (realized ${result.realized >= 0 ? '+' : ''}${result.realized.toLocaleString()}). Balance updated.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    goblinWheel: {
        definition: {
            name: 'goblinWheel',
            description: "The Ballistic Goblin Wheel: the guild's group call-buying ritual. Manage opt-ins (join/leave, personal allocation caps), check who rides the next spin, or SPIN both wheels and deploy every participant's wallet. Spinning needs Manage Server AND confirm=true after you explained what it does. Opt-outs always win over the server-wide override.",
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['status', 'optin', 'optout', 'participants', 'spin'] },
                    maxPercent: { type: 'number', description: 'For optin: personal cap on how much of the wallet one spin may deploy (1-100)' },
                    symbol: { type: 'string', description: 'For spin: the underlying (default SPX)' },
                    confirm: { type: 'boolean', description: 'Required true for spin, after the user explicitly asked for it.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, maxPercent, symbol, confirm, interactionContext }) => {
            const groupPlayService = require('../../services/exchange/groupPlayService');
            const wheelService = require('../../services/exchange/wheelService');
            const guildId = interactionContext?.guildId;
            const userId = interactionContext?.user?.id;
            if (!guildId) return '❌ The Wheel only spins in servers.';

            try {
                if (action === 'status') {
                    const summary = await groupPlayService.summarize(guildId);
                    const mine = userId ? await groupPlayService.effectiveOptIn(guildId, userId) : null;
                    return `Wheel status: override-all ${summary.optInOverride ? 'ON (everyone with a wallet is in unless they opted out)' : 'off (explicit opt-ins only)'}; ` +
                        `${summary.explicitOptIns} explicit opt-in(s), ${summary.explicitOptOuts} opt-out(s), ${summary.participants} riding the next spin.` +
                        `${mine ? ` The requesting user is ${mine.optedIn ? 'IN' : 'OUT'} (${mine.source}${mine.maxAllocationPercent ? `, cap ${mine.maxAllocationPercent}%` : ''}).` : ''}`;
                }
                if (action === 'optin' || action === 'optout') {
                    if (!userId) return '❌ I could not tell whose opt-in to change.';
                    const state = await groupPlayService.setOptIn({
                        guildId, userId, optedIn: action === 'optin', maxAllocationPercent: maxPercent ?? null
                    });
                    return action === 'optin'
                        ? `Opted in.${state.maxAllocationPercent ? ` Personal cap: ${state.maxAllocationPercent}% per spin.` : ''} They ride the next spin.`
                        : 'Opted out. No spin touches their wallet until they opt back in - the override cannot overrule this.';
                }
                if (action === 'participants') {
                    const participants = await groupPlayService.listParticipants({ guildId });
                    if (participants.length === 0) return 'Nobody is riding the Wheel.';
                    return `${participants.length} member(s) ride the next spin: ` +
                        participants.map(p => `<@${p.userId}>${p.maxAllocationPercent ? ` (cap ${p.maxAllocationPercent}%)` : ''}`).join(', ');
                }

                // Spinning deploys other people's wallets: permission + confirm
                const hasManage = interactionContext?.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)
                    || interactionContext?.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);
                if (!hasManage) return '❌ Spinning the Wheel deploys every participant\'s wallet - it needs the Manage Server permission (use /wheel spin).';
                if (!confirm) {
                    return '❌ Spinning deploys a wheel-chosen percentage of EVERY participant\'s wallet into wheel-chosen calls. Explain that, get an explicit yes, then call again with confirm=true.';
                }
                const result = await wheelService.spin({ guildId, symbol: symbol || 'SPX' });
                const deployed = result.deployments.filter(d => !d.skipped);
                return `🎡 THE WHEEL HAS SPOKEN. Wheel 1 rolled ${result.strikeSpin.roll}/100 → +${result.strikeSpin.targetPercent}% target; ` +
                    `Wheel 2 rolled ${result.allocationSpin.roll}/100 → ${result.allocationSpin.percent}% of every wallet.\n` +
                    `Coordinates: ${result.label} ${result.strike} CALL ${result.expiry}${result.zeroDte ? ' (0DTE - most likely worth 0 at the bell)' : ''} ` +
                    `at $${result.premium.toFixed(2)}/share (${(result.probabilityItm * 100).toFixed(1)}% ITM odds).\n` +
                    `Deployed for ${deployed.length} of ${result.participants} riders: ${result.totalContracts} contracts, ${result.totalPoints.toLocaleString()} points total.` +
                    `${result.deployments.filter(d => d.skipped).length > 0 ? ` Skipped: ${result.deployments.filter(d => d.skipped).map(d => `<@${d.userId}> (${d.reason})`).slice(0, 5).join('; ')}.` : ''}`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    auditAccount: {
        definition: {
            name: 'auditAccount',
            description: "Audit any server member's exchange account end to end: every stock, short, option (with live greeks), resting order, and event contract, plus equity, leverage, buying power, debt, margin-call distance, liquidation levels, realized P/L, and whether their wallet reconciles with the ledger. Use this whenever someone asks how an account is doing, what somebody holds, or how much trouble they are in. Read-only.",
            parameters: {
                type: 'object',
                properties: {
                    user: {
                        type: 'string',
                        description: 'Who to audit: a mention, a user id, a username, or a display name. Omit for the person you are talking to; use "you" for Goobster\'s own account.'
                    }
                }
            }
        },
        execute: async ({ user, interactionContext }) => {
            const auditService = require('../../services/exchange/auditService');
            const target = await resolveGuildMember(interactionContext, user);
            if (target.error) return target.error;
            try {
                const audit = await auditService.auditAccount({ guildId: target.guildId, userId: target.userId });
                return auditService.renderAccountAudit(audit, { label: target.label });
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    auditExchange: {
        definition: {
            name: 'auditExchange',
            description: "Audit the whole server's exchange: money supply, outstanding loans, who is on margin or in Goblin Mode, the most-held and most-shorted symbols, option open interest (including what expires today), working orders, event markets, the equity leaderboard, concentration, and what the risk engine has been doing. Can also run integrity checks that prove the books add up. Read-only.",
            parameters: {
                type: 'object',
                properties: {
                    view: {
                        type: 'string',
                        enum: ['overview', 'leaderboard', 'events', 'reconcile'],
                        description: 'overview = the market dashboard (default), leaderboard = traders by equity, events = the risk engine log, reconcile = integrity checks.'
                    },
                    user: { type: 'string', description: 'For the events view: limit the log to one member (mention, id, or name).' },
                    limit: { type: 'number', description: 'How many rows for the leaderboard or event log (default 10).' }
                }
            }
        },
        execute: async ({ view = 'overview', user, limit = 10, interactionContext }) => {
            const auditService = require('../../services/exchange/auditService');
            const exchangeEvents = require('../../services/exchange/exchangeEvents');
            const guildId = interactionContext?.guildId;
            if (!guildId) return '❌ The exchange only exists inside servers.';

            /** Best-effort display names so the audit reads like people, not snowflakes. */
            const nameFor = async userId => {
                try {
                    const guild = interactionContext.guild;
                    const member = guild?.members?.cache?.get(userId) || await guild?.members?.fetch(userId);
                    return member?.displayName || member?.user?.username || userId;
                } catch {
                    return userId;
                }
            };

            try {
                if (view === 'leaderboard') {
                    const board = await auditService.leaderboard({ guildId, limit: Math.min(25, Number(limit) || 10) });
                    if (board.length === 0) return 'Nobody is trading on the exchange yet.';
                    const lines = [];
                    for (const [index, trader] of board.entries()) {
                        lines.push(`${index + 1}. ${await nameFor(trader.userId)}: equity ${Math.round(trader.equity).toLocaleString()} points ` +
                            `(cash ${Math.round(trader.cash).toLocaleString()}, exposure ${Math.round(trader.exposure).toLocaleString()}` +
                            `${trader.debt > 0 ? `, debt ${Math.round(trader.debt).toLocaleString()}` : ''})` +
                            `${trader.accountType === 'MARGIN' ? ` on ${trader.leverage}x margin` : ''}` +
                            `${trader.goblinMode ? ', goblin mode' : ''}${trader.marginCall ? ', UNDER MARGIN CALL' : ''}`);
                    }
                    return `Exchange leaderboard by equity (wallet + positions - debt):\n${lines.join('\n')}`;
                }

                if (view === 'events') {
                    const target = user ? await resolveGuildMember(interactionContext, user) : null;
                    if (target?.error) return target.error;
                    const events = await exchangeEvents.list({
                        guildId, userId: target?.userId || null, limit: Math.min(25, Number(limit) || 10)
                    });
                    if (events.length === 0) return 'The risk engine has not done anything in this server yet.';
                    const lines = [];
                    for (const event of events) {
                        lines.push(`${event.createdAt} ${event.eventType}${event.symbol ? ` ${event.symbol}` : ''}` +
                            `${event.userId ? ` (${await nameFor(event.userId)})` : ''}` +
                            `${event.amount === null ? '' : ` ${event.amount >= 0 ? '+' : ''}${event.amount.toLocaleString()} points`}` +
                            `${event.detail ? ` ${JSON.stringify(event.detail)}` : ''}`);
                    }
                    return `Exchange event log${target ? ` for ${target.label}` : ''}:\n${lines.join('\n')}`;
                }

                if (view === 'reconcile') {
                    const report = await auditService.reconcile({ guildId });
                    const lines = report.checks.map(check =>
                        `${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.description}` +
                        `${check.ok ? '' : ` -> ${check.count} problem(s), e.g. ${JSON.stringify(check.sample[0])}`}`);
                    return `${report.ok ? 'The books add up - every check passed.' : 'Reconciliation found problems.'}\n${lines.join('\n')}`;
                }

                const audit = await auditService.auditGuild({ guildId });
                const names = new Map();
                for (const trader of audit.traders.slice(0, 5)) names.set(trader.userId, await nameFor(trader.userId));
                return auditService.renderGuildAudit(audit, { names });
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    }
};
