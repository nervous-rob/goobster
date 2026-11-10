/**
 * Requests made to Goobster in conversations, and changes of direction
 * (DA-4b, ADR 0021), against a throwaway database with a scripted model
 * (no provider, no network).
 *
 * The properties under test are the DA-4b acceptance scenarios: a library
 * comparison asked for in a project conversation is researched under a
 * grant without inventing a commitment to migrate; new steering supersedes
 * queued work and names what rested on it. Around them: only an explicit
 * request addressed to Goobster by the person the responsibility acts for
 * is ever read as one, a request is matched against existing work before
 * another is proposed, the attempt keeps references and never the text,
 * and a plan that moved on withdraws the steps proposed under it.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-conversation-requests-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runs = require('@goobster/core/services/assistantRunService');
const runner = require('@goobster/core/services/assistantRunnerService');
const updates = require('@goobster/core/services/assistantUpdateService');
const policies = require('@goobster/core/services/attentionPolicyService');
const missions = require('@goobster/core/services/projectMissionService');
const projects = require('@goobster/core/services/projectService');
const parlor = require('@goobster/core/services/parlorService');
const inbox = require('@goobster/core/services/inboxService');
const rules = require('@goobster/core/services/assistant/conversationRequests');
const requestRun = require('@goobster/core/services/assistant/conversationRequestRun');
const adapter = require('@goobster/core/services/assistant/sources/conversationRequest');
const { useState } = require('./helpers/featureFixtures');

const A = '770000000000000001';
const B = '770000000000000002';

afterAll(async () => {
    initiatives.stopListening();
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

let files;
beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    runner._reset();
    initiatives.stopListening();
    for (const table of [
        'assistant_run_operations', 'assistant_runs', 'assistant_initiatives', 'assistant_source_cursors',
        'assistant_update_receipts', 'assistant_updates', 'assistant_responsibility_revisions', 'assistant_responsibilities',
        'attention_policies', 'attention_items', 'inbox_items', 'usage_reservations', 'work_failures',
        'knowledge_transfers', 'parlor_messages', 'parlor_members', 'parlor_participants', 'parlor_conversations',
        'project_decisions', 'project_mission_approval_receipts', 'project_mission_events', 'project_mission_evidence',
        'project_mission_steps', 'project_missions', 'observatory_share_links', 'project_members', 'observatory_projects'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    files = new Map();
    jest.spyOn(projects, 'writeWorkspaceFile').mockImplementation(async ({ relativePath, bytes }) => {
        files.set(relativePath, bytes.toString('utf8'));
        return { relativePath };
    });
});

let callId = 0;
const call = (name, args = {}) => ({ id: `q${++callId}`, name, arguments: JSON.stringify(args) });
/** Script the model: each entry is one round's tool calls, a final text, or a function returning either. */
function script(...rounds) {
    const queue = [...rounds];
    return jest.spyOn(aiService, 'chat').mockImplementation(async () => {
        let next = queue.shift();
        if (typeof next === 'function') next = await next();
        if (next === undefined) return { content: 'Nothing more.', toolCalls: [] };
        return typeof next === 'string' ? { content: next, toolCalls: [] } : { content: '', toolCalls: next };
    });
}
const FINISH = call('finish', {
    outcome: 'done', title: 'Fastify and Hono compared', summary: 'Hono is smaller; Fastify has the larger plugin set. Sources: both projects\' docs.'
});

/** A project of `owner` with its main conversation; `members` are seated in both. */
async function project({ owner = A, members = [], title = 'API design' } = {}) {
    const pid = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'lab', 'Lab')", { u: owner });
    for (const member of members) {
        await db.run(
            'INSERT INTO project_members (projectId, userId, userName, invitedBy) VALUES (@pid, @u, @u, @owner)',
            { pid, u: member, owner }
        );
    }
    const conversation = await parlor.createProjectConversation({
        project: { id: pid, ownerId: owner, name: 'Lab' }, members: members.map(userId => ({ userId, userName: userId })), title
    });
    return { pid, conversationId: conversation.id };
}

/** A discussion of `owner` outside any project. */
async function discussion({ owner = A, members = [] } = {}) {
    const persona = await parlor.ensureBuiltinPersona(owner);
    const conversation = await parlor.createConversation({ ownerId: owner, personaIds: [persona.id] });
    for (const member of members) {
        await db.run(
            'INSERT INTO parlor_members (conversationId, userId, userName, invitedBy) VALUES (@c, @u, @u, @owner)',
            { c: conversation.id, u: member, owner }
        );
    }
    return conversation.id;
}

const say = async (userId, conversationId, content) => (await parlor.postMessage({
    userId, userName: userId === A ? 'Ada' : 'Bo', conversationId, content, notify: false
})).id;

