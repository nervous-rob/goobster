/**
 * Unit tests for the attention pipeline (services/attentionService.js) and
 * watches (services/attentionWatchService.js), against a throwaway database
 * with the AI provider mocked (no network).
 *
 * These cover the behaviours the feature exists for: candidates come from
 * durable state rather than a model's imagination, the same observation is
 * never raised twice, the initiative ceiling and contact budget are obeyed,
 * a model failure degrades instead of breaking, dismissal changes future
 * thresholds, and a watch fires exactly once per condition.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-attention-service-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/services/aiService', () => ({
    generateText: jest.fn()
}));

// Only watches reach the chat pipeline, and what matters here is the shape of
// the pseudo-interaction they hand it - not what the pipeline then does.
jest.mock('@goobster/core/utils/chatHandler', () => ({
    handleChatInteraction: jest.fn()
}));

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const attention = require('@goobster/core/services/attentionService');
const ledger = require('@goobster/core/services/attentionLedgerService');
const policies = require('@goobster/core/services/attentionPolicyService');
const watches = require('@goobster/core/services/attentionWatchService');
const domainEventBus = require('@goobster/core/services/domainEventBus');
const config = require('@goobster/core/config/attentionConfig');

const USER = '900000000000000001';
const GUILD = '910000000000000001';
const HOUR = 3600_000;

/** A gateway stand-in: records DMs instead of talking to Discord. */
function fakeGateway({ ok = true } = {}) {
    const sent = [];
    return {
        isGoobsterGateway: true,
        sent,
        sendDm: jest.fn(async (userId, payload) => {
            sent.push({ userId, payload });
            return ok ? { ok: true, channelId: 'dm-1', messageId: 'm-1' } : { ok: false, error: 'blocked' };
        })
    };
}

/** Triage answer that keeps every candidate it was shown. */
function keepAll(message = 'Two things look worth your attention.') {
    return async (prompt) => {
        const keys = [...prompt.matchAll(/\[key: ([^\]]+)\]/g)].map(m => m[1]);
        return JSON.stringify({
            keep: keys.map(key => ({ key, adjust: 0, reason: 'worth it' })),
            drop: [],
            message
        });
    };
}

async function enroll(initiative = 'delegate', overrides = {}) {
    await policies.setInitiative(USER, initiative);
    if (Object.keys(overrides).length > 0) {
        await policies.setBudget({ userId: USER, ...overrides });
    }
    return await policies.get(USER);
}

