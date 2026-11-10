/**
 * The outcome summary of delegated responsibilities (DA-6,
 * documentation/delegated_pilot.md) and what a run records about the
 * instructions and the model it was given, against a throwaway database
 * (no provider, no network).
 *
 * The properties under test: a result code checked is counted apart from
 * one a run only reported; notes created and tool calls are never a
 * measure; requests, refusals, withdrawals and rollbacks are counted where
 * they happened; cost comes from the work ledger, or from the runs' own
 * counts where the ledger's report is not installed, and says which; the
 * period and the owner bound everything; what the person said about a
 * finding is counted as their answer, never as the responsibility's own
 * change; and the summary carries counts and
 * names, never a title or a result text.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-outcome-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const personalAi = require('@goobster/core/services/personalAiService');
const outcomes = require('@goobster/core/services/assistantOutcomeService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runs = require('@goobster/core/services/assistantRunService');
const runner = require('@goobster/core/services/assistantRunnerService');
const control = require('@goobster/core/services/assistantControlService');
const policies = require('@goobster/core/services/attentionPolicyService');
const identityService = require('@goobster/core/services/identityService');
const instanceState = require('@goobster/core/services/instanceStateService');
const { useState } = require('./helpers/featureFixtures');

const A = '961000000000000001';
const B = '961000000000000002';
const DAY = 86400000;
const utc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const ago = (days) => utc(new Date(Date.now() - days * DAY));
const READ_NOTES = { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } };

afterAll(async () => {
    initiatives.stopListening();
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    runner._reset();
    delete outcomes._ledger;
    for (const table of [
        'kg_change_sets', 'assistant_process_repairs', 'assistant_run_operations', 'assistant_runs', 'assistant_initiatives',
        'assistant_source_cursors', 'assistant_update_receipts', 'assistant_updates', 'assistant_responsibility_revisions',
        'assistant_responsibilities', 'attention_policies', 'attention_items', 'inbox_items', 'usage_reservations',
        'resource_events', 'work_failures', 'assistant_feedback', 'assistant_source_weights'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    for (const key of [control.KEY_CAPS, control.KEY_PAUSED]) await instanceState.remove(key);
    // A is the installation's owner (the pilot's person); B is somebody else.
    await db.run('DELETE FROM app_accounts WHERE principalId IN (@a, @b)', { a: A, b: B });
    await identityService.ensureLegacyPrincipal({ discordId: A, displayName: 'owner' });
    await identityService.grantAccount({ principalId: A, entitlement: 'bootstrap', role: 'operator' });
    await policies.enroll({ userId: A, initiative: 'assist' });
    await policies.enroll({ userId: B, initiative: 'assist' });
});

/* ---------------------------------------------------------------------- */
/* Fixtures: plain rows, as the services leave them                        */
/* ---------------------------------------------------------------------- */

