/**
 * Findings for a project's members (DA-11c), against a throwaway database
 * with a scripted model (no provider, no network).
 *
 * The properties under test are the DA-11c acceptance scenarios: a run
 * publishes with `audience: { projectId }`; the producer is shown; private
 * sources are not quoted; a member's receipt is deleted when they leave.
 * Around them: the owner-only pilot gate (assistantAccessService, `reach`)
 * at entry and at publication, a finding that does not qualify coming to
 * the person alone with the reason, and erasure.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-project-audience-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runs = require('@goobster/core/services/assistantRunService');
const runner = require('@goobster/core/services/assistantRunnerService');
const updates = require('@goobster/core/services/assistantUpdateService');
const access = require('@goobster/core/services/assistantAccessService');
const identityService = require('@goobster/core/services/identityService');
const policies = require('@goobster/core/services/attentionPolicyService');
const projects = require('@goobster/core/services/projectService');
const parlor = require('@goobster/core/services/parlorService');
const audience = require('@goobster/core/services/assistant/projectAudience');
const { useState } = require('./helpers/featureFixtures');

/** The owner of the installation (an operator), a collaborator, and someone outside the project. */
const A = '770000000000000011';
const B = '770000000000000012';
const C = '770000000000000013';

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
        'project_mission_steps', 'project_missions', 'observatory_share_links', 'project_members', 'observatory_projects',
        'kg_nodes', 'instance_state', 'app_accounts'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    for (const [id, name] of [[A, 'Ada'], [B, 'Bo'], [C, 'Cy']]) {
        await identityService.ensureLegacyPrincipal({ discordId: id, displayName: name });
    }
    await identityService.grantAccount({ principalId: A, entitlement: 'bootstrap', role: 'operator' });
    files = new Map();
    jest.spyOn(projects, 'writeWorkspaceFile').mockImplementation(async ({ relativePath, bytes }) => {
        files.set(relativePath, bytes.toString('utf8'));
        return { relativePath };
    });
});

let callId = 0;
const call = (name, args = {}) => ({ id: `s${++callId}`, name, arguments: JSON.stringify(args) });
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

/** A project of `owner` named Lab with its main conversation; `members` are seated in both. */
async function project({ owner = A, members = [B], title = 'API design' } = {}) {
    const pid = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'lab', 'Lab')", { u: owner });
    for (const member of members) {
        await db.run(
            'INSERT INTO project_members (projectId, userId, userName, invitedBy) VALUES (@pid, @u, @name, @owner)',
            { pid, u: member, name: member === B ? 'Bo' : 'Cy', owner }
        );
    }
    const conversation = await parlor.createProjectConversation({
        project: { id: pid, ownerId: owner, name: 'Lab' }, members: members.map(userId => ({ userId, userName: userId })), title
    });
    return { pid, conversationId: conversation.id };
}

async function discussion({ owner = A } = {}) {
    const persona = await parlor.ensureBuiltinPersona(owner);
    return (await parlor.createConversation({ ownerId: owner, personaIds: [persona.id] })).id;
}

const say = async (userId, conversationId, content) => (await parlor.postMessage({
    userId, userName: userId === A ? 'Ada' : 'Bo', conversationId, content, notify: false
})).id;

/** An active responsibility of `userId` that takes requests from the named sources. */
async function delegate({ userId = A, pid = null, sources = ['project_chat'], share = true, operations = null, scopes = {} } = {}) {
    await policies.enroll({ userId, initiative: 'assist' });
    const { responsibility } = await responsibilities.create({
        userId,
        body: {
            title: 'Look into what I ask for',
            ...(pid ? { projectId: pid } : {}),
            scopes: { sources, ...(share ? { audience: 'project' } : {}), ...scopes },
            operations: operations || [
                { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } },
                ...(pid ? [{ operation: 'read', resource: { kind: 'project', ids: [String(pid)] } }] : [])
            ]
        }
    });
    return (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
}

