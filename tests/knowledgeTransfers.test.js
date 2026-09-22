/**
 * ADR 0010 - explicit transfers: answer -> note -> project / discussion.
 *
 * Real services behind the real portal routes, execution OFF (a disabled
 * sandbox), so every hop here is organization, not execution. Pins:
 *  - an assistant answer becomes a `saved` personal note with provenance
 *    back to the message; user turns and other people's chats are refused;
 *  - the picker line: distilled memory cannot be transferred;
 *  - reference mode only into a private project the caller owns, and it is
 *    invisible to everyone else - including after the project is shared;
 *  - a copy into a shared project names the audience, lives in the
 *    PROJECT: scope, is removable by owner or publisher, and survives the
 *    original's deletion (ledger keeps the title, sourceNodeId nulls);
 *  - Use in discussion posts a transcript message without a persona turn;
 *  - the transfer ledger is on the privacy report, audit and erasure paths;
 *  - existing rows (notes, projects, apps) are untouched by any of it.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-knowledge-transfers-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/services/embeddingService', () => ({
    embed: jest.fn(async () => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' })),
    embedBatch: jest.fn(async (texts) => texts.map(() => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' }))),
    cosineSimilarity: () => 0
}));
jest.mock('@goobster/core/services/aiService', () => ({
    listProviders: () => [{ key: 'openai', isDefault: true, chatModel: 'test-model' }],
    chat: jest.fn(),
    generateText: jest.fn().mockResolvedValue('A title'),
    supportsNativeWebSearch: () => false
}));
jest.mock('@goobster/core/utils/imageDetectionHandler', () => ({ generateImage: jest.fn() }));

const db = require('@goobster/core/db');
const { dmScopeId } = require('@goobster/core/utils/dmScope');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');
const transfers = require('@goobster/core/services/knowledgeTransferService');
const { suggestLabel } = require('@goobster/core/services/knowledgeTransferService');
const knowledgeGraphService = require('@goobster/core/services/knowledgeGraphService');
const parlorService = require('@goobster/core/services/parlorService');
const privacyService = require('@goobster/core/services/privacyService');
const webChatService = require('@goobster/core/services/webChatService');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const { ObservatoryService, PROJECTS_ROOT, DASHBOARDS_ROOT } = require('@goobster/core/services/projectService');

const ROB = '700000000000000051';
const SAM = '700000000000000052';
const TIA = '700000000000000053';
const BOT = '700000000000000009';

let server;
let port;
let svc;

function makeService() {
    return new ObservatoryService({
        config: {
            enabled: false,
            scope: 'web',
            maxProjectsPerUser: 6,
            maxMembersPerProject: 5,
            maxProjectMb: 64,
            maxActiveJobsPerUser: 1,
            maxResumes: 1,
            maxWorkspaceFiles: 50,
            maxWorkspaceReadMb: 8,
            maxUploadMb: 8,
            maxRenderFrames: 10,
            renderFps: 24,
            ffmpegCommand: 'ffmpeg'
        },
        sandbox: new SandboxService({
            enabled: false,
            scope: 'web',
            timeoutMs: 1000,
            maxCpuSeconds: 1,
            maxMemoryMb: 64,
            maxWriteMb: 1,
            maxOutputBytes: 1024,
            maxOutputFiles: 1,
            maxFileSizeBytes: 1024,
            runsPerWindow: 1,
            maxConcurrent: 1,
            retentionHours: 1,
            allowNetwork: false,
            pythonCommand: 'python3',
            extraBinds: [],
            requireStrongIsolation: false,
            runsDir: path.join(os.tmpdir(), `goobster-transfers-sandbox-${process.pid}`)
        })
    });
}

function request({ method = 'GET', reqPath, headers = {}, body = null }) {
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: reqPath,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* empty */ }
                resolve({ status: res.statusCode, headers: res.headers, json, text: data });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function login(userId, name) {
    const res = await request({
        method: 'POST',
        reqPath: '/api/app/auth/dev-session',
        body: { userId, name }
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers['set-cookie'].find(c => c.startsWith('goobster_web_session='));
    return setCookie.split(';')[0];
}

/** Seed a web conversation with message rows the way the chat pipeline writes them. */
async function seedConversation(userId, texts, { title = 'Compound interest' } = {}) {
    const conversation = await webChatService.createConversation(userId);
    await webChatService.renameConversation({ userId, conversationId: conversation.id, title });
    const { channelId } = await db.get('SELECT channelId FROM web_conversations WHERE id = @id', { id: conversation.id });
    await db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES (@n, @id, @n) ON CONFLICT DO NOTHING`, { id: userId, n: `user-${userId}` });
    await db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES ('Goobster', @id, 'Goobster') ON CONFLICT DO NOTHING`, { id: BOT });
    const human = (await db.get('SELECT id FROM users WHERE discordId = @id', { id: userId })).id;
    const bot = (await db.get('SELECT id FROM users WHERE discordId = @id', { id: BOT })).id;
    const guildConvId = await db.insert(
        `INSERT INTO guild_conversations (guildId, channelId, threadId) VALUES (@g, @c, @t)`,
        { g: dmScopeId(userId), c: channelId, t: `channel-${channelId}` }
    );
    const conversationId = await db.insert(
        'INSERT INTO conversations (userId, guildConversationId) VALUES (@u, @g)', { u: human, g: guildConvId }
    );
    const ids = [];
    for (const [role, text] of texts) {
        ids.push(await db.insert(
            `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot)
             VALUES (@c, @g, @by, @m, @isBot)`,
            { c: conversationId, g: guildConvId, by: role === 'user' ? human : bot, m: text, isBot: role !== 'user' ? 1 : 0 }
        ));
    }
    return { conversationId: conversation.id, messageIds: ids };
}

const ANSWER = '## Compound interest\n\nA = P(1 + r/n)^(nt). The **rate** compounds `n` times a year.';

beforeAll((done) => {
    svc = makeService();
    const ctx = createWebAppContext({
        client: { user: { id: '9', username: 'Goobster' }, guilds: { cache: new Map() } },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        deps: { observatory: svc }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        done();
    });
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await eventBusService.close();
    await db.closeConnection();
    for (const userId of [ROB, SAM, TIA]) {
        try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
        try { fs.rmSync(path.join(DASHBOARDS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
    }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* gone */ }
    }
});

describe('suggestLabel', () => {
    test('prefers a heading, strips inline markup, falls back to the first sentence', () => {
        expect(suggestLabel(ANSWER)).toBe('Compound interest');
        expect(suggestLabel('**Bold** start. Then more.')).toBe('Bold start.');
        expect(suggestLabel('- `code` item\n- second')).toBe('code item');
        expect(suggestLabel('   ')).toBe('Saved answer');
        expect(suggestLabel('x'.repeat(300)).length).toBeLessThanOrEqual(120);
    });
});

describe('Save as note (chat -> note)', () => {
    let chat;
    let baselineNotes;

    beforeAll(async () => {
        chat = await seedConversation(ROB, [['user', 'explain compound interest'], ['assistant', ANSWER]]);
        // A pre-existing note and a distilled memory row: both must survive untouched.
        await knowledgeGraphService.createUserNote({
            guildId: dmScopeId(ROB), userId: ROB, label: 'Older note', content: 'was here first', type: 'concept', tags: ['old']
        });
        await knowledgeGraphService.upsertNode({
            guildId: dmScopeId(ROB), scopeKey: `USER:${ROB}`, subjectType: 'USER', subjectId: ROB,
            type: 'fact', label: 'Likes tea', content: 'distilled from chat', source: 'conversation', curation: 'memory'
        });
        baselineNotes = await db.all('SELECT id, label, curation FROM kg_nodes ORDER BY id');
    });

    test('the answer becomes a saved personal note with provenance back to the message', async () => {
        const cookie = await login(ROB, 'rob');
        const res = await request({
            method: 'POST', reqPath: '/api/app/spitball/notes/from-message', headers: { cookie },
            body: { conversationId: chat.conversationId, messageId: chat.messageIds[1], tags: ['Finance', 'finance'] }
        });
        expect(res.status).toBe(200);
        expect(res.json.note).toMatchObject({ label: 'Compound interest', curation: 'saved', source: 'user', tags: ['finance'] });
        expect(res.json.truncated).toBe(false);
        expect(res.json.transfer).toMatchObject({
            sourceKind: 'chat_message',
            sourceConversationId: chat.conversationId,
            sourceMessageId: chat.messageIds[1],
            sourceLabel: 'Compound interest',
            targetKind: 'note',
            mode: 'copy',
            copyNodeId: res.json.note.id
        });

        // Knowledge -> Notes: the server's `knowledge` projection has it; the `memory` projection does not.
        const knowledge = await request({ reqPath: `/api/app/spitball/notes?scope=${dmScopeId(ROB)}&view=knowledge`, headers: { cookie } });
        expect(knowledge.json.notes.map(n => n.label)).toEqual(expect.arrayContaining(['Compound interest', 'Older note']));
        expect(knowledge.json.notes.map(n => n.label)).not.toContain('Likes tea');
        const memory = await request({ reqPath: `/api/app/spitball/notes?scope=${dmScopeId(ROB)}&view=memory`, headers: { cookie } });
        expect(memory.json.notes.map(n => n.label)).toEqual(['Likes tea']);

        // The Map shares the projection.
        const map = await request({ reqPath: `/api/app/memory/constellation?scope=${dmScopeId(ROB)}&view=knowledge`, headers: { cookie } });
        expect(map.status).toBe(200);
        expect(map.json.nodes.map(n => n.label)).toContain('Compound interest');
        expect(map.json.nodes.map(n => n.label)).not.toContain('Likes tea');

        // Where it came from is readable from the note.
        const where = await request({ reqPath: `/api/app/spitball/notes/${res.json.note.id}/transfers`, headers: { cookie } });
        expect(where.status).toBe(200);
        expect(where.json.savedFrom).toMatchObject({
            conversationId: chat.conversationId, messageId: chat.messageIds[1], title: 'Compound interest'
        });
        expect(where.json.projects).toEqual([]);
        expect(where.json.discussions).toEqual([]);
    });

    test('a user turn, a stranger, an unknown message, and an empty override are refused', async () => {
        const rob = await login(ROB, 'rob');
        const sam = await login(SAM, 'sam');
        const userTurn = await request({
            method: 'POST', reqPath: '/api/app/spitball/notes/from-message', headers: { cookie: rob },
            body: { conversationId: chat.conversationId, messageId: chat.messageIds[0] }
        });
        expect(userTurn.status).toBe(400);
        expect(userTurn.json.error.code).toBe('NOT_AN_ANSWER');

        const stranger = await request({
            method: 'POST', reqPath: '/api/app/spitball/notes/from-message', headers: { cookie: sam },
            body: { conversationId: chat.conversationId, messageId: chat.messageIds[1] }
        });
        expect(stranger.status).toBe(404);

        const unknown = await request({
            method: 'POST', reqPath: '/api/app/spitball/notes/from-message', headers: { cookie: rob },
            body: { conversationId: chat.conversationId, messageId: 999999 }
        });
        expect(unknown.status).toBe(404);

        const empty = await request({
            method: 'POST', reqPath: '/api/app/spitball/notes/from-message', headers: { cookie: rob },
            body: { conversationId: chat.conversationId, messageId: chat.messageIds[1], content: '   ' }
        });
        expect(empty.status).toBe(400);
        expect(empty.json.error.code).toBe('EMPTY');

        const anonymous = await request({
            method: 'POST', reqPath: '/api/app/spitball/notes/from-message',
            body: { conversationId: chat.conversationId, messageId: chat.messageIds[1] }
        });
        expect(anonymous.status).toBe(401);
    });

    test('a long answer is trimmed to the note cap and says so; a custom title wins', async () => {
        const long = await seedConversation(ROB, [['assistant', 'Intro line.\n' + 'x'.repeat(2000)]], { title: 'Long one' });
        const result = await transfers.saveMessageAsNote({
            userId: ROB, conversationId: long.conversationId, messageId: long.messageIds[0], label: '  My title  '
        });
        expect(result.truncated).toBe(true);
        expect(result.note.label).toBe('My title');
        expect(result.note.content.length).toBeLessThanOrEqual(1000);
    });

    test('pre-existing notes and memory rows are untouched', async () => {
        const now = await db.all('SELECT id, label, curation FROM kg_nodes WHERE id IN (SELECT id FROM kg_nodes) ORDER BY id');
        for (const row of baselineNotes) {
            expect(now).toContainEqual(row);
        }
    });
});

describe('Add to project (note -> project)', () => {
    let noteId;
    let memoryId;
    let privateProject;
    let sharedProject;

    beforeAll(async () => {
        noteId = (await db.get(`SELECT id FROM kg_nodes WHERE label = 'Compound interest' AND scopeKey = @s`, { s: `USER:${ROB}` })).id;
        memoryId = (await db.get(`SELECT id FROM kg_nodes WHERE label = 'Likes tea' AND scopeKey = @s`, { s: `USER:${ROB}` })).id;
        privateProject = await svc.createProject({ userId: ROB, name: 'Private study' });
        sharedProject = await svc.createProject({ userId: ROB, name: 'Shared study' });
        const { invite } = await svc.invite({ userId: ROB, project: 'shared-study', inviteeId: SAM });
        await svc.respondInvite({ userId: SAM, inviteId: invite.id, accept: true });
    });

    test('the project list says which projects are private (the reference precondition)', async () => {
        const cookie = await login(ROB, 'rob');
        const list = await request({ reqPath: '/api/app/observatory/projects', headers: { cookie } });
        const bySlug = Object.fromEntries(list.json.projects.map(p => [p.slug, p]));
        expect(bySlug['private-study']).toMatchObject({ private: true, memberCount: 0, shared: false });
        expect(bySlug['shared-study']).toMatchObject({ private: false, memberCount: 1 });

        const audience = await request({ reqPath: `/api/app/projects/shared-study/audience?owner=${ROB}`, headers: { cookie } });
        expect(audience.status).toBe(200);
        expect(audience.json).toMatchObject({ kind: 'project', ownerId: ROB, private: false, shared: false, role: 'owner' });
        expect(audience.json.memberIds).toEqual([ROB, SAM]);
        expect(audience.json.members[0]).toMatchObject({ userId: SAM });
    });

    test('the picker line: distilled memory cannot be transferred', async () => {
        const cookie = await login(ROB, 'rob');
        const res = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${memoryId}/transfers`, headers: { cookie },
            body: { target: 'project', project: 'private-study', owner: ROB, mode: 'copy' }
        });
        expect(res.status).toBe(400);
        expect(res.json.error.code).toBe('NOT_KNOWLEDGE');
        const asRef = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${memoryId}/transfers`, headers: { cookie },
            body: { target: 'discussion', conversationId: 1 }
        });
        expect(asRef.status).toBe(400);
        expect(asRef.json.error.code).toBe('NOT_KNOWLEDGE');
    });

    test('a bad target, a foreign note and an unknown project are refused', async () => {
        const rob = await login(ROB, 'rob');
        const sam = await login(SAM, 'sam');
        const bad = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${noteId}/transfers`, headers: { cookie: rob }, body: { target: 'moon' }
        });
        expect(bad.status).toBe(400);
        const foreign = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${noteId}/transfers`, headers: { cookie: sam },
            body: { target: 'project', project: 'shared-study', owner: ROB, mode: 'copy' }
        });
        expect(foreign.status).toBe(404);
        const noProject = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${noteId}/transfers`, headers: { cookie: rob },
            body: { target: 'project', project: 'nope', owner: ROB, mode: 'copy' }
        });
        expect(noProject.status).toBe(404);
    });

    test('reference: only into a private project the caller owns; a shared project refuses and names its audience', async () => {
        const cookie = await login(ROB, 'rob');
        const refused = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${noteId}/transfers`, headers: { cookie },
            body: { target: 'project', project: 'shared-study', owner: ROB, mode: 'reference' }
        });
        expect(refused.status).toBe(409);
        expect(refused.json.error.code).toBe('PROJECT_SHARED');

        const ok = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${noteId}/transfers`, headers: { cookie },
            body: { target: 'project', project: 'private-study', owner: ROB, mode: 'reference' }
        });
        expect(ok.status).toBe(200);
        expect(ok.json.mode).toBe('reference');
        expect(ok.json.copy).toBeNull();
        expect(ok.json.audience).toMatchObject({ private: true, memberIds: [ROB] });
        expect(ok.json.project).toMatchObject({ slug: 'private-study', ownerId: ROB, role: 'owner' });

        // Nothing was written into the project scope ...
        const coords = svc.knowledgeCoords({ ...privateProject, ownerId: ROB });
        const inScope = await db.get(
            'SELECT COUNT(*) AS c FROM kg_nodes WHERE guildId = @g AND scopeKey = @s', { g: coords.guildId, s: coords.scopeKey }
        );
        expect(inScope.c).toBe(0);
        // ... but the owner reads it there, resolved at read time.
        const notes = await request({ reqPath: `/api/app/projects/private-study/knowledge/notes?owner=${ROB}`, headers: { cookie } });
        expect(notes.status).toBe(200);
        expect(notes.json.notes).toEqual([]);
        expect(notes.json.references).toHaveLength(1);
        expect(notes.json.references[0]).toMatchObject({ id: noteId, label: 'Compound interest', tags: ['finance'] });
        expect(notes.json.references[0].reference).toMatchObject({ userId: ROB });
        expect(notes.json.audience.private).toBe(true);

        // Referencing twice is idempotent.
        const again = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${noteId}/transfers`, headers: { cookie },
            body: { target: 'project', project: 'private-study', owner: ROB, mode: 'reference' }
        });
        expect(again.json.transfer.id).toBe(ok.json.transfer.id);
    });

    test('sharing the project later does not expose the reference; the manifest reads it only as the actor', async () => {
        const { invite } = await svc.invite({ userId: ROB, project: 'private-study', inviteeId: TIA });
        await svc.respondInvite({ userId: TIA, inviteId: invite.id, accept: true });

        const tia = await login(TIA, 'tia');
        const theirs = await request({ reqPath: `/api/app/projects/private-study/knowledge/notes?owner=${ROB}`, headers: { cookie: tia } });
        expect(theirs.status).toBe(200);
        expect(theirs.json.notes).toEqual([]);
        expect(theirs.json.references).toEqual([]);
        expect(theirs.json.audience.private).toBe(false);

        const forRob = await transfers.describeReferencesForManifest({ userId: ROB, projectId: privateProject.id });
        expect(forRob).toMatch(/visible only to you/);
        expect(forRob).toMatch(/Compound interest/);
        const forTia = await transfers.describeReferencesForManifest({ userId: TIA, projectId: privateProject.id });
        expect(forTia).toBe('');

        // The reference is Rob's to drop; Tia cannot.
        const transferId = (await db.get(
            `SELECT id FROM knowledge_transfers WHERE sourceNodeId = @n AND mode = 'reference'`, { n: noteId }
        )).id;
        const denied = await request({ method: 'DELETE', reqPath: `/api/app/spitball/transfers/${transferId}`, headers: { cookie: tia } });
        expect(denied.status).toBe(404);
        const rob = await login(ROB, 'rob');
        const dropped = await request({ method: 'DELETE', reqPath: `/api/app/spitball/transfers/${transferId}`, headers: { cookie: rob } });
        expect(dropped.status).toBe(200);
        const after = await request({ reqPath: `/api/app/projects/private-study/knowledge/notes?owner=${ROB}`, headers: { cookie: rob } });
        expect(after.json.references).toEqual([]);
        // The note itself is untouched.
        expect(await db.get('SELECT id FROM kg_nodes WHERE id = @id', { id: noteId })).toBeTruthy();
    });

    test('copy: a snapshot in the project scope that names the audience; the original stays private', async () => {
        const rob = await login(ROB, 'rob');
        const res = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${noteId}/transfers`, headers: { cookie: rob },
            body: { target: 'project', project: 'shared-study', owner: ROB, mode: 'copy' }
        });
        expect(res.status).toBe(200);
        expect(res.json.mode).toBe('copy');
        expect(res.json.audience).toMatchObject({ kind: 'project', ownerId: ROB, memberIds: [ROB, SAM], private: false });
        expect(res.json.copy).toMatchObject({ label: 'Compound interest', curation: 'saved', tags: ['finance'] });
        expect(res.json.copy.id).not.toBe(noteId);
        expect(res.json.transfer).toMatchObject({
            sourceKind: 'note', sourceNodeId: noteId, targetKind: 'project', targetId: sharedProject.id,
            mode: 'copy', copyNodeId: res.json.copy.id
        });

        const coords = svc.knowledgeCoords({ ...sharedProject, ownerId: ROB });
        const copyRow = await db.get('SELECT guildId, scopeKey, curation, source FROM kg_nodes WHERE id = @id', { id: res.json.copy.id });
        expect(copyRow).toMatchObject({ guildId: coords.guildId, scopeKey: coords.scopeKey, curation: 'saved', source: 'user' });

        // Sam reads the copy - with who published it - and cannot see Rob's original.
        const sam = await login(SAM, 'sam');
        const theirs = await request({ reqPath: `/api/app/projects/shared-study/knowledge/notes?owner=${ROB}`, headers: { cookie: sam } });
        expect(theirs.json.notes).toHaveLength(1);
        expect(theirs.json.notes[0]).toMatchObject({
            id: res.json.copy.id, label: 'Compound interest', publishedBy: ROB, publishedFrom: 'Compound interest', canRemove: false
        });
        expect(theirs.json.references).toEqual([]);
        const samsNotes = await request({ reqPath: `/api/app/spitball/notes?scope=${dmScopeId(SAM)}&view=all`, headers: { cookie: sam } });
        expect(samsNotes.json.notes).toEqual([]);

        // The owner may remove it (canRemove), Sam may not.
        const mine = await request({ reqPath: `/api/app/projects/shared-study/knowledge/notes?owner=${ROB}`, headers: { cookie: rob } });
        expect(mine.json.notes[0].canRemove).toBe(true);
        const denied = await request({
            method: 'DELETE', reqPath: `/api/app/projects/shared-study/knowledge/notes/${res.json.copy.id}?owner=${ROB}`, headers: { cookie: sam }
        });
        expect(denied.status).toBe(403);
        expect(denied.json.error.code).toBe('NOT_OWNER');

        // Re-publishing after an edit updates the same copy instead of duplicating.
        await knowledgeGraphService.updateUserNote({
            guildId: dmScopeId(ROB), userId: ROB, nodeId: noteId, content: 'A = P(1 + r/n)^(nt), revised.'
        });
        const again = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${noteId}/transfers`, headers: { cookie: rob },
            body: { target: 'project', project: 'shared-study', owner: ROB, mode: 'copy' }
        });
        expect(again.status).toBe(200);
        expect(again.json.copy.id).toBe(res.json.copy.id);
        expect(again.json.copy.content).toBe('A = P(1 + r/n)^(nt), revised.');
        expect(again.json.transfer.id).toBe(res.json.transfer.id);
        const copies = await db.get(
            `SELECT COUNT(*) AS c FROM kg_nodes WHERE guildId = @g AND scopeKey = @s`, { g: coords.guildId, s: coords.scopeKey }
        );
        expect(copies.c).toBe(1);

        // Organization worked with execution off; running code in the same
        // project still refuses (ADR 0009 - the two switches stay separate).
        const run = await request({
            method: 'POST', reqPath: '/api/app/observatory/command', headers: { cookie: rob },
            body: { project: 'shared-study', owner: ROB, instructions: 'run it' }
        });
        expect(run.status).toBe(403);
        expect(run.json.error.code).toBe('DISABLED');

        // A different personal note with a clashing title is a conflict, not an overwrite.
        const clash = await knowledgeGraphService.createUserNote({
            guildId: dmScopeId(ROB), userId: ROB, label: 'Compound interest', content: 'a different note with the same title'
        }).catch(() => null);
        if (clash) {
            const conflict = await transfers.addNoteToProject({ userId: ROB, nodeId: clash.id, project: 'shared-study', mode: 'copy' })
                .catch(e => e);
            expect(conflict).toMatchObject({ status: 409, code: 'CONFLICT' });
        }
    });

    test('a collaborator may publish their own note into a shared project and remove their own copy', async () => {
        const sam = await login(SAM, 'sam');
        const own = await knowledgeGraphService.createUserNote({
            guildId: dmScopeId(SAM), userId: SAM, label: 'Sam’s angle', content: 'from the member', tags: ['member']
        });
        const res = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${own.id}/transfers`, headers: { cookie: sam },
            body: { target: 'project', project: 'shared-study', owner: ROB, mode: 'copy' }
        });
        expect(res.status).toBe(200);
        expect(res.json.project.role).toBe('collaborator');
        // Reference into someone else's project is never allowed.
        const ref = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${own.id}/transfers`, headers: { cookie: sam },
            body: { target: 'project', project: 'shared-study', owner: ROB, mode: 'reference' }
        });
        expect(ref.status).toBe(409);

        const list = await request({ reqPath: `/api/app/projects/shared-study/knowledge/notes?owner=${ROB}`, headers: { cookie: sam } });
        const theirs = list.json.notes.find(n => n.label === 'Sam’s angle');
        expect(theirs).toMatchObject({ publishedBy: SAM, canRemove: true });
        const removed = await request({
            method: 'DELETE', reqPath: `/api/app/projects/shared-study/knowledge/notes/${theirs.id}?owner=${ROB}`, headers: { cookie: sam }
        });
        expect(removed.status).toBe(200);
        expect(removed.json).toMatchObject({ deleted: true, label: 'Sam’s angle' });
        // Sam's original is untouched; the copy's ledger row went with the copy.
        expect(await db.get('SELECT id FROM kg_nodes WHERE id = @id', { id: own.id })).toBeTruthy();
        expect(await db.get(`SELECT id FROM knowledge_transfers WHERE sourceNodeId = @n AND targetKind = 'project'`, { n: own.id })).toBeUndefined();
    });

    test('the note knows where it has gone', async () => {
        const rob = await login(ROB, 'rob');
        await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${noteId}/transfers`, headers: { cookie: rob },
            body: { target: 'project', project: 'private-study', owner: ROB, mode: 'copy' }
        });
        const where = await request({ reqPath: `/api/app/spitball/notes/${noteId}/transfers`, headers: { cookie: rob } });
        expect(where.status).toBe(200);
        expect(where.json.note).toMatchObject({ id: noteId, label: 'Compound interest' });
        const byName = Object.fromEntries(where.json.projects.map(p => [p.name, p]));
        expect(byName['Shared study']).toMatchObject({ mode: 'copy', ownerId: ROB, role: 'owner', canRemove: true });
        expect(byName['Shared study'].audience.memberIds).toEqual([ROB, SAM]);
        expect(byName['Private study']).toMatchObject({ mode: 'copy' });
        expect(where.json.savedFrom).toMatchObject({ title: 'Compound interest' });
    });
});

describe('Use in discussion (note -> discussion)', () => {
    let noteId;
    let conversation;

    beforeAll(async () => {
        noteId = (await db.get(`SELECT id FROM kg_nodes WHERE label = 'Compound interest' AND scopeKey = @s`, { s: `USER:${ROB}` })).id;
        const persona = await parlorService.createPersona({ ownerId: ROB, name: 'Critic', emoji: '🧐', charter: 'pushes back' });
        conversation = await parlorService.createConversation({ ownerId: ROB, personaIds: [persona.id] });
        await parlorService.renameConversation({ ownerId: ROB, conversationId: conversation.id, title: 'Money talk' });
        const { invite } = await parlorService.invite({ ownerId: ROB, conversationId: conversation.id, inviteeId: SAM });
        await parlorService.respondInvite({ userId: SAM, userName: 'sam', inviteId: invite.id, accept: true });
    });

    test('the note becomes a message from the caller; no persona turn runs; the audience is named', async () => {
        const rob = await login(ROB, 'rob');
        const before = await db.get('SELECT COUNT(*) AS c FROM parlor_messages WHERE conversationId = @id', { id: conversation.id });
        const res = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${noteId}/transfers`, headers: { cookie: rob },
            body: { target: 'discussion', conversationId: conversation.id }
        });
        expect(res.status).toBe(200);
        expect(res.json.mode).toBe('copy');
        expect(res.json.discussion).toMatchObject({ id: conversation.id, title: 'Money talk', ownerId: ROB });
        expect(res.json.audience).toMatchObject({ kind: 'discussion', ownerId: ROB, memberIds: [ROB, SAM], private: false });
        expect(res.json.message).toMatchObject({ role: 'user', userId: ROB });
        expect(res.json.message.content).toMatch(/^📝 \*\*Compound interest\*\*/);
        expect(res.json.message.content).toMatch(/_Tags: finance_/);

        const after = await db.get('SELECT COUNT(*) AS c FROM parlor_messages WHERE conversationId = @id', { id: conversation.id });
        expect(after.c).toBe(before.c + 1);
        const personaTurns = await db.get(
            `SELECT COUNT(*) AS c FROM parlor_messages WHERE conversationId = @id AND role <> 'user'`, { id: conversation.id }
        );
        expect(personaTurns.c).toBe(0);

        const where = await request({ reqPath: `/api/app/spitball/notes/${noteId}/transfers`, headers: { cookie: rob } });
        expect(where.json.discussions).toHaveLength(1);
        expect(where.json.discussions[0]).toMatchObject({
            conversationId: conversation.id, title: 'Money talk', messageExists: true, canRemove: false
        });
    });

    test('a stranger to the discussion is refused', async () => {
        const tia = await login(TIA, 'tia');
        const own = await knowledgeGraphService.createUserNote({
            guildId: dmScopeId(TIA), userId: TIA, label: 'Tia’s note', content: 'hers'
        });
        const res = await request({
            method: 'POST', reqPath: `/api/app/spitball/notes/${own.id}/transfers`, headers: { cookie: tia },
            body: { target: 'discussion', conversationId: conversation.id }
        });
        expect(res.status).toBe(404);
    });
});

