/**
 * Unit tests for the /forget-me erasure scope and /what-do-you-know-about-me
 * report (services/privacyService.js), against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-privacy-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const privacyService = require('../services/privacyService');

const USER = '100000000000000001';   // erased user (Discord snowflake)
const OTHER = '100000000000000002';  // must remain untouched
const GUILD = '200000000000000001';

function seed() {
    // users / conversations / messages / prompts (internal integer ids)
    db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES ('rob', @id, 'rob')`, { id: USER });
    db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES ('alice', @id, 'alice')`, { id: OTHER });
    const rob = db.get('SELECT id FROM users WHERE discordId = @id', { id: USER }).id;
    const alice = db.get('SELECT id FROM users WHERE discordId = @id', { id: OTHER }).id;

    db.run(`INSERT INTO prompts (userId, prompt) VALUES (@rob, 'be nice')`, { rob });
    db.run(`INSERT INTO conversations (id, userId) VALUES (10, @rob)`, { rob });
    db.run(`INSERT INTO conversations (id, userId) VALUES (20, @alice)`, { alice });
    db.run(`UPDATE users SET activeConversationId = 10 WHERE id = @rob`, { rob });
    db.run(`INSERT INTO messages (conversationId, message, isBot, createdBy) VALUES (10, 'hi from rob', 0, @rob)`, { rob });
    db.run(`INSERT INTO messages (conversationId, message, isBot, createdBy) VALUES (10, 'bot reply to rob', 1, @alice)`, { alice });
    db.run(`INSERT INTO messages (conversationId, message, isBot, createdBy) VALUES (20, 'alice message', 0, @alice)`, { alice });

    // memories
    db.run(`INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
            VALUES (@g, @u, 'Rob', 'rob memory', x'00000000', 1, 'test/model')`, { g: GUILD, u: USER });
    db.run(`INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
            VALUES (@g, @u, 'Alice', 'alice memory', x'00000000', 1, 'test/model')`, { g: GUILD, u: OTHER });

    // facts: USER-subject, GUILD-subject mentioning Rob, GUILD not mentioning,
    // and a word-boundary trap ("problem" contains "rob")
    db.run(`INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@g, 'USER', @u, 'Rob likes trains')`, { g: GUILD, u: USER });
    db.run(`INSERT INTO facts (guildId, subjectType, content) VALUES (@g, 'GUILD', 'Rob runs the minecraft server')`, { g: GUILD });
    db.run(`INSERT INTO facts (guildId, subjectType, content) VALUES (@g, 'GUILD', 'Movie night is on Fridays')`, { g: GUILD });
    db.run(`INSERT INTO facts (guildId, subjectType, content) VALUES (@g, 'GUILD', 'The problem channel is for tech support')`, { g: GUILD });

    // conversation summaries (one mentioning Rob by name)
    db.run(`INSERT INTO guild_conversations (id, guildId, threadId, channelId) VALUES (5, @g, 't1', 'c1')`, { g: GUILD });
    db.run(`INSERT INTO conversation_summaries (guildConversationId, summary, messageCount) VALUES (5, 'Rob talked about his Pi cluster', 10)`);
    db.run(`INSERT INTO conversation_summaries (guildConversationId, summary, messageCount) VALUES (5, 'General chatter about games', 12)`);

    // followups: created by Rob, about Rob by name, unrelated
    db.run(`INSERT INTO followups (guildId, channelId, userId, note, dueAt) VALUES (@g, 'c1', @u, 'remind me to deploy', '2030-01-01 00:00:00')`, { g: GUILD, u: USER });
    db.run(`INSERT INTO followups (guildId, channelId, userId, note, dueAt) VALUES (@g, 'c1', @o, 'ask Rob how the deploy went', '2030-01-01 00:00:00')`, { g: GUILD, o: OTHER });
    db.run(`INSERT INTO followups (guildId, channelId, userId, note, dueAt) VALUES (@g, 'c1', @o, 'water the plants', '2030-01-01 00:00:00')`, { g: GUILD, o: OTHER });

    // nicknames, preferences, usage, command log
    db.run(`INSERT INTO user_nicknames (userId, guildId, nickname) VALUES (@u, @g, 'Robbo')`, { u: USER, g: GUILD });
    db.run(`INSERT INTO UserPreferences (userId, memeMode) VALUES (@u, 1)`, { u: USER });
    db.run(`INSERT INTO usage_log (guildId, userId, provider, model, operation, inputTokens, outputTokens)
            VALUES (@g, @u, 'openai', 'gpt-test', 'chat', 100, 50)`, { g: GUILD, u: USER });
    db.run(`INSERT INTO usage_log (guildId, userId, provider, model, operation, inputTokens, outputTokens)
            VALUES (@g, @o, 'openai', 'gpt-test', 'chat', 10, 5)`, { g: GUILD, o: OTHER });
    db.run(`INSERT INTO command_log (guildId, userId, command) VALUES (@g, @u, 'recall')`, { g: GUILD, u: USER });
}

beforeAll(() => {
    seed();
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

describe('buildUserReport', () => {
    test('reports facts, memories, followups, nickname, preferences, and history', () => {
        const report = privacyService.buildUserReport({ guildId: GUILD, userId: USER });

        expect(report.facts).toHaveLength(1);
        expect(report.facts[0].content).toBe('Rob likes trains');
        expect(report.memories.count).toBe(1);
        expect(report.followups).toHaveLength(1);
        expect(report.nickname).toBe('Robbo');
        expect(report.preferences.memeMode).toBe(1);
        expect(report.profile).not.toBeNull();
        expect(report.conversations.count).toBe(1);
        expect(report.conversations.messages).toBe(2);
        expect(report.usageRows).toBe(1);
    });
});

describe('forgetUser', () => {
    let counts;

    beforeAll(() => {
        counts = privacyService.forgetUser({ userId: USER, extraNames: ['Rob'] });
    });

    test('deletes memories, facts, followups, history, nicknames, preferences, profile', () => {
        expect(counts.memories).toBe(1);
        expect(counts.userFacts).toBe(1);
        expect(counts.messages).toBe(2); // rob's message + bot reply in his conversation
        expect(counts.conversations).toBe(1);
        expect(counts.prompts).toBe(1);
        expect(counts.nicknames).toBe(1);
        expect(counts.preferences).toBe(1);
        expect(counts.profile).toBe(1);
    });

    test('review pass deletes name-mentions in guild facts, summaries, and followup notes', () => {
        expect(counts.reviewedGuildFacts).toBe(1);
        expect(counts.reviewedSummaries).toBe(1);
        // 1 created by Rob + 1 note mentioning Rob
        expect(counts.followups).toBe(2);

        const remainingFacts = db.all(`SELECT content FROM facts WHERE subjectType = 'GUILD'`).map(r => r.content);
        expect(remainingFacts).toContain('Movie night is on Fridays');
        // word-boundary check: "problem" must survive a user named "rob"
        expect(remainingFacts).toContain('The problem channel is for tech support');
        expect(remainingFacts).not.toContain('Rob runs the minecraft server');

        const remainingSummaries = db.all('SELECT summary FROM conversation_summaries').map(r => r.summary);
        expect(remainingSummaries).toEqual(['General chatter about games']);

        const remainingNotes = db.all('SELECT note FROM followups').map(r => r.note);
        expect(remainingNotes).toEqual(['water the plants']);
    });

    test('anonymizes usage rows instead of deleting them', () => {
        expect(counts.anonymizedUsageRows).toBe(2); // 1 usage_log + 1 command_log
        const usage = db.all(`SELECT userId, inputTokens FROM usage_log ORDER BY inputTokens DESC`);
        expect(usage).toHaveLength(2); // token counts kept
        expect(usage[0]).toEqual({ userId: null, inputTokens: 100 });
    });

    test('leaves other users untouched', () => {
        expect(db.get('SELECT COUNT(*) AS c FROM users WHERE discordId = @id', { id: OTHER }).c).toBe(1);
        expect(db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE authorId = @id', { id: OTHER }).c).toBe(1);
        expect(db.get('SELECT COUNT(*) AS c FROM messages WHERE conversationId = 20').c).toBe(1);
        expect(db.get('SELECT userId FROM usage_log WHERE inputTokens = 10').userId).toBe(OTHER);
    });

    test('post-erasure audit reports zero user-attributed rows', () => {
        const audit = privacyService.auditUser({ userId: USER });
        expect(audit.total).toBe(0);
    });
});
