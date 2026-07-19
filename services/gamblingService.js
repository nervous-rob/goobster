const db = require('../db');
const economyService = require('./economyService');
const { EconomyError } = require('./economyService');
const poker = require('../utils/pokerHands');

const MAX_BET = 1_000_000;

/**
 * Point gambling games (coin flip, d20 showdown, 5-card poker) on top of the
 * economy service. Every game resolves atomically: the bet is validated
 * against the balance and the net result is written as a single ledger entry.
 * The RNG is injectable so game logic is fully testable.
 */
class GamblingService {
    constructor(rng = Math.random) {
        this.rng = rng;
    }

    /**
     * Validate a bet and return the guild's currency name.
     * @throws {EconomyError} BAD_BET / INSUFFICIENT_FUNDS
     */
    _checkBet({ guildId, userId, bet }) {
        if (!Number.isInteger(bet) || bet <= 0 || bet > MAX_BET) {
            throw new EconomyError('BAD_BET', `Bet must be a whole number between 1 and ${MAX_BET.toLocaleString()}.`);
        }
        const balance = economyService.getBalance(guildId, userId);
        const { currencyName } = economyService.getSettings(guildId);
        if (balance < bet) {
            throw new EconomyError(
                'INSUFFICIENT_FUNDS',
                `Not enough ${currencyName}: you have ${balance.toLocaleString()}, the bet is ${bet.toLocaleString()}.`
            );
        }
        return currencyName;
    }

    /**
     * Settle a finished game: apply the net point change and return the
     * common result envelope.
     */
    _settle({ guildId, userId, bet, net, game, detail }) {
        const balance = economyService.adjust({
            guildId, userId, amount: net,
            type: `gamble-${game}`, detail: JSON.stringify(detail)
        });
        return { net, balance, bet };
    }

    /**
     * Coin flip: call heads or tails for even money.
     * @param {Object} params - { guildId, userId, bet, choice: 'heads'|'tails' }
     * @returns {{result: string, won: boolean, net, balance, bet, currencyName}}
     */
    coinflip({ guildId, userId, bet, choice }) {
        const pick = String(choice || '').toLowerCase();
        if (pick !== 'heads' && pick !== 'tails') {
            throw new EconomyError('BAD_CHOICE', 'Call it: heads or tails.');
        }
        const currencyName = this._checkBet({ guildId, userId, bet });

        return db.transaction(() => {
            const result = this.rng() < 0.5 ? 'heads' : 'tails';
            const won = result === pick;
            const settled = this._settle({
                guildId, userId, bet, net: won ? bet : -bet,
                game: 'coinflip', detail: { choice: pick, result }
            });
            return { result, won, currencyName, ...settled };
        });
    }

    /**
     * D20 showdown: you and Goobster each roll a d20; higher roll wins even
     * money, a tie pushes (bet returned).
     * @returns {{playerRoll, botRoll, outcome: 'win'|'lose'|'push', net, balance, bet, currencyName}}
     */
    d20({ guildId, userId, bet }) {
        const currencyName = this._checkBet({ guildId, userId, bet });

        return db.transaction(() => {
            const playerRoll = 1 + Math.floor(this.rng() * 20);
            const botRoll = 1 + Math.floor(this.rng() * 20);
            const outcome = playerRoll > botRoll ? 'win' : playerRoll < botRoll ? 'lose' : 'push';
            const net = outcome === 'win' ? bet : outcome === 'lose' ? -bet : 0;
            const settled = this._settle({
                guildId, userId, bet, net,
                game: 'd20', detail: { playerRoll, botRoll, outcome }
            });
            return { playerRoll, botRoll, outcome, currencyName, ...settled };
        });
    }

    /**
     * 5-card poker showdown: you and the dealer are each dealt five cards
     * from one shuffled deck; the better poker hand wins even money, a tie
     * pushes.
     * @returns {{playerHand, dealerHand, playerHandName, dealerHandName,
     *            outcome: 'win'|'lose'|'push', net, balance, bet, currencyName}}
     */
    poker({ guildId, userId, bet }) {
        const currencyName = this._checkBet({ guildId, userId, bet });

        return db.transaction(() => {
            const deck = poker.shuffle(poker.buildDeck(), this.rng);
            const playerHand = deck.slice(0, 5);
            const dealerHand = deck.slice(5, 10);
            const playerEval = poker.evaluateHand(playerHand);
            const dealerEval = poker.evaluateHand(dealerHand);
            const diff = poker.compareHands(playerEval, dealerEval);
            const outcome = diff > 0 ? 'win' : diff < 0 ? 'lose' : 'push';
            const net = outcome === 'win' ? bet : outcome === 'lose' ? -bet : 0;
            const settled = this._settle({
                guildId, userId, bet, net,
                game: 'poker',
                detail: {
                    player: poker.formatHand(playerHand),
                    dealer: poker.formatHand(dealerHand),
                    outcome
                }
            });
            return {
                playerHand, dealerHand,
                playerHandName: poker.handName(playerEval),
                dealerHandName: poker.handName(dealerEval),
                outcome, currencyName, ...settled
            };
        });
    }
}

module.exports = new GamblingService();
module.exports.GamblingService = GamblingService;