describe('deleting the original (ADR 0010 §4)', () => {
    test('references vanish, published copies and transcript messages stay with a title snapshot', async () => {
        const noteId = (await db.get(`SELECT id FROM kg_nodes WHERE label = 'Compound interest' AND scopeKey = @s`, { s: `USER:${ROB}` })).id;
        const rob = await login(ROB, 'rob');
        // A fresh reference to see it go.
        const spare = await svc.createProject({ userId: ROB, name: 'Spare' });
        await transfers.addNoteToProject({ userId: ROB, nodeId: noteId, project: 'spare', mode: 'reference' });
        const copyId = (await db.get(
            `SELECT copyNodeId FROM knowledge_transfers WHERE sourceNodeId = @n AND targetKind = 'project' AND mode = 'copy' AND targetId = (SELECT id FROM observatory_projects WHERE slug = 'shared-study' AND userId = @u)`,
            { n: noteId, u: ROB }
        )).copyNodeId;

        const del = await request({
            method: 'DELETE', reqPath: `/api/app/spitball/notes/${noteId}?scope=${dmScopeId(ROB)}`, headers: { cookie: rob }
        });
        expect(del.status).toBe(200);

        const ledger = await db.all(
            'SELECT mode, targetKind, sourceKind, sourceNodeId, sourceLabel, copyNodeId FROM knowledge_transfers WHERE userId = @u ORDER BY id', { u: ROB }
        );
        expect(ledger.filter(r => r.mode === 'reference')).toEqual([]);
        expect(ledger.filter(r => r.targetKind === 'note' && r.copyNodeId === noteId)).toEqual([]);
        const copies = ledger.filter(r => r.mode === 'copy' && r.targetKind === 'project');
        expect(copies.length).toBeGreaterThanOrEqual(1);
        for (const row of copies) {
            expect(row.sourceNodeId).toBeNull();
            expect(row.sourceLabel).toBe('Compound interest');
        }
        expect(ledger.find(r => r.targetKind === 'discussion')).toMatchObject({ sourceNodeId: null, sourceLabel: 'Compound interest' });

        // Sam still reads the copy in the shared project and the message in the discussion.
        const sam = await login(SAM, 'sam');
        const theirs = await request({ reqPath: `/api/app/projects/shared-study/knowledge/notes?owner=${ROB}`, headers: { cookie: sam } });
        expect(theirs.json.notes.map(n => n.id)).toContain(copyId);
        expect(await db.get('SELECT id FROM kg_nodes WHERE id = @id', { id: copyId })).toBeTruthy();
        const spareRefs = await transfers.listProjectReferences({ readerId: ROB, projectId: spare.id });
        expect(spareRefs).toEqual([]);
    });
});

