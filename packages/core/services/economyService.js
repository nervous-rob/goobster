const db = require('../db');

// Guardrails for admin-configurable values
const MAX_CURRENCY_NAME_LENGTH = 32;
const MAX_STARTING_BALANCE = 1_000_000;
const MAX_DAILY_AMOUNT = 100_000;
const DAILY_COOLDOWN_HOURS = 24;

const DEFAULT_SETTINGS = Object.freeze({
    currencyName: 'points',
    startingBalance: 1000,
    dailyAmount: 100
});

/**
 * Errors callers can show to users directly (commands map `code` to friendly
 * copy; `message` is already presentable).
 */
class EconomyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'EconomyError';
        this.code = code;
    }
}

/**
 * Per-guild point currency ("Jimmy points", "doubloons", ...): wallets, a
 * full transaction ledger, daily claims, transfers, and leaderboards. All
 * balance changes run inside a SQLite transaction and never go negative
 * (enforced both here and by the CHECK constraint).
 */
class EconomyService {
    /**
     * Guild economy settings, falling back to defaults when unset.
     * @param {string} guildId
     * @returns {{currencyName: string, startingBalance: number, dailyAmount: number}}
     */
    getSettings(guildId) {
        const row = db.get(
            'SELECT currencyName, startingBalance, dailyAmount FROM economy_settings WHERE guildId = @guildId',
            { guildId }
        );
        return row ? { ...row } : { ...DEFAULT_SETTINGS };
    }

    /**
     * Rename the currency for a guild (e.g. "Jimmy points").
     * @returns {string} the stored name
     */
    setCurrencyName(guildId, name) {
        const trimmed = String(name || '').trim();
        if (!trimmed || trimmed.length > MAX_CURRENCY_NAME_LENGTH) {
            throw new EconomyError('BAD_NAME', `Currency name must be 1-${MAX_CURRENCY_NAME_LENGTH} characters.`);
        }
        db.run(
            `INSERT INTO economy_settings (guildId, currencyName) VALUES (@guildId, @name)
             ON CONFLICT(guildId) DO UPDATE SET currencyName = @name, updatedAt = CURRENT_TIMESTAMP`,
            { guildId, name: trimmed }
        );
        return trimmed;
    }

    /**
     * Update starting balance and/or daily claim amount (admin knobs).
     * @param {Object} params - { guildId, startingBalance?, dailyAmount? }
     */
    setAmounts({ guildId, startingBalance = null, dailyAmount = null }) {
        if (startingBalance !== null) {
            if (!Number.isInteger(startingBalance) || startingBalance < 0 || startingBalance > MAX_STARTING_BALANCE) {
                throw new EconomyError('BAD_AMOUNT', `Starting balance must be 0-${MAX_STARTING_BALANCE.toLocaleString()}.`);
            }
        }
        if (dailyAmount !== null) {
            if (!Number.isInteger(dailyAmount) || dailyAmount < 0 || dailyAmount > MAX_DAILY_AMOUNT) {
                throw new EconomyError('BAD_AMOUNT', `Daily amount must be 0-${MAX_DAILY_AMOUNT.toLocaleString()}.`);
            }
        }
        const current = this.getSettings(guildId);
        db.run(
            `INSERT INTO economy_settings (guildId, currencyName, startingBalance, dailyAmount)
             VALUES (@guildId, @currencyName, @startingBalance, @dailyAmount)
             ON CONFLICT(guildId) DO UPDATE SET
                 startingBalance = @startingBalance,
                 dailyAmount = @dailyAmount,
                 updatedAt = CURRENT_TIMESTAMP`,
            {
                guildId,
                currencyName: current.currencyName,
                startingBalance: startingBalance ?? current.startingBalance,
                dailyAmount: dailyAmount ?? current.dailyAmount
            }
        );
    }