/** An active responsibility of `userId` that takes requests from the named sources. */
async function delegate({ userId = A, pid = null, sources = ['project_chat'], operations = undefined, body = {} } = {}) {
    await policies.enroll({ userId, initiative: 'assist' });
    const { responsibility } = await responsibilities.create({
        userId,
        body: {
            title: 'Look into what I ask for',
            ...(pid ? { projectId: pid } : {}),
            scopes: { sources },
            operations: operations || (pid
                ? [{ operation: 'read', resource: { kind: 'project', ids: [String(pid)] } }]
                : [{ operation: 'read', resource: { kind: 'knowledge' } }]),
            ...body
        }
    });
    return (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
}

const look = (grant, now = new Date()) => initiatives.reconcileResponsibility(grant.id, { now });
/** A look late enough that the cursor has passed everything said so far. */
const lookLater = (grant) => look(grant, new Date(Date.now() + 10_000));
const rows = (where = '1 = 1') => db.all(`SELECT * FROM assistant_initiatives WHERE ${where} ORDER BY id`, {});
const row = (id) => db.get('SELECT * FROM assistant_initiatives WHERE id = @id', { id });
const queue = async (userId, id) => {
    const current = await initiatives.get({ userId, id });
    return (await initiatives.act({ userId, id, action: 'queue', expectedRevision: current.revision })).initiative;
};
const planCounts = async () => ({
    missions: (await db.get('SELECT COUNT(*) AS n FROM project_missions', {})).n,
    steps: (await db.get('SELECT COUNT(*) AS n FROM project_mission_steps', {})).n,
    decisions: (await db.get('SELECT COUNT(*) AS n FROM project_decisions', {})).n
});

describe('what counts as a request', () => {
    test.each([
        ['Goobster, can you compare Fastify and Hono for our API?', 'request'],
        ['@Goobster please look into why the import fails', 'request'],
        ['Hey Goobster, research rate limiting libraries', 'request'],
        ['Could you check the licence terms, Goobster?', 'request'],
        ['goobster compare x and y', 'request'],
        ['Ok Goobster \u2014 I need you to write up the findings', 'request'],
        // Addressed, but a question or chat: nothing to carry out.
        ['Goobster, what do you think?', 'nothing'],
        ['Goobster, can you explain that again?', 'nothing'],
        ['thanks Goobster', 'nothing'],
        ['Goobster', 'nothing'],
        // Mentioned, not addressed.
        ['I asked Goobster to compare them yesterday', 'nothing'],
        ['I think @Goobster could help with this', 'nothing'],
        // Work discussed between people is not a request to him.
        ['We should compare Fastify and Hono', 'nothing'],
        ['Can you compare Fastify and Hono, Bo?', 'nothing'],
        // A word that merely starts like a rule.
        ['Goobster, stopwatch apps: compare them', 'nothing']
    ])('%s -> %s', (text, expected) => {
        const parsed = rules.parse(text);
        expect(parsed.steer).toBe(false);
        expect(parsed.request).toBe(expected === 'request');
    });

    test.each([
        ['Goobster, scratch that', false],
        ['Goobster, stop', false],
        ['Goobster: never mind, we are staying on Express', false],
        ['Goobster, actually compare Fastify and Koa', true],
        ['Goobster, compare Koa instead.', true],
        ['Goobster, instead of Express, look at Fastify', true],
        // Calling work off is not asking for it.
        ["Goobster, don't research Fastify", false],
        ["Goobster, don't bother with that, look into Koa", true]
    ])('steering: %s (replacement: %s)', (text, replacement) => {
        expect(rules.parse(text)).toMatchObject({ addressed: true, steer: true, request: replacement });
    });
});

describe('the name a message must use', () => {
    const identityConfig = require('@goobster/core/config/identityConfig');
    const original = identityConfig.assistantName;
    afterEach(() => { identityConfig.assistantName = original; });

    test('it is the name this installation gives its assistant', () => {
        identityConfig.assistantName = 'Juniper';
        expect(rules.parse('Juniper, compare Fastify and Hono')).toMatchObject({ addressed: true, request: true });
        expect(rules.parse('@juniper please look into the flaky test')).toMatchObject({ request: true });
        expect(rules.parse('Goobster, compare Fastify and Hono')).toMatchObject({ addressed: false, request: false });
        identityConfig.assistantName = '';
        expect(rules.parse('Goobster, compare Fastify and Hono')).toMatchObject({ request: true });
    });
});

describe('the grant', () => {
    test('a project conversation source needs the project it belongs to', async () => {
        await policies.enroll({ userId: A, initiative: 'assist' });
        await expect(responsibilities.create({
            userId: A, body: { title: 'x', scopes: { sources: ['project_chat'] }, operations: [{ operation: 'read', resource: { kind: 'knowledge' } }] }
        })).rejects.toMatchObject({ code: 'INVALID_LINK' });
        expect(responsibilities.vocabulary().sourceScopes || responsibilities.SOURCE_SCOPES).toEqual(expect.arrayContaining(['project_chat', 'parlor']));
    });

    test('a responsibility that names no conversation source reads no conversation', async () => {
        const { pid, conversationId } = await project();
        const grant = await delegate({ pid, sources: ['project'] });
        await say(A, conversationId, 'Goobster, can you compare Fastify and Hono?');
        expect((await lookLater(grant)).proposed).toEqual([]);
        expect(await db.get("SELECT 1 AS ok FROM assistant_source_cursors WHERE sourceKind = 'conversation_request'", {})).toBeUndefined();
    });
});

describe('a request becomes a proposal', () => {
    test('what was said before the person delegated is history; a request made after is proposed once, by reference', async () => {
        const { pid, conversationId } = await project();
        await say(A, conversationId, 'Goobster, can you research the old thing from last month?');
        const grant = await delegate({ pid });
        expect(await rows()).toEqual([]);

        const messageId = await say(A, conversationId, 'Goobster, can you compare Fastify and Hono for our API?');
        const first = await look(grant);
        expect(first.proposed).toHaveLength(1);
        // The same message again (a rescan, a repeated hint) is one opportunity.
        expect((await look(grant)).proposed).toEqual([]);
        expect((await lookLater(grant)).proposed).toEqual([]);
        expect((await lookLater(grant)).proposed).toEqual([]);

        const [item] = await rows();
        expect(item).toMatchObject({
            status: 'CANDIDATE', sourceKind: 'conversation_request', sourceId: `parlor:${conversationId}:${messageId}`,
            ownerUserId: A, actingUserId: A, audience: 'private', projectId: pid, title: 'Asked in "API design"'
        });
        expect(JSON.parse(item.originJson)).toEqual({
            kind: 'parlor_message', surface: 'project', conversationId, messageId, speakerUserId: A,
            audience: { kind: 'project', projectId: pid }
        });
        // References only: the words stay in the conversation.
        expect(JSON.stringify(item)).not.toMatch(/Fastify|Hono/i);
        expect(initiatives.present(item).origin).toMatchObject({ conversationId, messageId });
    });

    test('only an explicit request, addressed to Goobster, by the person the responsibility acts for', async () => {
        const { pid, conversationId } = await project({ members: [B] });
        const grant = await delegate({ pid });
        await say(A, conversationId, 'We should compare Fastify and Hono before we commit.');
        await say(A, conversationId, 'Goobster, what do you think of Hono?');
        await say(A, conversationId, 'I asked Goobster to compare them yesterday');
        // Someone else asking is their request, under their own responsibility if they have one.
        await say(B, conversationId, 'Goobster, can you compare Fastify and Hono?');
        // A persona suggesting work is not a person asking for it.
        await db.run(
            "INSERT INTO parlor_messages (conversationId, role, personaName, content) VALUES (@c, 'persona', 'Goobster', 'Goobster, please research Hono')",
            { c: conversationId }
        );
        expect((await lookLater(grant)).proposed).toEqual([]);
        expect(await rows()).toEqual([]);

        // B's own responsibility takes B's request, as B.
        const theirs = await delegate({ userId: B, pid });
        const asked = await say(B, conversationId, 'Goobster, please look into the Hono licence');
        const [id] = (await look(theirs)).proposed;
        expect(await row(id)).toMatchObject({ ownerUserId: B, actingUserId: B, sourceId: `parlor:${conversationId}:${asked}` });
        expect((await lookLater(grant)).proposed).toEqual([]);
    });

    test('a responsibility covers its own project\'s conversations or the person\'s discussions, as its sources say', async () => {
        const { pid, conversationId } = await project();
        const other = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'other', 'Other')", { u: A });
        const elsewhere = await parlor.createProjectConversation({ project: { id: other, ownerId: A, name: 'Other' }, members: [], title: 'Other chat' });
        const talk = await discussion();
        const theirs = await discussion({ owner: B });

        const projectGrant = await delegate({ pid, sources: ['project_chat'] });
        const parlorGrant = await delegate({ sources: ['parlor'] });
        const inProject = await say(A, conversationId, 'Goobster, please compare Fastify and Hono');
        await say(A, elsewhere.id, 'Goobster, please compare Koa and Express');
        const inTalk = await say(A, talk, 'Goobster, please research standing desks');
        // A discussion the person is not part of is never read, whoever speaks in it.
        await db.run("INSERT INTO parlor_messages (conversationId, role, content, userId) VALUES (@c, 'user', 'Goobster, please research chairs', @u)", { c: theirs, u: A });

        expect((await look(projectGrant)).proposed).toHaveLength(1);
        expect((await look(parlorGrant)).proposed).toHaveLength(1);
        expect((await rows()).map(item => [item.responsibilityId, item.sourceId, item.title])).toEqual([
            [projectGrant.id, `parlor:${conversationId}:${inProject}`, 'Asked in "API design"'],
            [parlorGrant.id, `parlor:${talk}:${inTalk}`, 'Asked in a discussion']
        ]);
        expect(JSON.parse((await rows())[1].originJson)).toMatchObject({ surface: 'parlor', audience: { kind: 'conversation', conversationId: talk } });
    });

    test('existing work is matched before more is proposed', async () => {
        const { pid, conversationId } = await project();
        const older = await delegate({ pid });
        const younger = await delegate({ pid });
        await say(A, conversationId, 'Goobster, please compare Fastify and Hono');
        // Two responsibilities cover the conversation: the older one takes the request, once.
        expect((await look(younger)).proposed).toEqual([]);
        expect((await look(older)).proposed).toHaveLength(1);
        expect((await lookLater(younger)).proposed).toEqual([]);

        // The same words again while that attempt is open are the same request.
        await say(A, conversationId, 'Goobster,  please compare Fastify and Hono');
        expect((await lookLater(older)).proposed).toEqual([]);
        // Different words are different work.
        await say(A, conversationId, 'Goobster, please compare Fastify and Koa');
        expect((await lookLater(older)).proposed).toHaveLength(1);
        expect(await rows()).toHaveLength(2);

        // Once the first is finished, asking again is a new request.
        await db.run("UPDATE assistant_initiatives SET status = 'COMPLETED' WHERE id = (SELECT MIN(id) FROM assistant_initiatives)", {});
        await say(A, conversationId, 'Goobster, please compare Fastify and Hono');
        expect((await lookLater(older)).proposed).toHaveLength(1);
    });

    test('past the open limit a request is recorded as not started instead of queued or dropped', async () => {
        const { pid, conversationId } = await project();
        const grant = await delegate({ pid });
        for (let n = 0; n <= adapter.OPEN_LIMIT; n += 1) await say(A, conversationId, `Goobster, please research topic number ${n}`);
        await lookLater(grant);
        const all = await rows();
        expect(all).toHaveLength(adapter.OPEN_LIMIT + 1);
        expect(all.filter(item => item.status === 'CANDIDATE')).toHaveLength(adapter.OPEN_LIMIT);
        const over = all[all.length - 1];
        expect(over).toMatchObject({ status: 'CANCELLED', stopCode: 'OPEN_LIMIT' });
        expect(over.endedAt).toBeTruthy();
        // It is not lost: its owner can start it once there is room.
        await initiatives.act({ userId: A, id: all[0].id, action: 'cancel', expectedRevision: all[0].revision });
        const retried = (await initiatives.act({ userId: A, id: over.id, action: 'retry', expectedRevision: over.revision })).initiative;
        expect(retried).toMatchObject({ status: 'QUEUED', origin: expect.objectContaining({ kind: 'parlor_message' }) });
    });

    test('history copied into a conversation is not a request made there', async () => {
        const { pid, conversationId } = await project();
        const grant = await delegate({ pid });
        // A chat moved into the project keeps its messages' original times.
        await db.run(
            "INSERT INTO parlor_messages (conversationId, role, content, userId, createdAt) VALUES (@c, 'user', 'Goobster, please research the thing from my private chat', @u, '2020-01-01 00:00:00')",
            { c: conversationId, u: A }
        );
        // A single answer shared into the discussion is recorded as a transfer.
        const shared = await say(A, conversationId, 'Goobster, please research what I shared');
        await db.run(
            "INSERT INTO knowledge_transfers (userId, sourceKind, targetKind, targetId, mode, copyMessageId) VALUES (@u, 'chat_message', 'discussion', @c, 'copy', @m)",
            { u: A, c: conversationId, m: shared }
        );
        expect((await lookLater(grant)).proposed).toEqual([]);
        expect(await rows()).toEqual([]);
    });

    test('a request starts by itself only when the person turned that on', async () => {
        const { pid, conversationId } = await project();
        const grant = await delegate({ pid, body: { rules: { autoStart: true } } });
        await say(A, conversationId, 'Goobster, please compare Fastify and Hono');
        const [id] = (await look(grant)).proposed;
        expect(await row(id)).toMatchObject({ status: 'QUEUED' });
    });

    test('posting a message that addresses Goobster asks for an early look; any other message does not', async () => {
        const { conversationId } = await project();
        const hint = jest.spyOn(initiatives, 'hint').mockImplementation(() => {});
        // Only where the steward is running: elsewhere the periodic pass finds it.
        await say(A, conversationId, 'Goobster, please compare Fastify and Hono');
        expect(hint).not.toHaveBeenCalled();
        initiatives.listen();
        await say(A, conversationId, 'Lunch?');
        expect(hint).not.toHaveBeenCalled();
        await say(A, conversationId, 'Goobster, please compare Koa and Hono');
        expect(hint).toHaveBeenCalledWith(A);
        initiatives.stopListening();
    });
});

