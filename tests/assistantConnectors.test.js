/**
 * The outside-connector framework for delegated runs (DA-11d, ADR 0028):
 * the manifest registry, grants on `external` resources, the pilot gate,
 * writeConnector / readConnector / listConnectors, the externalOperations
 * budget, reconciliation after a crash, and revocation.
 *
 * The framework is exercised against a test double
 * (tests/helpers/connectorDouble.js): a fake in-memory notebook. The one
 * connector that ships (Notion, ADR 0030; tests/notionConnector.test.js)
 * is taken out of the registry for this file, so "nothing is installed"
 * can be tested. The model is scripted. No provider, no network.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-connectors-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const registry = require('@goobster/core/services/assistant/connectors/registry');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runs = require('@goobster/core/services/assistantRunService');
const runner = require('@goobster/core/services/assistantRunnerService');
const updates = require('@goobster/core/services/assistantUpdateService');
const policies = require('@goobster/core/services/attentionPolicyService');
const access = require('@goobster/core/services/assistantAccessService');
const connectorService = require('@goobster/core/services/assistantConnectorService');
const identityService = require('@goobster/core/services/identityService');
const instanceState = require('@goobster/core/services/instanceStateService');
const { useState } = require('./helpers/featureFixtures');
const { createDouble } = require('./helpers/connectorDouble');

/** The installation's owner (an operator account), and somebody who is not. */
const A = `77${String(process.pid).padStart(8, '0')}00000001`;
const B = `77${String(process.pid).padStart(8, '0')}00000002`;
const TOKEN_A = 'secret-token-of-the-owner';
const TOKEN_B = 'secret-token-of-somebody-else';
const double = createDouble();

const GARDEN = { kind: 'external', ids: ['notebook:garden'] };
const grant = (operation, resource = GARDEN) => ({ operation, resource });
const WRITE = grant('external.write');
const READ = grant('read');
const POND = { kind: 'external', ids: ['notebook:pond'] };
const READ_NOTES = { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } };

const shipped = require('@goobster/core/services/assistant/connectors/shipped');
beforeAll(() => { for (const manifest of shipped) registry.unregister(manifest.id); });