const look = (grant, now = new Date()) => initiatives.reconcileResponsibility(grant.id, { now });
const lookLater = (grant) => look(grant, new Date(Date.now() + 10_000));
const queue = async (userId, id) => {
    const current = await initiatives.get({ userId, id });
    return (await initiatives.act({ userId, id, action: 'queue', expectedRevision: current.revision })).initiative;
};
const heldBy = (userId) => db.all(
    "SELECT * FROM assistant_updates WHERE audienceKind = 'project' AND producerUserId = @userId ORDER BY id", { userId }
);

/** The asker says it, the assistant proposes it, the asker starts it, and one run is made. */
async function askAndRun({ userId = A, conversationId, grant, text = 'Goobster, compare Fastify and Hono for our API', rounds = [[FINISH]] }) {
    await look(grant);
    await say(userId, conversationId, text);
    const [id] = (await lookLater(grant)).proposed;
    await queue(userId, id);
    const chat = script(...rounds);
    const result = await runner.tick({ wait: true });
    return { id, chat, result: result.results[0] };
}

describe('a finding for a project\'s members', () => {
    test('is published to the project with the producer shown, and the person who asked has their own notice', async () => {
        const { pid, conversationId } = await project({ members: [B] });
        const grant = await delegate({ pid });
        const { id, result } = await askAndRun({ conversationId, grant });
        expect(result).toMatchObject({ status: 'COMPLETED', outcome: 'DONE' });

        // A collaborator reads it, as the project's finding, from Ada's assistant.
        const seen = (await updates.list({ userId: B })).updates;
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            kind: 'finding', title: 'Fastify and Hono compared', unseen: true, needsAction: false,
            audience: { kind: 'project', projectId: pid }, producer: { name: 'Ada', you: false },
            // Nothing from the producer's private records leaks into what a member sees.
            responsibilityId: null, initiativeId: null,
            actions: [{ kind: 'open_project', id: `${A}/lab` }, { kind: 'open_conversation', id: String(conversationId) }]
        });
        expect(seen[0].summary).toContain('Hono is smaller');
        expect(seen[0].componentIds).toEqual(expect.arrayContaining(['projects', 'conversations', 'research']));
        // No Inbox envelope for the members: the finding is in their briefing.
        expect(await db.get('SELECT COUNT(*) AS n FROM inbox_items WHERE userId = @B', { B })).toEqual({ n: 0 });

        // Someone outside the project reads nothing.
        expect((await updates.list({ userId: C })).updates).toEqual([]);

        // The person who asked has the finding once, as their own notice, with an Inbox envelope.
        const mine = (await updates.list({ userId: A })).updates;
        const notice = mine.find(update => update.audience.kind === 'private');
        expect(notice).toMatchObject({
            title: 'Fastify and Hono compared', initiativeId: id, inboxItemId: expect.any(Number),
            actions: [{ kind: 'open_initiative', id: String(id) }, { kind: 'open_conversation', id: String(conversationId) }]
        });
        expect(notice.summary).toContain('Shared with the members of "Lab".');
        const shared = mine.find(update => update.audience.kind === 'project');
        expect(shared).toMatchObject({ producer: { name: 'Ada', you: true }, initiativeId: id });
        // They have it already: the shared copy is not a second thing to review.
        expect(shared.unseen).toBe(false);
        expect(notice.unseen).toBe(true);

        const run = await db.get('SELECT * FROM assistant_runs', {});
        expect(run.updateId).toBe(notice.id);
    });

    test('is a collaborator\'s own finding when a collaborator asks, and the owner of the project reads it', async () => {
        const { pid, conversationId } = await project({ members: [B] });
        await access.recordDecision({ scope: 'everyone' });
        const grant = await delegate({ userId: B, pid });
        await askAndRun({ userId: B, conversationId, grant });

        const [row] = await heldBy(B);
        expect(row).toMatchObject({ audienceKind: 'project', projectId: pid, producerUserId: B });
        const owner = (await updates.list({ userId: A })).updates;
        expect(owner).toHaveLength(1);
        expect(owner[0]).toMatchObject({ producer: { name: 'Bo', you: false }, audience: { kind: 'project', projectId: pid } });
        // A finding is not the owner's to approve or decide: nothing here is a gate.
        expect(owner[0]).toMatchObject({ gate: null, needsAction: false });
    });

    test('a request the grant did not ask to share, and a finding with no change, are not shared', async () => {
        const { pid, conversationId } = await project({ members: [B] });
        const grant = await delegate({ pid, share: false });
        await askAndRun({ conversationId, grant });
        expect((await updates.list({ userId: B })).updates).toEqual([]);
        expect(await heldBy(A)).toEqual([]);
        // Nothing was said about sharing: it was never asked for.
        const [mine] = (await updates.list({ userId: A })).updates;
        expect(mine.summary).not.toMatch(/Kept private|Shared with/);
    });
});