describe('a library comparison asked for in a project conversation', () => {
    test('is researched under the grant, reported to the person who asked, and commits nobody to anything', async () => {
        const { pid, conversationId } = await project({ members: [B] });
        // A plan exists; the request must not touch it.
        await missions.create({
            userId: A, project: 'lab', title: 'Ship the API', objective: 'Ship a first version of the API.',
            successCriteria: ['It serves requests'], steps: [{ kind: 'human', title: 'Pick a framework' }]
        });
        const before = await planCounts();
        const planBefore = await db.get('SELECT status, planRevision, updatedAt FROM project_missions', {});

        // B is a collaborator: the work runs as B, on B's budget.
        const grant = await delegate({ userId: B, pid });
        const messageId = await say(B, conversationId, 'Goobster, can you compare Fastify and Hono for our API? We might migrate off Express.');
        const [id] = (await look(grant)).proposed;
        await queue(B, id);

        const chat = script([FINISH]);
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'COMPLETED', outcome: 'DONE' });

        // The model was given the request in the person's words, and told what it does not authorize.
        const [messages, options] = chat.mock.calls[0];
        expect(messages[1].content).toContain('compare Fastify and Hono for our API');
        expect(messages[0].content).toMatch(/gives you no permission the responsibility does not/);
        expect(messages[0].content).toMatch(/Do not record a decision, do not change a plan/);
        // No tool it was offered can approve, start, change or complete a plan, or record a decision.
        const offered = JSON.stringify(options.functions || options.tools || []);
        expect(offered).not.toMatch(/mission|decision|approve|reportStepResult/i);
        expect(Object.keys(runs.TOOLS).join(' ')).not.toMatch(/decision|mission|migrat/i);

        // Researched under the grant, as the collaborator, with them as the payer.
        const [run] = await db.all('SELECT * FROM assistant_runs', {});
        expect(run).toMatchObject({ status: 'COMPLETED', ownerUserId: B, actingUserId: B, payerUserId: B, responsibilityId: grant.id });

        // Nothing was committed: the plan, its steps and the project's decisions are as they were.
        expect(await planCounts()).toEqual(before);
        expect(await db.get('SELECT status, planRevision, updatedAt FROM project_missions', {})).toEqual(planBefore);

        // The result goes to the person who asked, privately, and links back to the conversation.
        const mine = (await updates.list({ userId: B })).updates;
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({
            kind: 'finding', title: 'Fastify and Hono compared', audience: { kind: 'private' }, initiativeId: id,
            actions: [{ kind: 'open_initiative', id: String(id) }, { kind: 'open_conversation', id: String(conversationId) }]
        });
        expect(mine[0].componentIds).toEqual(expect.arrayContaining(['conversations', 'projects', 'research']));
        // The project's owner, who can read the conversation, is not sent the result.
        expect((await updates.list({ userId: A })).updates).toEqual([]);
        // Nothing was posted into the shared conversation.
        expect(await db.get('SELECT MAX(id) AS top FROM parlor_messages', {})).toEqual({ top: messageId });

        // On the Assistant page the work item shows what was asked and where, read now.
        const described = await requestRun.origins({ userId: B, initiatives: [await initiatives.get({ userId: B, id })] });
        expect(described.get(id)).toMatchObject({
            available: true, surface: 'project', conversationTitle: 'API design', link: `/discussions/${conversationId}`,
            excerpt: expect.stringContaining('compare Fastify and Hono')
        });
    });

    test('a request whose message is gone, or whose conversation the person left, never reaches the model', async () => {
        const { pid, conversationId } = await project({ members: [B] });
        const grant = await delegate({ userId: B, pid });
        const chat = script([FINISH]);

        const first = await say(B, conversationId, 'Goobster, please compare Fastify and Hono');
        const second = await say(B, conversationId, 'Goobster, please compare Koa and Express');
        const [one, two] = (await look(grant)).proposed;
        await queue(B, one);
        await db.run('DELETE FROM parlor_messages WHERE id = @id', { id: first });
        expect((await runner.tick({ wait: true })).results[0]).toMatchObject({ status: 'SUPERSEDED', stopCode: 'SOURCE_GONE' });

        // Lost membership: the next look withdraws what was proposed, before anyone starts it.
        await db.run('DELETE FROM project_members WHERE projectId = @pid AND userId = @u', { pid, u: B });
        await db.run('DELETE FROM parlor_members WHERE conversationId = @c AND userId = @u', { c: conversationId, u: B });
        const described = await requestRun.origins({ userId: B, initiatives: [await initiatives.get({ userId: B, id: two })] });
        expect(described.get(two)).toMatchObject({ available: false, excerpt: null, link: null, conversationTitle: null });
        expect(await adapter.stale(await db.get('SELECT * FROM assistant_responsibilities WHERE id = @id', { id: grant.id })))
            .toEqual([{ id: two, code: 'SOURCE_GONE' }]);
        await initiatives._supersedeStale([{ id: two, code: 'SOURCE_GONE' }]);
        expect(await row(two)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'SOURCE_GONE' });
        expect(chat).not.toHaveBeenCalled();
        expect(second).toBeGreaterThan(first);
    });

    test('a responsibility that stopped covering the conversation does not carry its request out', async () => {
        const talk = await discussion();
        const grant = await delegate({ sources: ['parlor'] });
        await say(A, talk, 'Goobster, please research standing desks');
        const [id] = (await look(grant)).proposed;
        await db.run("UPDATE assistant_responsibilities SET scopesJson = '{\"sources\":[]}' WHERE id = @id", { id: grant.id });
        const chat = script([FINISH]);
        expect((await look(grant)).superseded).toBe(1);
        expect(await row(id)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'SOURCE_NOT_COVERED' });
        expect(chat).not.toHaveBeenCalled();
    });
});