afterAll(async () => {
    initiatives.stopListening();
    double.unregister();
    for (const manifest of shipped) registry.register(manifest);
    useState();
    await db.run('DELETE FROM app_accounts WHERE principalId IN (@a, @b)', { a: A, b: B });
    await db.run('DELETE FROM user_integrations WHERE userId IN (@a, @b)', { a: A, b: B });
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

const connect = (userId, token) => db.run(
    `INSERT INTO user_integrations (userId, provider, token, accountLabel) VALUES (@userId, 'notion', @token, 'Test')
     ON CONFLICT(userId, provider) DO UPDATE SET token = @token`,
    { userId, token }
);

beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    runner._reset();
    double.reset();
    double.register();
    for (const table of [
        'assistant_run_operations', 'assistant_runs', 'assistant_initiatives', 'assistant_source_cursors',
        'assistant_update_receipts', 'assistant_updates', 'assistant_responsibility_revisions', 'assistant_responsibilities',
        'attention_policies', 'attention_items', 'inbox_items', 'usage_reservations', 'work_failures',
        'user_integrations'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    await instanceState.remove(access.KEY_PILOT);
    await db.run('DELETE FROM app_accounts WHERE principalId IN (@a, @b)', { a: A, b: B });
    await identityService.ensureLegacyPrincipal({ discordId: A, displayName: 'owner' });
    await identityService.grantAccount({ principalId: A, entitlement: 'bootstrap', role: 'operator' });
    await identityService.ensureLegacyPrincipal({ discordId: B, displayName: 'member' });
    await connect(A, TOKEN_A);
});

let callId = 0;
let goalSeq = 0;
const call = (name, args = {}) => ({ id: `c${++callId}`, name, arguments: JSON.stringify(args) });
/** Script the model: each entry is one round's tool calls, or a final text. */
function script(...rounds) {
    const queue = [...rounds];
    const chat = jest.spyOn(aiService, 'chat');
    chat.mockClear();
    return chat.mockImplementation(async () => {
        const next = queue.shift();
        if (next === undefined) return { content: 'Nothing more.', toolCalls: [] };
        return typeof next === 'string' ? { content: next, toolCalls: [] } : { content: '', toolCalls: next };
    });
}
const FINISH = [call('finish', { outcome: 'finding', title: 'Kept the notebook', summary: 'See below.' })];
const append = (text, resource = 'garden') => call('writeConnector', { connector: 'notebook', resource, operation: 'append', input: { text } });

/** An active responsibility with one piece of work queued. */
async function queued({ userId = A, operations = [READ, WRITE], budgets = undefined } = {}) {
    await policies.enroll({ userId, initiative: 'delegate' });
    await policies.setBoundary({ userId, category: 'general', externalWrite: true });
    const item = await db.insert(
        `INSERT INTO attention_items (guildId, userId, kind, subject, goal, state)
         VALUES (@guildId, @userId, 'goal', @subject, 'Keep the notebook tidy', 'active')`,
        { guildId: `dm:${userId}`, userId, subject: `notebook-${++goalSeq}` }
    );
    const { responsibility } = await responsibilities.create({
        userId, body: { title: 'Keep the notebook tidy', operations, attentionItemId: item, ...(budgets ? { budgets } : {}) }
    });
    const active = (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
    return { grant: active, initiative: await another(active, item) };
}

async function another(held, item = held.attentionItemId) {
    await db.run('UPDATE attention_items SET goal = @goal WHERE id = @id', { id: item, goal: `Keep the notebook tidy, take ${++goalSeq}` });
    const [id] = (await initiatives.reconcileResponsibility(held.id)).proposed;
    const row = await initiatives.get({ userId: held.ownerUserId, id });
    return (await initiatives.act({ userId: held.ownerUserId, id, action: 'queue', expectedRevision: row.revision })).initiative;
}

/** A claimed initiative with its run row, as a worker that died would have left it. */
async function crashed(initiative) {
    const claimed = await initiatives.claim({ id: initiative.id });
    const runId = await db.insert(
        `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId)
         VALUES (@i, @r, @rev, @u, @u, @u)`,
        { i: initiative.id, r: initiative.responsibilityId, rev: claimed.initiative.responsibilityRevision, u: A }
    );
    const inFlight = async (tool, args) => {
        const id = await db.insert(
            `INSERT INTO assistant_run_operations (runId, ownerUserId, tool, argsHash, seq, effect, status)
             VALUES (@runId, @u, @tool, @hash, 1, 'write', 'DISPATCHED')`,
            { runId, u: A, tool, hash: runs.argsHash(args) }
        );
        return { id, operationId: `${runId}:${id}` };
    };
    return { runId, inFlight, resume: () => runs.execute({ initiative: claimed.initiative, leaseToken: claimed.leaseToken }) };
}

const operations = () => db.all('SELECT id, runId, tool, status, refusalCode, operation, resourceKind, resourceId, resultText FROM assistant_run_operations ORDER BY id', {});
const connectorOps = async () => (await operations()).filter(op => /Connector/.test(op.tool));
const writes = () => double.state.calls.filter(entry => entry.kind === 'write');
const offeredTo = (chat) => chat.mock.calls[0][1].functions.map(tool => tool.name);

describe('the connector registry', () => {
    test('what ships carries the owner\'s recorded decision, and nothing registers without one', () => {
        // Every shipped manifest names who decided, when, and where that is written down.
        expect(shipped.map(manifest => manifest.id)).toEqual(['notion']);
        for (const manifest of shipped) {
            expect(manifest.decision).toEqual({
                recordedBy: expect.stringMatching(/\S/), recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), reference: expect.stringMatching(/\S/)
            });
        }
        double.unregister();
        expect(registry.list()).toEqual([]);
        expect(() => registry.register({ ...double.manifest, decision: null }))
            .toThrow(expect.objectContaining({ code: 'NO_OWNER_DECISION' }));
        expect(() => registry.register({ ...double.manifest, decision: { recordedBy: 'owner' } }))
            .toThrow(expect.objectContaining({ code: 'INVALID_CONNECTOR' }));
        const decided = { recordedBy: 'owner', recordedAt: '2026-11-10', reference: 'issue 1' };
        expect(registry.register({ ...double.manifest, decision: decided }).decision).toEqual(decided);
        expect(() => registry.register({ ...double.manifest, decision: decided }))
            .toThrow(expect.objectContaining({ code: 'DUPLICATE_CONNECTOR' }));
        registry.unregister('notebook');
        // The testOnly door is the test double's, and it stays marked.
        expect(double.register().testOnly).toBe(true);
    });

    test('a manifest names a catalog provider and typed operations, and is validated whole', () => {
        const base = { ...double.manifest, id: 'other' };
        const bad = (patch) => expect(() => registry.register({ ...base, ...patch }, { testOnly: true }))
            .toThrow(expect.objectContaining({ code: 'INVALID_CONNECTOR' }));
        bad({ credential: { provider: 'no-such-provider' } });
        bad({ id: 'Not Valid' });
        bad({ feature: 'no-such-feature' });
        bad({ reads: [], writes: [] });
        bad({ writes: [{ operation: 'x', describe: 'y' }] });
        bad({ reads: [{ operation: 'search', describe: 's', run() {}, reconcile() {} }] });
        bad({ writes: [double.manifest.writes[0], double.manifest.writes[0]] });
    });

    test('only a named, wildcard-free resource of the shape the manifest accepts parses', () => {
        expect(registry.parseRef('notebook:garden')).toMatchObject({ resource: 'garden' });
        for (const ref of ['notebook:*', 'notebook:', 'notebook', 'nope:garden', 'notebook:two words', 'notebook:UPPER', 'notebook:a/b']) {
            expect(registry.parseRef(ref)).toBeNull();
        }
    });

    test('what the person is shown carries the manifest and no function or credential', async () => {
        const described = registry.describe(registry.get('notebook'));
        expect(described).toMatchObject({
            id: 'notebook', provider: 'notion',
            reads: [{ operation: 'search' }],
            writes: [{ operation: 'append', reconcilable: true }, { operation: 'clear', reconcilable: false }]
        });
        expect(JSON.stringify(described)).not.toMatch(/token|function/i);
        const shown = await connectorService.list(A);
        expect(shown).toMatchObject({ allowed: true, connectors: [{ id: 'notebook', connected: true, featureOn: true }] });
        expect(JSON.stringify(shown)).not.toContain(TOKEN_A);
        // Somebody outside the pilot is shown none.
        expect(await connectorService.list(B)).toEqual({ allowed: false, connectors: [] });
    });
});

describe('a grant on a connector', () => {
    test('names an installed connector\'s resource and nothing wider', async () => {
        const create = (resource, operation = 'external.write') => responsibilities.create({
            userId: A, body: { title: 'x', operations: [grant(operation, resource)] }
        });
        await expect(create({ kind: 'external', ids: ['notebook:garden'] })).resolves.toBeTruthy();
        await expect(create({ kind: 'external', ids: ['notebook:garden'] }, 'read')).resolves.toBeTruthy();
        for (const ids of [['notebook:*'], ['notebook'], ['nope:garden'], ['notebook:Two Words'], []]) {
            await expect(create({ kind: 'external', ids })).rejects.toMatchObject({ code: 'INVALID_RESOURCE' });
        }
        await expect(create({ kind: 'external' })).rejects.toMatchObject({ code: 'INVALID_RESOURCE' });
        // Not wholesale: no operation but read and external.write takes a connector.
        await expect(create(GARDEN, 'repo.push')).rejects.toMatchObject({ code: 'INVALID_RESOURCE' });
        // With nothing installed there is nothing to grant.
        double.unregister();
        await expect(create(GARDEN)).rejects.toMatchObject({ code: 'INVALID_RESOURCE' });
    });

    test('is the owner\'s alone until the pilot decision, reads included, and needs the person\'s own credential', async () => {
        await policies.enroll({ userId: B, initiative: 'delegate' });
        await connect(B, TOKEN_B);
        for (const operations of [[WRITE], [READ]]) {
            const { responsibility } = await responsibilities.create({ userId: B, body: { title: 'For me', operations } });
            await expect(responsibilities.act({ userId: B, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision }))
                .rejects.toMatchObject({ code: 'PILOT_ONLY' });
        }
        // The owner cannot activate it without having connected the service.
        await policies.enroll({ userId: A, initiative: 'delegate' });
        await db.run('DELETE FROM user_integrations WHERE userId = @a', { a: A });
        const { responsibility } = await responsibilities.create({ userId: A, body: { title: 'Mine', operations: [WRITE] } });
        await expect(responsibilities.act({ userId: A, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision }))
            .rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
        await connect(A, TOKEN_A);
        const activated = await responsibilities.act({ userId: A, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision });
        expect(activated.responsibility.status).toBe('ACTIVE');
        // The pilot decision opens it to everyone.
        await access.recordDecision({ scope: 'everyone' });
        const second = await responsibilities.create({ userId: B, body: { title: 'For me', operations: [WRITE] } });
        await expect(responsibilities.act({ userId: B, id: second.responsibility.id, action: 'activate', expectedRevision: second.responsibility.revision }))
            .resolves.toMatchObject({ responsibility: { status: 'ACTIVE' } });
    });

    test('is refused outright when the connector\'s feature is off', async () => {
        const { grant: held } = await queued({ operations: [WRITE] });
        expect(await connectorService.reachable(A, 'notebook:garden')).toBe(true);
        useState({ inactive: ['github'] });
        double.unregister();
        registry.register({ ...double.manifest, feature: 'github' }, { testOnly: true });
        expect(await connectorService.reachable(A, 'notebook:garden')).toBe('github');
        const verdict = await responsibilities.authorize({
            responsibilityId: held.id, revision: held.revision, operation: 'external.write',
            resource: { kind: 'external', id: 'notebook:garden' }, actorUserId: A
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.code).toBe('FEATURE_UNAVAILABLE');
    });
});

describe('writeConnector in a run', () => {
    test('writes to a granted resource as the person, says it cannot be undone, and reports it', async () => {
        await queued();
        script(
            [call('listConnectors')],
            [append('plant the beans')],
            FINISH
        );
        expect((await runner.tick({ wait: true })).results[0]).toMatchObject({ status: 'COMPLETED', outcome: 'DONE' });

        const ops = await connectorOps();
        expect(ops.map(op => `${op.tool}:${op.status}`)).toEqual(['listConnectors:SUCCEEDED', 'writeConnector:SUCCEEDED']);
        expect(ops[0].resultText).toContain('connector "notebook", resource "garden" (Test notebook) - writeConnector operations: append');
        expect(ops[0].resultText).toContain('clear (Delete every entry');
        expect(ops[1]).toMatchObject({ operation: 'external.write', resourceKind: 'external', resourceId: 'notebook:garden' });
        expect(ops[1].resultText).toBe('Wrote to Test notebook (garden): entry 1 added. That cannot be undone from here.');
        expect(double.state.entries.get('garden').map(entry => entry.text)).toEqual(['plant the beans']);
        expect(writes()).toHaveLength(1);
        // The adapter is handed the operation's identity so it can mark the write.
        expect(double.state.entries.get('garden')[0].operationId).toBe(`${ops[1].runId}:${ops[1].id}`);

        // Only the acting person's own credential was used, and it is nowhere in what was kept.
        expect([...double.state.tokensSeen]).toEqual([TOKEN_A]);
        const kept = JSON.stringify([await operations(), await db.all('SELECT * FROM assistant_runs', {}), (await updates.list({ userId: A })).updates]);
        expect(kept).not.toContain(TOKEN_A);
        expect((await updates.list({ userId: A })).updates[0].summary)
            .toContain('Wrote to Test notebook (garden): entry 1 added. That cannot be undone from here.');
    }, 60_000);

    test('refuses what the grant does not name before anything is sent', async () => {
        await queued({ operations: [WRITE] });
        script(
            [append('elsewhere', 'orchard')],
            [call('writeConnector', { connector: 'nope', resource: 'garden', operation: 'append', input: { text: 'x' } })],
            [call('writeConnector', { connector: 'notebook', resource: 'garden', operation: 'drop-table', input: {} })],
            [call('writeConnector', { connector: 'notebook', resource: 'garden', operation: 'append', input: { text: '   ' } })],
            [call('writeConnector', { connector: 'notebook', resource: 'garden', operation: 'append', input: 'not an object' })],
            [call('writeConnector', { connector: 'notebook', resource: '*', operation: 'append', input: { text: 'x' } })],
            [call('readConnector', { connector: 'notebook', resource: 'garden', operation: 'search', input: { query: 'x' } })],
            FINISH
        );
        await runner.tick({ wait: true });
        expect((await connectorOps()).map(op => op.refusalCode || op.status)).toEqual([
            'OPERATION_OUT_OF_SCOPE', 'NO_SUCH_CONNECTOR', 'NO_SUCH_OPERATION', 'EMPTY_TEXT', 'BAD_INPUT', 'BAD_RESOURCE', 'UNKNOWN_TOOL'
        ]);
        expect(double.state.calls).toEqual([]);
    }, 60_000);

    test('is offered only to a run whose grant names an external operation and whose owner has the pilot', async () => {
        await queued({ operations: [READ] });
        let chat = script('Nothing to do.');
        await runner.tick({ wait: true });
        expect(offeredTo(chat).filter(name => /Connector/.test(name)).sort()).toEqual(['listConnectors', 'readConnector']);

        // A grant with no connector in it offers none.
        await db.run('DELETE FROM assistant_runs', {});
        await db.run('DELETE FROM assistant_initiatives', {});
        await db.run('DELETE FROM assistant_responsibilities', {});
        await queued({ operations: [{ operation: 'read', resource: { kind: 'web' } }] });
        chat = script('Nothing to do.');
        await runner.tick({ wait: true });
        expect(offeredTo(chat).filter(name => /Connector/.test(name))).toEqual([]);

        // Nor does one when nothing is installed, or the owner has left the pilot.
        await db.run('DELETE FROM assistant_runs', {});
        await db.run('DELETE FROM assistant_initiatives', {});
        await db.run('DELETE FROM assistant_responsibilities', {});
        const { grant: held } = await queued({ operations: [WRITE] });
        double.unregister();
        chat = script('Nothing to do.');
        await runner.tick({ wait: true });
        expect(offeredTo(chat).filter(name => /Connector/.test(name))).toEqual([]);
        double.register();
        await another(held);
        await db.run("UPDATE app_accounts SET status = 'disabled' WHERE principalId = @id", { id: A });
        chat = script('Not mine.');
        await runner.tick({ wait: true });
        expect(offeredTo(chat).filter(name => /Connector/.test(name))).toEqual([]);
        expect(writes()).toEqual([]);
    }, 90_000);

    test('the guard checks the pilot and the credential again where the call is dispatched', async () => {
        const { grant: held } = await queued({ operations: [WRITE] });
        const ctx = { run: { id: 1, ownerUserId: A, responsibilityId: held.id }, opId: 1, actor: A };
        const args = { connector: 'notebook', resource: 'garden', operation: 'append', input: { text: 'x' } };
        expect(await runs.TOOLS.writeConnector.guard(args, ctx)).toBeNull();
        await db.run('DELETE FROM user_integrations WHERE userId = @a', { a: A });
        expect(await runs.TOOLS.writeConnector.guard(args, ctx)).toBe('NO_CREDENTIAL');
        await connect(A, TOKEN_A);
        await db.run("UPDATE app_accounts SET status = 'disabled' WHERE principalId = @id", { id: A });
        expect(await runs.TOOLS.writeConnector.guard(args, ctx)).toBe('PILOT_ONLY');
        expect(await runs.TOOLS.readConnector.guard(args, ctx)).toBe('PILOT_ONLY');
        expect(await runs.TOOLS.listConnectors.guard(args, ctx)).toBe('PILOT_ONLY');
    });
});

describe('what a connector may not do after a private read', () => {
    const readGarden = call('readConnector', { connector: 'notebook', resource: 'garden', operation: 'search', input: { query: 'gate' } });
    const bothResources = [READ, WRITE, grant('read', POND), grant('external.write', POND)];

    test('what a run read from a connector resource goes nowhere outside but back into that resource', async () => {
        await queued({ operations: bothResources });
        double.state.entries.set('garden', [{ n: 1, text: 'the gate code is 1234', operationId: null }]);
        script(
            [readGarden],
            // Another resource of the same connector is still somewhere else: other people may read it.
            [append('copied outward', 'pond')],
            // The resource the text came from already holds it.
            [append('noted beside it')],
            FINISH
        );
        await runner.tick({ wait: true });
        expect((await connectorOps()).map(op => `${op.resourceId} ${op.refusalCode || op.status}`)).toEqual([
            'notebook:garden SUCCEEDED', 'notebook:pond PRIVATE_CONTEXT', 'notebook:garden SUCCEEDED'
        ]);
        expect((await connectorOps())[0].resultText).toContain('the gate code is 1234');
        expect(writes().map(entry => entry.resource)).toEqual(['garden']);
    }, 60_000);

    test('a run that read from two connector resources can write to neither', async () => {
        await queued({ operations: bothResources });
        script(
            [readGarden],
            [call('readConnector', { connector: 'notebook', resource: 'pond', operation: 'search', input: { query: 'x' } })],
            [append('mixed', 'pond')],
            [append('mixed')],
            FINISH
        );
        await runner.tick({ wait: true });
        expect((await connectorOps()).map(op => op.refusalCode || op.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'PRIVATE_CONTEXT', 'PRIVATE_CONTEXT']);
        expect(writes()).toEqual([]);
    }, 60_000);

    test('a run that read the person\'s private notes cannot write to a connector at all', async () => {
        const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
        const realExecute = toolsRegistry.execute.bind(toolsRegistry);
        jest.spyOn(toolsRegistry, 'execute').mockImplementation(async (name, args) => (
            name === 'lookupNotes' ? 'SECRET-JOURNAL a note about beans' : realExecute(name, args)
        ));
        await queued({ operations: [READ, WRITE, READ_NOTES] });
        script([call('lookupNotes', { query: 'beans' })], [readGarden], [append('from my notes')], FINISH);
        await runner.tick({ wait: true });
        expect((await operations()).filter(op => op.tool !== 'finish').map(op => `${op.tool} ${op.refusalCode || op.status}`)).toEqual([
            'lookupNotes SUCCEEDED', 'readConnector SUCCEEDED', 'writeConnector PRIVATE_CONTEXT'
        ]);
        expect(writes()).toEqual([]);
    }, 60_000);

    test('a resumed run remembers where its private reads came from', async () => {
        const { initiative } = await queued({ operations: bothResources });
        const dead = await crashed(initiative);
        // Before the worker died the run had read the pond.
        await db.run(
            `INSERT INTO assistant_run_operations (runId, ownerUserId, tool, argsHash, seq, effect, status, operation, resourceKind, resourceId, resultText)
             VALUES (@runId, @u, 'readConnector', 'earlier', 1, 'read', 'SUCCEEDED', 'read', 'external', 'notebook:pond', 'x')`,
            { runId: dead.runId, u: A }
        );
        script([append('after the crash')], [append('back where it came from', 'pond')], FINISH);
        await dead.resume();
        expect((await connectorOps()).filter(op => op.tool === 'writeConnector').map(op => `${op.resourceId} ${op.refusalCode || op.status}`))
            .toEqual(['notebook:garden PRIVATE_CONTEXT', 'notebook:pond SUCCEEDED']);
        expect(writes().map(entry => entry.resource)).toEqual(['pond']);
    }, 60_000);
});

describe('the externalOperations budget', () => {
    test('is two a day by default across the responsibility; a refused or declined call costs nothing', async () => {
        const { grant: held } = await queued({ operations: [WRITE] });
        double.state.mode = 'declined';
        script([append('one')], FINISH);
        await runner.tick({ wait: true });
        let ops = await connectorOps();
        expect(ops[0]).toMatchObject({ status: 'SUCCEEDED', resultText: 'Not written (READ_ONLY): that notebook is read only.' });
        expect(await runs._externalUsed(held.id, Number.MAX_SAFE_INTEGER)).toBe(0);
        expect(double.state.entries.get('garden') || []).toEqual([]);
        // A declined write is not listed as a change.
        expect((await updates.list({ userId: A })).updates[0].summary).not.toContain('Wrote to');

        double.state.mode = 'ok';
        await another(held);
        script([append('one')], [append('two')], [append('three')], FINISH);
        await runner.tick({ wait: true });
        ops = (await connectorOps()).slice(1);
        expect(ops.map(op => op.refusalCode || op.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'EXTERNAL_BUDGET']);
        expect(double.state.entries.get('garden').map(entry => entry.text)).toEqual(['one', 'two']);
        expect(await runs._externalUsed(held.id, Number.MAX_SAFE_INTEGER)).toBe(2);
    }, 90_000);

    test('honours the grant\'s own number, a zero allows none, and a write whose outcome is unknown uses one', async () => {
        await queued({ operations: [WRITE], budgets: { externalOperations: 1 } });
        double.state.mode = 'lost';
        script([append('lands but the answer is lost')], [append('second')], FINISH);
        await runner.tick({ wait: true });
        expect((await connectorOps()).map(op => op.refusalCode || op.status)).toEqual(['FAILED', 'EXTERNAL_BUDGET']);
        expect(writes()).toHaveLength(1);

        await db.run('DELETE FROM assistant_runs', {});
        await db.run('DELETE FROM assistant_initiatives', {});
        await db.run('DELETE FROM assistant_responsibilities', {});
        double.reset();
        await queued({ operations: [WRITE], budgets: { externalOperations: 0 } });
        script([append('none')], 'No budget.');
        await runner.tick({ wait: true });
        expect((await connectorOps()).pop()).toMatchObject({ status: 'REFUSED', refusalCode: 'EXTERNAL_BUDGET' });
        expect(writes()).toEqual([]);
    }, 90_000);

    test('reads are not counted', async () => {
        const { grant: held } = await queued({ operations: [READ] });
        script(
            [call('readConnector', { connector: 'notebook', resource: 'garden', operation: 'search', input: { query: 'a' } })],
            [call('readConnector', { connector: 'notebook', resource: 'garden', operation: 'search', input: { query: 'b' } })],
            [call('readConnector', { connector: 'notebook', resource: 'garden', operation: 'search', input: { query: 'c' } })],
            FINISH
        );
        await runner.tick({ wait: true });
        expect((await connectorOps()).map(op => op.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
        expect(await runs._externalUsed(held.id, Number.MAX_SAFE_INTEGER)).toBe(0);
    }, 60_000);
});

describe('after a crash', () => {
    const APPEND = { connector: 'notebook', resource: 'garden', operation: 'append', input: { text: 'plant the beans' } };

    test('a write that reached the outside service is found there and not made again', async () => {
        const { initiative } = await queued({ operations: [WRITE] });
        const work = await crashed(initiative);
        const { operationId } = await work.inFlight('writeConnector', APPEND);
        double.state.entries.set('garden', [{ n: 1, text: 'plant the beans', operationId }]);
        double.state.applied.set(operationId, double.state.entries.get('garden')[0]);
        script([call('writeConnector', APPEND)], FINISH);
        expect(await work.resume()).toMatchObject({ status: 'COMPLETED' });
        expect(writes()).toEqual([]);
        expect((await connectorOps())[0]).toMatchObject({
            status: 'SUCCEEDED', resultText: 'Wrote to Test notebook (garden): entry 1 added. That cannot be undone from here.'
        });
        expect(double.state.entries.get('garden')).toHaveLength(1);
    }, 60_000);

    test('a write that never left is made once, after the service was asked', async () => {
        const { initiative } = await queued({ operations: [WRITE] });
        const work = await crashed(initiative);
        await work.inFlight('writeConnector', APPEND);
        script([call('writeConnector', APPEND)], FINISH);
        expect(await work.resume()).toMatchObject({ status: 'COMPLETED' });
        expect(writes()).toHaveLength(1);
        expect((await connectorOps())[0]).toMatchObject({ status: 'SUCCEEDED' });
    }, 60_000);

    test('a write the service cannot settle stops for review and is never tried again', async () => {
        const { initiative } = await queued({ operations: [WRITE] });
        const work = await crashed(initiative);
        await work.inFlight('writeConnector', APPEND);
        double.state.unreachable = true;
        script([call('writeConnector', APPEND)], FINISH);
        const result = await work.resume();
        expect(result.status).not.toBe('COMPLETED');
        expect(result).toMatchObject({ stopCode: 'OPERATION_UNCERTAIN' });
        expect((await connectorOps())[0]).toMatchObject({ status: 'UNCERTAIN' });
        expect(writes()).toEqual([]);
    }, 60_000);

    test('a write whose manifest cannot be asked stops for review after any uncertainty', async () => {
        const { initiative } = await queued({ operations: [WRITE] });
        const clear = { connector: 'notebook', resource: 'garden', operation: 'clear', input: {} };
        const work = await crashed(initiative);
        await work.inFlight('writeConnector', clear);
        script([call('writeConnector', clear)], FINISH);
        const result = await work.resume();
        expect(result.status).not.toBe('COMPLETED');
        expect((await connectorOps())[0]).toMatchObject({ status: 'UNCERTAIN' });
        expect(writes()).toEqual([]);
    }, 60_000);
});

describe('revoking a connector', () => {
    test('deletes the person\'s credential and the next call is refused, without anything being sent', async () => {
        const { grant: held } = await queued({ operations: [READ, WRITE] });
        const verdict = () => responsibilities.authorize({
            responsibilityId: held.id, revision: held.revision, operation: 'external.write',
            resource: { kind: 'external', id: 'notebook:garden' }, actorUserId: A
        });
        expect((await verdict()).ok).toBe(true);

        expect(await connectorService.revoke({ userId: A, connectorId: 'notebook' })).toEqual({ revoked: true, responsibilities: [held.id] });
        expect(await db.get('SELECT 1 AS n FROM user_integrations WHERE userId = @a', { a: A })).toBeFalsy();
        expect(await verdict()).toMatchObject({ ok: false, code: 'RESOURCE_UNAVAILABLE' });

        script([append('too late')], FINISH);
        await runner.tick({ wait: true });
        expect((await connectorOps())[0]).toMatchObject({ status: 'REFUSED', refusalCode: 'RESOURCE_UNAVAILABLE' });
        expect(writes()).toEqual([]);
        // Revoking again says nothing was left; an unknown connector is a plain 404.
        expect(await connectorService.revoke({ userId: A, connectorId: 'notebook' })).toMatchObject({ revoked: false });
        await expect(connectorService.revoke({ userId: A, connectorId: 'nope' })).rejects.toMatchObject({ code: 'NO_SUCH_CONNECTOR', status: 404 });
    }, 60_000);

    test('takes only the revoking person\'s credential', async () => {
        await connect(B, TOKEN_B);
        await connectorService.revoke({ userId: A, connectorId: 'notebook' });
        expect(await connectorService.reachable(B, 'notebook:garden')).toBe(true);
        expect(await connectorService.reachable(A, 'notebook:garden')).toBe(false);
    });
});
