/**
 * Phase 3/4 flows: 📋 reaction → issue proposal (utils/issueCapture.js),
 * the goobster-fix label → agent-launch bridge (repoWatchService), and
 * heartbeat propose_agent legalization. Throwaway SQLite DB; the AI provider
 * is mocked and credentials are toggled via integrationsConfig.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-capture-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../services/aiService', () => ({
    generateText: jest.fn(async () => '{"title": "Voice TTS clips the last word", "body": "On short replies the final word is cut off."}'),
    chatText: jest.fn(),
    chat: jest.fn()
}));

const db = require('../db');
const integrationsConfig = require('../config/integrationsConfig');
const repoWatchService = require('../services/repoWatchService');
const { handleIssueCaptureReaction, resolveTargetRepo } = require('../utils/issueCapture');
const HeartbeatService = require('../services/heartbeatService');

const GUILD = '810000000000000001';
const CHANNEL = '810000000000000002';
const OTHER_CHANNEL = '810000000000000003';
const USER = '810000000000000004';
const REPO = 'o/r';

function makeMessage({ content = 'the bot crashes when I run /wrapped', channelId = CHANNEL, authorBot = false } = {}) {
    const replies = [];
    return {
        id: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
        content,
        guild: { id: GUILD },
        author: { id: authorBot ? 'BOT' : USER, bot: authorBot, username: 'rob' },
        client: { user: { id: 'BOT' } },
        channel: {
            id: channelId,
            messages: { fetch: jest.fn(async () => new Map()) }
        },
        reply: jest.fn(async (payload) => { replies.push(payload); }),
        replies
    };
}

afterAll(() => {
    try { db.closeConnection?.(); } catch { /* best effort */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* best effort */ }
    }
});

let originalToken;
let originalKey;
beforeEach(() => {
    jest.clearAllMocks();
    originalToken = integrationsConfig.github.token;
    originalKey = integrationsConfig.cursor.apiKey;
    integrationsConfig.github.token = 'ghp_test';
    integrationsConfig.cursor.apiKey = 'key_test';
    db.run('DELETE FROM repo_watches');
    db.run('DELETE FROM pending_integration_actions');
    repoWatchService.addWatch({ guildId: GUILD, channelId: CHANNEL, repo: REPO, events: [], createdBy: USER });
});

afterEach(() => {
    integrationsConfig.github.token = originalToken;
    integrationsConfig.cursor.apiKey = originalKey;
});

describe('📋 issue capture', () => {
    test('resolveTargetRepo prefers the channel watch, then the only guild watch', () => {
        expect(resolveTargetRepo(GUILD, CHANNEL)).toBe(REPO);
        expect(resolveTargetRepo(GUILD, OTHER_CHANNEL)).toBe(REPO); // only one watch in guild

        repoWatchService.addWatch({ guildId: GUILD, channelId: OTHER_CHANNEL, repo: 'o/second', events: [], createdBy: USER });
        expect(resolveTargetRepo(GUILD, OTHER_CHANNEL)).toBe('o/second'); // channel-specific
        expect(resolveTargetRepo(GUILD, '810000000000000099')).toBeNull(); // ambiguous
    });

    test('reacting posts an AI-drafted proposal with buttons and audits it', async () => {
        const message = makeMessage();
        expect(await handleIssueCaptureReaction({ message }, { id: USER })).toBe(true);

        expect(message.reply).toHaveBeenCalledTimes(1);
        const proposal = message.replies[0];
        expect(proposal.components[0].components).toHaveLength(2);

        const row = db.get(`SELECT * FROM pending_integration_actions WHERE type = 'github-issue'`);
        const payload = JSON.parse(row.payload);
        expect(payload).toMatchObject({ repo: REPO, title: 'Voice TTS clips the last word', sourceMessageId: message.id });
        expect(payload.body).toContain('Reported by **rob**');

        // Reacting again on the same message doesn't stack proposals
        expect(await handleIssueCaptureReaction({ message }, { id: USER })).toBe(true);
        expect(message.reply).toHaveBeenCalledTimes(1);
    });

    test('falls back to a deterministic draft when the AI response is unusable', async () => {
        require('../services/aiService').generateText.mockResolvedValueOnce('not json at all');
        const message = makeMessage({ content: 'Stocks chart renders blank on ARM' });
        await handleIssueCaptureReaction({ message }, { id: USER });
        const payload = JSON.parse(db.get(`SELECT payload FROM pending_integration_actions`).payload);
        expect(payload.title).toBe('Stocks chart renders blank on ARM');
        expect(payload.body).toContain('> Stocks chart renders blank on ARM');
    });

    test('polite refusals: no token, no watches, bot message', async () => {
        integrationsConfig.github.token = null;
        const message = makeMessage();
        expect(await handleIssueCaptureReaction({ message }, { id: USER })).toBe(true);
        expect(message.replies[0].content).toContain('GITHUB_TOKEN');

        integrationsConfig.github.token = 'ghp_test';
        db.run('DELETE FROM repo_watches');
        const message2 = makeMessage();
        await handleIssueCaptureReaction({ message: message2 }, { id: USER });
        expect(message2.replies[0].content).toContain('/github watch');

        const botMessage = makeMessage({ authorBot: true });
        botMessage.author.id = 'BOT';
        expect(await handleIssueCaptureReaction({ message: botMessage }, { id: USER })).toBe(false);
    });
});

