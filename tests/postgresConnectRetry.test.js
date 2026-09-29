/**
 * The Postgres adapter's connect retry (db/postgresAdapter.js): a refused
 * or reset TCP connect happens before any statement runs, so the adapter
 * retries it a few times with backoff instead of failing the query; any
 * other error (SQL errors, auth, a server-side FATAL) passes straight
 * through on the first attempt. Node 20's dual-stack `localhost` refusal
 * arrives as an AggregateError with an empty message - the adapter fills
 * it in so a CI log says what happened. Pure unit test: no database.
 */
const { _withConnectRetry: withConnectRetry } = require('@goobster/core/db/postgresAdapter');

function refused(address = '127.0.0.1') {
    const error = new Error(`connect ECONNREFUSED ${address}:5432`);
    error.code = 'ECONNREFUSED';
    return error;
}

function dualStackRefused() {
    // What `pg` surfaces when both ::1 and 127.0.0.1 refuse.
    const error = new AggregateError([refused('::1'), refused('127.0.0.1')]);
    error.code = 'ECONNREFUSED';
    return error;
}

function harness() {
    const sleeps = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    return {
        sleeps,
        warn,
        opts: { delays: [10, 20, 40], sleep: async ms => { sleeps.push(ms); } },
        done: () => warn.mockRestore()
    };
}

describe('withConnectRetry', () => {
    test('returns the first successful attempt without sleeping', async () => {
        const h = harness();
        const fn = jest.fn(async () => 'ok');
        await expect(withConnectRetry(fn, h.opts)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(h.sleeps).toEqual([]);
        h.done();
    });

    test('retries a refused connect with the configured backoff and then succeeds', async () => {
        const h = harness();
        const fn = jest.fn()
            .mockRejectedValueOnce(refused())
            .mockRejectedValueOnce(dualStackRefused())
            .mockResolvedValue({ rows: [1] });
        await expect(withConnectRetry(fn, h.opts)).resolves.toEqual({ rows: [1] });
        expect(fn).toHaveBeenCalledTimes(3);
        expect(h.sleeps).toEqual([10, 20]);
        expect(h.warn).toHaveBeenCalledTimes(2);
        expect(h.warn.mock.calls[0][0]).toMatch(/ECONNREFUSED, retrying in 10ms \(1\/3\)/);
        h.done();
    });

    test('gives up after the budget and makes a blank AggregateError legible', async () => {
        const h = harness();
        const fn = jest.fn(async () => { throw dualStackRefused(); });
        const failure = await withConnectRetry(fn, h.opts).catch(e => e);
        expect(fn).toHaveBeenCalledTimes(4);
        expect(h.sleeps).toEqual([10, 20, 40]);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.code).toBe('ECONNREFUSED');
        expect(failure.message).toBe('ECONNREFUSED: connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432');
        h.done();
    });

    test('recognises the retryable code when it only lives on the nested errors', async () => {
        const h = harness();
        const bare = new AggregateError([refused()]);
        const fn = jest.fn().mockRejectedValueOnce(bare).mockResolvedValue('ok');
        await expect(withConnectRetry(fn, h.opts)).resolves.toBe('ok');
        expect(h.sleeps).toEqual([10]);
        h.done();
    });

    test('does not retry anything that is not a connect failure', async () => {
        const h = harness();
        for (const error of [
            Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }),
            Object.assign(new Error('password authentication failed'), { code: '28P01' }),
            Object.assign(new Error('too many clients already'), { code: '53300' }),
            new Error('plain')
        ]) {
            const fn = jest.fn(async () => { throw error; });
            await expect(withConnectRetry(fn, h.opts)).rejects.toBe(error);
            expect(fn).toHaveBeenCalledTimes(1);
        }
        expect(h.sleeps).toEqual([]);
        expect(h.warn).not.toHaveBeenCalled();
        h.done();
    });

    test('leaves an error that already has a message alone', async () => {
        const h = harness();
        const error = refused();
        const fn = jest.fn(async () => { throw error; });
        await expect(withConnectRetry(fn, { ...h.opts, delays: [] })).rejects.toBe(error);
        expect(error.message).toBe('connect ECONNREFUSED 127.0.0.1:5432');
        h.done();
    });
});
