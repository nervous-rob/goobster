/**
 * Unit tests for the /forget-me erasure scope and /what-do-you-know-about-me
 * report (services/privacyService.js), against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-privacy-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;
// Isolate upload storage too - the seeded user ids look like real
// snowflakes, and cleanup must never touch the repo's data directory.
const TEST_UPLOADS = path.join(os.tmpdir(), `goobster-privacy-test-uploads-${process.pid}`);
process.env.GOOBSTER_UPLOADS_DIR = TEST_UPLOADS;

const db = require('@goobster/core/db');
const privacyService = require('@goobster/core/services/privacyService');
const webUploads = require('@goobster/core/utils/webUploads');

// 1x1 transparent PNG
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const USER = '100000000000000001';   // erased user (Discord snowflake)
const OTHER = '100000000000000002';  // must remain untouched
const GUILD = '200000000000000001';

async function seed() {
    // users / conversations / messages / prompts (internal integer ids)
    await db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES ('rob', @id, 'rob')`, { id: USER });
    await db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES ('alice', @id, 'alice')`, { id: OTHER });
    const rob = (await db.get('SELECT id FROM users WHERE discordId = @id', { id: USER })).id;
    const alice = (await db.get('SELECT id FROM users WHERE discordId = @id', { id: OTHER })).id;

    await db.run(`INSERT INTO prompts (userId, prompt) VALUES (@rob, 'be nice')`, { rob });
    await db.run(`INSERT INTO conversations (id, userId) VALUES (10, @rob)`, { rob });
    await db.run(`INSERT INTO conversations (id, userId) VALUES (20, @alice)`, { alice });
    await db.run(`UPDATE users SET activeConversationId = 10 WHERE id = @rob`, { rob });
    await db.run(`INSERT INTO messages (conversationId, message, isBot, createdBy) VALUES (10, 'hi from rob', 0, @rob)`, { rob });
    await db.run(`INSERT INTO messages (conversationId, message, isBot, createdBy) VALUES (10, 'bot reply to rob', 1, @alice)`, { alice });
    await db.run(`INSERT INTO messages (conversationId, message, isBot, createdBy) VALUES (20, 'alice message', 0, @alice)`, { alice });

    // memories
    await db.run(`INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
            VALUES (@g, @u, 'Rob', 'rob memory', x'00000000', 1, 'test/model')`, { g: GUILD, u: USER });
    await db.run(`INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
            VALUES (@g, @u, 'Alice', 'alice memory', x'00000000', 1, 'test/model')`, { g: GUILD, u: OTHER });

    // facts: USER-subject, GUILD-subject mentioning Rob, GUILD not mentioning,
    // and a word-boundary trap ("problem" contains "rob")
    await db.run(`INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@g, 'USER', @u, 'Rob likes trains')`, { g: GUILD, u: USER });
    await db.run(`INSERT INTO facts (guildId, subjectType, content) VALUES (@g, 'GUILD', 'Rob runs the minecraft server')`, { g: GUILD });
    await db.run(`INSERT INTO facts (guildId, subjectType, content) VALUES (@g, 'GUILD', 'Movie night is on Fridays')`, { g: GUILD });
    await db.run(`INSERT INTO facts (guildId, subjectType, content) VALUES (@g, 'GUILD', 'The problem channel is for tech support')`, { g: GUILD });

    // conversation summaries (one mentioning Rob by name)
    await db.run(`INSERT INTO guild_conversations (id, guildId, threadId, channelId) VALUES (5, @g, 't1', 'c1')`, { g: GUILD });
    await db.run(`INSERT INTO conversation_summaries (guildConversationId, summary, messageCount) VALUES (5, 'Rob talked about his Pi cluster', 10)`);
    await db.run(`INSERT INTO conversation_summaries (guildConversationId, summary, messageCount) VALUES (5, 'General chatter about games', 12)`);

    // followups: created by Rob, about Rob by name, unrelated
    await db.run(`INSERT INTO followups (guildId, channelId, userId, note, dueAt) VALUES (@g, 'c1', @u, 'remind me to deploy', '2030-01-01 00:00:00')`, { g: GUILD, u: USER });
    await db.run(`INSERT INTO followups (guildId, channelId, userId, note, dueAt) VALUES (@g, 'c1', @o, 'ask Rob how the deploy went', '2030-01-01 00:00:00')`, { g: GUILD, o: OTHER });
    await db.run(`INSERT INTO followups (guildId, channelId, userId, note, dueAt) VALUES (@g, 'c1', @o, 'water the plants', '2030-01-01 00:00:00')`, { g: GUILD, o: OTHER });

    // nicknames, preferences, usage, command log
    await db.run(`INSERT INTO user_nicknames (userId, guildId, nickname) VALUES (@u, @g, 'Robbo')`, { u: USER, g: GUILD });
    await db.run(`INSERT INTO UserPreferences (userId, memeMode) VALUES (@u, 1)`, { u: USER });
    await db.run(`INSERT INTO usage_log (guildId, userId, provider, model, operation, inputTokens, outputTokens)
            VALUES (@g, @u, 'openai', 'gpt-test', 'chat', 100, 50)`, { g: GUILD, u: USER });
    await db.run(`INSERT INTO usage_log (guildId, userId, provider, model, operation, inputTokens, outputTokens)
            VALUES (@g, @o, 'openai', 'gpt-test', 'chat', 10, 5)`, { g: GUILD, o: OTHER });
    await db.run(`INSERT INTO command_log (guildId, userId, command) VALUES (@g, @u, 'recall')`, { g: GUILD, u: USER });

    // internal monologue: thoughts + scratchpad (review pass on erasure,
    // including a word-boundary trap)
    await db.run(`INSERT INTO monologue_thoughts (guildId, thought) VALUES (@g, 'Rob seems excited about the deploy')`, { g: GUILD });
    await db.run(`INSERT INTO monologue_thoughts (guildId, thought) VALUES (@g, 'quiet day on the server')`, { g: GUILD });
    await db.run(`INSERT INTO monologue_scratchpad (guildId, content) VALUES (@g, 'check in on Rob tomorrow')`, { g: GUILD });
    await db.run(`INSERT INTO monologue_scratchpad (guildId, content) VALUES (@g, 'the problem channel needs attention')`, { g: GUILD });

    // knowledge graph: node named after Rob, node mentioning him in content,
    // an unrelated node, and an edge that must cascade with its endpoint
    await db.run(`INSERT INTO kg_nodes (guildId, type, label, content) VALUES (@g, 'person', 'Rob', 'runs the minecraft server')`, { g: GUILD });
    await db.run(`INSERT INTO kg_nodes (guildId, type, label, content) VALUES (@g, 'thing', 'pi cluster', 'Rob built it from four boards')`, { g: GUILD });
    await db.run(`INSERT INTO kg_nodes (guildId, type, label, content) VALUES (@g, 'event', 'movie night', 'every friday')`, { g: GUILD });
    const robNode = (await db.get(`SELECT id FROM kg_nodes WHERE label = 'Rob'`)).id;
    const movieNode = (await db.get(`SELECT id FROM kg_nodes WHERE label = 'movie night'`)).id;
    await db.run(`INSERT INTO kg_edges (guildId, sourceId, targetId, relation) VALUES (@g, @s, @t, 'attends')`, { g: GUILD, s: robNode, t: movieNode });

    // activity counters (counts only - anonymized on erasure, not deleted)
    await db.run(`INSERT INTO guild_activity (guildId, channelId, userId, day, messageCount) VALUES (@g, 'c1', @u, '2026-07-01', 12)`, { g: GUILD, u: USER });
    await db.run(`INSERT INTO guild_activity (guildId, channelId, userId, day, messageCount) VALUES (@g, 'c2', @u, '2026-07-02', 3)`, { g: GUILD, u: USER });
    await db.run(`INSERT INTO guild_activity (guildId, channelId, userId, day, messageCount) VALUES (@g, 'c1', @o, '2026-07-01', 7)`, { g: GUILD, o: OTHER });

    // uploaded web chat images on disk (deleted with the messages that
    // reference them)
    webUploads.saveDataUrlImage(USER, PNG_DATA_URL);
    webUploads.saveDataUrlImage(OTHER, PNG_DATA_URL);

    // economy: wallet, ledger, stock holdings, and trades (deleted on erasure)
    await db.run(`INSERT INTO economy_wallets (guildId, userId, balance) VALUES (@g, @u, 750)`, { g: GUILD, u: USER });
    await db.run(`INSERT INTO economy_wallets (guildId, userId, balance) VALUES (@g, @o, 1000)`, { g: GUILD, o: OTHER });
    await db.run(`INSERT INTO economy_transactions (guildId, userId, amount, balanceAfter, type) VALUES (@g, @u, 750, 750, 'starting-balance')`, { g: GUILD, u: USER });
    await db.run(`INSERT INTO stock_holdings (guildId, userId, symbol, units, costBasis) VALUES (@g, @u, 'AAPL', 2, 400)`, { g: GUILD, u: USER });
    await db.run(`INSERT INTO stock_trades (guildId, userId, symbol, side, units, price, points) VALUES (@g, @u, 'AAPL', 'BUY', 2, 200, 400)`, { g: GUILD, u: USER });

    await db.run(`INSERT INTO web_applets (userId, contentHash, title, language, source)
            VALUES (@u, 'hash-rob', 'Breakout', 'html', '<html><title>Breakout</title></html>')`, { u: USER });
    await db.run(`INSERT INTO web_applets (userId, contentHash, title, language, source)
            VALUES (@o, 'hash-alice', 'Keep me', 'html', '<html></html>')`, { o: OTHER });

    await db.run(`INSERT INTO observatory_projects (userId, slug, name)
            VALUES (@u, 'rob-lab', 'Rob Lab')`, { u: USER });
    await db.run(`INSERT INTO observatory_projects (userId, slug, name)
            VALUES (@o, 'alice-lab', 'Alice Lab')`, { o: OTHER });
    const robProject = (await db.get(
        'SELECT id FROM observatory_projects WHERE userId = @u AND slug = @slug',
        { u: USER, slug: 'rob-lab' }
    )).id;
    const aliceProject = (await db.get(
        'SELECT id FROM observatory_projects WHERE userId = @o AND slug = @slug',
        { o: OTHER, slug: 'alice-lab' }
    )).id;
    const robAssetId = await db.insert(
        `INSERT INTO project_assets (projectId, userId, slug, name, kind)
         VALUES (@projectId, @u, 'dashboard', 'Dashboard', 'app')`,
        { projectId: robProject, u: USER }
    );
    const robVersionId = await db.insert(
        `INSERT INTO project_asset_versions
            (assetId, userId, version, language, source, contentHash, origin)
         VALUES (@assetId, @u, 1, 'html', '<html></html>', 'hash-rob-asset', 'chat')`,
        { assetId: robAssetId, u: USER }
    );
    await db.run(
        'UPDATE project_assets SET currentVersionId = @vid WHERE id = @id',
        { vid: robVersionId, id: robAssetId }
    );
    const aliceAssetId = await db.insert(
        `INSERT INTO project_assets (projectId, userId, slug, name, kind)
         VALUES (@projectId, @o, 'keep', 'Keep', 'note')`,
        { projectId: aliceProject, o: OTHER }
    );
    const aliceVersionId = await db.insert(
        `INSERT INTO project_asset_versions
            (assetId, userId, version, language, source, contentHash, origin)
         VALUES (@assetId, @o, 1, 'markdown', 'keep', 'hash-alice-asset', 'chat')`,
        { assetId: aliceAssetId, o: OTHER }
    );
    await db.run(
        'UPDATE project_assets SET currentVersionId = @vid WHERE id = @id',
        { vid: aliceVersionId, id: aliceAssetId }
    );

    await db.run(`INSERT INTO web_generated_files (id, userId, path, name)
            VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', @u, '/tmp/rob-gen.png', 'rob-gen.png')`, { u: USER });
    await db.run(`INSERT INTO web_generated_files (id, userId, path, name)
            VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', @o, '/tmp/alice-gen.png', 'alice-gen.png')`, { o: OTHER });

    await db.run(`INSERT INTO web_rate_events (scope, subject, createdAtMs)
            VALUES ('web_chat', @u, @now)`, { u: USER, now: Date.now() });
    await db.run(`INSERT INTO web_rate_events (scope, subject, createdAtMs)
            VALUES ('web_chat', @o, @now)`, { o: OTHER, now: Date.now() });
    await db.run(`INSERT INTO web_live_turns (userId, turnId, startedAtMs, conversationId, aborted)
            VALUES (@u, 'forget-me-turn', @now, NULL, 0)`,
        { u: USER, now: Date.now() });
}

beforeAll(async () => {
    await seed();
});

afterAll(async () => {
    fs.rmSync(TEST_UPLOADS, { recursive: true, force: true });
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

describe('buildUserReport', () => {
    test('reports facts, memories, followups, nickname, preferences, and history', async () => {
        const report = await privacyService.buildUserReport({ guildId: GUILD, userId: USER });

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
        expect(report.activityMessages).toBe(15);
        expect(report.economy).toEqual({ balance: 750, transactions: 1, stockHoldings: 1, stockTrades: 1 });
        expect(report.applets).toBe(1);
        expect(report.observatory.projects).toBe(1);
        expect(report.observatory.assets).toBe(1);
        expect(report.observatory.assetVersions).toBe(1);
    });
});

describe('forgetUser', () => {
    let counts;

    beforeAll(async () => {
        counts = await privacyService.forgetUser({ userId: USER, extraNames: ['Rob'] });
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

    test('review pass deletes name-mentions in guild facts, summaries, and followup notes', async () => {
        expect(counts.reviewedGuildFacts).toBe(1);
        expect(counts.reviewedSummaries).toBe(1);
        // 1 created by Rob + 1 note mentioning Rob
        expect(counts.followups).toBe(2);

        const remainingFacts = (await db.all(`SELECT content FROM facts WHERE subjectType = 'GUILD'`)).map(r => r.content);
        expect(remainingFacts).toContain('Movie night is on Fridays');
        // word-boundary check: "problem" must survive a user named "rob"
        expect(remainingFacts).toContain('The problem channel is for tech support');
        expect(remainingFacts).not.toContain('Rob runs the minecraft server');

        const remainingSummaries = (await db.all('SELECT summary FROM conversation_summaries')).map(r => r.summary);
        expect(remainingSummaries).toEqual(['General chatter about games']);

        const remainingNotes = (await db.all('SELECT note FROM followups')).map(r => r.note);
        expect(remainingNotes).toEqual(['water the plants']);
    });

    test('review pass deletes monologue thoughts and scratchpad notes mentioning the user', async () => {
        expect(counts.reviewedThoughts).toBe(2); // 1 thought + 1 scratchpad note

        const remainingThoughts = (await db.all('SELECT thought FROM monologue_thoughts')).map(r => r.thought);
        expect(remainingThoughts).toEqual(['quiet day on the server']);

        const remainingNotes = (await db.all('SELECT content FROM monologue_scratchpad')).map(r => r.content);
        // word-boundary check: "problem" must survive a user named "rob"
        expect(remainingNotes).toEqual(['the problem channel needs attention']);
    });

    test('review pass deletes knowledge-graph nodes naming the user, cascading their edges', async () => {
        expect(counts.reviewedGraphNodes).toBe(2); // label "Rob" + content mentioning Rob

        const remainingLabels = (await db.all('SELECT label FROM kg_nodes')).map(r => r.label);
        expect(remainingLabels).toEqual(['movie night']);
        // the Rob->movie-night edge cascaded with the deleted node
        expect((await db.get('SELECT COUNT(*) AS c FROM kg_edges')).c).toBe(0);
    });

    test('anonymizes usage rows instead of deleting them', async () => {
        expect(counts.anonymizedUsageRows).toBe(2); // 1 usage_log + 1 command_log
        const usage = await db.all(`SELECT userId, inputTokens FROM usage_log ORDER BY inputTokens DESC`);
        expect(usage).toHaveLength(2); // token counts kept
        expect(usage[0]).toEqual({ userId: null, inputTokens: 100 });
    });

    test('anonymizes activity counters, keeping counts for server totals', async () => {
        expect(counts.anonymizedActivityRows).toBe(2);
        // Counts survive, attribution doesn't
        const total = (await db.get('SELECT SUM(messageCount) AS c FROM guild_activity')).c;
        expect(total).toBe(22); // 12 + 3 + 7 all still counted
        expect((await db.get('SELECT COUNT(*) AS c FROM guild_activity WHERE userId IS NULL')).c).toBe(2);
    });

    test('deletes economy data outright (wallet, ledger, holdings, trades)', async () => {
        expect(counts.economy).toBe(4); // 1 wallet + 1 ledger row + 1 holding + 1 trade
        expect((await db.get('SELECT COUNT(*) AS c FROM economy_wallets WHERE userId = @id', { id: USER })).c).toBe(0);
        expect((await db.get('SELECT COUNT(*) AS c FROM stock_holdings WHERE userId = @id', { id: USER })).c).toBe(0);
        expect((await db.get('SELECT COUNT(*) AS c FROM stock_trades WHERE userId = @id', { id: USER })).c).toBe(0);
    });

    test('deletes pinned workshop applets', async () => {
        expect(counts.webApplets).toBe(1);
        expect((await db.get('SELECT COUNT(*) AS c FROM web_applets WHERE userId = @id', { id: USER })).c).toBe(0);
        expect((await db.get('SELECT COUNT(*) AS c FROM web_applets WHERE userId = @id', { id: OTHER })).c).toBe(1);
    });

    test('deletes project assets and versions by userId', async () => {
        expect(counts.projectAssets).toBe(1);
        expect(counts.projectAssetVersions).toBe(1);
        expect((await db.get('SELECT COUNT(*) AS c FROM project_assets WHERE userId = @id', { id: USER })).c).toBe(0);
        expect((await db.get('SELECT COUNT(*) AS c FROM project_asset_versions WHERE userId = @id', { id: USER })).c).toBe(0);
        expect((await db.get('SELECT COUNT(*) AS c FROM project_assets WHERE userId = @id', { id: OTHER })).c).toBe(1);
        expect((await db.get('SELECT COUNT(*) AS c FROM project_asset_versions WHERE userId = @id', { id: OTHER })).c).toBe(1);
    });

    test('deletes generated-file registry rows', async () => {
        expect(counts.webGeneratedFiles).toBe(1);
        expect((await db.get('SELECT COUNT(*) AS c FROM web_generated_files WHERE userId = @id', { id: USER })).c).toBe(0);
        expect((await db.get('SELECT COUNT(*) AS c FROM web_generated_files WHERE userId = @id', { id: OTHER })).c).toBe(1);
    });

    test('deletes shared rate-limit events and in-flight turn rows', async () => {
        expect(counts.webRateEvents).toBe(1);
        expect(counts.webLiveTurns).toBe(1);
        expect((await db.get('SELECT COUNT(*) AS c FROM web_rate_events WHERE subject = @id', { id: USER })).c).toBe(0);
        expect((await db.get('SELECT COUNT(*) AS c FROM web_rate_events WHERE subject = @id', { id: OTHER })).c).toBe(1);
        expect((await db.get('SELECT COUNT(*) AS c FROM web_live_turns WHERE userId = @id', { id: USER })).c).toBe(0);
    });

    test('deletes uploaded web chat images from disk', () => {
        expect(counts.uploadedFiles).toBe(1);
        expect(webUploads.countUserUploads(USER)).toBe(0);
    });

    test('leaves other users untouched', async () => {
        expect(webUploads.countUserUploads(OTHER)).toBe(1);
        expect((await db.get('SELECT COUNT(*) AS c FROM users WHERE discordId = @id', { id: OTHER })).c).toBe(1);
        expect((await db.get('SELECT balance FROM economy_wallets WHERE userId = @id', { id: OTHER })).balance).toBe(1000);
        expect((await db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE authorId = @id', { id: OTHER })).c).toBe(1);
        expect((await db.get('SELECT COUNT(*) AS c FROM messages WHERE conversationId = 20')).c).toBe(1);
        expect((await db.get('SELECT userId FROM usage_log WHERE inputTokens = 10')).userId).toBe(OTHER);
        expect((await db.get('SELECT COUNT(*) AS c FROM guild_activity WHERE userId = @id', { id: OTHER })).c).toBe(1);
    });

    test('post-erasure audit reports zero user-attributed rows', async () => {
        const audit = await privacyService.auditUser({ userId: USER });
        expect(audit.total).toBe(0);
    });
});
