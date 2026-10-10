const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createGunzip } = require('node:zlib');
const tar = require('tar-stream');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-account-export-'));
process.env.GOOBSTER_DATA_DIR = ROOT;
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'test.sqlite');
jest.mock('@goobster/core/services/aiService', () => ({ listProviders: () => [], generateText: jest.fn() }));
const db = require('@goobster/core/db');
const { AccountExportService } = require('@goobster/core/services/accountExportService');
const { snapshot } = require('@goobster/core/services/accountExportData');
const { buildArchive, safeOpen } = require('@goobster/core/utils/accountExportArchive');
const U = '800000000000000041', V = '800000000000000042';
let service, now;
function put(relative, value) { const file = path.join(ROOT, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; }
async function unpack(file) {
    const extract = tar.extract(), files = new Map();
    extract.on('entry', (header, stream, next) => {
        const chunks = []; stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => { files.set(header.name, Buffer.concat(chunks)); next(); }); stream.resume();
    });
    await require('node:stream/promises').pipeline(fs.createReadStream(file), createGunzip(), extract);
    return files;
}
beforeEach(async () => {
    for (const table of ['account_exports', 'inbox_items', 'knowledge_transfers', 'kg_nodes', 'kg_tags', 'observatory_projects', 'parlor_conversations', 'spitball_expeditions', 'messages', 'conversations', 'web_conversations', 'guild_conversations', 'users', 'memory_embeddings', 'facts', 'automations', 'followups', 'admission_locks']) await db.run(`DELETE FROM ${table}`);
    now = Date.now();
    service = new AccountExportService({ autoKick: false, now: () => now, settings: async () => ({ schemaVersion: 1, settings: { userId: U } }) });
});
afterAll(async () => { await service.stop(); await db.closeConnection(); fs.rmSync(ROOT, { recursive: true, force: true }); });
async function fixture() {
    const user = await db.insert('INSERT INTO users (discordUsername, discordId, username) VALUES (@userId, @userId, @userId)', { userId: U });
    const project = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, 'topic', 'Research project')", { userId: U });
    const otherProject = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, 'secret', 'PRIVATE_SENTINEL')", { userId: V });
    // PostgreSQL stores labels as citext and content as text: bind separately.
    const addNote = (userId, label, scopeKey = `USER:${userId}`) => db.insert("INSERT INTO kg_nodes (guildId, scopeKey, label, content, curation) VALUES (@guildId, @scopeKey, @label, @content, 'saved')", { guildId: `dm:${userId}`, scopeKey, label, content: label });
    const note = await addNote(U, 'Kept note'); const linked = await addNote(U, 'Linked note');
    const privateNote = await addNote(V, 'PRIVATE_SENTINEL'); const copy = await addNote(U, 'Published copy', `PROJECT:${project}`);
    await db.run("INSERT INTO knowledge_transfers (userId, sourceKind, sourceNodeId, sourceLabel, targetKind, targetId, mode, copyNodeId) VALUES (@userId, 'note', @sourceNodeId, 'PRIVATE_SENTINEL', 'project', @project, 'copy', @copy)", { userId: V, sourceNodeId: privateNote, project, copy });
    await db.run("INSERT INTO kg_edges (guildId, scopeKey, sourceId, targetId, relation) VALUES (@guildId, @scopeKey, @sourceId, @targetId, 'related')", { guildId: `dm:${U}`, scopeKey: `USER:${U}`, sourceId: note, targetId: linked });
    const tag = await db.insert("INSERT INTO kg_tags (guildId, scopeKey, name) VALUES (@guildId, @scopeKey, 'astronomy')", { guildId: `dm:${U}`, scopeKey: `USER:${U}` });
    await db.run('INSERT INTO kg_node_tags (nodeId, tagId) VALUES (@nodeId, @tagId)', { nodeId: note, tagId: tag });
    const attachment = put(`web-uploads/${U}/evidence.txt`, 'OWN_ATTACHMENT');
    const artifact = put(`kg-artifacts/dm:${U}/${U}/paper.md`, 'OWN_ARTIFACT');
    await db.run("INSERT INTO kg_artifacts (nodeId, guildId, scopeKey, authorId, originalName, relativePath) VALUES (@note, @guildId, @scopeKey, @userId, 'paper.md', @relative)", { note, guildId: `dm:${U}`, scopeKey: `USER:${U}`, userId: U, relative: path.relative(ROOT, artifact) });
    put(`sandbox/projects/${U}/topic/result.csv`, 'x,y\n1,2');
    put(`sandbox/projects/${V}/secret/private.txt`, 'PRIVATE_SENTINEL');
    const gc = await db.insert("INSERT INTO guild_conversations (guildId, channelId, threadId) VALUES (@scope, @channel, 'fixture')", { scope: `dm:${U}`, channel: `web:${U}:export` });
    const c = await db.insert('INSERT INTO conversations (userId, guildConversationId) VALUES (@userId, @gc)', { userId: user, gc });
    await db.run("INSERT INTO web_conversations (userId, channelId, title) VALUES (@userId, @channel, 'Portable chat')", { userId: U, channel: `web:${U}:export` });
    await db.run('INSERT INTO messages (conversationId, guildConversationId, message, createdBy, metadata) VALUES (@c, @gc, @message, @user, @meta)', { c, gc, user, message: 'My saved conversation', meta: JSON.stringify({ attachments: [{ path: attachment, name: 'evidence.txt' }] }) });
    await db.run("INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule) VALUES (@userId, @scope, 'inbox:fixture', 'Daily topic', 'Check topic', '0 9 * * *')", { userId: U, scope: `dm:${U}` });
    const asset = await db.insert("INSERT INTO project_assets (projectId, userId, slug, name, kind) VALUES (@project, @userId, 'analysis', 'Analysis', 'script')", { project, userId: U });
    await db.run("INSERT INTO project_asset_versions (assetId, userId, version, language, source, contentHash) VALUES (@asset, @userId, 1, 'python', 'print(42)', 'fixture')", { asset, userId: U });
    const mission = await db.insert("INSERT INTO project_missions (projectId, userId, title, objective, successCriteriaJson) VALUES (@project, @userId, 'My plan', 'Make a useful result', '[]')", { project, userId: U });
    await db.run("INSERT INTO project_mission_steps (missionId, userId, kind, title) VALUES (@mission, @userId, 'human', 'Check evidence')", { mission, userId: U });
    await db.run("INSERT INTO memory_embeddings (guildId, authorId, content, embedding, dims, model) VALUES (@scope, @userId, 'My retained memory', @vector, 1, 'fixture')", { scope: `dm:${U}`, userId: U, vector: Buffer.from(new Float32Array([1]).buffer) });
    await db.run("INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@scope, 'USER', @userId, 'My saved fact')", { scope: `dm:${U}`, userId: U });
    await db.run("INSERT INTO followups (guildId, channelId, userId, note, dueAt) VALUES (@scope, 'inbox:fixture', @userId, 'My task', '2030-01-01 00:00:00')", { scope: `dm:${U}`, userId: U });
    const discussion = await db.insert("INSERT INTO parlor_conversations (ownerId, title) VALUES (@userId, 'My discussion')", { userId: U });
    await db.run("INSERT INTO parlor_messages (conversationId, role, userId, userName, content, attachments) VALUES (@discussion, 'user', @userId, 'Publisher', 'Shared words', @files)", { discussion, userId: V, files: JSON.stringify([attachment]) });
    await db.run("INSERT INTO inbox_items (userId, kind, title, body, attachmentsJson) VALUES (@userId, 'system', 'Evidence', 'Saved output', @files)", { userId: U, files: JSON.stringify([{ name: 'evidence.txt', file: { userId: U, path: attachment } }]) });
    const expedition = await db.insert("INSERT INTO spitball_expeditions (userId, guildId, seed) VALUES (@userId, @scope, 'My research')", { userId: U, scope: `dm:${U}` });
    const brief = await db.insert("INSERT INTO expedition_briefs (expeditionId, userId, status, generatedJson) VALUES (@expedition, @userId, 'READY', @generated)", { expedition, userId: U, generated: JSON.stringify({ summary: 'My research summary', findings: [], limitations: [], citations: [] }) });
    const privateChat = await db.insert("INSERT INTO guild_conversations (guildId, channelId, threadId) VALUES (@scope, 'private-channel', 'private-thread')", { scope: `dm:${V}` });
    const privateConversation = await db.insert('INSERT INTO conversations (userId, guildConversationId) VALUES (@user, @privateChat)', { user, privateChat });
    await db.run("INSERT INTO messages (conversationId, guildConversationId, message, createdBy) VALUES (@privateConversation, @privateChat, 'PRIVATE_SENTINEL', @user)", { privateConversation, privateChat, user });
    return { note, linked, privateNote, copy, project, otherProject, attachment, discussion, brief };
}
test('complete archive preserves readable content, attribution, IDs, hashes and internal links', async () => {
    const f = await fixture();
    const job = await service.request(U); expect(job.status).toBe('QUEUED');
    await service.sweep();
    const ready = (await service.list(U)).exports[0]; expect(ready.status).toBe('READY');
    const download = await service.download(U, job.id); await download.handle.close();
    const files = await unpack(path.join(service.directory({ ...job, userId: U }), 'account.tar.gz'));
    const manifest = JSON.parse(files.get('manifest.json'));
    expect(manifest.warnings).toEqual([]);
    expect(files.get(`notes/${f.note}.md`).toString()).toContain('astronomy');
    expect(files.get(`notes/${f.note}.md`).toString()).toContain(`./${f.linked}.md`);
    expect(files.get(`notes/${f.copy}.md`).toString()).toContain(V);
    expect(files.get(`projects/${f.project}/files/result.csv`).toString()).toContain('1,2');
    expect(files.get(`projects/${f.project}/plan.md`).toString()).toContain('Check evidence');
    expect(files.get(`chats/discussion-${f.discussion}.md`).toString()).toContain('Publisher');
    expect(files.get(`chats/discussion-${f.discussion}.md`).toString()).toContain('../attachments/');
    expect(files.get(`research/brief-${f.brief}.md`).toString()).toContain('My research summary');
    expect(files.get('data/memory_embeddings.json').toString()).toContain('My retained memory');
    expect(files.get('data/memory_embeddings.json').toString()).not.toContain('embedding"');
    expect(files.get('data/followups.json').toString()).toContain('My task');
    expect(files.get('data/facts.json').toString()).toContain('My saved fact');
    expect(JSON.parse(files.get('data/inbox_items.json'))[0].attachmentsJson[0].status).toBe('included');
    expect(files.get('data/automations.json').toString()).toContain('Daily topic');
    expect([...files.values()].map(b => b.toString()).join('\n')).not.toContain('PRIVATE_SENTINEL');
    expect([...files.keys()].some(name => name.startsWith('chats/private-'))).toBe(true);
    for (const file of manifest.files) {
        expect(files.has(file.path)).toBe(true);
        expect(crypto.createHash('sha256').update(files.get(file.path)).digest('hex')).toBe(file.sha256);
    }
    for (const records of Object.values(manifest.records)) for (const record of records) {
        expect(JSON.parse(files.get(record.path))[Number(record.pointer.slice(1))]).toBeDefined();
    }
    for (const relationship of manifest.relationships) {
        expect(JSON.parse(files.get(relationship.from.path))[Number(relationship.from.pointer.slice(1))]).toBeDefined();
        if (relationship.path) expect(files.has(relationship.path)).toBe(true);
    }
    const notices = await db.all("SELECT * FROM inbox_items WHERE sourceType = 'account_export'");
    expect(notices).toHaveLength(1); expect(notices[0].userId).toBe(U);
});
test('jobs, downloads and deletion are owner-bound and concurrent requests share one job', async () => {
    const [first, second] = await Promise.all([service.request(U), service.request(U)]);
    expect(first.id).toBe(second.id);
    expect((await service.list(V)).exports).toEqual([]);
    await expect(service.remove(V, first.id)).rejects.toMatchObject({ status: 404 });
    await service.sweep();
    await expect(service.download(V, first.id)).rejects.toMatchObject({ status: 404 });
    await service.remove(U, first.id);
    await expect(service.download(U, first.id)).rejects.toMatchObject({ status: 404 });
});
test('missing attachments and symlinks are explicitly listed without copying private files', async () => {
    const f = await fixture();
    fs.unlinkSync(f.attachment);
    const root = path.join(ROOT, 'sandbox', 'projects', U, 'topic');
    fs.symlinkSync(path.join(ROOT, 'sandbox', 'projects', V, 'secret'), path.join(root, 'outside'));
    const job = await service.request(U); await service.sweep();
    const files = await unpack(path.join(service.directory({ ...job, userId: U }), 'account.tar.gz'));
    expect(JSON.parse(files.get('manifest.json')).warnings.length).toBeGreaterThanOrEqual(2);
    expect([...files.values()].map(b => b.toString()).join('\n')).not.toContain('PRIVATE_SENTINEL');
    fs.unlinkSync(path.join(root, 'outside'));
});
test('safe file reads refuse traversal, symlink roots and hard links', async () => {
    const file = put('safe/one.txt', 'file');
    await expect(safeOpen(path.join(ROOT, 'safe'), path.join(ROOT, 'test.sqlite'))).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
    fs.symlinkSync(path.join(ROOT, 'safe'), path.join(ROOT, 'linked-root'));
    await expect(safeOpen(path.join(ROOT, 'linked-root'), path.join(ROOT, 'linked-root', 'one.txt'))).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
    fs.linkSync(file, path.join(ROOT, 'hard-link'));
    await expect(safeOpen(path.join(ROOT, 'safe'), file)).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
});
test('erasure during generation cannot publish an archive or recreate an Inbox item', async () => {
    const build = jest.fn(async args => {
        await service.forgetUser(U);
        fs.mkdirSync(path.dirname(args.destination), { recursive: true });
        fs.writeFileSync(args.destination, 'bytes');
        return { fileCount: 1, warningCount: 0 };
    });
    service.build = build;
    const job = await service.request(U); await service.sweep();
    expect((await service.list(U)).exports).toEqual([]);
    expect(await db.all("SELECT * FROM inbox_items WHERE userId = @userId", { userId: U })).toEqual([]);
    expect(fs.existsSync(service.directory({ ...job, userId: U }))).toBe(false);
});
test('record and archive limits fail visibly without publishing partial downloads', async () => {
    await fixture();
    await expect(snapshot(U, { maxRows: 1 })).rejects.toMatchObject({ code: 'EXPORT_LIMIT' });
    service.limits = { maxBytes: 1 };
    const job = await service.request(U); await service.sweep();
    expect((await service.list(U)).exports[0]).toMatchObject({ status: 'FAILED', error: expect.stringContaining('limit') });
    await expect(service.download(U, job.id)).rejects.toMatchObject({ status: 404 });
    expect(fs.existsSync(service.directory({ ...job, userId: U }))).toBe(false);
});
test('expiry removes files and stale claims become failed rather than running forever', async () => {
    const job = await service.request(U); await service.sweep();
    now += 25 * 3600_000; await service.cleanup();
    expect((await service.list(U)).exports[0].status).toBe('EXPIRED');
    await expect(service.download(U, job.id)).rejects.toMatchObject({ status: 404 });
    expect(fs.existsSync(service.directory({ ...job, userId: U }))).toBe(false);
    const next = await service.request(U);
    await db.run("UPDATE account_exports SET status = 'RUNNING', claimToken = 'old', leaseUntil = '2000-01-01 00:00:00' WHERE id = @id", { id: next.id });
    await service.cleanup();
    expect((await service.list(U)).exports[0].status).toBe('FAILED');
});
test('archive builder never includes authentication or integration secret tables', async () => {
    const data = await snapshot(U);
    for (const table of ['web_sessions', 'password_credentials', 'account_invites', 'web_share_links', 'observatory_share_links']) expect(data).not.toHaveProperty(table);
    expect(typeof buildArchive).toBe('function');
});
test('stored integration tokens, push keys and pairing hashes never reach the archive, only the connection facts do', async () => {
    await db.run("INSERT INTO user_ai_connections (userId, completionUrl, encryptedKey, modelsJson) VALUES (@userId, 'https://openrouter.ai/api/v1/chat/completions', 'SECRET_CIPHER', '{}')", { userId: U });
    await db.run("INSERT INTO user_integrations (userId, provider, token, accountLabel) VALUES (@userId, 'github', 'ghp_SECRET_TOKEN', 'octo')", { userId: U });
    await db.run("INSERT INTO push_subscriptions (userId, endpoint, p256dh, auth, userAgent) VALUES (@userId, 'https://push.example/SECRET_ENDPOINT', 'SECRET_P256', 'SECRET_AUTH', 'Firefox')", { userId: U });
    await db.run("INSERT INTO screen_vision_clients (userId, tokenHash, label) VALUES (@userId, 'SECRET_PAIR_HASH', 'Desk PC')", { userId: U });
    try {
        const data = await snapshot(U);
        expect(data.user_integrations).toEqual([expect.objectContaining({ userId: U, provider: 'github', accountLabel: 'octo' })]);
        expect(data.push_subscriptions).toEqual([expect.objectContaining({ userId: U, userAgent: 'Firefox' })]);
        expect(data.screen_vision_clients).toEqual([expect.objectContaining({ userId: U, label: 'Desk PC' })]);
        expect(JSON.stringify(data)).not.toMatch(/SECRET_/);
        expect(Object.keys(data.user_integrations[0])).not.toContain('token');
        expect(data.user_ai_connections[0]).not.toHaveProperty('encryptedKey');
    } finally {
        for (const table of ['user_integrations', 'user_ai_connections', 'push_subscriptions', 'screen_vision_clients']) await db.run(`DELETE FROM ${table}`);
    }
});
test('optional-feature stores (economy, exchange, Tavern, Studio, DMs, sandbox, integrations) are exported for the owner only', async () => {
    const seedFor = async (userId, tag) => {
        const g = '200000000000000009';
        await db.run('INSERT INTO economy_wallets (guildId, userId, balance) VALUES (@g, @userId, 500)', { g, userId });
        await db.run("INSERT INTO economy_transactions (guildId, userId, amount, balanceAfter, type) VALUES (@g, @userId, 500, 500, 'daily')", { g, userId });
        await db.run("INSERT INTO stock_holdings (guildId, userId, symbol, units, costBasis) VALUES (@g, @userId, 'AAPL', 1, 100)", { g, userId });
        await db.run("INSERT INTO exchange_accounts (guildId, userId, accountType) VALUES (@g, @userId, 'MARGIN')", { g, userId });
        await db.run("INSERT INTO tavern_rooms (guildId, userId, description) VALUES (@g, @userId, @description)", { g, userId, description: `room ${tag}` });
        await db.run("INSERT INTO studio_songs (id, ownerId, name, projectJson) VALUES (@id, @userId, @name, '{}')", { id: `song-${tag}`, userId, name: `Song ${tag}` });
        await db.run("INSERT INTO sandbox_requests (type, userId, payload) VALUES ('package-install', @userId, @payload)", { userId, payload: `{"why":"${tag}"}` });
        await db.run("INSERT INTO agent_runs (agentId, runId, guildId, channelId, userId, repo, prompt, status) VALUES (@agentId, 'r', @g, 'c', @userId, 'a/b', @prompt, 'RUNNING')", { agentId: `agent-${tag}`, g, userId, prompt: `prompt ${tag}` });
    };
    await seedFor(U, 'MINE');
    await seedFor(V, 'THEIRS');
    const [low, high] = [U, V].sort();
    const thread = await db.insert('INSERT INTO dm_threads (lowId, highId) VALUES (@low, @high)', { low, high });
    await db.run("INSERT INTO dm_messages (threadId, senderId, content) VALUES (@thread, @V, 'hello from the other side')", { thread, V });
    const bystander = '800000000000000043';
    const other = await db.insert('INSERT INTO dm_threads (lowId, highId) VALUES (@low, @high)', { low: V, high: bystander });
    await db.run("INSERT INTO dm_messages (threadId, senderId, content) VALUES (@other, @V, 'BYSTANDER_SENTINEL')", { other, V });
    try {
        const data = await snapshot(U);
        expect(data.economy_wallets.map(r => r.balance)).toEqual([500]);
        expect(data.economy_transactions).toHaveLength(1);
        expect(data.stock_holdings).toHaveLength(1);
        expect(data.exchange_accounts).toHaveLength(1);
        expect(data.tavern_rooms.map(r => r.description)).toEqual(['room MINE']);
        expect(data.studio_songs.map(r => r.name)).toEqual(['Song MINE']);
        expect(data.sandbox_requests).toHaveLength(1);
        expect(data.agent_runs.map(r => r.prompt)).toEqual(['prompt MINE']);
        expect(data.dm_threads.map(r => r.id)).toEqual([thread]);
        expect(data.dm_messages.map(r => r.content)).toEqual(['hello from the other side']);
        const text = JSON.stringify(data);
        expect(text).not.toContain('THEIRS');
        expect(text).not.toContain('BYSTANDER_SENTINEL');

        const job = await service.request(U); await service.sweep();
        expect((await service.list(U)).exports[0].status).toBe('READY');
        const files = await unpack(path.join(service.directory({ ...job, userId: U }), 'account.tar.gz'));
        expect(JSON.parse(files.get('data/economy_wallets.json'))).toHaveLength(1);
        expect(JSON.parse(files.get('data/dm_messages.json'))).toHaveLength(1);
        expect(files.get('README.md').toString()).toMatch(/economy, trading, Tavern/);
        expect([...files.values()].map(b => b.toString()).join('\n')).not.toMatch(/THEIRS|BYSTANDER_SENTINEL/);
    } finally {
        for (const table of ['economy_wallets', 'economy_transactions', 'stock_holdings', 'exchange_accounts', 'tavern_rooms', 'studio_songs', 'sandbox_requests', 'agent_runs', 'dm_messages', 'dm_threads']) await db.run(`DELETE FROM ${table}`);
    }
});
test('snapshot includes every page of retained records and works for native identities', async () => {
    const userId = 'usr_56ef0876-73b3-4bc4-b6e1-90f99e58e963';
    await db.transaction(async () => {
        for (let i = 0; i < 270; i++) await db.run("INSERT INTO kg_nodes (guildId, scopeKey, label, content) VALUES (@scope, @userScope, @label, 'portable')", { scope: `dm:${userId}`, userScope: `USER:${userId}`, label: `Note ${i}` });
    });
    const data = await snapshot(userId);
    expect(data.kg_nodes).toHaveLength(270);
    expect(new Set(data.kg_nodes.map(n => n.id)).size).toBe(270);
    expect((await snapshot(U)).kg_nodes).toHaveLength(0);
    expect((await service.request(userId)).status).toBe('QUEUED');
});
test('real privacy erasure removes archive rows and files without touching another owner', async () => {
    await service.request(U); await service.sweep();
    await service.request(V); await service.sweep();
    expect(fs.existsSync(service.ownerDir(U))).toBe(true);
    await require('@goobster/core/services/privacyService').forgetUser({ userId: U });
    expect(fs.existsSync(service.ownerDir(U))).toBe(false);
    expect((await service.list(U)).exports).toEqual([]);
    expect((await service.list(V)).exports[0].status).toBe('READY');
});
test('a second worker cannot build a claimed job and failure messages never expose raw errors', async () => {
    const job = await service.request(U);
    const row = await db.get('SELECT * FROM account_exports WHERE id = @id', { id: job.id });
    let release;
    service.build = jest.fn(() => new Promise((_resolve, reject) => { release = () => reject(new Error('secret=PRIVATE_SENTINEL')); }));
    const first = service.run(row);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await service.run(row);
    expect(service.build).toHaveBeenCalledTimes(1);
    release(); await first;
    expect(JSON.stringify(await service.list(U))).not.toContain('PRIVATE_SENTINEL');
    expect((await db.all('SELECT * FROM inbox_items'))).toEqual([expect.objectContaining({ title: 'Account export could not finish' })]);
});
test('restore invalidates temporary exports instead of restoring broken download links', async () => {
    await service.request(U);
    await require('@goobster/core/services/backupService').interruptInFlightWork();
    expect(await db.all('SELECT * FROM account_exports')).toEqual([]);
});
test('API derives the owner from authentication, rejects foreign downloads and protects mutations', async () => {
    const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
    const { DisabledGateway } = require('@goobster/core/gateway');
    const app = require('express')();
    app.use(createWebAppApp(createWebAppContext({ gateway: new DisabledGateway(), config: { webapp: { enabled: true, devMode: true } }, deps: { accountExports: service } })));
    const server = require('node:http').createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        expect((await fetch(`${base}/api/app/settings/exports`)).status).toBe(401);
        async function cookie(userId) {
            const login = await fetch(`${base}/api/app/auth/dev-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, name: userId }) });
            expect(login.status).toBe(200);
            return login.headers.get('set-cookie').split(';')[0];
        }
        const own = await cookie(U), other = await cookie(V);
        const response = await fetch(`${base}/api/app/settings/exports`, { method: 'POST', headers: { Cookie: own, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: V }) });
        expect(response.status).toBe(200); const job = await response.json();
        expect((await service.list(V)).exports).toEqual([]);
        await service.sweep();
        expect((await fetch(`${base}/api/app/settings/exports/${job.id}/download`, { headers: { Cookie: other } })).status).toBe(404);
        const download = await fetch(`${base}/api/app/settings/exports/${job.id}/download`, { headers: { Cookie: own } });
        expect(download.status).toBe(200); expect(download.headers.get('cache-control')).toBe('no-store');
        expect(Buffer.from(await download.arrayBuffer()).subarray(0, 2).toString('hex')).toBe('1f8b');
        expect((await fetch(`${base}/api/app/settings/exports/${job.id}`, { method: 'DELETE', headers: { Cookie: own, Origin: 'https://evil.example' } })).status).toBe(403);
    } finally { await new Promise(resolve => server.close(resolve)); }
});


test('note upload links export the owned bytes and never another account’s file', async () => {
    const f = await fixture();
    const attachments = require('@goobster/core/utils/noteAttachments');
    const own = attachments.save(U, 'note-evidence.txt', Buffer.from('OWNED_NOTE_FILE'));
    const foreign = attachments.save(V, 'private.txt', Buffer.from('FOREIGN_NOTE_FILE'));
    await db.run('UPDATE kg_nodes SET content = @content WHERE id = @id', {
        id: f.note, content: `[Evidence](<${own.url}>)\n[Foreign](<${foreign.url}>)`
    });
    const job = await service.request(U);
    await service.sweep();
    const ready = (await service.list(U)).exports[0];
    expect(ready.status).toBe('READY');
    const files = await unpack(path.join(service.directory({ ...job, userId: U }), 'account.tar.gz'));
    const evidence = [...files].find(([name, bytes]) => name.startsWith('attachments/') && bytes.toString() === 'OWNED_NOTE_FILE');
    expect(evidence).toBeTruthy();
    expect(files.get(`notes/${f.note}.md`).toString()).toContain(`../${evidence[0]}`);
    expect([...files.values()].some(bytes => bytes.toString() === 'FOREIGN_NOTE_FILE')).toBe(false);
    expect(JSON.parse(files.get('manifest.json')).warnings).toContainEqual(expect.objectContaining({ reason: 'Note attachment is unavailable to this account.' }));
});
