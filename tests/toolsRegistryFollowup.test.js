/**
 * The scheduleFollowUp tool (utils/toolsRegistry.js): one-time follow-ups
 * keep working exactly as before, the optional `repeat` parameter creates
 * a recurring row (e.g. an hourly Observatory check-in) with recurrence
 * metadata, and validation errors surface as user-presentable messages.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tools-followup-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

// These wrapped commands boot heavy voice/music services at load time; the
// follow-up tool only needs the registry itself.
jest.mock('../commands/music/playtrack', () => ({ execute: jest.fn() }));
jest.mock('../commands/chat/speak', () => ({ execute: jest.fn() }));
jest.mock('../services/aiService', () => ({
    generateText: jest.fn(),
    chat: jest.fn()
}));

const db = require('../db');
const aiService = require('../services/aiService');
const toolsRegistry = require('../utils/toolsRegistry');

const GUILD = '710000000000000001';
const CHANNEL = '710000000000000002';
const USER = '710000000000000003';

const interactionContext = {
    guildId: GUILD,
    channelId: CHANNEL,
    user: { id: USER, username: 'rob' }
};

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    db.run('DELETE FROM followups');
});

describe('scheduleFollowUp tool', () => {
    test('the definition offers the optional repeat parameter and only requires the note', () => {
        const [definition] = toolsRegistry.getDefinitions(['scheduleFollowUp']);
        expect(definition.parameters.properties.repeat).toBeDefined();
        expect(definition.parameters.required).toEqual(['note']);
    });

    test('one-time follow-ups behave exactly as before', async () => {
        const future = new Date(Date.now() + 2 * 60 * 60 * 1000)
            .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        aiService.generateText.mockResolvedValueOnce(future);

        const reply = await toolsRegistry.execute('scheduleFollowUp', {
            note: 'Ask Rob how the deploy went', when: 'in 2 hours', interactionContext
        });
        expect(reply).toBe(`⏰ Follow-up scheduled for ${future} UTC: "Ask Rob how the deploy went"`);

        const row = db.get('SELECT * FROM followups');
        expect(row.recurMinutes).toBeNull();
        expect(row.recurrence).toBeNull();
    });

    test('repeat="every hour" creates a recurring follow-up without needing a when', async () => {
        const reply = await toolsRegistry.execute('scheduleFollowUp', {
            note: 'Check in on the neurogene-lab observatory job',
            repeat: 'every hour',
            interactionContext
        });
        expect(reply).toContain('Recurring follow-up scheduled (every hour)');
        expect(reply).toContain('repeats until cancelled');
        expect(aiService.generateText).not.toHaveBeenCalled();

        const row = db.get('SELECT * FROM followups');
        expect(row.recurMinutes).toBe(60);
        expect(row.recurrence).toBe('every hour');
        expect(row.status).toBe('PENDING');
        expect(row.userId).toBe(USER);
    });

    test('an invalid recurrence surfaces as a clear error message', async () => {
        const reply = await toolsRegistry.execute('scheduleFollowUp', {
            note: 'spam me', repeat: 'every 2 minutes', interactionContext
        });
        expect(reply).toMatch(/^❌ .*at most every 15 minutes/);
        expect(db.get('SELECT COUNT(*) AS c FROM followups').c).toBe(0);
    });

    test('missing both when and repeat is rejected', async () => {
        const reply = await toolsRegistry.execute('scheduleFollowUp', {
            note: 'sometime, maybe', interactionContext
        });
        expect(reply).toMatch(/^❌ .*time \("when"\) or a recurrence/);
    });
});
