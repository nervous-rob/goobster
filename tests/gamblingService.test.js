/**
 * Unit tests for the gambling games (services/gamblingService.js) and the
 * poker hand evaluator (utils/pokerHands.js) with a deterministic RNG,
 * against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-gambling-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const economyService = require('../services/economyService');
const { GamblingService } = require('../services/gamblingService');
const poker = require('../utils/pokerHands');

const GUILD = '400000000000000001';
const USER = '400000000000000002';

/** RNG that replays a fixed sequence (repeats the last value when drained). */
function sequenceRng(values) {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
}

function hand(spec) {
    // spec like 'AS KS QS JS 10S' (rank + suit letter)
    const rankMap = { A: 14, K: 13, Q: 12, J: 11 };
    return spec.split(' ').map(card => {
        const suit = card.slice(-1);
        const rankText = card.slice(0, -1);
        return { rank: rankMap[rankText] || Number(rankText), suit };
    });
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(() => {
    db.run('DELETE FROM economy_wallets');
    db.run('DELETE FROM economy_transactions');
    db.run('DELETE FROM economy_settings');
});

describe('poker hand evaluation', () => {
    const rankings = [
        ['straight flush', 'AS KS QS JS 10S'],
        ['four of a kind', '9S 9H 9D 9C 2S'],
        ['full house', '8S 8H 8D KS KH'],
        ['flush', 'AH 10H 7H 5H 2H'],
        ['straight', '9S 8H 7D 6C 5S'],
        ['three of a kind', 'QS QH QD 7C 2S'],
        ['two pair', 'JS JH 4D 4C 9S'],
        ['pair', '10S 10H 8D 5C 2S'],
        ['high card', 'AS JH 9D 6C 3S']
    ];

    test('categories rank in the right order', () => {
        for (let i = 0; i < rankings.length - 1; i++) {
            const better = poker.evaluateHand(hand(rankings[i][1]));
            const worse = poker.evaluateHand(hand(rankings[i + 1][1]));
            expect(poker.compareHands(better, worse)).toBeGreaterThan(0);
        }
    });

    test('the wheel (A-2-3-4-5) is a 5-high straight', () => {
        const wheel = poker.evaluateHand(hand('AS 2H 3D 4C 5S'));
        expect(wheel[0]).toBe(4);
        expect(wheel[1]).toBe(5);
        const sixHigh = poker.evaluateHand(hand('6S 5H 4D 3C 2S'));
        expect(poker.compareHands(sixHigh, wheel)).toBeGreaterThan(0);
    });

    test('kickers break ties', () => {
        const aceKicker = poker.evaluateHand(hand('10S 10H AD 5C 2S'));
        const kingKicker = poker.evaluateHand(hand('10D 10C KD 5H 2H'));
        expect(poker.compareHands(aceKicker, kingKicker)).toBeGreaterThan(0);
    });

    test('identical ranks tie', () => {
        const a = poker.evaluateHand(hand('AS KH 9D 6C 3S'));
        const b = poker.evaluateHand(hand('AH KD 9C 6S 3H'));
        expect(poker.compareHands(a, b)).toBe(0);
    });

    test('deck has 52 unique cards', () => {
        const deck = poker.buildDeck();
        expect(deck).toHaveLength(52);
        expect(new Set(deck.map(c => `${c.rank}${c.suit}`)).size).toBe(52);
    });
});

describe('coinflip', () => {
    test('winning call pays even money', () => {
        const games = new GamblingService(sequenceRng([0.2])); // < 0.5 => heads
        const result = games.coinflip({ guildId: GUILD, userId: USER, bet: 100, choice: 'heads' });
        expect(result).toMatchObject({ result: 'heads', won: true, net: 100, balance: 1100 });
    });

    test('losing call debits the bet', () => {
        const games = new GamblingService(sequenceRng([0.9])); // >= 0.5 => tails
        const result = games.coinflip({ guildId: GUILD, userId: USER, bet: 100, choice: 'heads' });
        expect(result).toMatchObject({ result: 'tails', won: false, net: -100, balance: 900 });
    });

    test('rejects bad calls and over-balance bets', () => {
        const games = new GamblingService(sequenceRng([0.5]));
        expect(() => games.coinflip({ guildId: GUILD, userId: USER, bet: 100, choice: 'edge' }))
            .toThrow(expect.objectContaining({ code: 'BAD_CHOICE' }));
        expect(() => games.coinflip({ guildId: GUILD, userId: USER, bet: 99999, choice: 'heads' }))
            .toThrow(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));
        expect(() => games.coinflip({ guildId: GUILD, userId: USER, bet: 0, choice: 'heads' }))
            .toThrow(expect.objectContaining({ code: 'BAD_BET' }));
        expect(economyService.getBalance(GUILD, USER)).toBe(1000);
    });
});

describe('d20 showdown', () => {
    test('higher roll wins, lower loses, equal pushes', () => {
        // rng 0.95 -> roll 20, rng 0.0 -> roll 1
        const win = new GamblingService(sequenceRng([0.95, 0.0]))
            .d20({ guildId: GUILD, userId: USER, bet: 50 });
        expect(win).toMatchObject({ playerRoll: 20, botRoll: 1, outcome: 'win', net: 50 });

        const lose = new GamblingService(sequenceRng([0.0, 0.95]))
            .d20({ guildId: GUILD, userId: USER, bet: 50 });
        expect(lose).toMatchObject({ playerRoll: 1, botRoll: 20, outcome: 'lose', net: -50 });

        const push = new GamblingService(sequenceRng([0.5, 0.5]))
            .d20({ guildId: GUILD, userId: USER, bet: 50 });
        expect(push).toMatchObject({ outcome: 'push', net: 0 });
        expect(push.playerRoll).toBe(push.botRoll);
    });
});

describe('poker showdown', () => {
    test('settles through the ledger and returns hand names', () => {
        const games = new GamblingService(); // real RNG - outcome unknown but consistent
        const result = games.poker({ guildId: GUILD, userId: USER, bet: 200 });

        expect(result.playerHand).toHaveLength(5);
        expect(result.dealerHand).toHaveLength(5);
        expect(poker.HAND_NAMES).toContain(result.playerHandName);
        expect(poker.HAND_NAMES).toContain(result.dealerHandName);

        // No card dealt twice
        const all = [...result.playerHand, ...result.dealerHand].map(c => `${c.rank}${c.suit}`);
        expect(new Set(all).size).toBe(10);

        // Balance matches the reported outcome, and the ledger recorded it
        const expected = result.outcome === 'win' ? 1200 : result.outcome === 'lose' ? 800 : 1000;
        expect(result.balance).toBe(expected);
        const entry = economyService.getHistory({ guildId: GUILD, userId: USER })[0];
        expect(entry.type).toBe('gamble-poker');
        expect(entry.amount).toBe(result.net);
    });
});