describe('a change of direction', () => {
    const WRITE = call('writeProjectFile', { path: 'docs/notes.md', content: '# Notes\nFastify first.' });
    const fileOps = (pid) => [
        { operation: 'read', resource: { kind: 'project', ids: [String(pid)] } },
        { operation: 'file.edit', resource: { kind: 'project', ids: [String(pid)], paths: ['docs'] } }
    ];

    test('supersedes proposed, queued and running work from that conversation, and says what rested on it', async () => {
        const { pid, conversationId } = await project();
        const grant = await delegate({ pid, operations: fileOps(pid) });

        // An earlier request that already finished under the old direction.
        await say(A, conversationId, 'Goobster, please research Express middleware');
        const [finished] = (await look(grant)).proposed;
        await queue(A, finished);
        script([call('finish', { outcome: 'done', title: 'Express middleware surveyed', summary: 'Three candidates.' })]);
        await runner.tick({ wait: true });
        expect(await row(finished)).toMatchObject({ status: 'COMPLETED' });

        await say(A, conversationId, 'Goobster, please compare Fastify and Hono');
        await say(A, conversationId, 'Goobster, please benchmark Fastify on our routes');
        await say(A, conversationId, 'Goobster, please write up the Fastify migration steps in docs/notes.md');
        const [proposed, queued, running] = (await look(grant)).proposed;
        await queue(A, queued);
        // Work from another conversation is not part of this direction.
        const elsewhere = await parlor.createProjectConversation({ project: { id: pid, ownerId: A, name: 'Lab' }, members: [], title: 'Ops' });
        await say(A, elsewhere.id, 'Goobster, please check the deploy logs');
        const [untouched] = (await look(grant)).proposed;

        // The third one is being worked on when the person changes their mind.
        const claimed = await initiatives.claim({ id: (await queue(A, running)).id });
        expect(claimed.ok).toBe(true);
        let steerId;
        const chat = script(
            [WRITE],
            async () => {
                steerId = await say(A, conversationId, 'Goobster, actually we are staying on Express. Compare Express 5 with our current version instead.');
                const outcome = await look(grant);
                expect(outcome.steered).toEqual([`parlor:${conversationId}:${steerId}`]);
                // The model carries on; its next call finds the work stopped.
                return [call('writeProjectFile', { path: 'docs/more.md', content: 'More Fastify.' })];
            },
            [FINISH]
        );
        const result = await runs.execute({ initiative: claimed.initiative, leaseToken: claimed.leaseToken });
        expect(result).toMatchObject({ status: 'CANCELLED', stopCode: 'LEASE_LOST' });
        expect(chat.mock.calls.length).toBeGreaterThanOrEqual(2);

        const ref = `parlor:${conversationId}:${steerId}`;
        for (const id of [proposed, queued, running]) {
            expect(await row(id)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'STEERED', supersededBy: ref, leaseToken: null });
        }
        expect(initiatives.present(await row(proposed)).supersededBy).toBe(ref);
        // The run stopped at its next step: the first change stands, the second never happened, no result was written.
        expect([...files.keys()]).toEqual(['docs/notes.md']);
        expect(await db.all('SELECT tool, status FROM assistant_run_operations WHERE runId = (SELECT id FROM assistant_runs WHERE initiativeId = @id) ORDER BY id', { id: running }))
            .toEqual([{ tool: 'writeProjectFile', status: 'SUCCEEDED' }]);
        expect(await db.get('SELECT status, stopCode, resultTitle FROM assistant_runs WHERE initiativeId = @id', { id: running }))
            .toEqual({ status: 'CANCELLED', stopCode: 'LEASE_LOST', resultTitle: null });
        // Untouched: the other conversation's request and the finished result.
        expect(await row(untouched)).toMatchObject({ status: 'CANDIDATE' });
        expect(await row(finished)).toMatchObject({ status: 'COMPLETED' });

        // The replacement in the same message is new work, proposed once.
        const replacement = await rows(`sourceId = '${ref}'`);
        expect(replacement).toHaveLength(1);
        expect(replacement[0]).toMatchObject({ status: 'CANDIDATE', supersededBy: null });

        // One update says what was stopped and what rested on it. It quotes no message.
        const steer = (await updates.list({ userId: A })).updates.filter(update => update.source?.kind === 'conversation_request');
        expect(steer).toHaveLength(1);
        expect(steer[0]).toMatchObject({
            kind: 'progress', title: 'Changed direction: 3 requests stopped', audience: { kind: 'private' },
            source: { kind: 'conversation_request', id: ref },
            actions: [{ kind: 'open_conversation', id: String(conversationId) }, { kind: 'open_responsibility', id: String(grant.id) }]
        });
        expect(steer[0].componentIds).toEqual(expect.arrayContaining(['conversations', 'projects']));
        const text = steer[0].summary;
        expect(text).toContain('You changed direction in "API design".');
        expect(text).toContain('2 requests had not started and were withdrawn.');
        expect(text).toContain('1 request had started and was stopped.');
        expect(text).toContain('Already changed, and left as it is: Wrote docs/notes.md.');
        expect(text).toContain('Finished under the earlier direction, worth another look: "Express middleware surveyed".');
        expect(text).toContain('Nothing was undone.');
        expect(text).not.toMatch(/Hono|benchmark|staying on Express/i);
        // It reached the person's Inbox once.
        const filed = (await inbox.list({ userId: A })).items.filter(item => item.title.startsWith('Changed direction'));
        expect(filed).toHaveLength(1);

        // Reading the same messages again changes nothing.
        const again = await lookLater(grant);
        expect(again).toMatchObject({ proposed: [], steered: [] });
        expect((await updates.list({ userId: A })).updates.filter(update => update.source?.kind === 'conversation_request')[0].revision).toBe(steer[0].revision);

        // A stopped request can be asked for again by its owner.
        const stopped = await row(proposed);
        const retried = (await initiatives.act({ userId: A, id: proposed, action: 'retry', expectedRevision: stopped.revision })).initiative;
        expect(retried).toMatchObject({ status: 'QUEUED', parentInitiativeId: proposed });
    });

    test('calling work off without a replacement stops it and proposes nothing new', async () => {
        const talk = await discussion();
        const grant = await delegate({ sources: ['parlor'] });
        await say(A, talk, 'Goobster, please research standing desks');
        const [id] = (await look(grant)).proposed;
        const steerId = await say(A, talk, 'Goobster, never mind');
        const outcome = await look(grant);
        expect(outcome).toMatchObject({ proposed: [], steered: [`parlor:${talk}:${steerId}`] });
        expect(await row(id)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'STEERED' });
        expect(await rows()).toHaveLength(1);
        const [update] = (await updates.list({ userId: A })).updates;
        expect(update.title).toBe('Changed direction: 1 request stopped');
        expect(update.summary).toContain('You changed direction in a discussion.');
    });

    test('someone else changing direction, or the person doing so elsewhere, stops nothing of theirs here', async () => {
        const { pid, conversationId } = await project({ members: [B] });
        const mine = await delegate({ pid });
        const theirs = await delegate({ userId: B, pid });
        await say(A, conversationId, 'Goobster, please compare Fastify and Hono');
        const [id] = (await look(mine)).proposed;
        await say(B, conversationId, 'Goobster, scratch that');
        const elsewhere = await parlor.createProjectConversation({ project: { id: pid, ownerId: A, name: 'Lab' }, members: [], title: 'Ops' });
        await say(A, elsewhere.id, 'Goobster, stop');
        expect((await lookLater(theirs)).steered).toEqual([]);
        expect((await lookLater(mine)).steered).toEqual([]);
        expect(await row(id)).toMatchObject({ status: 'CANDIDATE' });
        expect((await updates.list({ userId: A })).updates).toEqual([]);
        expect((await updates.list({ userId: B })).updates).toEqual([]);
    });
});

