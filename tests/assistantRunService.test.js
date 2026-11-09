/**
 * Delegated runs (DA-3, ADR 0018) against a throwaway database, with a
 * scripted model and fake tool backends (no provider, no network).
 *
 * The properties under test: only what a person queued is run; every tool
 * call is checked against the grant and an uncovered one is refused, not
 * attempted; a revoked or paused grant stops the run and no result is
 * written; a resumed run replays its journal instead of repeating work; a
 * write left in flight is never retried; budgets are hard caps with a
 * default when unset; the limits on concurrent work hold; and erasure
 * removes runs and their journals.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-run-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const perplexity = require('@goobster/core/services/perplexityService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runs = require('@goobster/core/services/assistantRunService');
const runner = require('@goobster/core/services/assistantRunnerService');
const updates = require('@goobster/core/services/assistantUpdateService');
const policies = require('@goobster/core/services/attentionPolicyService');
const privacyService = require('@goobster/core/services/privacyService');
const { useState } = require('./helpers/featureFixtures');

const A = '750000000000000001';
const B = '750000000000000002';
const C = '750000000000000003';
const READ_WEB = { operation: 'read', resource: { kind: 'web' } };
const READ_NOTES = { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } };

afterAll(async () => {
    initiatives.stopListening();
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

let search;
let lookup;
beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    runner._reset();
    for (const table of [
        'assistant_run_operations', 'assistant_runs', 'assistant_initiatives', 'assistant_source_cursors',
        'assistant_update_receipts', 'assistant_updates', 'assistant_responsibility_revisions', 'assistant_responsibilities',
        'attention_policies', 'attention_items', 'inbox_items', 'usage_reservations', 'work_failures',
        'kg_nodes', 'observatory_jobs', 'project_members', 'observatory_projects'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    search = jest.spyOn(perplexity, 'search').mockImplementation(async (query) => `results for ${query}`);
    const realExecute = toolsRegistry.execute.bind(toolsRegistry);
    lookup = jest.fn(async () => 'a note about beans');
    jest.spyOn(toolsRegistry, 'execute').mockImplementation(async (name, args) => (
        name === 'lookupNotes' ? lookup(args) : realExecute(name, args)
    ));
});

let callId = 0;
let goalSeq = 0;
const call = (name, args = {}) => ({ id: `c${++callId}`, name, arguments: JSON.stringify(args) });
/** Script the model: each entry is one round's tool calls, or a final text. */
function script(...rounds) {
    const queue = [...rounds];
    return jest.spyOn(aiService, 'chat').mockImplementation(async () => {
        const next = queue.shift();
        if (next === undefined) return { content: 'Nothing more.', toolCalls: [] };
        if (next instanceof Error) throw next;
        return typeof next === 'string' ? { content: next, toolCalls: [] } : { content: '', toolCalls: next };
    });
}

