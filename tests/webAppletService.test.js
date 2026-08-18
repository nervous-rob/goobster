/**
 * Workshop applet pin/discover/extract, against a throwaway SQLite file.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-applet-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const webAppletService = require('@goobster/core/services/webAppletService');
const { extractApplets } = webAppletService;
const { dmScopeId } = require('@goobster/core/utils/dmScope');

const USER = '700000000000000001';
const OTHER = '700000000000000002';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* gone */ }
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM web_applets');
    await db.run('DELETE FROM messages');
    await db.run('DELETE FROM guild_conversations');
    await db.run('DELETE FROM web_conversations');
});

describe('extractApplets', () => {
    test('pulls html and svg fences and titles from <title> / <h1>', () => {
        const found = extractApplets(
            'here\n```html\n<title>Breakout</title><canvas></canvas>\n```\n' +
            'and\n```svg\n<h1>Orbit</h1><circle/>\n```\n'
        );
        expect(found).toHaveLength(2);
        expect(found[0]).toMatchObject({ language: 'html', title: 'Breakout' });
        expect(found[1]).toMatchObject({ language: 'svg', title: 'Orbit' });
    });

    test('skips empty fences and unknown languages', () => {
        expect(extractApplets('```js\nconsole.log(1)\n```\n```html\n\n```')).toEqual([]);
    });
});

describe('pin / list / unpin', () => {
    test('pins idempotently by content hash and lists newest first', async () => {
        const first = await webAppletService.pin({
            userId: USER, language: 'html', source: '<html><title>A</title></html>'
        });
        const again = await webAppletService.pin({
            userId: USER, language: 'html', source: '<html><title>A</title></html>'
        });
        expect(again.id).toBe(first.id);
        expect(first.title).toBe('A');

        await webAppletService.pin({
            userId: USER, language: 'svg', source: '<svg><title>B</title></svg>', title: 'B'
        });
        const pinned = await webAppletService.listPinned(USER);
        expect(pinned).toHaveLength(2);
        expect(await webAppletService.listPinned(OTHER)).toEqual([]);
    });

    test('refuses empty source and foreign unpin', async () => {
        await expect((async () => await webAppletService.pin({ userId: USER, language: 'html', source: '  ' }))())
            .rejects.toThrow(/empty/i);
        const row = await webAppletService.pin({
            userId: USER, language: 'html', source: '<html>x</html>'
        });
        await expect((async () => await webAppletService.unpin({ userId: OTHER, appletId: row.id }))())
            .rejects.toThrow(/No such/);
    });
});

describe('discover', () => {
    test('finds unpinned fences in the user\'s web chats and skips pins', async () => {
        await db.run(
            `INSERT INTO users (discordUsername, discordId, username) VALUES ('rob', @id, 'rob')`,
            { id: USER }
        );
        const internal = (await db.get('SELECT id FROM users WHERE discordId = @id', { id: USER })).id;
        await db.run(`INSERT INTO conversations (id, userId) VALUES (70, @internal)`, { internal });
        const conv = await db.get(
            `INSERT INTO web_conversations (userId, channelId, title)
             VALUES (@userId, @channelId, 'Pi plans') RETURNING id, channelId`,
            { userId: USER, channelId: `web:${USER}:abc` }
        );
        const gc = await db.get(
            `INSERT INTO guild_conversations (guildId, threadId, channelId)
             VALUES (@scope, @channelId, @channelId) RETURNING id`,
            { scope: dmScopeId(USER), channelId: conv.channelId }
        );
        await db.run(
            `INSERT INTO messages (conversationId, guildConversationId, message, isBot, createdBy)
             VALUES (70, @gc, @msg, 1, @internal)`,
            { gc: gc.id, msg: '```html\n<title>Clock</title><div>tick</div>\n```', internal }
        );

        const discovered = await webAppletService.discover(USER);
        expect(discovered).toHaveLength(1);
        expect(discovered[0]).toMatchObject({
            title: 'Clock', pinned: false, conversationId: conv.id
        });

        await webAppletService.pin({
            userId: USER,
            language: 'html',
            source: discovered[0].source,
            conversationId: conv.id,
            messageId: discovered[0].messageId
        });
        expect(await webAppletService.discover(USER)).toEqual([]);
        expect((await webAppletService.listWorkshop(USER)).pinned).toHaveLength(1);
    });
});