/** An active loop with a deadline close enough to be urgent. */
async function seedUrgentDeadline({ subject = 'dbt demo', hoursOut = 6, importance = 0.9 } = {}) {
    const { id } = await ledger.upsertItem({
        guildId: GUILD,
        userId: USER,
        kind: 'commitment',
        subject,
        goal: 'give the presentation',
        unresolved: ['finish demo code'],
        importance,
        confidence: 0.95,
        state: 'active',
        deadlineAt: new Date(Date.now() + hoursOut * HOUR).toISOString()
    });
    // Untouched for two days, so the "they are already on it" damping that
    // deliberately keeps Goobster quiet does not apply.
    await db.run(
        `UPDATE attention_items SET lastActivityAt = datetime('now', '-2 days') WHERE id = @id`,
        { id }
    );
    return id;
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    jest.clearAllMocks();
    for (const table of [
        'attention_feedback', 'attention_notices', 'attention_provenance',
        'attention_items', 'attention_watches', 'attention_state',
        'attention_policies', 'observatory_jobs', 'observatory_projects',
        'kg_edges', 'kg_nodes'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
});

describe('enrollment gates everything', () => {
    test('an unenrolled person is never swept', async () => {
        await seedUrgentDeadline();
        const summary = await attention.sweepUser({ policy: { userId: USER, enabled: false } });
        expect(summary.considered).toBe(0);
        expect(summary.raised).toBe(0);
        expect(aiService.generateText).not.toHaveBeenCalled();
    });

    test('a domain event about an unenrolled person changes nothing', async () => {
        await attention.onEvent({
            topic: domainEventBus.TOPICS.CONVERSATION_MESSAGE_CREATED,
            payload: { userId: USER }
        });
        expect(await db.get('SELECT * FROM attention_state WHERE userId = @u', { u: USER }))
            .toBeUndefined();
    });

    test('an event about an enrolled person brings their sweep forward', async () => {
        await enroll();
        await attention.onEvent({
            topic: domainEventBus.TOPICS.CONVERSATION_MESSAGE_CREATED,
            payload: { userId: USER }
        });
        const state = await db.get('SELECT dirtyAt FROM attention_state WHERE userId = @u', { u: USER });
        expect(state?.dirtyAt).toBeTruthy();
    });
});

describe('candidate generation comes from state, not from a model', () => {
    test('an approaching deadline on a stalled loop is surfaced', async () => {
        const policy = await enroll();
        await seedUrgentDeadline();
        aiService.generateText.mockImplementation(keepAll());

        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        expect(summary.considered).toBeGreaterThan(0);
        expect(summary.raised).toBeGreaterThan(0);
        expect(summary.notices.some(notice => notice.title.includes('dbt demo'))).toBe(true);
    });

    test('nothing is invented when there is nothing to notice', async () => {
        const policy = await enroll();
        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        expect(summary.considered).toBe(0);
        expect(summary.raised).toBe(0);
        // The narrow triage question is never asked without candidates.
        expect(aiService.generateText).not.toHaveBeenCalled();
    });

    test('a loop being actively worked on is left alone', async () => {
        const policy = await enroll();
        const id = await seedUrgentDeadline();
        await ledger.touchActivity(id); // they were on it minutes ago
        aiService.generateText.mockImplementation(keepAll());

        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        const deadlineNotice = summary.notices.find(notice => notice.title.includes('due in'));
        // Either damped below the bar entirely, or demoted to the inbox -
        // never a DM about something they are visibly already doing.
        if (deadlineNotice) {
            expect(['inbox', 'mention']).toContain(deadlineNotice.disposition);
        }
    });

    test('an unconfirmed guess can never interrupt, only sit in the inbox', async () => {
        const policy = await enroll();
        const { id } = await ledger.upsertItem({
            guildId: GUILD,
            userId: USER,
            kind: 'commitment',
            subject: 'revisit causal emergence',
            importance: 1,
            confidence: 0.75
        });
        await db.run(
            `UPDATE attention_items SET createdAt = datetime('now', '-2 days'),
                                        lastActivityAt = datetime('now', '-2 days')
             WHERE id = @id`,
            { id }
        );
        aiService.generateText.mockImplementation(keepAll());

        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        for (const notice of summary.notices) {
            expect(notice.disposition).toBe('inbox');
        }
    });

    test('a failed Observatory run is news; a plain completion is not', async () => {
        const policy = await enroll();
        const projectId = await db.insert(
            `INSERT INTO observatory_projects (userId, slug, name)
             VALUES (@userId, 'emergence-study', 'Emergence study')`,
            { userId: USER }
        );
        await db.insert(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status, finishedAt, error)
             VALUES (@projectId, @userId, 'python', 'print(1)', 'FAILED', datetime('now'), 'boom')`,
            { projectId, userId: USER }
        );
        await db.insert(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status, finishedAt)
             VALUES (@projectId, @userId, 'python', 'print(1)', 'COMPLETED', datetime('now'))`,
            { projectId, userId: USER }
        );
        aiService.generateText.mockImplementation(keepAll());

        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        const titles = summary.notices.map(notice => notice.title);
        expect(titles.some(title => title.includes('failed'))).toBe(true);
        // observatoryService already DMs a completion follow-up; a second
        // "it finished" ping would be duplicate noise.
        expect(titles.some(title => title.includes('run finished'))).toBe(false);
    });

    test('a fresh contradiction in the personal graph is surfaced', async () => {
        const policy = await enroll();
        const nodeA = await db.insert(
            `INSERT INTO kg_nodes (guildId, scopeKey, type, label) VALUES (@g, @s, 'fact', 'prefers tabs')`,
            { g: GUILD, s: `USER:${USER}` }
        );
        const nodeB = await db.insert(
            `INSERT INTO kg_nodes (guildId, scopeKey, type, label) VALUES (@g, @s, 'fact', 'prefers spaces')`,
            { g: GUILD, s: `USER:${USER}` }
        );
        await db.insert(
            `INSERT INTO kg_edges (guildId, scopeKey, sourceId, targetId, relation, weight)
             VALUES (@g, @s, @a, @b, 'contradicts', 0.9)`,
            { g: GUILD, s: `USER:${USER}`, a: nodeA, b: nodeB }
        );
        aiService.generateText.mockImplementation(keepAll());

        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        expect(summary.notices.some(notice => notice.category === 'knowledge')).toBe(true);
    });

    test('a generator that throws does not take the sweep down with it', async () => {
        const policy = await enroll();
        await seedUrgentDeadline();
        attention.registerGenerator('exploding', {
            description: 'always throws',
            run: async () => { throw new Error('kaboom'); }
        });
        aiService.generateText.mockImplementation(keepAll());
        try {
            const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
            expect(summary.raised).toBeGreaterThan(0);
        } finally {
            attention.registerGenerator('exploding', { description: '', run: async () => [] });
        }
    });
});