async function queued({ userId = A, operations = [READ_WEB, READ_NOTES], budgets = undefined } = {}) {
    await policies.enroll({ userId, initiative: 'assist' });
    const item = await db.insert(
        `INSERT INTO attention_items (guildId, userId, kind, subject, goal, state)
         VALUES (@guildId, @userId, 'goal', @subject, 'Finish the garden plan', 'active')`,
        { guildId: `dm:${userId}`, userId, subject: `garden-${++goalSeq}` }
    );
    const { responsibility } = await responsibilities.create({
        userId, body: { title: 'Keep the garden plan moving', operations, attentionItemId: item, ...(budgets ? { budgets } : {}) }
    });
    const grant = (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
    await db.run("UPDATE attention_items SET goal = 'Finish the garden plan before the frost' WHERE id = @id", { id: item });
    const [id] = (await initiatives.reconcileResponsibility(grant.id)).proposed;
    const row = await initiatives.get({ userId, id });
    const initiative = (await initiatives.act({ userId, id, action: 'queue', expectedRevision: row.revision })).initiative;
    return { grant, initiative };
}

const operations = () => db.all('SELECT tool, status, refusalCode, seq, resultText FROM assistant_run_operations ORDER BY id', {});
const initiativeRow = (id) => db.get('SELECT * FROM assistant_initiatives WHERE id = @id', { id });
const runRow = () => db.get('SELECT * FROM assistant_runs', {});

describe('a run', () => {
    test('does the work within the grant and files one finding', async () => {
        const { initiative } = await queued();
        script(
            [call('lookupNotes', { query: 'frost dates' }), call('searchWeb', { query: 'first frost date' })],
            [call('finish', { outcome: 'finding', title: 'Frost is expected on the 14th', summary: 'Two sources agree. Your plan ends on the 20th.' })]
        );
        const result = await runner.tick({ wait: true });
        expect(result).toMatchObject({ started: 1 });
        expect(result.results[0]).toMatchObject({ status: 'COMPLETED', outcome: 'DONE' });

        expect(await initiativeRow(initiative.id)).toMatchObject({ status: 'COMPLETED', outcome: 'DONE', leaseToken: null });
        expect(await runRow()).toMatchObject({
            status: 'COMPLETED', outcome: 'DONE', searches: 1, resultTitle: 'Frost is expected on the 14th', actingUserId: A, payerUserId: A
        });
        expect((await operations()).map(op => `${op.tool}:${op.status}`)).toEqual(['lookupNotes:SUCCEEDED', 'searchWeb:SUCCEEDED', 'finish:SUCCEEDED']);
        // The tools ran as the person, in their private scope.
        expect(lookup.mock.calls[0][0].interactionContext.user.id).toBe(A);

        const listed = await updates.list({ userId: A });
        expect(listed.updates).toHaveLength(1);
        expect(listed.updates[0]).toMatchObject({
            title: 'Frost is expected on the 14th', kind: 'finding', componentIds: ['research'], initiativeId: initiative.id, unseen: true, needsAction: false
        });
        expect(listed.updates[0].inboxItemId).toBeTruthy();
        // Model calls were background work attributed to the person.
        expect(aiService.chat.mock.calls[0][1]).toMatchObject({ background: true, usageContext: { userId: A } });
    });

    test('"nothing needs your attention" completes without an update and sets a recheck', async () => {
        const { initiative } = await queued();
        script([call('finish', { outcome: 'no_change', title: 'Nothing changed' })]);
        await runner.tick({ wait: true });
        const row = await initiativeRow(initiative.id);
        expect(row).toMatchObject({ status: 'COMPLETED', outcome: 'NO_CHANGE' });
        expect(row.recheckAfter).toBeTruthy();
        expect((await updates.list({ userId: A })).updates).toEqual([]);
    });

    test('a proposed initiative is never run until its owner queues it', async () => {
        const { initiative } = await queued();
        await db.run("UPDATE assistant_initiatives SET status = 'CANDIDATE' WHERE id = @id", { id: initiative.id });
        const chat = script('should not be called');
        expect(await runner.tick({ wait: true })).toMatchObject({ started: 0 });
        expect(chat).not.toHaveBeenCalled();
    });
});

describe('authority at every tool call', () => {
    test('a tool the grant does not cover is refused and not attempted', async () => {
        await queued({ operations: [READ_NOTES] });
        script(
            [call('searchWeb', { query: 'frost' }), call('readProjectFile', { path: 'plan.md' }), call('runCode', { code: 'rm -rf /' })],
            [call('finish', { outcome: 'finding', title: 'Could only read notes', summary: 'Web search is not delegated.' })]
        );
        const { results } = await runner.tick({ wait: true });
        expect(results[0].status).toBe('COMPLETED');
        expect(search).not.toHaveBeenCalled();
        const ops = await operations();
        expect(ops.find(op => op.tool === 'searchWeb')).toMatchObject({ status: 'REFUSED', refusalCode: 'OPERATION_OUT_OF_SCOPE' });
        // A tool that is not on the run's list never reaches the registry.
        expect(ops.find(op => op.tool === 'runCode')).toMatchObject({ status: 'REFUSED', refusalCode: 'UNKNOWN_TOOL' });
        expect(ops.find(op => op.tool === 'readProjectFile')).toMatchObject({ status: 'REFUSED' });
        expect(toolsRegistry.execute.mock.calls.map(c => c[0])).not.toContain('runCode');
    });

    test('revoking mid-run stops it at the next tool call and no result is written', async () => {
        const { grant, initiative } = await queued();
        script(
            [call('lookupNotes', { query: 'frost' })],
            [call('searchWeb', { query: 'frost' })],
            [call('finish', { outcome: 'finding', title: 'Should never be filed' })]
        );
        lookup.mockImplementation(async () => {
            const current = await responsibilities.get({ userId: A, id: grant.id });
            await responsibilities.act({ userId: A, id: grant.id, action: 'revoke', expectedRevision: current.revision });
            return 'a note';
        });
        const { results } = await runner.tick({ wait: true });
        expect(results[0]).toMatchObject({ status: 'CANCELLED', stopCode: 'LEASE_LOST' });
        expect(search).not.toHaveBeenCalled();
        expect((await initiativeRow(initiative.id)).status).toBe('CANCELLED');
        expect(await runRow()).toMatchObject({ status: 'CANCELLED', resultTitle: null });
        expect((await updates.list({ userId: A })).updates).toEqual([]);
    });

    test('pausing parks the run; it does not finish under a paused grant', async () => {
        const { grant, initiative } = await queued();
        script([call('lookupNotes', { query: 'frost' })], [call('searchWeb', { query: 'frost' })], 'done anyway');
        lookup.mockImplementation(async () => {
            const current = await responsibilities.get({ userId: A, id: grant.id });
            await responsibilities.act({ userId: A, id: grant.id, action: 'pause', expectedRevision: current.revision });
            return 'a note';
        });
        const { results } = await runner.tick({ wait: true });
        expect(results[0].status).toBe('CANCELLED');
        expect((await initiativeRow(initiative.id)).status).toBe('WAITING');
        expect(search).not.toHaveBeenCalled();
        expect((await updates.list({ userId: A })).updates).toEqual([]);
    });
});

describe('recovery', () => {
    test('a resumed run replays finished calls from its journal instead of repeating them', async () => {
        const { initiative } = await queued();
        // First worker: does one search, then dies before settling.
        script([call('searchWeb', { query: 'first frost date' })], new Error('worker died'));
        const first = await initiatives.claim({ id: initiative.id });
        jest.spyOn(initiatives, 'settle').mockResolvedValueOnce({ ok: false, code: 'LEASE_LOST' });
        await runs.execute({ initiative: first.initiative, leaseToken: first.leaseToken });
        expect(search).toHaveBeenCalledTimes(1);
        jest.restoreAllMocks();
        search = jest.spyOn(perplexity, 'search').mockImplementation(async () => 'DIFFERENT results');

        // The lease lapses; the steward returns it to QUEUED; a worker resumes.
        await db.run("UPDATE assistant_initiatives SET leaseExpiresAt = '2000-01-01 00:00:00' WHERE id = @id", { id: initiative.id });
        expect(await initiatives.reapExpiredLeases()).toBe(1);
        const seenByModel = [];
        jest.spyOn(aiService, 'chat').mockImplementation(async (messages) => {
            const toolResults = messages.filter(m => m.role === 'tool' || m.role === 'function').map(m => String(m.content));
            seenByModel.push(toolResults);
            if (toolResults.length === 0) return { content: '', toolCalls: [call('searchWeb', { query: 'first frost date' })] };
            return { content: '', toolCalls: [call('finish', { outcome: 'finding', title: 'Frost on the 14th' })] };
        });
        const { results } = await runner.tick({ wait: true });
        expect(results[0]).toMatchObject({ status: 'COMPLETED' });
        // The search was not made again, and the model saw the original result.
        expect(search).not.toHaveBeenCalled();
        expect(JSON.stringify(seenByModel)).toContain('results for first frost date');
        expect(await runRow()).toMatchObject({ attempt: 2, searches: 1, status: 'COMPLETED' });
        expect((await operations()).filter(op => op.tool === 'searchWeb')).toHaveLength(1);
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_runs', {})).toMatchObject({ n: 1 });
    });

    test('a write left in flight is never retried: the run stops for review', async () => {
        const { initiative } = await queued();
        runs.TOOLS.testWrite = {
            effect: 'write',
            definition: { name: 'testWrite', description: 'test', parameters: { type: 'object', properties: {} } },
            needs: () => null,
            run: jest.fn(async () => 'written')
        };
        try {
            const claimed = await initiatives.claim({ id: initiative.id });
            const runId = await db.insert(
                `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId)
                 VALUES (@i, @r, @rev, @u, @u, @u)`,
                { i: initiative.id, r: initiative.responsibilityId, rev: claimed.initiative.responsibilityRevision, u: A }
            );
            await db.run(
                `INSERT INTO assistant_run_operations (runId, ownerUserId, tool, argsHash, seq, effect, status)
                 VALUES (@runId, @u, 'testWrite', @hash, 1, 'write', 'DISPATCHED')`,
                { runId, u: A, hash: runs.argsHash({}) }
            );
            script([call('testWrite', {})], 'carried on');
            const result = await runs.execute({ initiative: claimed.initiative, leaseToken: claimed.leaseToken });
            expect(result).toMatchObject({ status: 'REVIEW', stopCode: 'OPERATION_UNCERTAIN' });
            expect(runs.TOOLS.testWrite.run).not.toHaveBeenCalled();
            expect((await operations())[0]).toMatchObject({ tool: 'testWrite', status: 'UNCERTAIN' });
            expect((await initiativeRow(initiative.id)).status).toBe('REVIEW');
        } finally {
            delete runs.TOOLS.testWrite;
        }
    });

    test('a provider failure fails the attempt with a code and files nothing', async () => {
        const { initiative } = await queued();
        script(new Error('upstream exploded with private details'));
        const { results } = await runner.tick({ wait: true });
        expect(results[0]).toMatchObject({ status: 'FAILED', stopCode: 'PROVIDER_ERROR' });
        expect(await initiativeRow(initiative.id)).toMatchObject({ status: 'FAILED', stopCode: 'PROVIDER_ERROR' });
        const failures = await db.all('SELECT kind, code, reason FROM work_failures', {});
        expect(failures).toEqual([expect.objectContaining({ kind: 'assistant_run', code: 'PROVIDER_ERROR' })]);
        expect(JSON.stringify(failures)).not.toContain('private details');
    });
});

describe('budgets', () => {
    test('the search budget is a hard cap, with a default when the grant sets none', async () => {
        expect(runs.budgets({ budgetsJson: '{}' })).toEqual({ modelTokens: 200000, searches: 20, computeSeconds: 120 });
        expect(runs.budgets({ budgetsJson: '{"searches":0,"modelTokens":5}' })).toEqual({ modelTokens: 5, searches: 0, computeSeconds: 120 });
        await queued({ budgets: { searches: 1 } });
        script(
            [call('searchWeb', { query: 'one' }), call('searchWeb', { query: 'two' })],
            [call('finish', { outcome: 'finding', title: 'One search was enough' })]
        );
        await runner.tick({ wait: true });
        expect(search).toHaveBeenCalledTimes(1);
        const ops = await operations();
        expect(ops.filter(op => op.tool === 'searchWeb').map(op => op.status)).toEqual(['SUCCEEDED', 'REFUSED']);
        expect(ops[1].refusalCode).toBe('SEARCH_BUDGET');
    });

    test('an exhausted token budget parks the run until the window resets; nothing is spent', async () => {
        const { initiative } = await queued({ budgets: { modelTokens: 1000 } });
        const other = await db.insert(
            `INSERT INTO assistant_initiatives (responsibilityId, responsibilityRevision, ownerUserId, sourceKind, sourceId, sourceRevision, dedupeKey, title, status)
             VALUES (@r, 1, @u, 'attention_item', '9', 'x', 'earlier', 'Earlier work', 'COMPLETED')`,
            { r: initiative.responsibilityId, u: A }
        );
        await db.run(
            `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, status, tokensUsed)
             VALUES (@i, @r, 1, @u, 'COMPLETED', 1000)`,
            { i: other, r: initiative.responsibilityId, u: A }
        );
        const chat = script('should not be called');
        const { results } = await runner.tick({ wait: true });
        expect(results[0]).toMatchObject({ status: 'WAITING', stopCode: 'TOKEN_BUDGET' });
        expect(chat).not.toHaveBeenCalled();
        const row = await initiativeRow(initiative.id);
        expect(row).toMatchObject({ status: 'WAITING', waitReason: 'budget' });
        expect(row.recheckAfter).toBeTruthy();

        // It does not poll: it comes back only when the recheck time passes.
        expect(await initiatives.requeueDue({ now: new Date() })).toBe(0);
        expect(await initiatives.requeueDue({ now: new Date(Date.now() + 2 * 86400000) })).toBe(1);
        expect((await initiativeRow(initiative.id)).status).toBe('QUEUED');
    });

    test('tokens the run reserved count against the cap while it works', async () => {
        await queued({ budgets: { modelTokens: 500 } });
        script([call('lookupNotes', { query: 'a' })], [call('lookupNotes', { query: 'b' })], 'never reached');
        lookup.mockImplementation(async () => {
            const run = await runRow();
            await db.run(
                `INSERT INTO usage_reservations (payer, workKind, workId, estimatedTokens, actualTokens, status)
                 VALUES (@u, 'assistant_run', @id, 600, 600, 'settled')`,
                { u: A, id: String(run.id) }
            );
            return 'note';
        });
        const { results } = await runner.tick({ wait: true });
        expect(results[0]).toMatchObject({ status: 'WAITING', stopCode: 'TOKEN_BUDGET' });
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(await runRow()).toMatchObject({ status: 'WAITING', tokensUsed: 600 });
    });
});

describe('generated notes', () => {
    const kg = require('@goobster/core/services/knowledgeGraphService');
    const NOTES = [
        READ_NOTES,
        { operation: 'kg.generated.add', resource: { kind: 'knowledge', ids: ['personal'] } },
        { operation: 'kg.generated.amend', resource: { kind: 'knowledge', ids: ['personal'] } }
    ];
    const scope = `dm:${A}`;
    const notes = () => db.all("SELECT id, label, content, generated, curation, revision FROM kg_nodes WHERE scopeKey = @s ORDER BY id", { s: `USER:${A}` });

    test('a run adds a generated note, the person is told, and the note is not "saved"', async () => {
        await queued({ operations: NOTES });
        script(
            [call('addGeneratedNote', { title: 'First frost date', content: 'Around the 14th (two almanacs).' })],
            [call('finish', { outcome: 'no_change', title: 'Nothing to report' })]
        );
        const { results } = await runner.tick({ wait: true });
        // A change was made, so there is always an update, whatever the model reported.
        expect(results[0]).toMatchObject({ status: 'COMPLETED', outcome: 'DONE' });
        expect(await notes()).toEqual([expect.objectContaining({ label: 'First frost date', generated: 1, curation: 'unclassified', revision: 1 })]);
        const [update] = (await updates.list({ userId: A })).updates;
        expect(update.componentIds).toEqual(['knowledge', 'research']);
        expect(update.summary).toContain('Changed: Added as note #');
    });

    test('without the grant the note is not written', async () => {
        await queued({ operations: [READ_NOTES] });
        script([call('addGeneratedNote', { title: 'T', content: 'c' })], [call('finish', { outcome: 'no_change', title: 'x' })]);
        await runner.tick({ wait: true });
        expect(await notes()).toEqual([]);
        expect((await operations())[0]).toMatchObject({ tool: 'addGeneratedNote', status: 'REFUSED', refusalCode: 'OPERATION_OUT_OF_SCOPE' });
    });

    test('it never overwrites an existing note, and a note the person edited is theirs', async () => {
        const saved = await kg.createUserNote({ guildId: scope, userId: A, label: 'Beans', content: 'My own words.' });
        const generated = await kg.addGeneratedNote({ guildId: scope, userId: A, label: 'Frost', content: 'v1' });
        await queued({ operations: NOTES });
        script(
            [call('addGeneratedNote', { title: 'Beans', content: 'Replaced!' }),
                call('amendGeneratedNote', { id: saved.id, revision: 1, content: 'Replaced!' }),
                call('amendGeneratedNote', { id: generated.id, revision: 7, content: 'stale' }),
                call('amendGeneratedNote', { id: generated.id, revision: 1, content: 'v2, corrected' })],
            [call('finish', { outcome: 'finding', title: 'Updated the frost note' })]
        );
        await runner.tick({ wait: true });
        const rows = await notes();
        expect(rows.find(n => n.label === 'Beans')).toMatchObject({ content: 'My own words.', curation: 'saved' });
        expect(rows.find(n => n.label === 'Frost')).toMatchObject({ content: 'v2, corrected', revision: 2, generated: 1 });
        const results = (await operations()).map(op => op.resultText);
        expect(results[0]).toMatch(/already exists/);
        expect(results[1]).toMatch(/is theirs/);
        expect(results[2]).toMatch(/changed since you read it/);
        // The earlier wording is kept in the note's history.
        expect((await kg.listNodeRevisions(generated.id)).map(r => r.content)).toEqual(expect.arrayContaining(['v1']));

        // Once the person edits it, a later run cannot amend it.
        await kg.updateUserNote({ guildId: scope, userId: A, nodeId: generated.id, content: 'my edit' });
        expect(await kg.amendGeneratedNote({ guildId: scope, userId: A, nodeId: generated.id, content: 'x', expectedRevision: 3 }))
            .toMatchObject({ ok: false, code: 'NOT_GENERATED' });
    });

    test('a note write that did not commit is retried safely; one that did is not repeated', async () => {
        const { initiative } = await queued({ operations: NOTES });
        const claimed = await initiatives.claim({ id: initiative.id });
        const runId = await db.insert(
            `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId)
             VALUES (@i, @r, @rev, @u, @u, @u)`,
            { i: initiative.id, r: initiative.responsibilityId, rev: claimed.initiative.responsibilityRevision, u: A }
        );
        const args = { title: 'Frost', content: 'the 14th' };
        // The worker died after journaling the intent, before the transaction.
        await db.run(
            `INSERT INTO assistant_run_operations (runId, ownerUserId, tool, argsHash, seq, effect, status)
             VALUES (@runId, @u, 'addGeneratedNote', @hash, 1, 'write', 'DISPATCHED')`,
            { runId, u: A, hash: runs.argsHash(args) }
        );
        script([call('addGeneratedNote', args)], [call('finish', { outcome: 'finding', title: 'Noted' })]);
        const result = await runs.execute({ initiative: claimed.initiative, leaseToken: claimed.leaseToken });
        expect(result.status).toBe('COMPLETED');
        expect(await notes()).toHaveLength(1);
        expect((await operations()).filter(op => op.tool === 'addGeneratedNote')).toEqual([expect.objectContaining({ status: 'SUCCEEDED' })]);
    });

    test('pruning never deletes a note the person saved, however weak it scores', async () => {
        const scopeKey = `USER:${A}`;
        const config = require('@goobster/core/config/knowledgeGraphConfig');
        await kg.createUserNote({ guildId: scope, userId: A, label: 'Saved and weak', content: 'mine' });
        await kg.addGeneratedNote({ guildId: scope, userId: A, label: 'Generated and weak', content: 'not mine' });
        await db.run('UPDATE kg_nodes SET salience = 0.01, confidence = 0.01 WHERE scopeKey = @s', { s: scopeKey });
        await db.run('DELETE FROM kg_provenance', {});
        // Fill the scope past its cap with stronger unsaved notes.
        for (let i = 0; i < config.MAX_NODES_USER + 5; i += 1) {
            await db.run(
                `INSERT INTO kg_nodes (guildId, scopeKey, label, content, salience, confidence, curation)
                 VALUES (@g, @s, @label, 'filler', 0.9, 0.9, 'unclassified')`,
                { g: scope, s: scopeKey, label: `filler ${i}` }
            );
        }
        await kg.pruneScope(scope, scopeKey);
        const left = await db.all('SELECT label FROM kg_nodes WHERE scopeKey = @s AND label LIKE @p', { s: scopeKey, p: '% and weak' });
        expect(left.map(row => row.label)).toEqual(['Saved and weak']);

        // At capacity an addition is refused; nothing is evicted to make room.
        const before = (await db.get('SELECT COUNT(*) AS n FROM kg_nodes WHERE scopeKey = @s', { s: scopeKey })).n;
        expect(await kg.addGeneratedNote({ guildId: scope, userId: A, label: 'One more', content: 'x' })).toEqual({ ok: false, code: 'CAPACITY' });
        expect((await db.get('SELECT COUNT(*) AS n FROM kg_nodes WHERE scopeKey = @s', { s: scopeKey })).n).toBe(before);
    }, 60000);
});

describe('project files and sandbox runs', () => {
    const projects = require('@goobster/core/services/projectService');
    let files;
    let pid;
    const PROJECT_OPS = () => [
        { operation: 'read', resource: { kind: 'project', ids: [String(pid)] } },
        { operation: 'file.edit', resource: { kind: 'project', ids: [String(pid)], paths: ['docs'] } },
        { operation: 'sandbox.run', resource: { kind: 'project', ids: [String(pid)] } }
    ];

    async function linked(extra = {}) {
        pid = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'garden', 'Garden')", { u: A });
        const made = await queued({ operations: PROJECT_OPS(), ...extra });
        await db.run('UPDATE assistant_responsibilities SET projectId = @pid WHERE id = @id', { pid, id: made.grant.id });
        return made;
    }

    beforeEach(() => {
        files = new Map([['docs/plan.md', 'old plan']]);
        const notFound = () => Object.assign(new Error('No such file.'), { code: 'NOT_FOUND', status: 404 });
        jest.spyOn(projects, 'readWorkspaceFile').mockImplementation(async ({ relativePath }) => {
            if (!files.has(relativePath)) throw notFound();
            const bytes = Buffer.from(files.get(relativePath));
            return { relativePath, name: relativePath, mime: 'text/markdown', bytes, size: bytes.length };
        });
        jest.spyOn(projects, 'writeWorkspaceFile').mockImplementation(async ({ relativePath, bytes }) => {
            files.set(relativePath, bytes.toString('utf8'));
            return { relativePath };
        });
    });

    test('an existing file must be read first, and only granted folders can be written', async () => {
        await linked();
        script(
            [call('writeProjectFile', { path: 'docs/plan.md', content: 'blind overwrite' }),
                call('writeProjectFile', { path: 'src/app.js', content: 'outside the grant' })],
            [call('readProjectFile', { path: 'docs/plan.md' })],
            [call('writeProjectFile', { path: 'docs/plan.md', content: 'new plan' }),
                call('writeProjectFile', { path: 'docs/new.md', content: 'a new file' })],
            [call('finish', { outcome: 'finding', title: 'Updated the plan' })]
        );
        await runner.tick({ wait: true });
        const ops = await operations();
        expect(ops[0].resultText).toMatch(/Read it with readProjectFile first/);
        expect(ops[1]).toMatchObject({ status: 'REFUSED', refusalCode: 'OPERATION_OUT_OF_SCOPE' });
        expect(files.get('docs/plan.md')).toBe('new plan');
        expect(files.get('docs/new.md')).toBe('a new file');
        expect(files.has('src/app.js')).toBe(false);
        const [update] = (await updates.list({ userId: A })).updates;
        expect(update.componentIds).toEqual(['projects', 'research']);
        expect(update.summary).toContain('Wrote docs/plan.md.');
        // Written as the person, in their project.
        expect(projects.writeWorkspaceFile.mock.calls[0][0]).toMatchObject({ userId: A, slug: 'garden', owner: A });
    });

    test('a file the person changed after it was read is not overwritten', async () => {
        await linked();
        script(
            [call('readProjectFile', { path: 'docs/plan.md' })],
            [call('writeProjectFile', { path: 'docs/plan.md', content: 'stale write' })],
            [call('finish', { outcome: 'finding', title: 'Could not update' })]
        );
        projects.readWorkspaceFile.mockImplementationOnce(async ({ relativePath }) => {
            const bytes = Buffer.from('old plan');
            files.set('docs/plan.md', 'the person edited this meanwhile');
            return { relativePath, name: relativePath, mime: 'text/markdown', bytes, size: bytes.length };
        });
        await runner.tick({ wait: true });
        expect(files.get('docs/plan.md')).toBe('the person edited this meanwhile');
        expect((await operations())[1].resultText).toMatch(/changed since you read it/);
    });

    test('after a crash a write is reconciled by content: done if it landed, review if unsure', async () => {
        const { initiative } = await linked();
        const claimed = await initiatives.claim({ id: initiative.id });
        const runId = await db.insert(
            `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId)
             VALUES (@i, @r, @rev, @u, @u, @u)`,
            { i: initiative.id, r: initiative.responsibilityId, rev: claimed.initiative.responsibilityRevision, u: A }
        );
        const landed = { path: 'docs/a.md', content: 'landed' };
        const unsure = { path: 'docs/b.md', content: 'maybe' };
        for (const args of [landed, unsure]) {
            await db.run(
                `INSERT INTO assistant_run_operations (runId, ownerUserId, tool, argsHash, seq, effect, status)
                 VALUES (@runId, @u, 'writeProjectFile', @hash, 1, 'write', 'DISPATCHED')`,
                { runId, u: A, hash: runs.argsHash(args) }
            );
        }
        files.set('docs/a.md', 'landed');
        files.set('docs/b.md', 'something else');
        script([call('writeProjectFile', landed)], [call('writeProjectFile', unsure)], 'carried on');
        const result = await runs.execute({ initiative: claimed.initiative, leaseToken: claimed.leaseToken });
        expect(result).toMatchObject({ status: 'REVIEW', stopCode: 'OPERATION_UNCERTAIN' });
        expect(projects.writeWorkspaceFile).not.toHaveBeenCalled();
        expect((await operations()).map(op => op.status)).toEqual(['SUCCEEDED', 'UNCERTAIN']);
        expect(files.get('docs/b.md')).toBe('something else');
    });

    test('a sandbox run is authorized, attributed, budgeted, and adopted after a crash instead of run twice', async () => {
        const { initiative } = await linked({ budgets: { computeSeconds: 1 } });
        const runFile = jest.spyOn(projects, 'runFile').mockImplementation(async () => ({ jobId: 41, result: { ok: true, exitCode: 0, stdout: 'ran', stderr: '' } }));
        script(
            [call('runProjectFile', { path: 'tools/sim.py', args: ['--days', '3'] })],
            [call('runProjectFile', { path: 'tools/sim.py', args: ['--days', '9'] })],
            [call('finish', { outcome: 'finding', title: 'Simulated' })]
        );
        await runner.tick({ wait: true });
        expect(runFile).toHaveBeenCalledTimes(1);
        const sent = runFile.mock.calls[0][0];
        expect(sent).toMatchObject({ userId: A, project: 'garden', owner: A, path: 'tools/sim.py', args: ['--days', '3'], background: false, startedBy: 'assistant' });
        expect(sent.executionAttemptId).toMatch(/^assistant_run:\d+:\d+$/);
        const ops = await operations();
        expect(ops[1]).toMatchObject({ tool: 'runProjectFile', status: 'REFUSED', refusalCode: 'COMPUTE_BUDGET' });
        expect((await runRow()).computeSeconds).toBeGreaterThanOrEqual(1);

        // A second attempt of the same initiative, crashed mid-run: the job row decides.
        const retried = (await initiatives.act({ userId: A, id: initiative.id, action: 'retry' }).catch(() => null));
        expect(retried).toBeNull();
        const op = await db.get("SELECT id, runId FROM assistant_run_operations WHERE tool = 'runProjectFile' AND status = 'SUCCEEDED'", {});
        await db.run("UPDATE assistant_run_operations SET status = 'DISPATCHED', resultText = NULL WHERE id = @id", { id: op.id });
        await db.run(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status, exitCode, executionAttemptId)
             VALUES (@pid, @u, 'python', 'x', 'COMPLETED', 0, @attempt)`,
            { pid, u: A, attempt: `assistant_run:${op.runId}:${op.id}` }
        );
        const tool = runs.TOOLS.runProjectFile;
        expect(await tool.reconcile({}, { run: { id: op.runId }, opId: op.id })).toMatchObject({ state: 'done' });
        expect(await tool.reconcile({}, { run: { id: op.runId }, opId: 999999 })).toEqual({ state: 'absent' });
    });
});

describe('the runner\'s limits', () => {
    test('one running initiative per person and two across the installation', async () => {
        const hold = [];
        jest.spyOn(runs, 'execute').mockImplementation(() => new Promise((resolve) => hold.push(() => resolve({ status: 'COMPLETED' }))));
        await queued({ userId: A });
        const second = await queued({ userId: A });
        await queued({ userId: B });
        await queued({ userId: C });
        expect(await runner.tick()).toMatchObject({ started: 2 });
        const running = await db.all("SELECT ownerUserId FROM assistant_initiatives WHERE status = 'RUNNING' ORDER BY ownerUserId", {});
        expect(running.map(row => row.ownerUserId)).toEqual([A, B]);
        expect((await initiativeRow(second.initiative.id)).status).toBe('QUEUED');
        expect(await runner.tick()).toMatchObject({ skipped: 'capacity', started: 0 });
        hold.forEach(release => release());
        await runner.stop();
    });

    test('a stopping runner claims nothing, and nothing runs with the feature off', async () => {
        await queued();
        const chat = script('no');
        await runner.stop();
        expect(await runner.tick({ wait: true })).toMatchObject({ skipped: 'stopping' });
        runner._reset();
        useState({ inactive: ['assistant'] });
        expect(await runner.tick({ wait: true })).toMatchObject({ skipped: 'feature' });
        expect(chat).not.toHaveBeenCalled();
    });
});

describe('privacy', () => {
    test('the owner sees the run without retrieved text; another person sees nothing; erasure removes it', async () => {
        const { initiative } = await queued();
        script([call('searchWeb', { query: 'frost' })], [call('finish', { outcome: 'finding', title: 'Frost on the 14th' })]);
        await runner.tick({ wait: true });
        const mine = await runs.forInitiative({ userId: A, initiativeId: initiative.id });
        expect(mine).toMatchObject({ status: 'COMPLETED', resultTitle: 'Frost on the 14th' });
        expect(mine.operations.map(op => op.tool)).toEqual(['searchWeb', 'finish']);
        expect(JSON.stringify(mine.operations)).not.toContain('results for');
        expect(await runs.forInitiative({ userId: B, initiativeId: initiative.id })).toBeNull();

        await privacyService.forgetUser({ userId: A });
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_runs', {})).toMatchObject({ n: 0 });
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_run_operations', {})).toMatchObject({ n: 0 });
        const audit = await privacyService.auditUser({ userId: A });
        expect(audit.byTable).toMatchObject({ assistant_runs: 0, assistant_run_operations: 0 });
    });
});