describe('privacy paths', () => {
    test('the ledger is on the transparency report, the audit and the erasure path', async () => {
        const summary = await transfers.summarizeForUser(ROB);
        expect(summary.publishedToProjects).toBeGreaterThanOrEqual(1);
        expect(summary.publishedToDiscussions).toBe(1);
        expect(summary.savedAnswers).toBeGreaterThanOrEqual(1);

        const report = await privacyService.buildUserReport({ guildId: dmScopeId(ROB), userId: ROB });
        expect(report.knowledgeGraph.transfers).toEqual(summary);

        const audit = await privacyService.auditUser({ userId: ROB });
        const rows = (await db.get('SELECT COUNT(*) AS c FROM knowledge_transfers WHERE userId = @u', { u: ROB })).c;
        expect(audit.byTable.knowledge_transfers).toBe(rows);
        expect(rows).toBeGreaterThan(0);

        const result = await privacyService.forgetUser({ userId: ROB });
        expect(result.knowledgeTransfers).toBe(rows);
        expect((await db.get('SELECT COUNT(*) AS c FROM knowledge_transfers WHERE userId = @u', { u: ROB })).c).toBe(0);
        // Sam's own rows are not Rob's to erase.
        expect((await db.get('SELECT COUNT(*) AS c FROM knowledge_transfers WHERE userId = @u', { u: SAM })).c).toBe(0);
    });
});