describe('idempotence through the dedupe key', () => {
    test('the same observation is never raised twice', async () => {
        const policy = await enroll();
        await seedUrgentDeadline();
        aiService.generateText.mockImplementation(keepAll());

        const first = await attention.sweepUser({ policy, gateway: fakeGateway() });
        expect(first.raised).toBeGreaterThan(0);

        // Sweeping again re-derives the very same candidates from state.
        const second = await attention.sweepUser({
            policy: await policies.get(USER),
            gateway: fakeGateway()
        });
        expect(second.considered).toBeGreaterThan(0);
        expect(second.raised).toBe(0);
    });
});

describe('the interruption policy', () => {
    test('observe fills the inbox but never reaches out', async () => {
        const policy = await enroll('observe');
        await seedUrgentDeadline();
        aiService.generateText.mockImplementation(keepAll());
        const gateway = fakeGateway();

        const summary = await attention.sweepUser({ policy, gateway });
        expect(summary.raised).toBeGreaterThan(0);
        expect(summary.contacted).toBe(false);
        expect(gateway.sendDm).not.toHaveBeenCalled();
        for (const notice of summary.notices) {
            expect(notice.disposition).toBe('inbox');
        }
    });

    test('a per-item ceiling overrides a permissive policy', async () => {
        const policy = await enroll('delegate');
        const id = await seedUrgentDeadline();
        await db.run(
            `UPDATE attention_items SET allowedInitiative = 'observe' WHERE id = @id`,
            { id }
        );
        aiService.generateText.mockImplementation(keepAll());
        const gateway = fakeGateway();

        const summary = await attention.sweepUser({ policy, gateway });
        for (const notice of summary.notices.filter(n => n.itemId === id)) {
            expect(notice.disposition).toBe('inbox');
        }
        expect(gateway.sendDm).not.toHaveBeenCalled();
    });

    test('quiet hours hold contact while the inbox keeps filling', async () => {
        await enroll('delegate');
        // A window covering the whole day, so "now" is always inside it.
        await policies.setQuietHours({ userId: USER, startMinute: 0, endMinute: 1439 });
        const policy = await policies.get(USER);
        await seedUrgentDeadline();
        aiService.generateText.mockImplementation(keepAll());
        const gateway = fakeGateway();

        const summary = await attention.sweepUser({ policy, gateway });
        expect(summary.raised).toBeGreaterThan(0);
        expect(gateway.sendDm).not.toHaveBeenCalled();
    });

    test('a zero contact budget means everything stays in the inbox', async () => {
        await enroll('delegate');
        await policies.setBudget({ userId: USER, maxContactsPerDay: 0 });
        const policy = await policies.get(USER);
        await seedUrgentDeadline();
        aiService.generateText.mockImplementation(keepAll());
        const gateway = fakeGateway();

        const summary = await attention.sweepUser({ policy, gateway });
        expect(summary.raised).toBeGreaterThan(0);
        expect(gateway.sendDm).not.toHaveBeenCalled();
    });

    test('a DM is sent, marked delivered, and anchors the cooldown', async () => {
        const policy = await enroll('delegate');
        await seedUrgentDeadline();
        aiService.generateText.mockImplementation(keepAll('The dbt demo is due in 6 hours and the demo code is unfinished.'));
        const gateway = fakeGateway();

        const summary = await attention.sweepUser({ policy, gateway });
        expect(summary.contacted).toBe(true);
        expect(gateway.sent).toHaveLength(1);
        expect(gateway.sent[0].userId).toBe(USER);
        expect(gateway.sent[0].payload.content).toContain('dbt demo');
        // No stray pings: proactive contact must not mention anyone.
        expect(gateway.sent[0].payload.allowedMentions).toEqual({ users: [], roles: [] });

        const state = await db.get('SELECT lastContactAt FROM attention_state WHERE userId = @u', { u: USER });
        expect(state.lastContactAt).toBeTruthy();
        const delivered = await db.get(
            `SELECT COUNT(*) AS c FROM attention_notices
             WHERE userId = @u AND status = 'delivered'`,
            { u: USER }
        );
        expect(delivered.c).toBeGreaterThan(0);
    });

    test('a DM that fails to send leaves the notice undelivered for next time', async () => {
        const policy = await enroll('delegate');
        await seedUrgentDeadline();
        aiService.generateText.mockImplementation(keepAll());
        const gateway = fakeGateway({ ok: false });

        const summary = await attention.sweepUser({ policy, gateway });
        expect(summary.contacted).toBe(false);
        const stuck = await db.get(
            `SELECT COUNT(*) AS c FROM attention_notices
             WHERE userId = @u AND status = 'surfaced'`,
            { u: USER }
        );
        expect(stuck.c).toBeGreaterThan(0);
    });
});

