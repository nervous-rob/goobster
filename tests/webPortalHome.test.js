/**
 * Companion Home snapshot, personal constellation, and web forget-me.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-home-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const webDashboardService = require('../services/webDashboardService');
const webChatService = require('../services/webChatService');
const webAppletService = require('../services/webAppletService');
const { dmScopeId } = require('../utils/dmScope');

const USER = '800000000000000001';
const OTHER = '800000000000000002';
const GUILD = '800000000000000099';

const fakeClient = {
    guilds: { cache: new Map() }
};

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* gone */ }
    }
});

beforeEach(() => {
    db.run('DELETE FROM facts');
    db.run('DELETE FROM memory_embeddings');
    db.run('DELETE FROM followups');
    db.run('DELETE FROM automations');
    db.run('DELETE FROM web_applets');
    db.run('DELETE FROM web_conversations');
    db.run('DELETE FROM web_sessions');
});

describe('getHome', () => {
    test('assembles you / watching / pickup / workshop from existing rows', async () => {
        const scope = dmScopeId(USER);
        db.run(
            `INSERT INTO facts (guildId, subjectType, subjectId, content)
             VALUES (@scope, 'USER', @userId, 'Likes trains')`,
            { scope, userId: USER }
        );
        db.run(
            `INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
             VALUES (@scope, @userId, 'Rob', 'talked about the Pi', x'00000000', 1, 'test/model')`,
            { scope, userId: USER }
        );
        db.run(
            `INSERT INTO followups (guildId, channelId, userId, note, dueAt, status)
             VALUES (@scope, 'dm', @userId, 'check the lab', '2030-01-01 09:00:00', 'PENDING')`,
            { scope, userId: USER }
        );
        const convo = webChatService.createConversation(USER);
        db.run('UPDATE web_conversations SET title = @title WHERE id = @id',
            { title: 'Pi plans', id: convo.id });
        webAppletService.pin({
            userId: USER, language: 'html', source: '<html><title>Clock</title></html>'
        });

        const home = await webDashboardService.getHome({ client: fakeClient, userId: USER });
        expect(home.you.facts).toContain('Likes trains');
        expect(home.you.memoryCount).toBe(1);
        expect(home.watching.followups).toHaveLength(1);
        expect(home.pickup.conversations[0].title).toBe('Pi plans');
        expect(home.workshop.pinned[0].title).toBe('Clock');
        expect(home.servers).toEqual([]);
    });
});

describe('getConstellation', () => {
    test('stars facts and memories around you in the DM scope', async () => {
        const scope = dmScopeId(USER);
        db.run(
            `INSERT INTO facts (guildId, subjectType, subjectId, content)
             VALUES (@scope, 'USER', @userId, 'Likes trains')`,
            { scope, userId: USER }
        );
        db.run(
            `INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
             VALUES (@scope, @userId, 'Rob', 'talked about the Pi', x'00000000', 1, 'test/model')`,
            { scope, userId: USER }
        );
        // Another user's rows never appear
        db.run(
            `INSERT INTO facts (guildId, subjectType, subjectId, content)
             VALUES (@other, 'USER', @otherUser, 'secret')`,
            { other: dmScopeId(OTHER), otherUser: OTHER }
        );

        const graph = await webDashboardService.getConstellation({
            client: fakeClient, scope, userId: USER
        });
        expect(graph.kind).toBe('personal');
        expect(graph.nodes[0]).toMatchObject({ id: 'you', type: 'person' });
        expect(graph.nodes.some(n => n.content === 'Likes trains')).toBe(true);
        expect(graph.nodes.some(n => n.content === 'talked about the Pi')).toBe(true);
        expect(graph.nodes.some(n => n.content === 'secret')).toBe(false);
        expect(graph.edges.every(e => e.sourceId === 'you')).toBe(true);
    });

    test('refuses another user\'s DM scope', async () => {
        await expect(webDashboardService.getConstellation({
            client: fakeClient, scope: dmScopeId(OTHER), userId: USER
        })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    });
});

describe('forgetMe', () => {
    test('requires the phrase and then erases', () => {
        webAppletService.pin({
            userId: USER, language: 'html', source: '<html>x</html>'
        });
        expect(() => webDashboardService.forgetMe({ userId: USER, confirm: 'please' }))
            .toThrow(/FORGET ME/);
        const result = webDashboardService.forgetMe({ userId: USER, confirm: 'forget me' });
        expect(result.counts.webApplets).toBe(1);
        expect(result.audit.total).toBe(0);
        expect(result.audit.byTable.web_applets).toBe(0);
    });
});

describe('guild constellation access', () => {
    test('requires live membership', async () => {
        const client = {
            guilds: {
                cache: new Map([[GUILD, {
                    id: GUILD,
                    members: { fetch: async () => { throw new Error('Unknown Member'); } }
                }]])
            }
        };
        await expect(webDashboardService.getConstellation({
            client, scope: GUILD, userId: USER
        })).rejects.toMatchObject({ status: 403 });
    });
});