describe('private sources are not quoted into a project finding', () => {
    test('a run that will share is not offered the tools that read private knowledge, and told who reads its report', async () => {
        const { pid, conversationId } = await project({ members: [B] });
        const grant = await delegate({ pid });
        const { chat } = await askAndRun({
            conversationId, grant,
            rounds: [[call('lookupNotes', { query: 'my private plans' }), call('listGeneratedNotes')], [FINISH]]
        });
        const [messages, options] = chat.mock.calls[0];
        const offered = JSON.stringify(options.functions || options.tools || options);
        expect(offered).not.toMatch(/"name":"(lookupNotes|listGeneratedNotes)"/);
        expect(offered).toMatch(/"name":"searchWeb"/);
        expect(messages[0].content).toMatch(/shared with every member of the project "Lab"/);
        expect(messages[0].content).not.toMatch(/goes only to the person who asked/);
        // Asking for one anyway runs nothing: the journal shows it refused.
        const ops = await db.all('SELECT tool, status, refusalCode FROM assistant_run_operations WHERE tool IN (\'lookupNotes\', \'listGeneratedNotes\')', {});
        expect(ops.map(op => op.status)).toEqual(['REFUSED', 'REFUSED']);
        expect(ops.map(op => op.refusalCode)).toEqual(['UNKNOWN_TOOL', 'UNKNOWN_TOOL']);
        expect((await updates.list({ userId: B })).updates).toHaveLength(1);
    });

    test('a grant that does not share still offers them, and the report goes only to the person', async () => {
        const { pid, conversationId } = await project({ members: [B] });
        const grant = await delegate({ pid, share: false });
        const { chat } = await askAndRun({ conversationId, grant });
        const [messages, options] = chat.mock.calls[0];
        expect(JSON.stringify(options.functions || options.tools || options)).toMatch(/"name":"lookupNotes"/);
        expect(messages[0].content).toMatch(/goes only to the person who asked/);
    });

    test('work that came from the person\'s own goal stays private whatever the grant says', async () => {
        const { pid } = await project({ members: [B] });
        const grant = await delegate({ pid, sources: [] });
        await db.run(
            `INSERT INTO assistant_initiatives (responsibilityId, responsibilityRevision, ownerUserId, actingUserId, audience, projectId,
                sourceKind, sourceId, sourceRevision, dedupeKey, title, reason, status)
             VALUES (@rid, @rev, @A, @A, 'project', @pid, 'attention_item', '1', 'r1', 'k1', 'Your goal changed', 'x', 'QUEUED')`,
            { rid: grant.id, rev: grant.revision, A, pid }
        );
        script([FINISH]);
        expect((await runner.tick({ wait: true })).results[0]).toMatchObject({ status: 'COMPLETED' });
        expect((await updates.list({ userId: B })).updates).toEqual([]);
        const [mine] = (await updates.list({ userId: A })).updates;
        expect(mine.audience).toEqual({ kind: 'private' });
        expect(mine.summary).toContain(`Kept private: ${audience.REASONS.SOURCE_PRIVATE}`);
    });

    test('a request made in a discussion outside the project stays private', async () => {
        const { pid } = await project({ members: [B] });
        const talk = await discussion();
        const grant = await delegate({ pid, sources: ['project_chat', 'parlor'] });
        await askAndRun({ conversationId: talk, grant, text: 'Goobster, compare Koa and Hono' });
        expect((await updates.list({ userId: B })).updates).toEqual([]);
        const [mine] = (await updates.list({ userId: A })).updates;
        expect(mine).toMatchObject({ audience: { kind: 'private' } });
        expect(mine.summary).toContain('Kept private:');
    });

    test('a run that read private knowledge publishes to the person alone', async () => {
        const { pid } = await project({ members: [B] });
        const grant = await delegate({ pid });
        const initiative = { audience: 'project', source: { kind: 'project_plan' }, origin: null };
        const row = await db.get('SELECT * FROM assistant_responsibilities WHERE id = @id', { id: grant.id });
        const project_ = { id: pid };
        expect(await audience.decide({ initiative, responsibility: row, project: project_ })).toEqual({ requested: true, shared: true });
        expect(await audience.decide({ initiative, responsibility: row, project: project_, privateRead: true }))
            .toEqual({ requested: true, shared: false, code: 'PRIVATE_CONTEXT' });
        // The project's conversation is the project's own; another project's is not.
        const asked = { audience: 'project', source: { kind: 'conversation_request' }, origin: { surface: 'project', audience: { projectId: pid } } };
        expect(await audience.decide({ initiative: asked, responsibility: row, project: project_ })).toMatchObject({ shared: true });
        const other = { ...asked, origin: { surface: 'project', audience: { projectId: pid + 1 } } };
        expect(await audience.decide({ initiative: other, responsibility: row, project: project_ })).toMatchObject({ shared: false, code: 'SOURCE_PRIVATE' });
        const parlorOrigin = { ...asked, origin: { surface: 'parlor', audience: { kind: 'conversation', conversationId: 1 } } };
        expect(await audience.decide({ initiative: parlorOrigin, responsibility: row, project: project_ })).toMatchObject({ shared: false, code: 'SOURCE_PRIVATE' });
    });

    test('what the run changed in the person\'s own knowledge is not named to the project; what it changed in the project is', async () => {
        const { pid, conversationId } = await project({ members: [B] });
        const grant = await delegate({
            pid,
            operations: [
                { operation: 'read', resource: { kind: 'project', ids: [String(pid)] } },
                { operation: 'file.edit', resource: { kind: 'project', ids: [String(pid)] } },
                { operation: 'kg.generated.add', resource: { kind: 'knowledge', ids: ['personal'] } }
            ]
        });
        await askAndRun({
            conversationId, grant,
            rounds: [[
                call('addGeneratedNote', { title: 'Hono notes', content: 'Hono is small. Source: docs.' }),
                call('writeProjectFile', { path: 'docs/frameworks.md', content: '# Frameworks\nHono is small.\n' })
            ], [FINISH]]
        });
        expect(files.get('docs/frameworks.md')).toContain('Hono is small');
        const [shared] = (await updates.list({ userId: B })).updates;
        expect(shared.summary).toContain('Changed:');
        expect(shared.summary).toContain('docs/frameworks.md');
        expect(shared.summary).not.toMatch(/note #|Hono notes/);
        expect(shared.componentIds).not.toContain('knowledge');
        const mine = (await updates.list({ userId: A })).updates.find(update => update.audience.kind === 'private');
        expect(mine.summary).toMatch(/Added as note #/);
        expect(mine.summary).toContain('docs/frameworks.md');
        expect(mine.componentIds).toContain('knowledge');
    });
});

describe('a member who leaves', () => {
    async function shared() {
        const setup = await project({ members: [B, C] });
        const grant = await delegate({ pid: setup.pid });
        await askAndRun({ conversationId: setup.conversationId, grant });
        const [row] = await heldBy(A);
        return { ...setup, updateId: Number(row.id) };
    }
    const receipts = (userId) => db.all('SELECT * FROM assistant_update_receipts WHERE userId = @userId', { userId });

    test('stops receiving its findings at once, and the receipt they held is deleted', async () => {
        const { updateId } = await shared();
        // B read it and C has it delivered.
        await updates.acknowledge({ userId: B, items: [{ id: updateId, revision: 1 }] });
        await updates.markDelivered({ userId: C, id: updateId, revision: 1 });
        expect(await receipts(B)).toHaveLength(1);
        expect((await updates.list({ userId: B })).updates).toHaveLength(1);

        // They leave: it is gone for them in the same breath, and so is the record.
        expect(await projects.removeMember({ userId: B, project: 'lab', owner: A, memberId: B })).toEqual({ left: true });
        expect((await updates.list({ userId: B })).updates).toEqual([]);
        expect((await updates.list({ userId: B })).counts).toMatchObject({ unseen: 0 });
        expect(await receipts(B)).toEqual([]);
        expect(await updates.acknowledge({ userId: B, items: [{ id: updateId, revision: 1 }] }))
            .toEqual({ results: [{ id: updateId, status: 'not_found' }] });

        // The owner removing someone does the same; the others keep theirs.
        expect(await projects.removeMember({ userId: A, project: 'lab', owner: A, memberId: C })).toEqual({ left: false });
        expect(await receipts(C)).toEqual([]);
        expect((await updates.list({ userId: C })).updates).toEqual([]);
        expect((await updates.list({ userId: A })).updates.filter(update => update.audience.kind === 'project')).toHaveLength(1);
        // The finding itself stays with the project.
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_updates WHERE id = @updateId', { updateId })).toEqual({ n: 1 });
    });

    test('coming back later reads it afresh', async () => {
        const { pid, updateId } = await shared();
        await updates.acknowledge({ userId: B, items: [{ id: updateId, revision: 1 }] });
        await projects.removeMember({ userId: B, project: 'lab', owner: A, memberId: B });
        await db.run('INSERT INTO project_members (projectId, userId, userName, invitedBy) VALUES (@pid, @B, \'Bo\', @A)', { pid, B, A });
        const [again] = (await updates.list({ userId: B })).updates;
        expect(again).toMatchObject({ id: updateId, unseen: true, acknowledgedRevision: 0 });
    });

    test('a receipt a removal path missed is swept, with findings whose project is gone', async () => {
        const { pid, updateId } = await shared();
        await updates.acknowledge({ userId: B, items: [{ id: updateId, revision: 1 }] });
        await updates.acknowledge({ userId: A, items: [{ id: updateId, revision: 1 }] });
        // Membership removed behind the service's back.
        await db.run('DELETE FROM project_members WHERE projectId = @pid AND userId = @B', { pid, B });
        expect(await receipts(B)).toHaveLength(1);
        expect((await updates.list({ userId: B })).updates).toEqual([]);
        await updates.prune({});
        expect(await receipts(B)).toEqual([]);
        // Whoever still reads the project keeps theirs.
        expect((await receipts(A)).map(receipt => receipt.updateId)).toContain(updateId);

        await db.run('DELETE FROM observatory_projects WHERE id = @pid', { pid });
        await updates.prune({});
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_updates WHERE audienceKind = \'project\'', {})).toEqual({ n: 0 });
    });

    test('deleting the project takes the findings shared with it, and everyone\'s receipts for them', async () => {
        const { pid, updateId } = await shared();
        await updates.acknowledge({ userId: B, items: [{ id: updateId, revision: 1 }] });
        expect(await updates.forgetProject(pid)).toBe(1);
        expect(await receipts(B)).toEqual([]);
        // Her own notice is hers, not the project's.
        expect((await updates.list({ userId: A })).updates.map(update => update.audience.kind)).toEqual(['private']);
    });

    test('erasing the project\'s owner takes them too', async () => {
        const privacyService = require('@goobster/core/services/privacyService');
        const { updateId } = await shared();
        await updates.acknowledge({ userId: B, items: [{ id: updateId, revision: 1 }] });
        await privacyService.forgetUser({ userId: A });
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_updates WHERE audienceKind = \'project\'', {})).toEqual({ n: 0 });
        expect(await receipts(B)).toEqual([]);
    });
});