describe('model triage shapes the decision but never owns it', () => {
    test('a vetoed candidate is demoted to the inbox, never erased', async () => {
        const policy = await enroll('delegate');
        await seedUrgentDeadline();
        aiService.generateText.mockImplementation(async (prompt) => {
            const keys = [...prompt.matchAll(/\[key: ([^\]]+)\]/g)].map(m => m[1]);
            return JSON.stringify({ keep: [], drop: keys, message: '' });
        });
        const gateway = fakeGateway();

        const summary = await attention.sweepUser({ policy, gateway });
        // Scoring decides whether something is recorded; triage only decides
        // how loudly. A veto must therefore silence, not delete.
        expect(summary.raised).toBeGreaterThan(0);
        expect(gateway.sendDm).not.toHaveBeenCalled();
        for (const notice of summary.notices) {
            expect(notice.disposition).toBe('inbox');
            expect(notice.reason).toBeTruthy();
        }
    });

    test('a candidate the model never mentions is silenced, not lost', async () => {
        const policy = await enroll('delegate');
        await seedUrgentDeadline();
        // An answer that keeps nothing and drops nothing: the model simply
        // did not vouch for anything it was shown.
        aiService.generateText.mockResolvedValue('{"keep":[],"drop":[],"message":""}');

        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        expect(summary.raised).toBeGreaterThan(0);
        expect(summary.notices.every(notice => notice.disposition === 'inbox')).toBe(true);
    });

    test('triage cannot make something louder than scoring allowed', async () => {
        const policy = await enroll('delegate');
        await seedUrgentDeadline({ importance: 0.35 });
        aiService.generateText.mockImplementation(async (prompt) => {
            const keys = [...prompt.matchAll(/\[key: ([^\]]+)\]/g)].map(m => m[1]);
            return JSON.stringify({
                // A wildly out-of-range boost, which must be clamped and then
                // capped at the disposition scoring already chose.
                keep: keys.map(key => ({ key, adjust: 99, reason: 'URGENT!!' })),
                drop: [],
                message: 'hey'
            });
        });

        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        for (const notice of summary.notices) {
            expect(config.DISPOSITION_RANK[notice.disposition])
                .toBeLessThanOrEqual(config.DISPOSITION_RANK.dm);
        }
    });

    test('an unavailable model degrades to deterministic scores and a plain digest', async () => {
        const policy = await enroll('delegate');
        await seedUrgentDeadline();
        aiService.generateText.mockRejectedValue(new Error('provider down'));
        const gateway = fakeGateway();

        const summary = await attention.sweepUser({ policy, gateway });
        expect(summary.raised).toBeGreaterThan(0);
        expect(summary.contacted).toBe(true);
        expect(gateway.sent[0].payload.content).toContain('dbt demo');
    });

    test('unparseable model output degrades the same way', async () => {
        const policy = await enroll('delegate');
        await seedUrgentDeadline();
        aiService.generateText.mockResolvedValue('I would rather not answer in JSON.');

        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        expect(summary.raised).toBeGreaterThan(0);
    });
});