describe('a plan that moved on', () => {
    async function approveAsHuman(args) {
        const receipt = await missions.mintApprovalReceipt({ ...args, origin: 'portal' });
        return missions.approve({ ...args, receiptId: receipt.id, nonce: receipt.nonce });
    }
    async function startedPlan() {
        const pid = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'lab', 'Lab')", { u: A });
        const args = { userId: A, project: 'lab' };
        await missions.create({
            ...args, title: 'Choose a charting library', objective: 'Decide between library X and library Y.',
            successCriteria: ['A written comparison exists'],
            steps: [{ kind: 'agent', title: 'Write the comparison report' }, { kind: 'agent', title: 'Summarize it' }]
        });
        await approveAsHuman(args);
        const mission = await missions.start(args);
        await policies.enroll({ userId: A, initiative: 'assist' });
        const { responsibility } = await responsibilities.create({
            userId: A,
            body: {
                title: 'Carry the plan forward', projectId: pid,
                operations: [
                    { operation: 'read', resource: { kind: 'project', ids: [String(pid)] } },
                    { operation: 'plan.step.execute', resource: { kind: 'project', ids: [String(pid)] } }
                ]
            }
        });
        const grant = (await responsibilities.act({ userId: A, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
        return { pid, args, mission, grant };
    }

    test('withdraws the steps it had proposed without waiting for anyone to start them', async () => {
        const { args, mission, grant } = await startedPlan();
        const proposed = await rows();
        expect(proposed.map(item => item.status)).toEqual(['CANDIDATE', 'CANDIDATE']);
        const chat = script();

        // A person does the first step themselves.
        await missions.completeStep({ ...args, stepId: mission.steps[0].id });
        expect(await look(grant)).toMatchObject({ superseded: 1 });
        expect(await row(proposed[0].id)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'STEP_NOT_ELIGIBLE', supersededBy: `plan:${mission.id}` });
        expect(await row(proposed[1].id)).toMatchObject({ status: 'CANDIDATE' });

        // The plan is cancelled: what is left goes too.
        await missions.cancel(args);
        expect(await look(grant)).toMatchObject({ superseded: 1 });
        expect(await row(proposed[1].id)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'PLAN_NOT_ACTIVE', supersededBy: `plan:${mission.id}` });
        expect(chat).not.toHaveBeenCalled();
    });

    test('an approved scope that changed voids proposed and queued work at the next look, before anything is dispatched', async () => {
        const { mission, grant } = await startedPlan();
        const [first, second] = await rows();
        await queue(A, first.id);
        // The approved scope changed after the work was proposed.
        await db.run('UPDATE project_missions SET planRevision = planRevision + 1', {});
        const chat = script();
        expect((await look(grant)).superseded).toBe(2);
        for (const id of [first.id, second.id]) {
            expect(await row(id)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'PLAN_REVISION_STALE', supersededBy: `plan:${mission.id}` });
        }
        expect((await runner.tick({ wait: true })).started).toBe(0);
        expect(chat).not.toHaveBeenCalled();
    });

    test('a step its own run holds is still that run\'s to finish', async () => {
        const { mission, grant } = await startedPlan();
        const [first] = await rows();
        await queue(A, first.id);
        const claimed = await initiatives.claim({ id: first.id });
        const run = await runs._open(claimed.initiative, await db.get('SELECT * FROM assistant_responsibilities WHERE id = @id', { id: grant.id }));
        await db.run(
            "UPDATE project_mission_steps SET status = 'RUNNING', executionAttemptId = @attempt, agentRunId = @run WHERE id = @id",
            { id: mission.steps[0].id, attempt: `assistant_run:${run.id}`, run: run.id }
        );
        // Parked mid-work (a budget wait): the attempt is waiting, the step is still its own.
        await initiatives.settle({ id: first.id, leaseToken: claimed.leaseToken, status: 'WAITING', waitReason: 'budget', stopCode: 'TOKEN_BUDGET' });
        await look(grant);
        expect(await row(first.id)).toMatchObject({ status: 'WAITING', stopCode: 'TOKEN_BUDGET' });
    });
});

