/**
 * The scheduled-work registry (services/scheduledWorkRegistry) is the one
 * list of recurring work kinds. Each surface that enumerates scheduled work
 * on its own - missed-run recovery, the process catalog and the operator
 * panel - must agree with it, and every table with a next-time column must
 * be accounted for, so a new scheduler cannot silently miss a surface.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-schedreg-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { SCHEDULED_WORK, NOT_SCHEDULED_WORK, surfaceKeys, isExcluded } = require('@goobster/core/services/scheduledWorkRegistry');
const { ADAPTERS } = require('@goobster/core/services/assistantProcessService');
const operatorSchedules = require('@goobster/core/services/operatorScheduleService');
const instanceState = require('@goobster/core/services/instanceStateService');

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

const sorted = (list) => [...list].sort();

test('every kind decides each surface: a key, or an excluded reason', () => {
    for (const [kind, entry] of Object.entries(SCHEDULED_WORK)) {
        expect(typeof entry.table).toBe('string');
        for (const surface of ['missedRecovery', 'processCatalog', 'operatorPanel']) {
            const value = entry[surface];
            const decided = isExcluded(value)
                ? typeof value.excluded === 'string' && value.excluded.length > 0
                : (Array.isArray(value) ? value.length > 0 : typeof value === 'string');
            if (!decided) throw new Error(`${kind}.${surface} must name its key(s) or say why it is excluded`);
        }
    }
});

test('the process catalog adapters match the registry', () => {
    expect(sorted(Object.keys(ADAPTERS))).toEqual(sorted(surfaceKeys('processCatalog')));
});

test('the operator panel kinds match the registry', () => {
    expect(sorted(operatorSchedules.KINDS)).toEqual(sorted(surfaceKeys('operatorPanel')));
});

test('missed-run recovery counts exactly the registry\'s kinds', async () => {
    const outcome = await instanceState.skipMissedSchedules({ now: new Date() });
    const counters = Object.keys(outcome).filter((key) => typeof outcome[key] === 'number');
    expect(sorted(counters)).toEqual(sorted(surfaceKeys('missedRecovery')));
});

test('every schema table with a next-time column is registered', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'packages', 'core', 'db', 'schema.sql'), 'utf8');
    const registered = new Set([
        ...Object.values(SCHEDULED_WORK).map((entry) => entry.table),
        ...Object.keys(NOT_SCHEDULED_WORK)
    ]);
    const unregistered = [];
    for (const match of schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) {
        const columns = [...match[2].matchAll(/^\s*(\w+)\s/gm)].map((m) => m[1]);
        const timed = columns.some((c) => /^(next[A-Z]\w*|dueAt|runAt|fireAt|scheduledFor)$/.test(c));
        if (timed && !registered.has(match[1])) unregistered.push(match[1]);
    }
    expect(unregistered).toEqual([]);
});