describe('notices and feedback', () => {
    test('reacting to a notice records the outcome and can revive its loop', async () => {
        const policy = await enroll('delegate');
        const itemId = await seedUrgentDeadline();
        aiService.generateText.mockImplementation(keepAll());
        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        const notice = summary.notices.find(n => n.itemId === itemId);
        expect(notice).toBeTruthy();

        const acted = await attention.actOnNotice({ userId: USER, noticeId: notice.id, action: 'act' });
        expect(acted.status).toBe('acted_on');
        const feedback = await db.all(
            'SELECT signal FROM attention_feedback WHERE userId = @u ORDER BY id ASC', { u: USER }
        );
        expect(feedback.map(row => row.signal)).toContain('surfaced');
        expect(feedback.map(row => row.signal)).toContain('acted_on');

        // Acting on it is evidence the loop is alive again.
        const item = await ledger.getItem(itemId);
        const age = Date.now() - new Date(`${item.lastActivityAt.replace(' ', 'T')}Z`).getTime();
        expect(age).toBeLessThan(60_000);
    });

    test('another person cannot touch your notices', async () => {
        const policy = await enroll('delegate');
        await seedUrgentDeadline();
        aiService.generateText.mockImplementation(keepAll());
        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        const notice = summary.notices[0];

        expect(await attention.actOnNotice({
            userId: '999999999999999999', noticeId: notice.id, action: 'dismiss'
        })).toBeNull();
    });

    test('an unknown action is refused', async () => {
        expect(await attention.actOnNotice({ userId: USER, noticeId: 1, action: 'explode' })).toBeNull();
    });

    test('snoozing hides a notice until its window passes', async () => {
        const policy = await enroll('delegate');
        await seedUrgentDeadline();
        aiService.generateText.mockImplementation(keepAll());
        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        const notice = summary.notices[0];

        await attention.actOnNotice({ userId: USER, noticeId: notice.id, action: 'snooze', snoozeHours: 5 });
        const visible = await attention.listNotices({ userId: USER });
        expect(visible.some(row => row.id === notice.id)).toBe(false);

        await db.run(
            `UPDATE attention_notices SET snoozeUntil = datetime('now', '-1 hours') WHERE id = @id`,
            { id: notice.id }
        );
        const back = await attention.listNotices({ userId: USER });
        expect(back.some(row => row.id === notice.id)).toBe(true);
    });

    test('dismissals raise the bar for that category, acting on them lowers it', async () => {
        await enroll('delegate');
        const base = await attention.thresholdsFor(USER, 'schedule');
        expect(base).toEqual(config.THRESHOLDS);

        for (let i = 0; i < 6; i++) {
            await attention.recordFeedback({ userId: USER, category: 'schedule', signal: 'dismissed' });
        }
        const stricter = await attention.thresholdsFor(USER, 'schedule');
        expect(stricter.dm).toBeGreaterThan(base.dm);

        for (let i = 0; i < 6; i++) {
            await attention.recordFeedback({ userId: USER, category: 'observatory', signal: 'acted_on' });
        }
        const looser = await attention.thresholdsFor(USER, 'observatory');
        expect(looser.dm).toBeLessThan(base.dm);

        const calibration = await attention.getCalibration(USER);
        expect(calibration.find(row => row.category === 'schedule').dismissed).toBe(6);
    });

    test('mention notices surface exactly once, in conversation', async () => {
        await enroll('delegate');
        await db.insert(
            `INSERT INTO attention_notices (userId, dedupeKey, category, title, disposition, score)
             VALUES (@u, 'test:mention', 'general', 'PR #164 has been waiting for review', 'mention', 0.6)`,
            { u: USER }
        );
        const block = await attention.buildChatContext(USER);
        expect(block).toContain('PR #164');
        // Taken means delivered: it must not be raised again next turn.
        expect(await attention.buildChatContext(USER)).toBeNull();
    });

    test('notices nobody looked at expire quietly', async () => {
        await enroll('delegate');
        await db.insert(
            `INSERT INTO attention_notices (userId, dedupeKey, category, title, disposition, score, createdAt)
             VALUES (@u, 'test:ancient', 'general', 'Old news', 'inbox', 0.4, datetime('now', '-90 days'))`,
            { u: USER }
        );
        expect(await attention.expireStaleNotices(USER)).toBe(1);
        expect(await attention.listNotices({ userId: USER })).toHaveLength(0);
    });
});