    /**
     * Get the user's wallet, creating it with the guild's starting balance on
     * first touch (the grant is recorded in the ledger).
     * @returns {{balance: number, lastDailyAt: string|null}}
     */
    getWallet(guildId, userId) {
        const existing = db.get(
            'SELECT balance, lastDailyAt FROM economy_wallets WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );
        if (existing) return existing;

        const { startingBalance } = this.getSettings(guildId);
        return db.transaction(() => {
            const inserted = db.run(
                `INSERT INTO economy_wallets (guildId, userId, balance) VALUES (@guildId, @userId, @balance)
                 ON CONFLICT(guildId, userId) DO NOTHING`,
                { guildId, userId, balance: startingBalance }
            ).changes;
            if (inserted && startingBalance > 0) {
                db.run(
                    `INSERT INTO economy_transactions (guildId, userId, amount, balanceAfter, type, detail)
                     VALUES (@guildId, @userId, @amount, @amount, 'starting-balance', NULL)`,
                    { guildId, userId, amount: startingBalance }
                );
            }
            return db.get(
                'SELECT balance, lastDailyAt FROM economy_wallets WHERE guildId = @guildId AND userId = @userId',
                { guildId, userId }
            );
        });
    }

    /**
     * Current balance (creates the wallet if needed).
     * @returns {number}
     */
    getBalance(guildId, userId) {
        return this.getWallet(guildId, userId).balance;
    }

    /**
     * Apply a signed balance change and record it in the ledger. The single
     * choke point for every point movement (games, trades, grants, daily).
     * @param {Object} params - { guildId, userId, amount (signed int), type, detail }
     * @returns {number} the new balance
     * @throws {EconomyError} INSUFFICIENT_FUNDS when the debit exceeds the balance
     */
    adjust({ guildId, userId, amount, type, detail = null }) {
        if (!Number.isInteger(amount)) {
            throw new EconomyError('BAD_AMOUNT', 'Amount must be a whole number.');
        }
        this.getWallet(guildId, userId);

        return db.transaction(() => {
            const { balance } = db.get(
                'SELECT balance FROM economy_wallets WHERE guildId = @guildId AND userId = @userId',
                { guildId, userId }
            );
            const newBalance = balance + amount;
            if (newBalance < 0) {
                const { currencyName } = this.getSettings(guildId);
                throw new EconomyError(
                    'INSUFFICIENT_FUNDS',
                    `Not enough ${currencyName}: you have ${balance.toLocaleString()}, that needs ${Math.abs(amount).toLocaleString()}.`
                );
            }
            db.run(
                `UPDATE economy_wallets SET balance = @newBalance, updatedAt = CURRENT_TIMESTAMP
                 WHERE guildId = @guildId AND userId = @userId`,
                { guildId, userId, newBalance }
            );
            db.run(
                `INSERT INTO economy_transactions (guildId, userId, amount, balanceAfter, type, detail)
                 VALUES (@guildId, @userId, @amount, @balanceAfter, @type, @detail)`,
                { guildId, userId, amount, balanceAfter: newBalance, type, detail }
            );
            return newBalance;
        });
    }

    /**
     * Move points between two users atomically.
     * @returns {{fromBalance: number, toBalance: number}}
     */
    transfer({ guildId, fromUserId, toUserId, amount }) {
        if (!Number.isInteger(amount) || amount <= 0) {
            throw new EconomyError('BAD_AMOUNT', 'Transfer amount must be a positive whole number.');
        }
        if (fromUserId === toUserId) {
            throw new EconomyError('SELF_TRANSFER', 'You cannot send points to yourself.');
        }
        // Materialize both wallets before entering the transfer transaction
        this.getWallet(guildId, fromUserId);
        this.getWallet(guildId, toUserId);

        return db.transaction(() => {
            const fromBalance = this.adjust({
                guildId, userId: fromUserId, amount: -amount,
                type: 'transfer-out', detail: JSON.stringify({ to: toUserId })
            });
            const toBalance = this.adjust({
                guildId, userId: toUserId, amount,
                type: 'transfer-in', detail: JSON.stringify({ from: fromUserId })
            });
            return { fromBalance, toBalance };
        });
    }

    /**
     * Claim the daily allowance (24h cooldown).
     * @returns {{amount: number, balance: number}}
     * @throws {EconomyError} DAILY_COOLDOWN with `nextClaimAt` (UTC text) attached
     */
    claimDaily(guildId, userId) {
        const { dailyAmount } = this.getSettings(guildId);
        if (dailyAmount <= 0) {
            throw new EconomyError('DAILY_DISABLED', 'Daily claims are disabled in this server.');
        }
        this.getWallet(guildId, userId);

        return db.transaction(() => {
            const wallet = db.get(
                `SELECT balance, lastDailyAt,
                        (lastDailyAt IS NULL OR lastDailyAt <= datetime('now', '-${DAILY_COOLDOWN_HOURS} hours')) AS eligible,
                        datetime(lastDailyAt, '+${DAILY_COOLDOWN_HOURS} hours') AS nextClaimAt
                 FROM economy_wallets WHERE guildId = @guildId AND userId = @userId`,
                { guildId, userId }
            );
            if (!wallet.eligible) {
                const error = new EconomyError('DAILY_COOLDOWN', `Daily already claimed. Next claim: ${wallet.nextClaimAt} UTC.`);
                error.nextClaimAt = wallet.nextClaimAt;
                throw error;
            }
            const balance = this.adjust({ guildId, userId, amount: dailyAmount, type: 'daily', detail: null });
            db.run(
                `UPDATE economy_wallets SET lastDailyAt = CURRENT_TIMESTAMP
                 WHERE guildId = @guildId AND userId = @userId`,
                { guildId, userId }
            );
            return { amount: dailyAmount, balance };
        });
    }

    /**
     * Richest wallets in a guild.
     * @returns {Array<{userId: string, balance: number}>}
     */
    leaderboard(guildId, limit = 10) {
        return db.all(
            `SELECT userId, balance FROM economy_wallets
             WHERE guildId = @guildId ORDER BY balance DESC, userId ASC LIMIT @limit`,
            { guildId, limit }
        );
    }

    /**
     * Recent ledger entries for a user (newest first).
     * @returns {Array<{amount: number, balanceAfter: number, type: string, detail: string|null, createdAt: string}>}
     */
    getHistory({ guildId, userId, limit = 10 }) {
        return db.all(
            `SELECT amount, balanceAfter, type, detail, createdAt FROM economy_transactions
             WHERE guildId = @guildId AND userId = @userId
             ORDER BY id DESC LIMIT @limit`,
            { guildId, userId, limit }
        );
    }
}

module.exports = new EconomyService();
module.exports.EconomyError = EconomyError;
