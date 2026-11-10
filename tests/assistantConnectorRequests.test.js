/**
 * Asking first (DA-11e, ADR 0030; documentation/delegated_connectors.md):
 * an action a connector's manifest lists under `asks` is never taken by a
 * run. `askConnector` files a request; the person answers it on Home or in
 * the Inbox, and approving does it with their own credential, at that
 * moment, after every check is made again.
 *
 * Runs against the test double (tests/helpers/connectorDouble.js), whose
 * one ask removes a notebook entry. The model is scripted. No network.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-connector-requests-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const registry = require('@goobster/core/services/assistant/connectors/registry');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runs = require('@goobster/core/services/assistantRunService');
const runner = require('@goobster/core/services/assistantRunnerService');
const policies = require('@goobster/core/services/attentionPolicyService');
const access = require('@goobster/core/services/assistantAccessService');
const control = require('@goobster/core/services/assistantControlService');
const connectorService = require('@goobster/core/services/assistantConnectorService');
const requests = require('@goobster/core/services/assistantConnectorRequestService');
const gates = require('@goobster/core/services/assistantGateService');
const home = require('@goobster/core/services/assistantHomeService');
const inbox = require('@goobster/core/services/inboxService');
const steward = require('@goobster/core/services/assistantStewardService');
const dormantData = require('@goobster/core/services/dormantDataService');
const identityService = require('@goobster/core/services/identityService');
const instanceState = require('@goobster/core/services/instanceStateService');
const { useState } = require('./helpers/featureFixtures');
const { createDouble } = require('./helpers/connectorDouble');

const A = `78${String(process.pid).padStart(8, '0')}00000001`;
const B = `78${String(process.pid).padStart(8, '0')}00000002`;
const TOKEN_A = 'secret-token-of-the-owner';
const double = createDouble();
const shipped = require('@goobster/core/services/assistant/connectors/shipped');

const GARDEN = { kind: 'external', ids: ['notebook:garden'] };
const WRITE = { operation: 'external.write', resource: GARDEN };
const READ = { operation: 'read', resource: GARDEN };

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
        'assistant_connector_requests', 'assistant_run_operations', 'assistant_runs', 'assistant_initiatives',
        'assistant_source_cursors', 'assistant_update_receipts', 'assistant_updates', 'assistant_responsibility_revisions',
        'assistant_responsibilities', 'attention_policies', 'attention_items', 'inbox_items', 'usage_reservations',
        'work_failures', 'resource_events', 'user_integrations'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    await instanceState.remove(access.KEY_PILOT);
    await control.resumeAll();
    await db.run('DELETE FROM app_accounts WHERE principalId IN (@a, @b)', { a: A, b: B });
    await identityService.ensureLegacyPrincipal({ discordId: A, displayName: 'owner' });
    await identityService.grantAccount({ principalId: A, entitlement: 'bootstrap', role: 'operator' });
    await identityService.ensureLegacyPrincipal({ discordId: B, displayName: 'member' });
    await connect(A, TOKEN_A);
    double.state.entries.set('garden', [
        { n: 1, text: 'beans', operationId: null }, { n: 2, text: 'old slug traps', operationId: null }, { n: 3, text: 'peas', operationId: null }
    ]);
});

let callId = 0;
let goalSeq = 0;
const call = (name, args = {}) => ({ id: `c${++callId}`, name, arguments: JSON.stringify(args) });
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
const FINISH = [call('finish', { outcome: 'finding', title: 'Looked over the notebook', summary: 'Asked about one entry.' })];
const ask = (n, resource = 'garden') => call('askConnector', { connector: 'notebook', resource, operation: 'remove', input: { n } });

async function queued({ userId = A, operations = [READ, WRITE] } = {}) {
    await policies.enroll({ userId, initiative: 'delegate' });
    await policies.setBoundary({ userId, category: 'general', externalWrite: true });
    const item = await db.insert(
        `INSERT INTO attention_items (guildId, userId, kind, subject, goal, state)
         VALUES (@guildId, @userId, 'goal', @subject, 'Keep the notebook tidy', 'active')`,
        { guildId: `dm:${userId}`, userId, subject: `notebook-${++goalSeq}` }
    );
    const { responsibility } = await responsibilities.create({
        userId, body: { title: 'Keep the notebook tidy', operations, attentionItemId: item }
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

const operations = () => db.all('SELECT id, runId, tool, status, refusalCode, operation, resourceKind, resourceId, resultText FROM assistant_run_operations ORDER BY id', {});
const asked = () => db.all('SELECT * FROM assistant_connector_requests ORDER BY id', {});
const entries = () => double.state.entries.get('garden').map(entry => entry.text);
const calls = (kind) => double.state.calls.filter(entry => entry.kind === kind);
const needsYou = async (userId = A) => (await inbox.list({ userId, view: 'needs_you' })).items;
const caught = (promise) => promise.then(() => null, error => error);
const decide = (card, option, userId = A) => gates.decide({
    userId, ref: card.ref, option, occurrence: card.occurrence, revision: card.revision, surface: 'home'
});
const offeredTo = (chat) => chat.mock.calls[0][1].functions.map(tool => tool.name);

/** A run asks to remove entry 2; returns the request and the card the person is shown. */
async function requested() {
    const made = await queued();
    script([ask(2)], FINISH);
    await runner.tick({ wait: true });
    const request = (await asked()).pop();
    const item = (await needsYou()).find(entry => entry.decision?.state === 'open');
    return { ...made, request, item, card: item?.decision };
}

