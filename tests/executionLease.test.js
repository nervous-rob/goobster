/**
 * Shared runner-lease helpers (utils/executionLease.js).
 */
const {
    makeRunnerId, staleCutoffUtc, isLeaseStale, toUtcText, DEFAULT_TTL_MS
} = require('@goobster/core/utils/executionLease');

describe('executionLease', () => {
    test('makeRunnerId honours GOOBSTER_RUNNER_ID and otherwise returns a uuid', () => {
        const prev = process.env.GOOBSTER_RUNNER_ID;
        try {
            process.env.GOOBSTER_RUNNER_ID = 'bot';
            expect(makeRunnerId()).toMatch(
                /^bot:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            );
            delete process.env.GOOBSTER_RUNNER_ID;
            expect(makeRunnerId()).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            );
        } finally {
            if (prev === undefined) delete process.env.GOOBSTER_RUNNER_ID;
            else process.env.GOOBSTER_RUNNER_ID = prev;
        }
    });

    test('isLeaseStale treats missing and old heartbeats as reclaimable', () => {
        const now = Date.parse('2026-09-04T12:00:00Z');
        expect(isLeaseStale(null, { now })).toBe(true);
        expect(isLeaseStale('2026-09-04 11:58:00', { now, ttlMs: DEFAULT_TTL_MS })).toBe(true);
        expect(isLeaseStale('2026-09-04 11:59:30', { now, ttlMs: DEFAULT_TTL_MS })).toBe(false);
    });

    test('staleCutoffUtc is DEFAULT_TTL_MS behind now', () => {
        const now = Date.parse('2026-09-04T12:00:00Z');
        expect(staleCutoffUtc(DEFAULT_TTL_MS, now)).toBe(toUtcText(now - DEFAULT_TTL_MS));
    });
});