async function grant(title, { userId = A, body = {}, activate = true } = {}) {
    const { responsibility } = await responsibilities.create({ userId, body: { title, operations: [READ_NOTES], ...body } });
    if (!activate) return responsibility;
    return (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
}

let seq = 0;
async function work(responsibility, { status = 'COMPLETED', stopCode = null, planStepId = null, createdAt = ago(1) } = {}) {
    seq += 1;
    return Number(await db.insert(
        `INSERT INTO assistant_initiatives (responsibilityId, responsibilityRevision, ownerUserId, actingUserId, sourceKind, sourceId,
            sourceRevision, dedupeKey, title, status, stopCode, planStepId, createdAt)
         VALUES (@rid, @rev, @owner, @owner, 'attention_item', @source, 'r1', @key, 'A private title', @status, @stopCode, @planStepId, @createdAt)`,
        {
            rid: responsibility.id, rev: responsibility.revision, owner: responsibility.ownerUserId, source: String(seq), key: `k${seq}`,
            status, stopCode, planStepId, createdAt
        }
    ));
}

async function run(responsibility, {
    status = 'COMPLETED', outcome = 'DONE', stopCode = null, planStepId = null, tokensUsed = 0, searches = 0, computeSeconds = 0,
    startedAt = ago(1), prompt = 'v1-aaaaaaaaaaaa', provider = 'openai', model = 'model-a',
    initiativeStatus = status === 'RUNNING' ? 'RUNNING' : status === 'CANCELLED' ? 'CANCELLED' : status
} = {}) {
    const initiativeId = await work(responsibility, { status: initiativeStatus, stopCode, planStepId, createdAt: startedAt });
    return Number(await db.insert(
        `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId, status,
            outcome, stopCode, tokensUsed, searches, computeSeconds, resultTitle, resultSummary, startedAt, promptVersion, provider, model)
         VALUES (@initiativeId, @rid, @rev, @owner, @owner, @owner, @status, @outcome, @stopCode, @tokensUsed, @searches, @computeSeconds,
            'A private result title', 'A private result text', @startedAt, @prompt, @provider, @model)`,
        {
            initiativeId, rid: responsibility.id, rev: responsibility.revision, owner: responsibility.ownerUserId, status,
            outcome: status === 'COMPLETED' ? outcome : null, stopCode, tokensUsed, searches, computeSeconds, startedAt, prompt, provider, model
        }
    ));
}

async function operation(runId, tool, { effect = 'read', status = 'SUCCEEDED', refusalCode = null, resultText = 'Done.' } = {}) {
    seq += 1;
    return db.insert(
        `INSERT INTO assistant_run_operations (runId, ownerUserId, tool, argsHash, effect, status, refusalCode, resultText)
         VALUES (@runId, @owner, @tool, @hash, @effect, @status, @refusalCode, @resultText)`,
        { runId, owner: A, tool, hash: `h${seq}`, effect, status, refusalCode, resultText }
    );
}

async function changeSet(responsibility, kind, status, { createdAt = ago(1), policy = null } = {}) {
    return db.insert(
        `INSERT INTO kg_change_sets (userId, guildId, scopeKey, kind, status, responsibilityId, operationsJson, policyCode, createdAt)
         VALUES (@owner, @guild, @scope, @kind, @status, @rid, '[]', @policy, @createdAt)`,
        {
            owner: responsibility.ownerUserId, guild: `dm:${responsibility.ownerUserId}`, scope: `USER:${responsibility.ownerUserId}`,
            kind, status, rid: responsibility.id, policy, createdAt
        }
    );
}

/** An answer the person gave about a finding or a proposal (delegated_feedback.md), as assistantFeedbackService leaves it. */
async function answer(responsibility, kind, { createdAt = ago(1) } = {}) {
    return db.insert(
        `INSERT INTO assistant_feedback (userId, responsibilityId, adapter, kind, effectCode, createdAt)
         VALUES (@owner, @rid, 'followed_source', @kind, 'COUNTED', @createdAt)`,
        { owner: responsibility.ownerUserId, rid: responsibility.id, kind, createdAt }
    );
}

async function repair(responsibility, status, { actorKind = 'assistant', verified = false, rollback = null, appliedAt = ago(1) } = {}) {
    seq += 1;
    return db.insert(
        `INSERT INTO assistant_process_repairs (ownerUserId, processKind, processId, status, action, actorKind, responsibilityId, rollback, appliedAt, verifiedAt)
         VALUES (@owner, 'automation', @pid, @status, 'rerun', @actorKind, @rid, @rollback, @appliedAt, @verifiedAt)`,
        {
            owner: responsibility.ownerUserId, pid: String(seq), status, actorKind, rid: actorKind === 'assistant' ? responsibility.id : null,
            rollback, appliedAt, verifiedAt: verified ? appliedAt : null
        }
    );
}

async function update(responsibility, { gate = false, resolved = false, outbound = null, createdAt = ago(1) } = {}) {
    seq += 1;
    return db.insert(
        `INSERT INTO assistant_updates (audienceKind, audienceKey, audienceUserId, identityKey, kind, fingerprint, sequence, title, componentsJson,
            responsibilityId, gateJson, gateResolvedAt, outboundKind, outboundAt, happenedAt, createdAt)
         VALUES ('user', @owner, @owner, @key, @kind, @key, @sequence, 'A private update title', '["research"]',
            @rid, @gate, @resolvedAt, @outbound, @outboundAt, @createdAt, @createdAt)`,
        {
            owner: responsibility.ownerUserId, key: `outcome:${seq}`, sequence: seq, kind: gate ? 'question' : 'finding', rid: responsibility.id,
            gate: gate ? JSON.stringify({ kind: 'question', id: `outcome:${seq}` }) : null, resolvedAt: gate && resolved ? createdAt : null,
            outbound, outboundAt: outbound ? createdAt : null, createdAt
        }
    );
}

const reserve = (workKind, workId, { status = 'settled', actual = 0, estimated = 0, payer = A } = {}) => db.insert(
    `INSERT INTO usage_reservations (actor, payer, workKind, workId, estimatedTokens, actualTokens, status)
     VALUES (@payer, @payer, @workKind, @workId, @estimated, @actual, @status)`,
    { payer, workKind, workId: String(workId), estimated, actual: status === 'settled' ? actual : null, status }
);

const summary = (params = {}) => outcomes.summarize({ userId: A, ...params });
const row = (result, responsibility) => result.responsibilities.find(entry => entry.id === responsibility.id);

/* ---------------------------------------------------------------------- */

describe('the period', () => {
    test('defaults to 14 days, takes 1 to 90, and refuses anything else', async () => {
        const now = new Date('2026-11-10T12:00:00Z');
        expect((await summary({ now })).period).toEqual({ from: '2026-10-27 12:00:00', to: '2026-11-10 12:00:00', days: 14 });
        expect((await summary({ now, days: '7' })).period).toMatchObject({ from: '2026-11-03 12:00:00', days: 7 });
        expect((await summary({ now, days: 90 })).period.days).toBe(90);
        expect((await summary({ now, from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-04T00:00:00Z') })).period)
            .toEqual({ from: '2026-11-01 00:00:00', to: '2026-11-04 00:00:00', days: 3 });
        for (const days of [0, 91, -1, 1.5, 'week']) {
            await expect(summary({ days })).rejects.toMatchObject({ code: 'BAD_PERIOD', status: 400 });
        }
        await expect(summary({ from: new Date('2026-11-04T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') })).rejects.toMatchObject({ code: 'BAD_PERIOD' });
        await expect(outcomes.summarize({})).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    });

    test('with nothing delegated the summary is empty, with no figure where there is no result', async () => {
        const result = await summary();
        expect(result.responsibilities).toEqual([]);
        expect(result.totals).toMatchObject({
            runs: { total: 0 }, verified: { planSteps: 0, repairs: 0, total: 0 }, cost: { tokens: 0, provisional: false },
            tokensPerVerified: null, tokensPerResult: null
        });
        expect(result).toMatchObject({
            prompt: runs.promptVersion().label, costSource: 'ledger',
            notMeasured: ['usefulness', 'unwanted_actions', 'foreground_responsiveness']
        });
    });
});

describe('what is counted', () => {
    test('verified results apart from reported ones, and requests, refusals, changes and withdrawals where they happened', async () => {
        const plan = await grant('Carry the plan forward');
        const notes = await grant('Keep my notes current', { body: { rules: { interruption: 'digest' }, budgets: { modelTokens: 50000, searches: 4, repairAttempts: 2 } } });

        // The plan responsibility: two verified steps, one that failed its check, one waiting on access.
        await run(plan, { planStepId: 11 });
        await run(plan, { planStepId: 12 });
        await run(plan, { planStepId: 13, status: 'FAILED', stopCode: 'VERIFICATION_FAILED' });
        await run(plan, { planStepId: 14, status: 'WAITING', stopCode: 'RESOURCE_UNAVAILABLE' });
        await work(plan, { status: 'SUPERSEDED', stopCode: 'STEERED' });
        await work(plan, { status: 'CANDIDATE' });
        await repair(plan, 'OBSERVING', { verified: true });
        await repair(plan, 'SUCCEEDED', { verified: true });
        await repair(plan, 'FAILED', { rollback: 'restored' });
        await repair(plan, 'VERIFYING');
        // A repair the person approved themselves is theirs, not the responsibility's.
        await repair(plan, 'SUCCEEDED', { actorKind: 'person', verified: true });

        // The notes responsibility: a finding, a "nothing needs you", a cancelled run and one still running.
        const finding = await run(notes, { searches: 2, computeSeconds: 30 });
        await run(notes, { outcome: 'NO_CHANGE', provider: 'anthropic', model: 'model-b', prompt: 'v1-bbbbbbbbbbbb' });
        await run(notes, { status: 'CANCELLED', stopCode: 'LEASE_LOST' });
        await run(notes, { status: 'RUNNING' });
        await run(notes, { status: 'REVIEW', stopCode: 'UNCERTAIN_WRITE' });
        await operation(finding, 'lookupNotes');
        await operation(finding, 'lookupNotes');
        await operation(finding, 'searchWeb', { status: 'REFUSED', refusalCode: 'OPERATION_OUT_OF_SCOPE' });
        await operation(finding, 'writeConnector', { effect: 'write', status: 'REFUSED', refusalCode: 'EXTERNAL_BUDGET' });
        await operation(finding, 'addGeneratedNote', { effect: 'write', resultText: 'Added note "x".' });
        await operation(finding, 'addGeneratedNote', { effect: 'write', resultText: 'Added note "y".' });
        await operation(finding, 'writeConnector', { effect: 'write', resultText: 'added 1 block to the page' });
        // A write that answered "Not ..." changed nothing; a proposal is a request, not a change.
        await operation(finding, 'amendGeneratedNote', { effect: 'write', resultText: 'Not amended: the note changed since you read it.' });
        await operation(finding, 'proposeNoteChange', { effect: 'write', resultText: 'Proposed a change to note "x".' });
        await operation(finding, 'writeConnector', { effect: 'write', status: 'UNCERTAIN', resultText: null });
        await changeSet(notes, 'saved_note_edit', 'APPLIED');
        await changeSet(notes, 'saved_note_edit', 'REJECTED');
        await changeSet(notes, 'saved_note_edit', 'STALE');
        await changeSet(notes, 'saved_note_edit', 'PROPOSED');
        await changeSet(notes, 'saved_note_edit', 'REVERTED');
        await changeSet(notes, 'direct_change', 'APPLIED');
        await changeSet(notes, 'direct_change', 'REVERTED');
        // What the person said: counted as their answers. The undoable record of "this is wrong" and
        // "keep this wording" is a change to a note, and is not the responsibility's change.
        for (const kind of ['useful', 'useful', 'already_knew', 'wrong', 'less_of_this', 'wrong_time', 'keep_wording', 'stop_responsibility', 'ignored', 'ignored', 'ignored']) {
            await answer(notes, kind);
        }
        await changeSet(notes, 'direct_change', 'APPLIED', { policy: 'FEEDBACK_WRONG' });
        await changeSet(notes, 'direct_change', 'REVERTED', { policy: 'FEEDBACK_KEEP' });
        await update(notes, { outbound: 'digest' });
        await update(notes, { outbound: 'digest' });
        await update(notes, { gate: true, resolved: true, outbound: 'contact' });
        await update(notes, { gate: true });

        const result = await summary();
        expect(row(result, plan)).toMatchObject({
            title: 'Carry the plan forward', status: 'ACTIVE',
            work: { proposed: 6, completed: 2, failed: 1, waiting: 1, open: 1, withdrawn: 1 },
            runs: { total: 4, completed: 2, failed: 1, waiting: 1, review: 0, cancelled: 0, running: 0 },
            verified: { planSteps: 2, repairs: 2, total: 4 },
            reported: { findings: 0, noChange: 0 },
            repairs: { applied: 4, verified: 2, succeeded: 1, failed: 1, rolledBack: 1 },
            stopped: { total: 2, byCode: { VERIFICATION_FAILED: 1, RESOURCE_UNAVAILABLE: 1 } },
            refusals: { total: 0, byCode: {} },
            limits: { interruption: 'home', repairAttempts: null },
            models: [{ provider: 'openai', model: 'model-a', prompt: 'v1-aaaaaaaaaaaa', runs: 4 }]
        });
        expect(row(result, notes)).toMatchObject({
            work: { proposed: 5, completed: 2, waiting: 1, open: 1, withdrawn: 1 },
            runs: { total: 5, completed: 2, cancelled: 1, running: 1, review: 1 },
            verified: { planSteps: 0, repairs: 0, total: 0 },
            reported: { findings: 1, noChange: 1 },
            // Two notes added and one line appended outside; the refused, the unchanged and the proposed are not changes.
            changes: { applied: 3, outside: 1 },
            notes: { proposed: 5, applied: 2, dismissed: 1, stale: 1, waiting: 1, direct: 2, undone: 2 },
            requests: { asked: 2, answered: 1, open: 1 },
            refusals: { total: 2, byCode: { OPERATION_OUT_OF_SCOPE: 1, EXTERNAL_BUDGET: 1 } },
            stopped: { total: 2, byCode: { LEASE_LOST: 1, UNCERTAIN_WRITE: 1 } },
            review: 1,
            delivery: { updates: 4, digest: 2, contacts: 1 },
            feedback: { useful: 2, alreadyKnew: 1, wrong: 1, lessOfThis: 1, wrongTime: 1, keptWording: 1, stopped: 1, ignored: 3 },
            cost: { searches: 2, computeSeconds: 30 },
            limits: { modelTokens: 50000, searches: 4, repairAttempts: 2, interruption: 'digest' }
        });
        expect(row(result, notes).models).toEqual(expect.arrayContaining([
            { provider: 'openai', model: 'model-a', prompt: 'v1-aaaaaaaaaaaa', runs: 4 },
            { provider: 'anthropic', model: 'model-b', prompt: 'v1-bbbbbbbbbbbb', runs: 1 }
        ]));
        expect(result.totals).toMatchObject({
            runs: { total: 9, completed: 4 }, verified: { planSteps: 2, repairs: 2, total: 4 }, reported: { findings: 1, noChange: 1 },
            refusals: { total: 2 }, requests: { asked: 2 }, feedback: { useful: 2, wrong: 1, ignored: 3 }
        });
        expect(row(result, plan).feedback).toEqual({ useful: 0, alreadyKnew: 0, wrong: 0, lessOfThis: 0, wrongTime: 0, keptWording: 0, stopped: 0, ignored: 0 });
        // Counts and names only: no title of a piece of work, an update or a result, and no result text.
        expect(JSON.stringify(result)).not.toMatch(/A private/);
    });

    test('only what happened in the period, and only this person\'s', async () => {
        const mine = await grant('Mine');
        const theirs = await grant('Theirs', { userId: B });
        await run(mine, { planStepId: 1 });
        await run(mine, { planStepId: 2, startedAt: ago(20) });
        await repair(mine, 'SUCCEEDED', { verified: true, appliedAt: ago(20) });
        await changeSet(mine, 'saved_note_edit', 'APPLIED', { createdAt: ago(20) });
        await update(mine, { gate: true, createdAt: ago(20) });
        await answer(mine, 'useful', { createdAt: ago(20) });
        await run(theirs, { planStepId: 3 });
        await answer(theirs, 'wrong');

        const recent = await summary();
        expect(recent.responsibilities.map(entry => entry.title)).toEqual(['Mine']);
        expect(row(recent, mine)).toMatchObject({
            work: { proposed: 1 }, runs: { total: 1 }, verified: { planSteps: 1, repairs: 0, total: 1 }, notes: { proposed: 0 }, requests: { asked: 0 },
            feedback: { useful: 0, wrong: 0 }
        });
        expect(row(await summary({ days: 30 }), mine)).toMatchObject({
            work: { proposed: 2 }, runs: { total: 2 }, verified: { planSteps: 2, repairs: 1, total: 3 }, notes: { proposed: 1, applied: 1 }, requests: { asked: 1, open: 1 },
            feedback: { useful: 1, wrong: 0 }
        });
        expect((await outcomes.summarize({ userId: B })).responsibilities.map(entry => entry.title)).toEqual(['Theirs']);
    });

    test('a live responsibility is listed even when it did nothing; an ended one only when it did', async () => {
        const idle = await grant('Idle and active');
        const draft = await grant('Never activated', { activate: false });
        const ended = await grant('Revoked, did nothing');
        await responsibilities.act({ userId: A, id: ended.id, action: 'revoke', expectedRevision: ended.revision });
        const worked = await grant('Revoked after working');
        await run(worked, {});
        await responsibilities.act({ userId: A, id: worked.id, action: 'revoke', expectedRevision: worked.revision });

        const result = await summary();
        expect(result.responsibilities.map(entry => entry.title)).toEqual(['Idle and active', 'Revoked after working']);
        expect(row(result, idle)).toMatchObject({ status: 'ACTIVE', runs: { total: 0 }, tokensPerVerified: null, tokensPerResult: null, models: [] });
        expect(row(result, draft)).toBeUndefined();
        expect(row(result, worked)).toMatchObject({ status: 'REVOKED', reported: { findings: 1 } });
    });
});

describe('cost', () => {
    test('comes from the work ledger: settled tokens of the runs and of the labels judged, held tokens apart, with resources and failures', async () => {
        const plan = await grant('Carry the plan forward');
        const other = await grant('Something else');
        const done = await run(plan, { planStepId: 1, tokensUsed: 999999 });
        const second = await run(plan, { planStepId: 2 });
        const found = await run(other, {});
        await reserve('assistant_run', done, { actual: 1200 });
        await reserve('assistant_run', done, { actual: 300 });
        await reserve('assistant_run', second, { status: 'held', estimated: 5000 });
        await reserve('assistant_run', second, { status: 'released', estimated: 700 });
        await reserve('assistant_run', found, { actual: 400 });
        await reserve('assistant_classification', plan.id, { actual: 60 });
        // Somebody else's run with the same number in another kind of work is not this one's.
        await reserve('expedition', done, { actual: 9000 });
        await db.run("INSERT INTO resource_events (kind, quantity, workKind, workId, payer) VALUES ('search', 3, 'assistant_run', @id, @a)", { id: String(done), a: A });
        await db.run("INSERT INTO work_failures (kind, workId, phase, code) VALUES ('assistant_run', @id, 'run', 'PROVIDER_ERROR')", { id: String(second) });

        const result = await summary();
        expect(result.costSource).toBe('ledger');
        expect(row(result, plan)).toMatchObject({
            cost: { tokens: 1560, heldTokens: 5000, resources: { search: 3 }, failures: 1, provisional: true },
            verified: { total: 2 }, tokensPerVerified: 780, tokensPerResult: 780
        });
        expect(row(result, other)).toMatchObject({
            cost: { tokens: 400, heldTokens: 0, provisional: false }, tokensPerVerified: null, tokensPerResult: 400
        });
        expect(result.totals).toMatchObject({ cost: { tokens: 1960, heldTokens: 5000, provisional: true }, tokensPerVerified: 980, tokensPerResult: 653 });
    });

    test('where the ledger\'s report is not installed, the runs\' own counts are used and marked provisional', async () => {
        outcomes._ledger = () => null;
        const plan = await grant('Carry the plan forward');
        const done = await run(plan, { planStepId: 1, tokensUsed: 2500 });
        await run(plan, { planStepId: 2, tokensUsed: 0 });
        await reserve('assistant_run', done, { actual: 1200 });

        const result = await summary();
        expect(result.costSource).toBe('runs');
        expect(row(result, plan)).toMatchObject({ cost: { tokens: 2500, heldTokens: 0, provisional: true }, tokensPerVerified: 1250 });
    });
});

describe('what a run records about what it was given', () => {
    let callId = 0;
    const call = (name, args = {}) => ({ id: `o${++callId}`, name, arguments: JSON.stringify(args) });

    async function queued(userId = A) {
        const item = await db.insert(
            `INSERT INTO attention_items (guildId, userId, kind, subject, goal, state)
             VALUES (@guildId, @userId, 'goal', @subject, 'Keep my garden notes accurate', 'active')`,
            { guildId: `dm:${userId}`, userId, subject: `outcome-${++seq}` }
        );
        const responsibility = await grant('Keep my garden notes accurate', { userId, body: { attentionItemId: item } });
        await db.run('UPDATE attention_items SET goal = @goal WHERE id = @id', { id: item, goal: `Keep my garden notes accurate, take ${++seq}` });
        const [id] = (await initiatives.reconcileResponsibility(responsibility.id)).proposed;
        const proposed = await initiatives.get({ userId, id });
        await initiatives.act({ userId, id, action: 'queue', expectedRevision: proposed.revision });
        return { responsibility, id };
    }
    const finish = () => jest.spyOn(aiService, 'chat').mockResolvedValue({
        content: '', toolCalls: [call('finish', { outcome: 'no_change', title: 'Checked the notes' })]
    });

    test('the prompt version, the provider and the model, on the run row and in what the person reads', async () => {
        const { id } = await queued();
        finish();
        const out = await runner.tick({ wait: true });
        expect(out.results[0]).toMatchObject({ status: 'COMPLETED' });

        const stored = await db.get('SELECT promptVersion, provider, model FROM assistant_runs WHERE initiativeId = @id', { id });
        const route = await aiService.routeFor({});
        expect(stored).toEqual({ promptVersion: runs.promptVersion().label, provider: route.provider, model: route.model });
        expect(stored.promptVersion).toMatch(/^v\d+-[0-9a-f]{12}$/);
        expect(stored.provider).toBeTruthy();
        expect(stored.model).toBeTruthy();

        const shown = await runs.forInitiative({ userId: A, initiativeId: id });
        expect(shown).toMatchObject(stored);
        const result = await summary();
        expect(result.responsibilities[0].models).toEqual([{ provider: stored.provider, model: stored.model, prompt: stored.promptVersion, runs: 1 }]);
    });

    test('a person\'s own connection is recorded as the route their run took', async () => {
        const { id } = await queued();
        jest.spyOn(personalAi, 'selection').mockImplementation(async (userId, fn) => (
            userId === A && fn === 'chat' ? { completionUrl: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'never-recorded', model: 'vendor/model-x', userId } : null
        ));
        jest.spyOn(personalAi, 'chat').mockResolvedValue({ content: '', toolCalls: [call('finish', { outcome: 'no_change', title: 'Checked the notes' })] });
        await runner.tick({ wait: true });
        const stored = await db.get('SELECT * FROM assistant_runs WHERE initiativeId = @id', { id });
        expect(stored).toMatchObject({ status: 'COMPLETED', provider: 'openrouter', model: 'vendor/model-x' });
        expect(JSON.stringify(stored)).not.toContain('never-recorded');
        expect(await aiService.routeFor({ usageContext: { userId: A, guildId: `dm:${A}` } })).toEqual({ provider: 'openrouter', model: 'vendor/model-x', personal: true });
        // In a server the person's own connection is not used, so it is not the route either.
        expect((await aiService.routeFor({ usageContext: { userId: A, guildId: '123' } })).personal).toBe(false);
    });

    test('a resumed attempt names the instructions it resumed under; a route that cannot be read is recorded as unknown', async () => {
        const { id } = await queued();
        const chat = jest.spyOn(aiService, 'chat').mockRejectedValueOnce(Object.assign(new Error('No AI provider is configured'), { code: 'NO_PROVIDER' }));
        await runner.tick({ wait: true });
        const parked = await db.get('SELECT * FROM assistant_runs WHERE initiativeId = @id', { id });
        expect(parked).toMatchObject({ status: 'WAITING', stopCode: 'NO_PROVIDER', promptVersion: runs.promptVersion().label });

        // The row is from an older build: no version on it. The next attempt fills it in.
        await db.run('UPDATE assistant_runs SET promptVersion = NULL, provider = NULL, model = NULL WHERE id = @id', { id: parked.id });
        expect(await runs.forInitiative({ userId: A, initiativeId: id })).toMatchObject({ promptVersion: null, provider: null, model: null });
        await initiatives.requeueDue({ now: new Date(Date.now() + 2 * 3600000) });
        jest.spyOn(aiService, 'routeFor').mockRejectedValue(new Error('unreadable'));
        chat.mockResolvedValue({ content: '', toolCalls: [call('finish', { outcome: 'no_change', title: 'Checked the notes' })] });
        await runner.tick({ wait: true });
        const resumed = await db.get('SELECT * FROM assistant_runs WHERE initiativeId = @id', { id });
        expect(resumed).toMatchObject({
            id: parked.id, status: 'COMPLETED', attempt: 2, promptVersion: runs.promptVersion().label, provider: null, model: null
        });
    });
});

describe('the portal route', () => {
    let server;
    let base;
    beforeAll(async () => {
        const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
        const { DisabledGateway } = require('@goobster/core/gateway');
        const app = require('express')();
        app.use(createWebAppApp(createWebAppContext({ gateway: new DisabledGateway(), config: { webapp: { enabled: true, devMode: true } } })));
        server = require('node:http').createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    async function cookie(userId) {
        const login = await fetch(`${base}/api/app/auth/dev-session`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, name: userId })
        });
        expect(login.status).toBe(200);
        return login.headers.get('set-cookie').split(';')[0];
    }

    test('GET /api/app/assistant/outcomes is the signed-in person\'s own summary', async () => {
        const mine = await grant('Mine');
        await run(mine, { planStepId: 1 });
        await grant('Theirs', { userId: B });

        expect((await fetch(`${base}/api/app/assistant/outcomes`)).status).toBe(401);
        const own = await cookie(A);
        const response = await fetch(`${base}/api/app/assistant/outcomes?days=7`, { headers: { Cookie: own } });
        expect(response.status).toBe(200);
        const { outcomes: body } = await response.json();
        expect(body.period.days).toBe(7);
        expect(body.responsibilities.map(entry => entry.title)).toEqual(['Mine']);
        expect(body.responsibilities[0].verified).toEqual({ planSteps: 1, repairs: 0, total: 1 });

        const bad = await fetch(`${base}/api/app/assistant/outcomes?days=400`, { headers: { Cookie: own } });
        expect(bad.status).toBe(400);
        expect((await bad.json()).error.code).toBe('BAD_PERIOD');
        const other = await (await fetch(`${base}/api/app/assistant/outcomes`, { headers: { Cookie: await cookie(B) } })).json();
        expect(other.outcomes.responsibilities.map(entry => entry.title)).toEqual(['Theirs']);
    });
});