describe('a run asks, and changes nothing', () => {
    test('askConnector files one request, shown under Needs you, and is not in what the run changed', async () => {
        const { grant: held, request, item, card } = await requested();
        expect(request).toMatchObject({
            ownerUserId: A, responsibilityId: held.id, connector: 'notebook', resource: 'garden', operation: 'remove',
            target: '2', label: 'entry 2 ("old slug traps")', status: 'PENDING'
        });
        const [op] = (await operations()).filter(row => row.tool === 'askConnector');
        expect(op).toMatchObject({ status: 'SUCCEEDED', operation: 'external.write', resourceKind: 'external', resourceId: 'notebook:garden' });
        expect(op.resultText).toMatch(/^Not done: the person has been asked to approve it/);
        // Reading what to ask about is all the outside service saw.
        expect(double.state.calls.map(entry => entry.kind)).toEqual(['prepare']);
        expect(entries()).toEqual(['beans', 'old slug traps', 'peas']);

        const run = await db.get('SELECT * FROM assistant_runs', {});
        expect(run.status).toBe('COMPLETED');
        expect(run.resultSummary || '').not.toMatch(/Changed:[^\n]*askConnector/);
        expect(run.resultSummary || '').not.toContain('Changed:');

        expect(card).toMatchObject({
            kind: 'connector_request', state: 'open',
            title: 'Remove it: entry 2 ("old slug traps"), in Test notebook?',
            options: [
                { id: 'approve', label: 'Remove it', effect: 'Entry 2 ("old slug traps"). The entry is removed from the notebook, as you.', danger: true },
                { id: 'decline', label: 'Leave it', danger: false }
            ]
        });
        expect((await home.project({ userId: A })).needsYou.map(entry => entry.decision)).toContainEqual(card);
        expect(item.title).toContain('Remove it');
    }, 60_000);

    test('is offered only with external.write on a connector that has something to ask for', async () => {
        await queued({ operations: [READ] });
        let chat = script('Nothing to do.');
        await runner.tick({ wait: true });
        expect(offeredTo(chat)).not.toContain('askConnector');

        await db.run('DELETE FROM assistant_runs', {});
        await db.run('DELETE FROM assistant_initiatives', {});
        await db.run('DELETE FROM assistant_responsibilities', {});
        await queued({ operations: [WRITE] });
        chat = script('Nothing to do.');
        await runner.tick({ wait: true });
        expect(offeredTo(chat)).toEqual(expect.arrayContaining(['askConnector', 'writeConnector', 'listConnectors']));
        const list = registry.describe(registry.get('notebook'));
        expect(list.asks).toEqual([{ operation: 'remove', describe: expect.any(String), action: 'Remove it', consequence: expect.any(String) }]);
    }, 60_000);

    test('a read-only grant cannot ask, and an ask is never run through writeConnector', async () => {
        await queued({ operations: [READ] });
        script(
            [ask(2)],
            [call('writeConnector', { connector: 'notebook', resource: 'garden', operation: 'remove', input: { n: 2 } })],
            FINISH
        );
        await runner.tick({ wait: true });
        const ops = (await operations()).filter(row => /Connector/.test(row.tool));
        expect(ops.every(op => op.status === 'REFUSED' || /^Not /.test(op.resultText || ''))).toBe(true);
        expect(await asked()).toEqual([]);
        expect(double.state.calls).toEqual([]);

        // With the grant, the write tool still has no such operation.
        await db.run('DELETE FROM assistant_runs', {});
        await db.run('DELETE FROM assistant_initiatives', {});
        await db.run('DELETE FROM assistant_responsibilities', {});
        await queued();
        script([call('writeConnector', { connector: 'notebook', resource: 'garden', operation: 'remove', input: { n: 2 } })], FINISH);
        await runner.tick({ wait: true });
        const [op] = (await operations()).filter(row => row.tool === 'writeConnector');
        expect(op.status === 'REFUSED' || /^Not written/.test(op.resultText || '')).toBe(true);
        expect(calls('approved')).toEqual([]);
        expect(entries()).toHaveLength(3);
    }, 90_000);

    test('asking twice for the same thing keeps one request, and at most five wait at once', async () => {
        const { grant: held } = await requested();
        await another(held);
        script([ask(2)], FINISH);
        await runner.tick({ wait: true });
        expect(await asked()).toHaveLength(1);
        expect((await operations()).filter(row => row.tool === 'askConnector').pop().resultText).toMatch(/already asked/);

        double.state.entries.set('garden', Array.from({ length: 9 }, (_, index) => ({ n: index + 1, text: `entry ${index + 1}`, operationId: null })));
        await another(held);
        script([ask(3)], [ask(4)], [ask(5)], [ask(6)], [ask(7)], FINISH);
        await runner.tick({ wait: true });
        expect(await asked()).toHaveLength(requests.MAX_OPEN);
        expect((await operations()).pop() && (await operations()).filter(row => row.tool === 'askConnector').pop().resultText)
            .toMatch(/^Not asked \(ASK_LIMIT\)/);
        expect(await needsYou()).toHaveLength(requests.MAX_OPEN);
    }, 120_000);

    test('what cannot be asked about says so and files nothing', async () => {
        await queued();
        script([ask(99)], [ask(2, 'pond')], FINISH);
        await runner.tick({ wait: true });
        const ops = (await operations()).filter(row => row.tool === 'askConnector');
        expect(ops[0].resultText).toMatch(/^Not asked \(NO_SUCH_ENTRY\)/);
        expect(ops[1]).toMatchObject({ status: 'REFUSED' });
        expect(await asked()).toEqual([]);
        expect(await needsYou()).toEqual([]);
    }, 60_000);

    test('a run that died while asking does not ask twice', async () => {
        const { initiative } = await queued();
        const claimed = await initiatives.claim({ id: initiative.id });
        const runId = await db.insert(
            `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId)
             VALUES (@i, @r, @rev, @u, @u, @u)`,
            { i: initiative.id, r: initiative.responsibilityId, rev: claimed.initiative.responsibilityRevision, u: A }
        );
        const args = { connector: 'notebook', resource: 'garden', operation: 'remove', input: { n: 2 } };
        const opId = await db.insert(
            `INSERT INTO assistant_run_operations (runId, ownerUserId, tool, argsHash, seq, effect, status)
             VALUES (@runId, @u, 'askConnector', @hash, 1, 'write', 'DISPATCHED')`,
            { runId, u: A, hash: runs.argsHash(args) }
        );
        // The request was filed before the worker died.
        await requests.ask({
            userId: A, run: { id: runId, responsibilityId: initiative.responsibilityId, initiativeId: initiative.id },
            connector: registry.get('notebook'), ask: registry.operationOf(registry.get('notebook'), 'ask', 'remove'),
            resource: 'garden', target: '2', label: 'entry 2', operationId: `${runId}:${opId}`
        });
        script([call('askConnector', args)], FINISH);
        await runs.execute({ initiative: claimed.initiative, leaseToken: claimed.leaseToken });
        expect(await asked()).toHaveLength(1);
        expect(calls('prepare')).toEqual([]);
        expect((await operations()).find(row => row.id === opId)).toMatchObject({ status: 'SUCCEEDED' });
    }, 60_000);
});

