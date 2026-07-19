const db = require('../../db');
const economyService = require('../economyService');
const { EconomyError } = require('../economyService');
const blackjackEngine = require('./blackjack');
const rouletteEngine = require('./roulette');
const baccaratEngine = require('./baccarat');
const { GameError } = require('./gameError');

// Empty tables are discarded after this long without a connected client
const IDLE_TABLE_TTL_MS = 10 * 60 * 1000;

const ENGINES = {
    blackjack: blackjackEngine,
    roulette: rouletteEngine,
    baccarat: baccaratEngine
};

/**
 * The generic multiplayer table layer for Activity games. Owns everything a
 * game engine must not touch:
 *
 *  - one live table per guild+channel, engine chosen by gameType
 *  - money: engine "charges" are applied through economyService inside the
 *    same SQLite transaction that journals the new state (bets can never be
 *    taken without the state that took them being durable, and vice versa)
 *  - timers: engines declare `state.timer`; the manager schedules the system
 *    action and cancels stale ones on every transition
 *  - subscribers: connected clients get personalized views + event streams
 *  - crash recovery: on boot, escrowed bets from unfinished hands found in
 *    the journal are refunded and the rows cleared
 *
 * Engines are pure state machines; this class is the only side-effect zone.
 */
class TableManager {
    constructor({ engines = ENGINES } = {}) {
        this.engines = engines;
        // key -> { key, guildId, channelId, engine, state, subscribers: Set, timer, emptySince }
        this.tables = new Map();
    }

    _key(guildId, channelId) {
        return `${guildId}:${channelId}`;
    }

    /**
     * Refund escrowed bets from unfinished hands left in the journal by a
     * crash/restart, then clear the journal. Call once on startup.
     * @returns {{tables: number, refunds: number}}
     */
    recoverFromJournal() {
        const rows = db.all('SELECT guildId, channelId, gameType, state FROM table_games');
        let refunds = 0;
        for (const row of rows) {
            const engine = this.engines[row.gameType];
            try {
                const state = JSON.parse(row.state);
                for (const refund of (engine?.getEscrowRefunds(state) || [])) {
                    economyService.adjust({
                        guildId: row.guildId,
                        userId: refund.userId,
                        amount: refund.amount,
                        type: `table-${row.gameType}-refund`,
                        detail: JSON.stringify({ reason: 'restart-recovery' })
                    });
                    refunds++;
                }
            } catch (error) {
                console.error('[TableManager] Journal recovery failed for a table:', error.message);
            }
        }
        db.run('DELETE FROM table_games');
        if (rows.length > 0) {
            console.log(`[TableManager] Recovered ${rows.length} journaled table(s), refunded ${refunds} escrowed bet(s).`);
        }
        return { tables: rows.length, refunds };
    }

    /**
     * Get or create the live table for a channel (one per guild+channel).
     * When the channel's table runs a different game but has no seated
     * players, it is switched in place to the requested game (subscribers
     * stay attached and get the fresh state); with players seated, the
     * running game wins and the caller joins it as-is.
     */
    getTable({ guildId, channelId, gameType = 'blackjack' }) {
        const key = this._key(guildId, channelId);
        let table = this.tables.get(key);
        if (table) {
            if (table.engine.gameType !== gameType && table.engine.isEmpty(table.state)) {
                this._switchGame(table, gameType);
            }
            return table;
        }

        const engine = this.engines[gameType];
        if (!engine) throw new GameError('BAD_GAME', `Unknown game "${gameType}".`);

        table = {
            key,
            guildId,
            channelId,
            engine,
            state: engine.createTable(),
            subscribers: new Set(),
            timer: null,
            emptySince: Date.now()
        };
        this.tables.set(key, table);
        this._journal(table);
        return table;
    }

    /**
     * Swap an empty table's engine in place: cancel any pending timer,
     * journal the fresh state, and push it to attached subscribers. Only
     * valid when the engine reports no seated players (nothing escrowed).
     */
    _switchGame(table, gameType) {
        const engine = this.engines[gameType];
        if (!engine) throw new GameError('BAD_GAME', `Unknown game "${gameType}".`);

        if (table.timer) {
            clearTimeout(table.timer);
            table.timer = null;
        }
        table.engine = engine;
        table.state = engine.createTable();
        this._journal(table);
        for (const subscriber of table.subscribers) {
            try {
                subscriber.send({ type: 'state', view: engine.getView(table.state, subscriber.userId) });
            } catch (error) {
                console.warn('[TableManager] Broadcast to a subscriber failed:', error.message);
            }
        }
    }

    /**
     * Subscribe a connection to a table. `subscriber` is
     * { userId, name, send(message) } - send receives already-serializable
     * objects ({ type: 'state', view } / { type: 'events', events }).
     * @returns {Function} unsubscribe
     */
    subscribe(table, subscriber) {
        table.subscribers.add(subscriber);
        table.emptySince = null;
        subscriber.send({ type: 'state', view: table.engine.getView(table.state, subscriber.userId) });

        return () => {
            table.subscribers.delete(subscriber);
            if (table.subscribers.size === 0) {
                table.emptySince = Date.now();
                this._maybeDiscardLater(table);
            }
        };
    }

