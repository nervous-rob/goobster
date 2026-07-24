/**
 * Developer-integration plumbing: repo watch CRUD/allowlisting, HMAC
 * verification on both webhook receivers (end-to-end over HTTP against the
 * real express app), and agent-run tracking updates. Uses a throwaway SQLite
 * file — no config or network needed.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DB = path.join(os.tmpdir(), `goobster-integrations-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const integrationsConfig = require('../config/integrationsConfig');
const repoWatchService = require('../services/repoWatchService');
const AgentTrackerService = require('../services/agentTrackerService');
const { createIntegrationsApp, verifySignature } = require('../web/integrationsApi');

const GUILD = '600000000000000001';
const CHANNEL = '600000000000000002';
const USER = '600000000000000003';
const GITHUB_SECRET = 'github-webhook-secret-for-tests-1234';
const CURSOR_SECRET = 'cursor-webhook-secret-for-tests-5678';

function sign(secret, body) {
    return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Minimal fake discord.js client: text channel with a recorded send(). */
function makeFakeClient() {
    const sent = [];
    const channel = {
        isTextBased: () => true,
        send: jest.fn(async (message) => { sent.push(message); })
    };
    const client = {
        channels: { fetch: jest.fn(async () => channel) }
    };
    return { client, channel, sent };
}

afterAll(() => {
    try {
        db.closeConnection?.();
    } catch { /* best effort */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* best effort */ }
    }
});

describe('repoWatchService', () => {
    beforeEach(() => {
        db.run('DELETE FROM repo_watches');
    });

    test('addWatch upserts and defaults to all events', () => {
        const events = repoWatchService.addWatch({ guildId: GUILD, channelId: CHANNEL, repo: 'o/r', events: [], createdBy: USER });
        expect(events).toEqual(['push', 'pull_request', 'issues', 'release', 'ci']);

        // Re-watching replaces channel and events instead of duplicating.
        repoWatchService.addWatch({ guildId: GUILD, channelId: '999', repo: 'o/r', events: ['push'], createdBy: USER });
        const watches = repoWatchService.listWatches(GUILD);
        expect(watches).toHaveLength(1);
        expect(watches[0].channelId).toBe('999');
        expect(watches[0].events).toEqual(['push']);
    });

    test('isRepoAllowed reflects the watch list per guild', () => {
        repoWatchService.addWatch({ guildId: GUILD, channelId: CHANNEL, repo: 'o/r', events: ['push'], createdBy: USER });
        expect(repoWatchService.isRepoAllowed(GUILD, 'o/r')).toBe(true);
        expect(repoWatchService.isRepoAllowed(GUILD, 'o/other')).toBe(false);
        expect(repoWatchService.isRepoAllowed('700000000000000009', 'o/r')).toBe(false);

        expect(repoWatchService.removeWatch(GUILD, 'o/r')).toBe(true);
        expect(repoWatchService.isRepoAllowed(GUILD, 'o/r')).toBe(false);
        expect(repoWatchService.removeWatch(GUILD, 'o/r')).toBe(false);
    });

    test('findWatches filters by subscribed event key', () => {
        repoWatchService.addWatch({ guildId: GUILD, channelId: CHANNEL, repo: 'o/r', events: ['push'], createdBy: USER });
        expect(repoWatchService.findWatches('o/r', 'push')).toHaveLength(1);
        expect(repoWatchService.findWatches('o/r', 'issues')).toHaveLength(0);
    });

    test('handleEvent posts a push embed to the watching channel only', async () => {
        repoWatchService.addWatch({ guildId: GUILD, channelId: CHANNEL, repo: 'o/r', events: ['push', 'ci'], createdBy: USER });
        const { client, sent } = makeFakeClient();

        const delivered = await repoWatchService.handleEvent({
            client,
            event: 'push',
            payload: {
                ref: 'refs/heads/main',
                compare: 'https://github.com/o/r/compare/a...b',
                repository: { full_name: 'o/r' },
                sender: { login: 'rob' },
                commits: [{ id: 'abcdef1234567', url: 'https://github.com/o/r/commit/abcdef1', message: 'fix: things' }]
            }
        });
        expect(delivered).toBe(1);
        expect(sent[0].embeds).toHaveLength(1);

        // Successful CI runs are deliberately silent (failures only).
        const quiet = await repoWatchService.handleEvent({
            client,
            event: 'workflow_run',
            payload: {
                action: 'completed',
                repository: { full_name: 'o/r' },
                workflow_run: { conclusion: 'success', name: 'CI', head_branch: 'main', head_sha: 'abc', html_url: 'x' }
            }
        });
        expect(quiet).toBe(0);
    });
});

