/**
 * Cron schedules are documented as UTC on every creation surface, so fire
 * times must be computed in UTC regardless of the host's timezone. The
 * Jest worker has already initialized its clock (TZ can't change
 * mid-process), so the real services are exercised in a child Node process
 * pinned to a non-UTC zone: on a UTC host these assertions would pass
 * trivially, in Denver they catch any regression to local-time parsing.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TEST_DB = path.join(os.tmpdir(), `goobster-cronutc-test-${process.pid}.sqlite`);

const CHILD_SCRIPT = `
// The chat pipeline is irrelevant here; stub it so requiring the real
// automation service doesn't boot the whole Discord stack.
require.cache[require.resolve('@goobster/core/utils/chatHandler')] =
    { exports: { handleChatInteraction: async () => {} } };

const db = require('@goobster/core/db');
const automationManagerService = require('@goobster/core/services/automationManagerService');
const AutomationService = require('@goobster/core/services/automationService');

(async () => {
    const created = await automationManagerService.create({
        userId: '730000000000000001', scope: '830000000000000001',
        channelId: '930000000000000001', name: 'nine utc', prompt: 'p', cron: '0 9 * * *'
    });

    // Backdate the row so it is due, then claim it through the REAL service -
    // the same code path the minute poll loop runs.
    await db.run("UPDATE automations SET nextRun = datetime('now', '-1 minute') WHERE id = @id", { id: created.id });
    const service = new AutomationService({});
    const [automation] = await service.getDueAutomations();
    const claimed = await service.claimDueRun(automation);
    const row = await db.get('SELECT nextRun FROM automations WHERE id = @id', { id: created.id });

    console.log(JSON.stringify({
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        createdUtcHour: created.nextRun.getUTCHours(),
        createdUtcMinute: created.nextRun.getUTCMinutes(),
        claimed,
        claimedUtcHour: new Date(row.nextRun.replace(' ', 'T') + 'Z').getUTCHours()
    }));
})().catch(error => {
    console.error(error);
    process.exit(1);
});
`;

afterAll(() => {
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

test('creation and claim both schedule in UTC even on a non-UTC host', () => {
    const stdout = execFileSync(process.execPath, ['-e', CHILD_SCRIPT], {
        cwd: REPO_ROOT,
        env: { ...process.env, TZ: 'America/Denver', GOOBSTER_DB_PATH: TEST_DB },
        encoding: 'utf8',
        timeout: 60_000
    });
    const result = JSON.parse(stdout.trim().split('\n').pop());

    // Precondition: the child really ran in a non-UTC zone (Denver is
    // UTC-6/UTC-7, so the offset is never 0)
    expect(result.timezoneOffsetMinutes).not.toBe(0);

    // "0 9 * * *" means 09:00 UTC - not 09:00 Denver (= 15:00/16:00 UTC)
    expect(result.createdUtcHour).toBe(9);
    expect(result.createdUtcMinute).toBe(0);
    expect(result.claimed).toBe(true);
    expect(result.claimedUtcHour).toBe(9);
}, 90_000);