describe('erasure', () => {
    test('forget-me removes the work a person asked for, and the reference to them on anyone else\'s', async () => {
        const privacyService = require('@goobster/core/services/privacyService');
        const { pid, conversationId } = await project({ members: [B] });
        const grant = await delegate({ pid });
        await look(grant);
        const asked = await say(A, conversationId, 'Goobster, compare Fastify and Hono');
        await lookLater(grant);
        expect(await rows(`ownerUserId = '${A}'`)).toHaveLength(1);

        // Work on someone else's grant that names the erased person as its speaker.
        const theirs = await delegate({ userId: B, pid });
        await look(theirs);
        await say(B, conversationId, 'Goobster, compare Koa and Hono');
        await lookLater(theirs);
        await db.run('UPDATE assistant_responsibilities SET actingUserId = @A WHERE id = @id', { A, id: theirs.id });
        await db.run(
            'UPDATE assistant_initiatives SET actingUserId = @A, originJson = @origin WHERE responsibilityId = @id',
            { A, id: theirs.id, origin: JSON.stringify({ kind: 'parlor_message', surface: 'project', conversationId, messageId: asked, speakerUserId: A }) }
        );

        await privacyService.forgetUser({ userId: A });
        expect(await rows(`ownerUserId = '${A}'`)).toEqual([]);
        const [kept] = await rows(`responsibilityId = ${theirs.id}`);
        expect(kept).toMatchObject({ ownerUserId: B, actingUserId: null, originJson: null, status: 'CANCELLED', stopCode: 'PRINCIPAL_ERASED' });
        expect(JSON.stringify(await rows())).not.toContain(A);
    });
});