describe('the person answers', () => {
    test('approving does it once, with their credential, and the card closes', async () => {
        const { card, request } = await requested();
        double.state.tokensSeen.clear();
        const outcome = await decide(card, 'approve');
        expect(outcome.decided).toMatchObject({ kind: 'connector_request', option: 'approve', message: 'Removed entry 2.' });
        expect(outcome.current).toMatchObject({ state: 'resolved', outcome: 'You approved it, and it was done.' });
        expect(entries()).toEqual(['beans', 'peas']);
        expect([...double.state.tokensSeen]).toEqual([TOKEN_A]);
        expect(await requests.get(request.id)).toMatchObject({ status: 'APPROVED', resultCode: null });
        expect(await needsYou()).toEqual([]);

        // The same card pressed again decides nothing.
        expect(await caught(decide(card, 'approve'))).toMatchObject({ code: 'STALE_GATE' });
        expect(calls('approved')).toHaveLength(1);
        // Nothing of it is in a ledger row.
        const ledgers = JSON.stringify([
            await db.all('SELECT * FROM work_failures', {}), await db.all('SELECT * FROM resource_events', {})
        ]);
        expect(ledgers).not.toContain('slug');
        expect(ledgers).not.toContain(TOKEN_A);
    }, 60_000);

    test('refusing changes nothing and the outside service is never called', async () => {
        const { card, request } = await requested();
        double.state.calls.length = 0;
        const outcome = await decide(card, 'decline');
        expect(outcome.decided.message).toBe('Nothing was changed.');
        expect(outcome.current).toMatchObject({ state: 'resolved', outcome: 'You refused it. Nothing was changed.' });
        expect(double.state.calls).toEqual([]);
        expect(entries()).toHaveLength(3);
        expect(await requests.get(request.id)).toMatchObject({ status: 'DECLINED' });
    }, 60_000);

    test('nobody else can see or answer it', async () => {
        const { card, request } = await requested();
        expect(await needsYou(B)).toEqual([]);
        expect(await caught(decide(card, 'approve', B))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
        expect(await caught(requests.decide({ userId: B, id: request.id, approve: true }))).toMatchObject({ code: 'NOT_FOUND' });
        expect(calls('approved')).toEqual([]);
        expect(await requests.get(request.id)).toMatchObject({ status: 'PENDING' });
    }, 60_000);

    test('approval checks the pilot, the host\'s stop and the credential again, and the request waits', async () => {
        const { card, request } = await requested();

        await db.run("UPDATE app_accounts SET status = 'disabled' WHERE principalId = @id", { id: A });
        expect(await caught(requests.decide({ userId: A, id: request.id, approve: true }))).toMatchObject({ code: access.REFUSAL_CODE });
        await db.run("UPDATE app_accounts SET status = 'active' WHERE principalId = @id", { id: A });

        await control.pauseAll();
        expect(await caught(decide(card, 'approve'))).toMatchObject({ code: 'HOST_STOPPED' });
        await control.resumeAll();

        await db.run('DELETE FROM user_integrations WHERE userId = @a', { a: A });
        expect(await caught(decide(card, 'approve'))).toMatchObject({ code: 'NO_CREDENTIAL' });

        expect(calls('approved')).toEqual([]);
        expect(await requests.get(request.id)).toMatchObject({ status: 'PENDING' });
        expect(entries()).toHaveLength(3);

        // Once all of it is back, the same request can still be approved.
        await connect(A, TOKEN_A);
        const [item] = await needsYou();
        expect((await decide(item.decision, 'approve')).decided.option).toBe('approve');
        expect(entries()).toEqual(['beans', 'peas']);
    }, 60_000);

    test('a refusal from outside leaves it waiting; no answer says it may have happened', async () => {
        const { card, request } = await requested();
        double.state.mode = 'declined';
        expect(await caught(decide(card, 'approve'))).toMatchObject({ code: 'READ_ONLY', message: expect.stringContaining('Nothing was changed') });
        double.state.mode = 'ok';
        double.state.unreachable = true;
        expect(await caught(decide(card, 'approve'))).toMatchObject({ code: 'OUTCOME_UNKNOWN', message: expect.stringContaining('may or may not') });
        double.state.unreachable = false;
        expect(await requests.get(request.id)).toMatchObject({ status: 'PENDING' });
        expect(entries()).toHaveLength(3);
    }, 60_000);

    test('a target that is gone withdraws the request instead of leaving it open', async () => {
        const { card, request } = await requested();
        double.state.entries.set('garden', [{ n: 1, text: 'beans', operationId: null }]);
        expect(await caught(decide(card, 'approve'))).toMatchObject({ code: 'STALE_GATE' });
        expect(await requests.get(request.id)).toMatchObject({ status: 'WITHDRAWN', resultCode: 'NO_SUCH_ENTRY' });
        expect(await needsYou()).toEqual([]);
    }, 60_000);
});

describe('a request does not outlive what it was asked under', () => {
    test('narrowing the grant, ending the responsibility or revoking the connector withdraws it', async () => {
        const first = await requested();
        // The grant no longer covers writing there: approval is refused and the request ends.
        const current = await responsibilities.get({ userId: A, id: first.grant.id });
        const paused = (await responsibilities.act({ userId: A, id: first.grant.id, action: 'pause', expectedRevision: current.revision })).responsibility;
        // Paused, the grant is still there: the request stays answerable.
        expect(await requests.withdrawStale()).toBe(0);
        await responsibilities.update({ userId: A, id: first.grant.id, expectedRevision: paused.revision, body: { operations: [READ] } });
        expect(await caught(decide(first.card, 'approve'))).toMatchObject({ code: 'STALE_GATE' });
        expect(await requests.get(first.request.id)).toMatchObject({ status: 'WITHDRAWN', resultCode: 'GRANT_GONE' });

        // The steward's sweep withdraws what nobody pressed.
        const second = await requested();
        const held = await responsibilities.get({ userId: A, id: second.grant.id });
        await responsibilities.act({ userId: A, id: second.grant.id, action: 'revoke', expectedRevision: held.revision });
        expect(await requests.withdrawStale()).toBe(1);
        expect(await requests.get(second.request.id)).toMatchObject({ status: 'WITHDRAWN', resultCode: 'GRANT_GONE' });

        const third = await requested();
        await connectorService.revoke({ userId: A, connectorId: 'notebook' });
        expect(await requests.get(third.request.id)).toMatchObject({ status: 'WITHDRAWN', resultCode: 'REVOKED' });
        expect(await needsYou()).toEqual([]);
        expect(calls('approved')).toEqual([]);
        expect(entries()).toHaveLength(3);
    }, 120_000);

    test('erasure deletes the person\'s requests, and retention keeps only what is waiting', async () => {
        const { request } = await requested();
        expect((await dormantData.countAssistantResponsibilities(A)).connectorRequests).toBe(1);
        const old = '2020-01-01 00:00:00';
        await db.run(
            `INSERT INTO assistant_connector_requests
                (ownerUserId, responsibilityId, runId, operationId, connector, resource, operation, target, label, status, createdAt, decidedAt)
             VALUES (@u, @r, NULL, 'old:1', 'notebook', 'garden', 'remove', '9', 'entry 9', 'DECLINED', @old, @old)`,
            { u: A, r: request.responsibilityId, old }
        );
        await db.run('UPDATE assistant_connector_requests SET createdAt = @old WHERE id = @id', { id: request.id, old });
        expect(await requests.prune({ days: 30 })).toBe(1);
        expect((await asked()).map(row => row.status)).toEqual(['PENDING']);
        expect((await steward.sweep({ retention: true })).skipped).toBe(false);

        expect((await dormantData.forgetAssistantResponsibilities(A)).connectorRequests).toBe(1);
        expect(await asked()).toEqual([]);
        expect((await dormantData.auditAssistantResponsibilities(A)).connectorRequests).toBe(0);
    }, 60_000);
});
