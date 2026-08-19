/**
 * Singleton-worker advisory locks (Phase 5a).
 *
 * SQLite is one process, so withSingletonLock always runs the callback.
 * Postgres uses pg_try_advisory_lock: a second holder of the same name
 * is skipped while the first still holds it, then succeeds after release.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-singleton-lock-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const HeartbeatService = require('@goobster/core/services/heartbeatService');

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

describe('withSingletonLock', () => {
    test('rejects a bad lock name', async () => {
        await expect(db.withSingletonLock('', async () => 1)).rejects.toThrow(/letter-first name/);
        await expect(db.withSingletonLock('has space', async () => 1)).rejects.toThrow(/letter-first name/);
    });

    test('runs the callback and returns its result', async () => {
        const outcome = await db.withSingletonLock('lock_basic', async () => 42);
        expect(outcome).toEqual({ acquired: true, result: 42 });
    });

    test('a thrown callback still releases the lock for the next caller', async () => {
        await expect(db.withSingletonLock('lock_throw', async () => {
            throw new Error('tick exploded');
        })).rejects.toThrow('tick exploded');

        const retry = await db.withSingletonLock('lock_throw', async () => 'recovered');
        expect(retry).toEqual({ acquired: true, result: 'recovered' });
    });

    test('nested same-name lock is skipped on Postgres and nested on SQLite', async () => {
        let inner;
        const outer = await db.withSingletonLock('lock_nested', async () => {
            inner = await db.withSingletonLock('lock_nested', async () => 'inner');
            return 'outer';
        });
        expect(outer).toEqual({ acquired: true, result: 'outer' });
        if (db.engine === 'postgres') {
            expect(inner).toEqual({ acquired: false });
        } else {
            expect(inner).toEqual({ acquired: true, result: 'inner' });
        }
    });

    test('heartbeat tick reports skipped when the lock is already held', async () => {
        const service = new HeartbeatService({
            guilds: { cache: new Map() }
        });
        await service.ready;

        if (db.engine !== 'postgres') {
            const result = await service.tick();
            expect(result).not.toEqual({ skipped: true });
            return;
        }

        const during = await db.withSingletonLock('heartbeat', async () => service.tick());
        expect(during.acquired).toBe(true);
        expect(during.result).toEqual({ skipped: true });

        const after = await service.tick();
        expect(after).not.toEqual({ skipped: true });
    });
});