describe('watches wait for conditions', () => {
    test('registering enforces a known topic, a label, and a prompt', async () => {
        await expect(watches.register({
            userId: USER, guildId: GUILD, label: 'x', topic: 'nonsense.topic', prompt: 'do it'
        })).rejects.toThrow(/Watchable conditions/);
        await expect(watches.register({
            userId: USER, guildId: GUILD, label: '', topic: 'observatory.job_completed', prompt: 'do it'
        })).rejects.toThrow(/label is required/);
        await expect(watches.register({
            userId: USER, guildId: GUILD, label: 'x', topic: 'observatory.job_completed', prompt: '  '
        })).rejects.toThrow(/what you want done/);
    });

    test('labels are unique per person and armed watches are capped', async () => {
        await watches.register({
            userId: USER, guildId: GUILD, label: 'run result',
            topic: 'observatory.job_completed', prompt: 'inspect it'
        });
        await expect(watches.register({
            userId: USER, guildId: GUILD, label: 'run result',
            topic: 'observatory.job_completed', prompt: 'inspect it'
        })).rejects.toThrow(/already have a watch/);

        for (let i = 0; i < config.WATCHES.maxPerUser - 1; i++) {
            await watches.register({
                userId: USER, guildId: GUILD, label: `watch ${i}`,
                topic: 'observatory.job_completed', prompt: 'inspect it'
            });
        }
        await expect(watches.register({
            userId: USER, guildId: GUILD, label: 'one too many',
            topic: 'observatory.job_completed', prompt: 'inspect it'
        })).rejects.toThrow(/At most/);
    });

    test('a matching condition fires the turn exactly once', async () => {
        const watch = await watches.register({
            userId: USER, guildId: GUILD, label: 'emergence run',
            topic: 'observatory.job_completed', prompt: 'inspect the result',
            condition: { jobId: 42 }
        });
        const runTurn = jest.spyOn(watches, '_runTurn').mockResolvedValue();

        const event = {
            topic: 'observatory.job_completed',
            payload: { userId: USER, jobId: 42, status: 'COMPLETED' }
        };
        await watches.onEvent(event);
        await watches.onEvent(event); // a duplicated event must not re-fire

        expect(runTurn).toHaveBeenCalledTimes(1);
        expect((await watches.get(watch.id)).status).toBe('FIRED');
        runTurn.mockRestore();
    });

    test('a condition that does not match is ignored', async () => {
        await watches.register({
            userId: USER, guildId: GUILD, label: 'job 42 only',
            topic: 'observatory.job_completed', prompt: 'inspect it',
            condition: { jobId: 42 }
        });
        const runTurn = jest.spyOn(watches, '_runTurn').mockResolvedValue();

        await watches.onEvent({
            topic: 'observatory.job_completed',
            payload: { userId: USER, jobId: 43 }
        });
        await watches.onEvent({
            topic: 'reflection.completed',
            payload: { userId: USER, jobId: 42 }
        });
        expect(runTurn).not.toHaveBeenCalled();
        runTurn.mockRestore();
    });

    test('a wildcard topic catches its whole namespace', async () => {
        await watches.register({
            userId: USER, guildId: GUILD, label: 'any observatory news',
            topic: 'observatory.*', prompt: 'tell me'
        });
        const runTurn = jest.spyOn(watches, '_runTurn').mockResolvedValue();
        await watches.onEvent({
            topic: 'observatory.job_failed',
            payload: { userId: USER, jobId: 1 }
        });
        expect(runTurn).toHaveBeenCalledTimes(1);
        runTurn.mockRestore();
    });

    test('another person\'s event never fires your watch', async () => {
        await watches.register({
            userId: USER, guildId: GUILD, label: 'mine',
            topic: 'observatory.job_completed', prompt: 'inspect it'
        });
        const runTurn = jest.spyOn(watches, '_runTurn').mockResolvedValue();
        await watches.onEvent({
            topic: 'observatory.job_completed',
            payload: { userId: '111111111111111111', jobId: 9 }
        });
        expect(runTurn).not.toHaveBeenCalled();
        runTurn.mockRestore();
    });

    test('a failing turn marks the watch failed with its reason', async () => {
        const watch = await watches.register({
            userId: USER, guildId: GUILD, label: 'doomed',
            topic: 'observatory.job_completed', prompt: 'inspect it'
        });
        const runTurn = jest.spyOn(watches, '_runTurn').mockRejectedValue(new Error('channel gone'));
        await watches.onEvent({
            topic: 'observatory.job_completed',
            payload: { userId: USER, jobId: 1 }
        });
        const after = await watches.get(watch.id);
        expect(after.status).toBe('FAILED');
        expect(after.lastError).toContain('channel gone');
        runTurn.mockRestore();
    });

    test('a firing watch hands the turn the evidence, not just the event name', async () => {
        // A watch that wakes up knowing only "job 42 completed" has to go
        // hunting before it can say anything, and reports failure when the
        // relevant tool is unavailable. The opening context should carry the
        // run's outcome and output.
        const projectId = await db.insert(
            `INSERT INTO observatory_projects (userId, slug, name)
             VALUES (@userId, 'emergence-study', 'Emergence study')`,
            { userId: USER }
        );
        const jobId = Number(await db.insert(
            `INSERT INTO observatory_jobs
                (projectId, userId, language, code, status, segments, resumeCount, exitCode,
                 finishedAt, stdoutTail, stderrTail)
             VALUES (@projectId, @userId, 'python', 'simulate()', 'COMPLETED', 4, 2, 0,
                     datetime('now'),
                     'lambda=0.30 present | lambda=0.34 present | lambda=0.38 absent',
                     'seed 8/10 diverged')`,
            { projectId, userId: USER }
        ));

        const evidence = await watches._describeEvent({
            topic: 'observatory.job_completed',
            payload: { userId: USER, jobId, project: 'emergence-study', status: 'COMPLETED' }
        });
        expect(evidence).toContain('observatory.job_completed');
        expect(evidence).toContain('Emergence study');
        expect(evidence).toContain('COMPLETED');
        expect(evidence).toContain('2 checkpoint resume');
        expect(evidence).toContain('lambda=0.38 absent');
        expect(evidence).toContain('seed 8/10 diverged');
    });

    test('event evidence degrades gracefully when there is nothing to look up', async () => {
        const evidence = await watches._describeEvent({
            topic: 'reflection.completed',
            payload: { userId: USER, runId: 12, contradictions: 2 }
        });
        expect(evidence).toContain('reflection.completed');
        expect(evidence).toContain('contradictions=2');

        const orphan = await watches._describeEvent({
            topic: 'observatory.job_completed',
            payload: { userId: USER, jobId: 999999 }
        });
        expect(orphan).toContain('observatory.job_completed');
    });

    test('the turn it runs actually carries the instruction', async () => {
        // The pipeline reads the prompt through options.getString() first and
        // interaction.content second, so both have to be populated - a watch
        // that fires with no content produces "no message provided" and
        // silently wastes the condition it was waiting for.
        const { handleChatInteraction } = require('@goobster/core/utils/chatHandler');
        const sent = [];
        const channel = {
            id: 'dm-channel',
            isTextBased: () => true,
            sendTyping: async () => {},
            send: async (payload) => { sent.push(payload.content); return { id: 'm1' }; }
        };
        watches.attach({
            user: { id: '999999999999999999' },
            users: { fetch: async () => ({ id: USER, username: 'rob', createDM: async () => channel }) },
            channels: { fetch: async () => channel },
            guilds: { cache: new Map() }
        });
        try {
            await watches.register({
                userId: USER, guildId: `dm:${USER}`, label: 'run result',
                topic: 'observatory.job_completed',
                prompt: 'Inspect the output and compare it against the hypothesis.'
            });
            await watches.onEvent({
                topic: 'observatory.job_completed',
                payload: { userId: USER, jobId: 7, project: 'emergence-study' }
            });

            expect(handleChatInteraction).toHaveBeenCalledTimes(1);
            const interaction = handleChatInteraction.mock.calls[0][0];
            expect(interaction.content).toBe('Inspect the output and compare it against the hypothesis.');
            expect(interaction.options.getString('message'))
                .toBe('Inspect the output and compare it against the hypothesis.');
            // An unattended turn, with the automation guardrails that implies.
            expect(interaction.isAutomation).toBe(true);
            // The turn is told what happened, not merely what to do.
            expect(interaction.sourceDescription).toContain('observatory.job_completed');
            expect(interaction.sourceDescription).toContain('emergence-study');

            // Delivery is labelled with the watch, so an unprompted message is
            // always traceable to the thing the user asked him to watch for.
            await interaction.sendFullResponse('The bifurcation held for 8 of 10 seeds.');
            expect(sent[0]).toContain('run result');
            expect(sent[0]).toContain('bifurcation held');
        } finally {
            watches.detach();
        }
    });

    test('cancelling disarms, and expiry sweeps the rest', async () => {
        const watch = await watches.register({
            userId: USER, guildId: GUILD, label: 'cancel me',
            topic: 'observatory.job_completed', prompt: 'inspect it'
        });
        expect(await watches.cancel({ userId: USER, label: 'cancel me' })).toBe(true);
        expect((await watches.get(watch.id)).status).toBe('CANCELLED');
        expect(await watches.cancel({ userId: USER, label: 'cancel me' })).toBe(false);

        const other = await watches.register({
            userId: USER, guildId: GUILD, label: 'stale',
            topic: 'observatory.job_completed', prompt: 'inspect it'
        });
        await db.run(
            `UPDATE attention_watches SET expiresAt = datetime('now', '-1 hours') WHERE id = @id`,
            { id: other.id }
        );
        expect(await watches.expireStale()).toBe(1);
        expect((await watches.get(other.id)).status).toBe('EXPIRED');
    });
});