describe('the producer', () => {
    test('erased, leaves the finding with the project and no trace of themselves', async () => {
        const privacyService = require('@goobster/core/services/privacyService');
        const { pid, conversationId } = await project({ members: [B] });
        await access.recordDecision({ scope: 'everyone' });
        const grant = await delegate({ userId: B, pid });
        await askAndRun({ userId: B, conversationId, grant });
        const [row] = await heldBy(B);
        await updates.acknowledge({ userId: B, items: [{ id: Number(row.id), revision: 1 }] });

        await privacyService.forgetUser({ userId: B });
        const kept = await db.get('SELECT * FROM assistant_updates WHERE id = @id', { id: row.id });
        expect(kept).toMatchObject({ audienceKind: 'project', projectId: pid, producerUserId: null, responsibilityId: null, initiativeId: null });
        expect(JSON.stringify(kept)).not.toContain(B);
        expect(await db.all('SELECT * FROM assistant_update_receipts WHERE userId = @B', { B })).toEqual([]);
        const [seen] = (await updates.list({ userId: A })).updates;
        expect(seen.producer).toEqual({ name: null, you: false });
    });
});

describe('the owner-only pilot gate', () => {
    const SHARING = { sources: ['project_chat'], audience: 'project' };
    const draft = (userId, pid) => responsibilities.create({
        userId,
        body: { title: 'Share it', projectId: pid, scopes: SHARING, operations: [{ operation: 'read', resource: { kind: 'project', ids: [String(pid)] } }] }
    });

    test('sharing is the owner\'s alone until the host records the pilot decision, then everyone\'s', async () => {
        const { pid } = await project({ members: [B] });
        await policies.enroll({ userId: B, initiative: 'assist' });
        // Not the owner: refused on entry, and nothing was stored.
        await expect(draft(B, pid)).rejects.toMatchObject({ code: 'PILOT_ONLY', status: 409, details: { capability: 'reach' } });
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_responsibilities WHERE ownerUserId = @B', { B })).toEqual({ n: 0 });
        // A responsibility that does not share is not gated.
        await expect(responsibilities.create({
            userId: B, body: { title: 'Private', projectId: pid, scopes: { sources: ['project_chat'] }, operations: [{ operation: 'read', resource: { kind: 'project', ids: [String(pid)] } }] }
        })).resolves.toMatchObject({ created: true });
        // The owner is not asked to wait.
        await expect(draft(A, pid)).resolves.toMatchObject({ created: true });

        await access.recordDecision({ scope: 'everyone' });
        const opened = await draft(B, pid);
        expect(opened.created).toBe(true);

        // Closed again: what was saved can no longer be switched on, or changed to share.
        await access.recordDecision({ scope: 'owner' });
        await expect(responsibilities.act({ userId: B, id: opened.responsibility.id, action: 'activate', expectedRevision: opened.responsibility.revision }))
            .rejects.toMatchObject({ code: 'PILOT_ONLY' });
        const plain = (await responsibilities.list({ userId: B })).responsibilities.find(item => item.title === 'Private');
        await expect(responsibilities.update({ userId: B, id: plain.id, expectedRevision: plain.revision, body: { scopes: SHARING } }))
            .rejects.toMatchObject({ code: 'PILOT_ONLY' });
    });

    test('an operator who was demoted or disabled is not the owner', async () => {
        const { pid } = await project({ members: [B] });
        await db.run("UPDATE app_accounts SET role = 'member' WHERE principalId = @A", { A });
        await expect(draft(A, pid)).rejects.toMatchObject({ code: 'PILOT_ONLY' });
    });

    test('closed after the work was proposed, a finding comes to the person alone, with the reason', async () => {
        const { pid, conversationId } = await project({ members: [B] });
        await access.recordDecision({ scope: 'everyone' });
        const grant = await delegate({ userId: B, pid });
        await look(grant);
        await say(B, conversationId, 'Goobster, compare Fastify and Hono for our API');
        const [id] = (await lookLater(grant)).proposed;
        await queue(B, id);
        await access.recordDecision({ scope: 'owner' });
        script([FINISH]);
        expect((await runner.tick({ wait: true })).results[0]).toMatchObject({ status: 'COMPLETED', outcome: 'DONE' });

        expect(await heldBy(B)).toEqual([]);
        expect((await updates.list({ userId: A })).updates).toEqual([]);
        const [mine] = (await updates.list({ userId: B })).updates;
        expect(mine).toMatchObject({ audience: { kind: 'private' }, title: 'Fastify and Hono compared' });
        expect(mine.summary).toContain(`Kept private: ${audience.REASONS.PILOT_ONLY}`);
        // The ordinary case reported nothing it had not found: the reason is the only addition.
        expect(mine.summary).toContain('Hono is smaller');
    });
});