    /**
     * Apply a player action to a table: run the engine, settle charges +
     * journal atomically, broadcast, schedule the declared timer.
     * @param {Object} params - { table, userId, name, action, amount?, seat?, kind?, target? }
     * @returns {Array} events emitted by the transition
     * @throws {GameError|EconomyError} presentable errors on illegal moves / no funds
     */
    act({ table, userId, name, action, amount = null, seat = null, kind = null, target = null, system = false }) {
        const result = table.engine.applyAction(
            table.state,
            { userId, name, action, amount, seat, kind, target, system }
        );
        this._commit(table, result);
        return result.events;
    }

    /**
     * Commit a transition: apply charges through the economy and journal the
     * state in ONE SQLite transaction, then swap in-memory state, broadcast,
     * and (re)arm the engine-declared timer.
     */
    _commit(table, { state, events, charges }) {
        db.transaction(() => {
            for (const charge of charges) {
                economyService.adjust({
                    guildId: table.guildId,
                    userId: charge.userId,
                    amount: charge.amount,
                    type: charge.type,
                    detail: typeof charge.detail === 'string' ? charge.detail : JSON.stringify(charge.detail ?? null)
                });
            }
            db.run(
                `INSERT INTO table_games (guildId, channelId, gameType, state)
                 VALUES (@guildId, @channelId, @gameType, @state)
                 ON CONFLICT(guildId, channelId) DO UPDATE SET
                     gameType = @gameType, state = @state, updatedAt = CURRENT_TIMESTAMP`,
                {
                    guildId: table.guildId,
                    channelId: table.channelId,
                    gameType: table.engine.gameType,
                    state: JSON.stringify(state)
                }
            );
        });

        table.state = state;
        this._broadcast(table, events);
        this._armTimer(table);
    }

    _broadcast(table, events) {
        for (const subscriber of table.subscribers) {
            try {
                subscriber.send({
                    type: 'update',
                    events,
                    view: table.engine.getView(table.state, subscriber.userId)
                });
            } catch (error) {
                console.warn('[TableManager] Broadcast to a subscriber failed:', error.message);
            }
        }
    }

    /** Schedule the engine-declared system action; cancel any previous one. */
    _armTimer(table) {
        if (table.timer) {
            clearTimeout(table.timer);
            table.timer = null;
        }
        const declared = table.state.timer;
        if (!declared) return;

        table.timer = setTimeout(() => {
            table.timer = null;
            try {
                this.act({ table, action: declared.action, system: true });
            } catch (error) {
                // Stale/impossible system actions are expected (e.g. everyone
                // left before the deal timer fired); anything else is a bug.
                if (!(error instanceof GameError)) {
                    console.error('[TableManager] Timer action failed:', error);
                }
            }
        }, declared.ms);
        table.timer.unref?.();
    }

    _maybeDiscardLater(table) {
        setTimeout(() => {
            const current = this.tables.get(table.key);
            if (current !== table) return;
            const idle = table.subscribers.size === 0
                && table.emptySince !== null
                && Date.now() - table.emptySince >= IDLE_TABLE_TTL_MS;
            if (idle && table.engine.isEmpty(table.state)) {
                this.closeTable(table);
            }
        }, IDLE_TABLE_TTL_MS + 1000).unref?.();
    }

    /**
     * Close a table: refund any escrowed bets, cancel timers, clear the
     * journal row, drop it from memory.
     */
    closeTable(table) {
        if (table.timer) clearTimeout(table.timer);
        db.transaction(() => {
            for (const refund of table.engine.getEscrowRefunds(table.state)) {
                economyService.adjust({
                    guildId: table.guildId,
                    userId: refund.userId,
                    amount: refund.amount,
                    type: `table-${table.engine.gameType}-refund`,
                    detail: JSON.stringify({ reason: 'table-closed' })
                });
            }
            db.run(
                'DELETE FROM table_games WHERE guildId = @guildId AND channelId = @channelId',
                { guildId: table.guildId, channelId: table.channelId }
            );
        });
        this.tables.delete(table.key);
    }

    /** Shutdown: persist nothing extra (journal is current), stop timers. */
    stop() {
        for (const table of this.tables.values()) {
            if (table.timer) clearTimeout(table.timer);
        }
    }

    _journal(table) {
        db.run(
            `INSERT INTO table_games (guildId, channelId, gameType, state)
             VALUES (@guildId, @channelId, @gameType, @state)
             ON CONFLICT(guildId, channelId) DO UPDATE SET
                 gameType = @gameType, state = @state, updatedAt = CURRENT_TIMESTAMP`,
            {
                guildId: table.guildId,
                channelId: table.channelId,
                gameType: table.engine.gameType,
                state: JSON.stringify(table.state)
            }
        );
    }
}

module.exports = { TableManager, GameError, EconomyError, ENGINES };
