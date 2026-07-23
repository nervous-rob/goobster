/**
 * DM privacy coverage: /forget-me must erase a user's DM-scoped data
 * (memories from both sides of the DM, facts learned in the DM, and the DM
 * conversation containers/summaries) without touching other users' DMs or
 * guild data - and the post-erasure audit must count DM leftovers.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-dm-privacy-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const privacyService = require('../services/privacyService');
const { dmScopeId } = require('../utils/dmScope');

const USER = '100000000000000001';   // erased user
const OTHER = '100000000000000002';  // must remain untouched
const BOT = '900000000000000001';
const GUILD = '200000000000000001';

const USER_DM = dmScopeId(USER);
const OTHER_DM = dmScopeId(OTHER);

function seed() {
    db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES ('rob', @id, 'rob')`, { id: USER });
    db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES ('alice', @id, 'alice')`, { id: OTHER });
    db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES ('Goobster', @id, 'Goobster')`, { id: BOT });
    const rob = db.get('SELECT id FROM users WHERE discordId = @id', { id: USER }).id;
    const alice = db.get('SELECT id FROM users WHERE discordId = @id', { id: OTHER }).id;
    const bot = db.get('SELECT id FROM users WHERE discordId = @id', { id: BOT }).id;

    // DM conversation containers (one per user) + summaries
    db.run(`INSERT INTO guild_conversations (id, guildId, threadId, channelId) VALUES (1, @g, 'channel-d1', 'd1')`, { g: USER_DM });
    db.run(`INSERT INTO guild_conversations (id, guildId, threadId, channelId) VALUES (2, @g, 'channel-d2', 'd2')`, { g: OTHER_DM });
    db.run(`INSERT INTO guild_conversations (id, guildId, threadId, channelId) VALUES (3, @g, 't1', 'c1')`, { g: GUILD });
    // Name-free on purpose: must be caught by the DM-scope deletion,
    // not the name-mention review pass
    db.run(`INSERT INTO conversation_summaries (guildConversationId, summary, messageCount) VALUES (1, 'dm chat about music', 10)`);
    db.run(`INSERT INTO conversation_summaries (guildConversationId, summary, messageCount) VALUES (2, 'alice dm summary', 10)`);

    // DM chat history for both users
    db.run(`INSERT INTO conversations (id, userId, guildConversationId) VALUES (10, @rob, 1)`, { rob });
    db.run(`INSERT INTO conversations (id, userId, guildConversationId) VALUES (20, @alice, 2)`, { alice });
    db.run(`INSERT INTO messages (conversationId, guildConversationId, message, isBot, createdBy) VALUES (10, 1, 'rob dm message', 0, @rob)`, { rob });
    db.run(`INSERT INTO messages (conversationId, guildConversationId, message, isBot, createdBy) VALUES (10, 1, 'bot dm reply', 1, @bot)`, { bot });
    db.run(`INSERT INTO messages (conversationId, guildConversationId, message, isBot, createdBy) VALUES (20, 2, 'alice dm message', 0, @alice)`, { alice });

    // DM memories: user-authored AND bot-authored (both live in the DM scope)
    db.run(`INSERT INTO memory_embeddings (guildId, channelId, authorId, authorName, content, embedding, dims, model)
            VALUES (@g, 'd1', @u, 'Rob', 'rob told me a secret in dm', x'00000000', 1, 'test/model')`, { g: USER_DM, u: USER });
    db.run(`INSERT INTO memory_embeddings (guildId, channelId, authorId, authorName, content, embedding, dims, model)
            VALUES (@g, 'd1', @b, 'Goobster', 'my reply in robs dm', x'00000000', 1, 'test/model')`, { g: USER_DM, b: BOT });
    db.run(`INSERT INTO memory_embeddings (guildId, channelId, authorId, authorName, content, embedding, dims, model)
            VALUES (@g, 'd2', @o, 'Alice', 'alice dm memory', x'00000000', 1, 'test/model')`, { g: OTHER_DM, o: OTHER });
    db.run(`INSERT INTO memory_embeddings (guildId, channelId, authorId, authorName, content, embedding, dims, model)
            VALUES (@g, 'c1', @o, 'Alice', 'alice guild memory', x'00000000', 1, 'test/model')`, { g: GUILD, o: OTHER });

    // DM facts: USER-subject and conversation-level (GUILD-subject in DM scope)
    db.run(`INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@g, 'USER', @u, 'Prefers DMs for personal stuff')`, { g: USER_DM, u: USER });
    db.run(`INSERT INTO facts (guildId, subjectType, content) VALUES (@g, 'GUILD', 'This DM is usually about music')`, { g: USER_DM });
    db.run(`INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@g, 'USER', @o, 'Alice likes cats')`, { g: OTHER_DM, o: OTHER });
    db.run(`INSERT INTO facts (guildId, subjectType, content) VALUES (@g, 'GUILD', 'Movie night is on Fridays')`, { g: GUILD });
}

beforeAll(() => {
    seed();
});

afterAll(() => {
    try {
        db.closeConnection?.();
    } catch { /* already closed */ }
    try {
        fs.unlinkSync(TEST_DB);
    } catch { /* not created */ }
});

describe('forgetUser DM-scope erasure', () => {
    let counts;

    beforeAll(() => {
        counts = privacyService.forgetUser({ userId: USER, extraNames: ['Rob'] });
    });

    test('deletes memories from both sides of the DM', () => {
        const rows = db.all('SELECT * FROM memory_embeddings WHERE guildId = @g', { g: USER_DM });
        expect(rows).toHaveLength(0);
        // 1 user-authored + 1 bot-authored DM memory
        expect(counts.memories).toBe(2);
    });

    test('deletes all facts learned in the DM scope', () => {
        const rows = db.all('SELECT * FROM facts WHERE guildId = @g', { g: USER_DM });
        expect(rows).toHaveLength(0);
    });

    test('deletes the DM conversation container and its summary', () => {
        expect(db.all('SELECT * FROM guild_conversations WHERE guildId = @g', { g: USER_DM })).toHaveLength(0);
        expect(db.all('SELECT * FROM conversation_summaries WHERE guildConversationId = 1')).toHaveLength(0);
        // 1 summary + 1 guild_conversations row
        expect(counts.dmConversationRows).toBe(2);
    });

    test('leaves other users\' DM data and guild data untouched', () => {
        expect(db.all('SELECT * FROM memory_embeddings WHERE guildId = @g', { g: OTHER_DM })).toHaveLength(1);
        expect(db.all('SELECT * FROM memory_embeddings WHERE guildId = @g', { g: GUILD })).toHaveLength(1);
        expect(db.all('SELECT * FROM facts WHERE guildId = @g', { g: OTHER_DM })).toHaveLength(1);
        expect(db.all('SELECT * FROM facts WHERE guildId = @g', { g: GUILD })).toHaveLength(1);
        expect(db.all('SELECT * FROM guild_conversations WHERE guildId = @g', { g: OTHER_DM })).toHaveLength(1);
        expect(db.all('SELECT * FROM messages WHERE conversationId = 20')).toHaveLength(1);
    });

    test('post-erasure audit reports zero leftovers', () => {
        const audit = privacyService.auditUser({ userId: USER });
        expect(audit.total).toBe(0);
        expect(audit.byTable.dm_conversations).toBe(0);
    });
});

describe('buildUserReport with a DM scope', () => {
    test('reports the remaining user\'s DM-scoped data', () => {
        const report = privacyService.buildUserReport({ guildId: OTHER_DM, userId: OTHER });
        expect(report.facts).toHaveLength(1);
        expect(report.memories.count).toBe(1);
    });
});