describe('issue label → agent bridge', () => {
    function labeledPayload({ label = 'goobster-fix', state = 'open', number = 12 } = {}) {
        return {
            action: 'labeled',
            label: { name: label },
            repository: { full_name: REPO },
            sender: { login: 'rob' },
            issue: { number, state, title: 'Wrapped card fails on Pi', body: 'sharp explodes', html_url: `https://github.com/o/r/issues/${number}` }
        };
    }

    function makeClient() {
        const sent = [];
        return {
            sent,
            channels: { fetch: jest.fn(async () => ({ isTextBased: () => true, send: jest.fn(async m => { sent.push(m); }) })) }
        };
    }

    test('the agent label posts a launch proposal in the watch channel', async () => {
        const client = makeClient();
        const posted = await repoWatchService.handleEvent({ client, event: 'issues', payload: labeledPayload() });
        expect(posted).toBe(1);
        expect(client.sent[0].content).toContain('goobster-fix');
        expect(client.sent[0].components[0].components).toHaveLength(2);

        const row = db.get(`SELECT payload FROM pending_integration_actions WHERE type = 'agent-launch'`);
        const payload = JSON.parse(row.payload);
        expect(payload.issueRef).toBe(`${REPO}#12`);
        expect(payload.prompt).toContain('Fix GitHub issue #12');

        // Re-labeling doesn't stack proposals
        expect(await repoWatchService.handleEvent({ client, event: 'issues', payload: labeledPayload() })).toBe(0);
    });

    test('other labels, closed issues, and missing Cursor config are ignored', async () => {
        const client = makeClient();
        expect(await repoWatchService.handleEvent({ client, event: 'issues', payload: labeledPayload({ label: 'bug' }) })).toBe(0);
        expect(await repoWatchService.handleEvent({ client, event: 'issues', payload: labeledPayload({ state: 'closed' }) })).toBe(0);

        integrationsConfig.cursor.apiKey = null;
        expect(await repoWatchService.handleEvent({ client, event: 'issues', payload: labeledPayload() })).toBe(0);
        expect(client.sent).toHaveLength(0);
    });
});

describe('heartbeat propose_agent', () => {
    function makeGuildAndChannel() {
        const sent = [];
        return {
            guild: { id: GUILD, name: 'Test Guild' },
            channel: { id: CHANNEL, name: 'general', send: jest.fn(async m => { sent.push(m); }) },
            sent
        };
    }

    test('a legal proposal posts buttons; illegal ones are dropped', async () => {
        const heartbeat = new HeartbeatService({ guilds: { cache: new Map() } });
        const { guild, channel, sent } = makeGuildAndChannel();

        // Unallowlisted repo → dropped
        expect(await heartbeat._proposeAgent(guild, channel, { repo: 'o/evil', task: 'x' })).toBe(false);
        // Missing task → dropped
        expect(await heartbeat._proposeAgent(guild, channel, { repo: REPO, task: ' ' })).toBe(false);

        expect(await heartbeat._proposeAgent(guild, channel, { repo: REPO, task: 'Fix the /wrapped crash', reason: 'You two have been fighting this for an hour.' })).toBe(true);
        expect(sent[0].content).toContain('💡');
        expect(sent[0].components[0].components).toHaveLength(2);

        // A second proposal while one is pending → dropped (no stacking)
        expect(await heartbeat._proposeAgent(guild, channel, { repo: REPO, task: 'Another thing' })).toBe(false);
    });

    test('proposals are off the menu without Cursor config', () => {
        const heartbeat = new HeartbeatService({ guilds: { cache: new Map() } });
        expect(heartbeat._agentProposalRepos(GUILD)).toEqual([REPO]);
        integrationsConfig.cursor.apiKey = null;
        expect(heartbeat._agentProposalRepos(GUILD)).toEqual([]);
    });
});