describe('the domain event bus', () => {
    test('matches exact topics, namespace wildcards, and everything', () => {
        expect(domainEventBus.topicMatches('observatory.job_completed', 'observatory.job_completed')).toBe(true);
        expect(domainEventBus.topicMatches('observatory.job_completed', 'observatory.*')).toBe(true);
        expect(domainEventBus.topicMatches('observatory.job_completed', '*')).toBe(true);
        expect(domainEventBus.topicMatches('observatory.job_completed', 'knowledge.*')).toBe(false);
    });

    test('delivers to matching subscribers only, and refuses unknown topics', () => {
        const seen = [];
        const stop = domainEventBus.subscribe('observatory.*', event => seen.push(event.topic));
        const other = [];
        const stopOther = domainEventBus.subscribe('knowledge.*', event => other.push(event.topic));
        try {
            domainEventBus.publish(domainEventBus.TOPICS.OBSERVATORY_JOB_COMPLETED, { userId: USER });
            domainEventBus.publish('made.up.topic', { userId: USER });
            expect(seen).toEqual(['observatory.job_completed']);
            expect(other).toEqual([]);
        } finally {
            stop();
            stopOther();
        }
    });

    test('a throwing subscriber does not stop the others', () => {
        const seen = [];
        const stopBad = domainEventBus.subscribe('*', () => { throw new Error('bad listener'); });
        const stopGood = domainEventBus.subscribe('*', event => seen.push(event.topic));
        try {
            domainEventBus.publish(domainEventBus.TOPICS.REFLECTION_COMPLETED, { userId: USER });
            expect(seen).toEqual(['reflection.completed']);
        } finally {
            stopBad();
            stopGood();
        }
    });
});