describe('webhook receivers (HTTP end-to-end)', () => {
    let server;
    let baseUrl;
    let fakeClient;
    let tracker;
    let originalGithubSecret;
    let originalCursorSecret;

    beforeAll(async () => {
        originalGithubSecret = integrationsConfig.github.webhookSecret;
        originalCursorSecret = integrationsConfig.cursor.webhookSecret;
        integrationsConfig.github.webhookSecret = GITHUB_SECRET;
        integrationsConfig.cursor.webhookSecret = CURSOR_SECRET;

        fakeClient = makeFakeClient();
        tracker = new AgentTrackerService(fakeClient.client);
        fakeClient.client.agentTrackerService = tracker;

        const app = createIntegrationsApp({ client: fakeClient.client, logger: { warn: () => {}, error: () => {} } });
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        integrationsConfig.github.webhookSecret = originalGithubSecret;
        integrationsConfig.cursor.webhookSecret = originalCursorSecret;
        await new Promise(resolve => server.close(resolve));
    });

    beforeEach(() => {
        db.run('DELETE FROM repo_watches');
        db.run('DELETE FROM agent_runs');
        fakeClient.sent.length = 0;
    });

    test('verifySignature accepts only the exact HMAC', () => {
        const body = Buffer.from('{"a":1}');
        expect(verifySignature('secret', body, sign('secret', body))).toBe(true);
        expect(verifySignature('secret', body, sign('other', body))).toBe(false);
        expect(verifySignature('secret', body, 'sha256=zz')).toBe(false);
        expect(verifySignature('secret', body, null)).toBe(false);
        expect(verifySignature(null, body, sign('secret', body))).toBe(false);
        // A body already parsed by an upstream JSON middleware must be
        // rejected, never crash Hmac.update().
        expect(verifySignature('secret', { a: 1 }, sign('secret', body))).toBe(false);
        expect(verifySignature('secret', undefined, sign('secret', body))).toBe(false);
    });

    test('GitHub receiver rejects bad signatures and delivers good ones', async () => {
        repoWatchService.addWatch({ guildId: GUILD, channelId: CHANNEL, repo: 'o/r', events: ['issues'], createdBy: USER });
        const body = JSON.stringify({
            action: 'opened',
            repository: { full_name: 'o/r' },
            sender: { login: 'rob' },
            issue: { number: 7, title: 'It broke', body: 'stack trace…', html_url: 'https://github.com/o/r/issues/7' }
        });

        const bad = await fetch(`${baseUrl}/api/webhooks/github`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-hub-signature-256': sign('wrong', body) },
            body
        });
        expect(bad.status).toBe(401);

        const good = await fetch(`${baseUrl}/api/webhooks/github`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-hub-signature-256': sign(GITHUB_SECRET, body) },
            body
        });
        expect(good.status).toBe(202);

        // Delivery is async after the 202 ACK.
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(fakeClient.sent).toHaveLength(1);
        expect(fakeClient.sent[0].embeds[0].data.title).toContain('Issue opened');
    });

    test('Cursor receiver updates the tracked run and notifies the channel', async () => {
        tracker.track({
            agentId: 'bc-test-1', runId: 'run-test-1',
            guildId: GUILD, channelId: CHANNEL, userId: USER,
            repo: 'o/r', prompt: 'Fix the bug', status: 'RUNNING',
            agentUrl: 'https://cursor.com/agents/bc-test-1'
        });

        const body = JSON.stringify({
            event: 'statusChange',
            id: 'bc-test-1',
            status: 'FINISHED',
            summary: 'Fixed the bug and added a test.',
            target: { prUrl: 'https://github.com/o/r/pull/42', branchName: 'cursor/fix-bug-1234' }
        });

        const response = await fetch(`${baseUrl}/api/webhooks/cursor`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(CURSOR_SECRET, body) },
            body
        });
        expect(response.status).toBe(202);

        await new Promise(resolve => setTimeout(resolve, 100));
        const row = db.get('SELECT * FROM agent_runs WHERE agentId = @agentId', { agentId: 'bc-test-1' });
        expect(row.status).toBe('FINISHED');
        expect(row.prUrl).toBe('https://github.com/o/r/pull/42');
        expect(row.summary).toBe('Fixed the bug and added a test.');
        expect(fakeClient.sent).toHaveLength(1);

        // A repeat delivery with no change stays silent.
        const repeat = await fetch(`${baseUrl}/api/webhooks/cursor`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(CURSOR_SECRET, body) },
            body
        });
        expect(repeat.status).toBe(202);
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(fakeClient.sent).toHaveLength(1);
    });

    test('agent tracker ignores updates for unknown agents', async () => {
        await tracker.applyUpdate({ agentId: 'bc-unknown', status: 'FINISHED' });
        expect(fakeClient.sent).toHaveLength(0);
    });
});

