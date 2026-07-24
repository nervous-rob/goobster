/**
 * Confirmable integration actions (services/integrationActionService.js) and
 * agent mission-control threads (agentTrackerService.openThread /
 * handleThreadMessage): pending lifecycle + TTL, button permission gates,
 * execution on confirm, and reply-to-follow-up routing. Throwaway SQLite DB;
 * the Cursor and GitHub API wrappers are mocked.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-intactions-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../services/cursorAgentService', () => ({
    isConfigured: jest.fn(() => true),
    launchAgent: jest.fn(),
    followUp: jest.fn(),
    getRun: jest.fn(),
    isTerminalStatus: (status) => ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'].includes(String(status || '').toUpperCase())
}));
jest.mock('../services/githubService', () => ({
    hasToken: jest.fn(() => true),
    parseRepo: jest.fn(input => input),
    createIssue: jest.fn()
}));

const db = require('../db');
const cursorAgentService = require('../services/cursorAgentService');
const githubService = require('../services/githubService');
const repoWatchService = require('../services/repoWatchService');
const integrationActionService = require('../services/integrationActionService');
const AgentTrackerService = require('../services/agentTrackerService');

const GUILD = '800000000000000001';
const CHANNEL = '800000000000000002';
const ADMIN = '800000000000000003';
const REPO = 'o/r';

function makeInteraction({ canManage = true, guildId = GUILD } = {}) {
    return {
        guildId,
        user: { id: ADMIN },
        memberPermissions: { has: () => canManage },
        client: { agentTrackerService: null },
        message: { startThread: jest.fn() },
        followUp: jest.fn(async () => {})
    };
}

afterAll(() => {
    try { db.closeConnection?.(); } catch { /* best effort */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* best effort */ }
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    db.run('DELETE FROM pending_integration_actions');
    db.run('DELETE FROM repo_watches');
    db.run('DELETE FROM agent_runs');
    repoWatchService.addWatch({ guildId: GUILD, channelId: CHANNEL, repo: REPO, events: [], createdBy: ADMIN });
});

describe('pending action lifecycle', () => {
    test('createPending stores the row and returns Confirm/Cancel buttons', () => {
        const { id, message } = integrationActionService.createPending({
            type: 'github-issue', guildId: GUILD, channelId: CHANNEL, requestedBy: ADMIN,
            payload: { repo: REPO, title: 'It broke', body: 'details' }
        });
        expect(integrationActionService.getPending(id)).toMatchObject({
            type: 'github-issue', status: 'PENDING', payload: { title: 'It broke' }
        });
        const ids = message.components[0].components.map(component => component.data.custom_id);
        expect(ids).toEqual([`approve_intaction_${id}`, `deny_intaction_${id}`]);
    });

    test('stale pending rows expire on read', () => {
        const { id } = integrationActionService.createPending({
            type: 'github-issue', guildId: GUILD, channelId: CHANNEL,
            payload: { repo: REPO, title: 'x' }
        });
        db.run(`UPDATE pending_integration_actions SET createdAt = datetime('now', '-16 minutes') WHERE id = @id`, { id });
        expect(integrationActionService.getPending(id)).toBeNull();
        expect(db.get('SELECT status FROM pending_integration_actions WHERE id = @id', { id }).status).toBe('EXPIRED');
    });
});

describe('handleButton', () => {
    test('resolved or unknown ids report "no longer pending"', async () => {
        const edit = await integrationActionService.handleButton('approve', 999999, makeInteraction());
        expect(edit.content).toContain('no longer pending');
        expect(edit.components).toEqual([]);
    });

    test('non-managers cannot resolve; buttons stay up', async () => {
        const { id } = integrationActionService.createPending({
            type: 'github-issue', guildId: GUILD, channelId: CHANNEL, payload: { repo: REPO, title: 'x' }
        });
        const interaction = makeInteraction({ canManage: false });
        const edit = await integrationActionService.handleButton('approve', id, interaction);
        expect(edit).toBeNull();
        expect(interaction.followUp).toHaveBeenCalled();
        expect(integrationActionService.getPending(id)).not.toBeNull();
    });

    test('a request from another guild cannot be resolved', async () => {
        const { id } = integrationActionService.createPending({
            type: 'github-issue', guildId: GUILD, channelId: CHANNEL, payload: { repo: REPO, title: 'x' }
        });
        const edit = await integrationActionService.handleButton('approve', id, makeInteraction({ guildId: '900000000000000009' }));
        expect(edit.content).toContain('different server');
    });

    test('deny cancels without executing anything', async () => {
        const { id } = integrationActionService.createPending({
            type: 'agent-launch', guildId: GUILD, channelId: CHANNEL, payload: { repo: REPO, prompt: 'do it' }
        });
        const edit = await integrationActionService.handleButton('deny', id, makeInteraction());
        expect(edit.content).toContain('Cancelled');
        expect(cursorAgentService.launchAgent).not.toHaveBeenCalled();
        expect(db.get('SELECT status FROM pending_integration_actions WHERE id = @id', { id }).status).toBe('CANCELLED');
    });

    test('confirming an agent-launch launches, tracks, and opens a thread', async () => {
        cursorAgentService.launchAgent.mockResolvedValue({
            agent: { id: 'bc-42', name: 'Do it', url: 'https://cursor.com/agents/bc-42' },
            run: { id: 'run-42', status: 'CREATING' }
        });
        const interaction = makeInteraction();
        const tracker = new AgentTrackerService({ channels: { fetch: jest.fn() } });
        interaction.client.agentTrackerService = tracker;
        const thread = { id: '800000000000000042', send: jest.fn(async () => {}) };
        interaction.message.startThread.mockResolvedValue(thread);

        const { id } = integrationActionService.createPending({
            type: 'agent-launch', guildId: GUILD, channelId: CHANNEL, payload: { repo: REPO, prompt: 'do it', branch: 'main' }
        });
        const edit = await integrationActionService.handleButton('approve', id, interaction);

        expect(cursorAgentService.launchAgent).toHaveBeenCalledWith({ prompt: 'do it', repo: REPO, ref: 'main', autoCreatePr: true });
        const row = db.get(`SELECT * FROM agent_runs WHERE agentId = 'bc-42'`);
        expect(row).toMatchObject({ runId: 'run-42', guildId: GUILD, status: 'CREATING', threadId: thread.id });
        expect(edit.embeds).toHaveLength(1);
        expect(db.get('SELECT status FROM pending_integration_actions WHERE id = @id', { id }).status).toBe('CONFIRMED');
    });

    test('confirming an unwatched repo launch fails and stays pending for retry', async () => {
        const { id } = integrationActionService.createPending({
            type: 'agent-launch', guildId: GUILD, channelId: CHANNEL, payload: { repo: 'o/other', prompt: 'x' }
        });
        const interaction = makeInteraction();
        const edit = await integrationActionService.handleButton('approve', id, interaction);
        expect(edit).toBeNull();
        expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('allowlisted') }));
        expect(integrationActionService.getPending(id)).not.toBeNull();
    });

    test('confirming a github-issue creates the issue', async () => {
        githubService.createIssue.mockResolvedValue({ number: 7, title: 'It broke', html_url: 'https://github.com/o/r/issues/7' });
        const { id } = integrationActionService.createPending({
            type: 'github-issue', guildId: GUILD, channelId: CHANNEL, payload: { repo: REPO, title: 'It broke', body: 'details' }
        });
        const edit = await integrationActionService.handleButton('approve', id, makeInteraction());
        expect(githubService.createIssue).toHaveBeenCalledWith(REPO, { title: 'It broke', body: 'details' });
        expect(edit.embeds[0].data.title).toContain('#7');
    });
});

