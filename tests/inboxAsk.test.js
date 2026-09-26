const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const express = require('express');
process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-inbox-ask-${process.pid}.sqlite`);
jest.mock('@goobster/core/utils/chatHandler', () => ({ handleChatInteraction: jest.fn(async () => {}) }));
jest.mock('@goobster/core/utils/toolsRegistry', () => ({ getDefinitions: jest.fn(async () => []) }));
jest.mock('@goobster/core/utils/chat/agentOrchestrator', () => ({ runAgentLoop: jest.fn(async () => ({ content: 'Inspect the failed header.' })) }));
jest.mock('@goobster/core/services/aiService', () => ({
    listProviders: jest.fn(() => [{ key: 'openai', configured: true }]),
    generateText: jest.fn(async () => ''), chat: jest.fn(), supportsNativeWebSearch: () => false
}));
const db = require('@goobster/core/db');
const inbox = require('@goobster/core/services/inboxService');
const contexts = require('@goobster/core/services/conversationContextService');
const chat = require('@goobster/core/services/webChatService');
const parlor = require('@goobster/core/services/parlorService');
const failures = require('@goobster/core/services/workFailureService');
const ai = require('@goobster/core/services/aiService');
const { handleChatInteraction } = require('@goobster/core/utils/chatHandler');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const USER = '700000000000000001', OTHER = '700000000000000002';
let server, base, cookie;
async function request(route, method = 'GET', body, auth = cookie) {
    const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { cookie: auth } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { /* SSE */ }
    return { status: response.status, json, headers: response.headers, text };
}
const item = async (userId = USER, extra = {}) => (await inbox.deliver({ userId, kind: 'task', title: 'A failed run', body: 'Original evidence', ...extra })).item;
const ask = (id, body = {}) => request(`/api/app/inbox/${id}/ask`, 'POST', body);
const send = (id) => request('/api/app/chat', 'POST', { conversationId: id, message: 'Why did this fail?' });

beforeAll(async () => {
    const app = express();
    app.use(createWebAppApp(createWebAppContext({ config: { discord: { enabled: false }, webapp: { enabled: true, devMode: true } }, logger: { error() {}, warn() {}, info() {} } })));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await request('/api/app/auth/dev-session', 'POST', { userId: USER, name: 'Rob' }, null);
    expect(login.status).toBe(200);
    cookie = login.headers.get('set-cookie').split(';')[0];
});
beforeEach(async () => {
    for (const table of ['conversation_contexts', 'web_conversations', 'parlor_conversations', 'inbox_items', 'work_failures', 'attention_notices', 'observatory_projects', 'web_rate_events']) await db.run(`DELETE FROM ${table}`);
    ai.listProviders.mockReturnValue([{ key: 'openai', configured: true }]);
    jest.clearAllMocks();
});
afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await require('@goobster/core/services/eventBusService').close();
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.GOOBSTER_DB_PATH + suffix, { force: true });
});

test('Ask stores only a reference, marks read, reuses the conversation, and spends nothing before send', async () => {
    const delivered = await item();
    const before = await db.get('SELECT COUNT(*) AS n FROM usage_reservations');
    const result = await ask(delivered.id, { title: 'forged', body: 'client instructions', message: 'not sent' });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ kind: 'chat', path: `/chat/${result.json.conversationId}` });
    expect((await ask(delivered.id)).json.conversationId).toBe(result.json.conversationId);
    expect(await db.all('SELECT * FROM conversation_contexts')).toEqual([{
        id: expect.any(Number), userId: USER, inboxItemId: delivered.id, webConversationId: result.json.conversationId, parlorConversationId: null
    }]);
    const read = (await request(`/api/app/inbox/${delivered.id}`)).json;
    expect(read.read).toBe(true);
    expect(read.ask.conversations[0].path).toBe(result.json.path);
    expect((await db.get('SELECT COUNT(*) AS n FROM usage_reservations'))).toEqual(before);
    expect(ai.generateText).not.toHaveBeenCalled();
    expect(ai.chat).not.toHaveBeenCalled();
    expect(handleChatInteraction).not.toHaveBeenCalled();
    expect((await chat.getHistory({ userId: USER, conversationId: result.json.conversationId }))).toEqual([]);
});

test('send reloads current text, ignores client snapshots, and removing the chip removes subsequent context', async () => {
    const delivered = await item();
    const { conversationId } = (await ask(delivered.id)).json;
    await db.run("UPDATE inbox_items SET body = 'Updated evidence at send' WHERE id = @id", { id: delivered.id });
    expect((await send(conversationId)).status).toBe(200);
    expect(handleChatInteraction.mock.calls[0][0].inboxInstructions).toContain('Updated evidence at send');
    expect(handleChatInteraction.mock.calls[0][0].inboxInstructions).not.toContain('Original evidence');
    const chip = (await request(`/api/app/conversation-context/chat/${conversationId}`)).json.contexts[0];
    expect((await request(`/api/app/conversation-context/chat/${conversationId}/${chip.id}`, 'DELETE')).status).toBe(200);
    expect((await send(conversationId)).status).toBe(200);
    expect(handleChatInteraction.mock.calls[1][0].inboxInstructions).toBeNull();
});

test('another person’s item is refused both on Ask and at send even through a forged context row', async () => {
    const foreign = await item(OTHER);
    expect((await ask(foreign.id)).status).toBe(404);
    const own = await item();
    const { conversationId } = (await ask(own.id)).json;
    await db.run('UPDATE conversation_contexts SET inboxItemId = @id', { id: foreign.id });
    const before = await db.get('SELECT COUNT(*) AS n FROM usage_reservations');
    expect((await send(conversationId)).status).toBe(404);
    expect(handleChatInteraction).not.toHaveBeenCalled();
    expect(ai.generateText).not.toHaveBeenCalled();
    expect(await db.get('SELECT COUNT(*) AS n FROM usage_reservations')).toEqual(before);
    const chips = (await request(`/api/app/conversation-context/chat/${conversationId}`)).json.contexts;
    expect(chips[0]).toMatchObject({ title: 'Unavailable Inbox item', unavailable: true });
});

test('deleted items fail closed but the chip remains removable; archive remains readable', async () => {
    const own = await item();
    const { conversationId } = (await ask(own.id)).json;
    await inbox.archive({ userId: USER, itemId: own.id });
    expect((await send(conversationId)).status).toBe(200);
    await db.run('DELETE FROM inbox_items WHERE id = @id', { id: own.id });
    expect((await send(conversationId)).status).toBe(404);
    const chip = (await request(`/api/app/conversation-context/chat/${conversationId}`)).json.contexts[0];
    expect((await request(`/api/app/conversation-context/chat/${conversationId}/${chip.id}`, 'DELETE')).status).toBe(200);
    expect((await send(conversationId)).status).toBe(200);
});

test('linked Attention and failure records are owner-scoped and reflect current state', async () => {
    const notice = await db.insert("INSERT INTO attention_notices (userId, dedupeKey, title, detail) VALUES (@userId, 'ask', 'Notice title', 'Notice detail')", { userId: USER });
    const foreign = await db.insert("INSERT INTO attention_notices (userId, dedupeKey, title, detail) VALUES (@userId, 'ask', 'Foreign title', 'SECRET')", { userId: OTHER });
    const own = await item(USER, { kind: 'notice', source: { type: 'attention', id: `${notice},${foreign}` } });
    const { conversationId } = (await ask(own.id)).json;
    await db.run("UPDATE attention_notices SET status = 'dismissed' WHERE id = @id", { id: notice });
    const instructions = await contexts.instructions({ userId: USER, kind: 'chat', conversationId });
    expect(instructions).toContain('Notice detail'); expect(instructions).toContain('dismissed'); expect(instructions).not.toContain('SECRET');
    const failure = await failures.record({ kind: 'automation', workId: '41', code: 'INPUT_REJECTED', reason: 'Bad header', actor: USER });
    const failed = await item(USER, { source: { type: 'work_failure', id: failure } });
    const otherChat = (await ask(failed.id)).json;
    expect(otherChat.suggestedQuestion).toBe('Why did this fail, and what should I do next?');
    const result = await contexts.instructions({ userId: USER, kind: 'chat', conversationId: otherChat.conversationId });
    expect(result).toContain('INPUT_REJECTED'); expect(result).toContain('"taskId":"41"');
    await db.run('UPDATE work_failures SET actor = @actor WHERE id = @id', { actor: OTHER, id: failure });
    expect(await contexts.instructions({ userId: USER, kind: 'chat', conversationId: otherChat.conversationId })).not.toContain('Bad header');
});

async function projectFixture() {
    const projectId = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, 'atlas', 'JWST Atlas')", { userId: OTHER });
    const jobId = await db.insert("INSERT INTO observatory_jobs (projectId, userId, language, code, status) VALUES (@projectId, @userId, 'python', 'PRIVATE CODE', 'FAILED')", { projectId, userId: OTHER });
    const failureId = await failures.record({ kind: 'job', workId: jobId, actor: USER, code: 'HEADER_REJECTED', reason: 'Non-ASCII header' });
    const own = await item(USER, { source: { type: 'work_failure', id: failureId } });
    return { projectId, jobId, own };
}
test('project Ask requires membership, scopes references to the speaker, and rejects revoked membership on send', async () => {
    const { projectId, jobId, own } = await projectFixture();
    expect((await ask(own.id, { inProject: true })).status).toBe(404);
    await db.run('INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@projectId, @userId, @owner)', { projectId, userId: USER, owner: OTHER });
    const result = await ask(own.id, { inProject: true });
    expect(result.status).toBe(200);
    const { conversationId } = result.json;
    expect(result.json.path).toBe(`/projects/${OTHER}/atlas/conversation`);
    const instructions = await contexts.instructions({ userId: USER, kind: 'project', conversationId });
    expect(instructions).toContain(`"jobId":${jobId}`); expect(instructions).toContain(`"projectId":${projectId}`);
    expect(instructions).not.toContain('PRIVATE CODE');
    expect((await contexts.list({ userId: OTHER, kind: 'project', conversationId })).contexts).toEqual([]);
    expect(await contexts.instructions({ userId: OTHER, kind: 'project', conversationId })).toBeNull();
    const turn = await parlor.startTurn({ userId: USER, conversationId, message: 'Why?' });
    parlor._activeTurns.delete(conversationId); // validation only; no model work in this test
    expect(turn.conversationId).toBe(conversationId);
    await db.run('DELETE FROM project_members WHERE userId = @userId', { userId: USER });
    const denied = await request('/api/app/parlor/chat', 'POST', { conversationId, message: 'Why?' });
    expect(denied.status).toBe(404);
    expect(ai.chat).not.toHaveBeenCalled();
});

test('project send refuses a tampered Inbox reference and puts valid context before user text', async () => {
    const { projectId, own } = await projectFixture();
    await db.run('INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@projectId, @userId, @owner)', { projectId, userId: USER, owner: OTHER });
    const { conversationId } = (await ask(own.id, { inProject: true })).json;
    const instructions = await contexts.instructions({ userId: USER, kind: 'project', conversationId });
    const messages = parlor._buildPersonaMessages({ persona: { id: 1, name: 'Goobster', charter: 'Help' }, history: [{ role: 'user', content: 'Why?' }], retrieved: [], projectSeat: true, userInstructions: instructions });
    expect(messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('HEADER_REJECTED') });
    expect(messages[1]).toMatchObject({ role: 'user', content: expect.stringContaining('Why?') });
    const foreign = await item(OTHER);
    await db.run('UPDATE conversation_contexts SET inboxItemId = @id', { id: foreign.id });
    const response = await request('/api/app/parlor/chat', 'POST', { conversationId, message: 'Why?' });
    expect(response.status).toBe(404);
    expect(ai.chat).not.toHaveBeenCalled();
});

test('no configured provider hides Ask with an explanation and rejects creation', async () => {
    ai.listProviders.mockReturnValue([]);
    const own = await item();
    expect(own.ask).toMatchObject({ available: false, reason: expect.stringContaining('chat provider') });
    expect((await ask(own.id)).status).toBe(503);
    expect(await db.all('SELECT * FROM conversation_contexts')).toEqual([]);
});

test('conversation deletion cascades references and foreign conversations cannot expose/remove chips', async () => {
    const own = await item();
    const { conversationId } = (await ask(own.id)).json;
    const chip = (await contexts.list({ userId: USER, kind: 'chat', conversationId })).contexts[0];
    await expect(contexts.list({ userId: OTHER, kind: 'chat', conversationId })).rejects.toMatchObject({ status: 404 });
    await expect(contexts.remove({ userId: OTHER, kind: 'chat', conversationId, contextId: chip.id })).rejects.toMatchObject({ status: 404 });
    await chat.deleteConversation({ userId: USER, conversationId });
    expect(await db.all('SELECT * FROM conversation_contexts')).toEqual([]);
});


test('real job completion reminders retain the job, project and failure links', async () => {
    const { projectId, jobId } = await projectFixture();
    await db.run('UPDATE observatory_jobs SET userId = @userId WHERE id = @id', { userId: USER, id: jobId });
    await db.run('INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@projectId, @userId, @owner)', { projectId, userId: USER, owner: OTHER });
    await require('@goobster/core/services/projectService')._notifyJobFinished(jobId);
    const followup = await db.get('SELECT * FROM followups WHERE jobId = @jobId ORDER BY id DESC LIMIT 1', { jobId });
    expect(followup.jobId).toBe(jobId);
    await require('@goobster/core/services/followupDeliveryService')._deliverPersonal(followup, null);
    const delivered = (await inbox.list({ userId: USER })).items.find(row => row.title.startsWith('Reminder:'));
    expect(delivered.ask.project.id).toBe(projectId);
    expect(delivered.failure.code).toBe('HEADER_REJECTED');
    expect((await ask(delivered.id, { inProject: true })).status).toBe(200);
});

test('queued execution revalidates context before any model request', async () => {
    const own = await item();
    const { conversationId } = (await ask(own.id)).json;
    const turn = await chat.startTurn({ userId: USER, conversationId, message: 'Why?' });
    await db.run('UPDATE inbox_items SET userId = @userId WHERE id = @id', { userId: OTHER, id: own.id });
    await expect(turn.run()).rejects.toMatchObject({ status: 404 });
    expect(handleChatInteraction).not.toHaveBeenCalled();
    expect(ai.generateText).not.toHaveBeenCalled();
});


test('project agent receives current context and tools act as the member who sent', async () => {
    const { projectId, own } = await projectFixture();
    await db.run('INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@projectId, @userId, @owner)', { projectId, userId: USER, owner: OTHER });
    const { conversationId } = (await ask(own.id, { inProject: true })).json;
    const search = jest.spyOn(parlor, '_searchScope').mockResolvedValue([]);
    const write = jest.spyOn(parlor, '_writeBack').mockResolvedValue([]);
    try {
        const response = await request('/api/app/parlor/chat', 'POST', { conversationId, message: 'Goobster, why did this fail?' });
        expect(response.status).toBe(200);
        const { runAgentLoop } = require('@goobster/core/utils/chat/agentOrchestrator');
        expect(runAgentLoop).toHaveBeenCalledTimes(1);
        const call = runAgentLoop.mock.calls[0][0];
        expect(call.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('HEADER_REJECTED') });
        expect(call.interactionContext.user.id).toBe(USER);
        expect(call.interactionContext.user.id).not.toBe(OTHER);
    } finally { search.mockRestore(); write.mockRestore(); }
});


test('Attention job notices resolve ids through structured keys without accepting prose as an authority', async () => {
    const { projectId, jobId } = await projectFixture();
    await db.run('INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@projectId, @userId, @owner)', { projectId, userId: USER, owner: OTHER });
    const noticeId = await db.insert("INSERT INTO attention_notices (userId, dedupeKey, title, detail) VALUES (@userId, @key, 'Atlas run failed', 'Header rejected')", { userId: USER, key: `observatory.job:${jobId}:FAILED` });
    const delivered = await item(USER, { kind: 'notice', source: { type: 'attention', id: noticeId } });
    expect(delivered.ask.project.id).toBe(projectId);
    const { conversationId } = (await ask(delivered.id, { inProject: true })).json;
    const instructions = await contexts.instructions({ userId: USER, kind: 'project', conversationId });
    expect(instructions).toContain(`"jobId":${jobId}`);
    await db.run("UPDATE attention_notices SET dedupeKey = 'generic', detail = @detail WHERE id = @id", { id: noticeId, detail: `jobId=${jobId}` });
    await expect(contexts.instructions({ userId: USER, kind: 'project', conversationId })).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
});

test('account erasure removes personal context rows without deleting another person’s references', async () => {
    const own = await item();
    await ask(own.id);
    const otherItem = await item(OTHER);
    await contexts.ask({ userId: OTHER, itemId: otherItem.id });
    const result = await require('@goobster/core/services/privacyService').forgetUser({ userId: OTHER });
    expect(result.conversationContexts).toBe(1);
    expect(await db.all('SELECT userId FROM conversation_contexts')).toEqual([{ userId: USER }]);
});