describe('a person who stopped reading the project mid-run', () => {
    test('has the finding kept private with the reason, and shares nothing', async () => {
        const { pid, conversationId } = await project({ members: [B] });
        await access.recordDecision({ scope: 'everyone' });
        const grant = await delegate({ userId: B, pid });
        await askAndRun({
            userId: B, conversationId, grant,
            rounds: [async () => {
                await db.run('DELETE FROM project_members WHERE projectId = @pid AND userId = @B', { pid, B });
                return [FINISH];
            }]
        });
        expect(await heldBy(B)).toEqual([]);
        const [mine] = (await updates.list({ userId: B })).updates;
        expect(mine.audience).toEqual({ kind: 'private' });
        expect(mine.summary).toContain(`Kept private: ${audience.REASONS.NOT_MEMBER}`);
    });
});

describe('what a member sees', () => {
    test('another member\'s assistant is named, nothing of the producer\'s records is linked, and the briefing carries it', async () => {
        const { pid } = await project({ members: [B] });
        await updates.publish({
            audience: { projectId: pid }, identityKey: 'initiative:99', kind: 'finding', title: 'Shared result', summary: 'Found it.',
            components: ['projects'], producerUserId: A, responsibilityId: 5, initiativeId: 99,
            actions: [{ kind: 'open_initiative', id: '99' }, { kind: 'open_project', id: `${A}/lab` }]
        });
        const home = await require('@goobster/core/services/assistantHomeService').project({ userId: B });
        const [item] = home.brief;
        expect(item).toMatchObject({
            title: 'Shared result', audience: { kind: 'project', projectId: pid }, producer: { name: 'Ada', you: false },
            responsibilityId: null, initiativeId: null, actions: [{ kind: 'open_project', id: `${A}/lab` }]
        });
        // The producer's own view keeps its links.
        const own = (await updates.list({ userId: A })).updates[0];
        expect(own).toMatchObject({ producer: { name: 'Ada', you: true }, responsibilityId: 5, initiativeId: 99 });
        expect(own.actions.map(action => action.kind)).toEqual(['open_initiative', 'open_project']);
    });

    test('the tool table still has no way to share by itself', () => {
        // Sharing is the run service's decision at publication, never a tool the model calls.
        expect(Object.keys(runs.TOOLS).join(' ')).not.toMatch(/share|publish|audience|project(Finding|Update)/i);
    });
});