describe('mission-control threads', () => {
    function makeThreadMessage({ content = 'also add tests', threadId = 'T1', canManage = true } = {}) {
        return {
            content,
            author: { id: ADMIN, bot: false },
            member: { permissions: { has: () => canManage } },
            client: { user: { id: 'BOT' } },
            channel: { id: threadId, isThread: () => true },
            react: jest.fn(async () => {}),
            reply: jest.fn(async () => {})
        };
    }

    test('openThread stores the thread id and updates route into it', async () => {
        const sent = [];
        const threadChannel = { isTextBased: () => true, send: jest.fn(async message => { sent.push(message); }) };
        const tracker = new AgentTrackerService({ channels: { fetch: jest.fn(async () => threadChannel) } });
        tracker.track({ agentId: 'bc-7', runId: 'run-7', guildId: GUILD, channelId: CHANNEL, userId: ADMIN, repo: REPO, prompt: 'x', status: 'RUNNING', agentUrl: null });

        const message = { startThread: jest.fn(async () => ({ id: 'T1', send: jest.fn(async () => {}) })) };
        const thread = await tracker.openThread({ message, agentId: 'bc-7', prompt: 'x' });
        expect(thread.id).toBe('T1');
        expect(db.get(`SELECT threadId FROM agent_runs WHERE agentId = 'bc-7'`).threadId).toBe('T1');

        await tracker.applyUpdate({ agentId: 'bc-7', status: 'FINISHED', summary: 'done' });
        expect(tracker.client.channels.fetch).toHaveBeenCalledWith('T1');
        expect(sent).toHaveLength(1);
    });

    test('a manager reply in the thread becomes a follow-up run', async () => {
        cursorAgentService.followUp.mockResolvedValue({ id: 'run-8', status: 'CREATING' });
        const tracker = new AgentTrackerService({ channels: { fetch: jest.fn() } });
        tracker.track({ agentId: 'bc-7', runId: 'run-7', guildId: GUILD, channelId: CHANNEL, userId: ADMIN, repo: REPO, prompt: 'x', status: 'FINISHED', agentUrl: null });
        db.run(`UPDATE agent_runs SET threadId = 'T1' WHERE agentId = 'bc-7'`);

        const message = makeThreadMessage();
        expect(await tracker.handleThreadMessage(message)).toBe(true);
        expect(cursorAgentService.followUp).toHaveBeenCalledWith('bc-7', 'also add tests');
        expect(message.react).toHaveBeenCalledWith('📨');
        const row = db.get(`SELECT runId, status, prompt FROM agent_runs WHERE agentId = 'bc-7'`);
        expect(row).toMatchObject({ runId: 'run-8', status: 'CREATING', prompt: 'also add tests' });
    });

    test('non-managers are refused; unrelated messages pass through', async () => {
        const tracker = new AgentTrackerService({ channels: { fetch: jest.fn() } });
        tracker.track({ agentId: 'bc-7', runId: 'run-7', guildId: GUILD, channelId: CHANNEL, userId: ADMIN, repo: REPO, prompt: 'x', status: 'RUNNING', agentUrl: null });
        db.run(`UPDATE agent_runs SET threadId = 'T1' WHERE agentId = 'bc-7'`);

        const refused = makeThreadMessage({ canManage: false });
        expect(await tracker.handleThreadMessage(refused)).toBe(true);
        expect(refused.react).toHaveBeenCalledWith('🚫');
        expect(cursorAgentService.followUp).not.toHaveBeenCalled();

        const elsewhere = makeThreadMessage({ threadId: 'T-other' });
        expect(await tracker.handleThreadMessage(elsewhere)).toBe(false);

        const notThread = makeThreadMessage();
        notThread.channel.isThread = () => false;
        expect(await tracker.handleThreadMessage(notThread)).toBe(false);
    });
});