describe('public server composition (activity + webhook receivers)', () => {
    // Regression for the middleware-ordering bug: the Activity router's
    // router-wide express.json() used to consume webhook bodies first, so
    // GitHub deliveries failed with 413 (>16kb) or a Hmac TypeError (<16kb).
    let server;
    let baseUrl;
    let originalGithubSecret;

    beforeAll(async () => {
        originalGithubSecret = integrationsConfig.github.webhookSecret;
        integrationsConfig.github.webhookSecret = GITHUB_SECRET;

        const { createHealthApp } = require('../web/server');
        const { createActivityApp } = require('../web/activityApi');
        const app = createHealthApp({ logger: { debug: () => {} } });
        // Worst-case mount order (activity first) to prove the webhook
        // receivers survive it regardless of web/server.js ordering.
        app.use(createActivityApp({ clientId: 'test-client', devMode: true, sessions: new Map(), logger: console }));
        app.use(createIntegrationsApp({ client: makeFakeClient().client, logger: { warn: () => {}, error: () => {} } }));
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        integrationsConfig.github.webhookSecret = originalGithubSecret;
        await new Promise(resolve => server.close(resolve));
    });

    function postGithub(body) {
        return fetch(`${baseUrl}/api/webhooks/github`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sign(GITHUB_SECRET, body) },
            body
        });
    }

    test('small signed webhook is ACKed (raw body not consumed upstream)', async () => {
        const response = await postGithub(JSON.stringify({ zen: 'ping', repository: { full_name: 'o/r' } }));
        expect(response.status).toBe(202);
    });

    test('large signed webhook (>16kb) is ACKed (no activity-size limit applied)', async () => {
        const body = JSON.stringify({
            repository: { full_name: 'o/r' },
            commits: Array.from({ length: 300 }, (_, i) => ({ id: String(i), message: 'x'.repeat(100) }))
        });
        expect(body.length).toBeGreaterThan(16 * 1024);
        const response = await postGithub(body);
        expect(response.status).toBe(202);
    });

    test('activity API still parses JSON bodies on its own routes', async () => {
        const response = await fetch(`${baseUrl}/api/activity/dev-session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userId: '600000000000000003', name: 'tester' })
        });
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.user).toEqual({ id: '600000000000000003', name: 'tester' });
    });
});
