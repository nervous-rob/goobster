/**
 * Repairing a failing process (DA-5c, ADR 0029), against a throwaway
 * database. Scripted model, no provider, no network.
 *
 * The properties under test: a repair is one of a closed list of typed
 * actions and is recorded before anything is touched; without a grant
 * nothing is changed and the person is offered the one repair that needs
 * no judgement; with a grant the assistant applies a repair only through a
 * delegated run whose `repairProcess` call passed `authorize()` for exactly
 * that process; whether it worked is read from the process's own typed
 * observations (a clean run, fresh output where the contract asks for it,
 * dependents freed), then from its next normal run; a repair that fails is
 * undone where that is safe, counted, and after the allowed attempts the
 * person is asked what to do and nothing more is tried; and the pilot gate
 * and the host's stop-all hold all of it.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-repair-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const repairs = require('@goobster/core/services/assistantProcessRepairService');
const processes = require('@goobster/core/services/assistantProcessService');
const incidents = require('@goobster/core/services/assistantIncidentService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const runner = require('@goobster/core/services/assistantRunnerService');
const runs = require('@goobster/core/services/assistantRunService');
const updates = require('@goobster/core/services/assistantUpdateService');
const gates = require('@goobster/core/services/assistantGateService');
const inbox = require('@goobster/core/services/inboxService');
const control = require('@goobster/core/services/assistantControlService');
const policies = require('@goobster/core/services/attentionPolicyService');
const sources = require('@goobster/core/services/followedSourceService');
const steward = require('@goobster/core/services/assistantStewardService');
const privacy = require('@goobster/core/services/privacyService');
const originRuns = require('@goobster/core/services/assistant/originRuns');
const { INVENTORY } = require('@goobster/core/services/accountExportData');
const kit = require('./helpers/opportunityKit');
const { useState } = require('./helpers/featureFixtures');

const { A, B, OWNER } = kit;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const utc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const after = (ms) => new Date(Date.now() + ms);

const TABLES = [
    'assistant_process_repairs', 'assistant_process_cleanups', 'assistant_process_lifecycle',
    'assistant_process_incident_members', 'assistant_process_incidents', 'assistant_process_observations',
    'assistant_process_contracts', 'automations', 'project_triggers', 'kg_nodes', 'source_fetch_hosts', 'resource_events'
];

const realFetch = sources.fetch;

afterAll(async () => {
    initiatives.stopListening();
    sources.fetch = realFetch;
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    jest.restoreAllMocks();
    sources.fetch = jest.fn(async () => { throw new Error('no network in this spec'); });
    await kit.reset();
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`, {});
    await kit.openPilot();
    await policies.enroll({ userId: A, initiative: 'assist' });
});

/* ---------------------------------------------------------------------- */
/* Fixtures                                                                */
/* ---------------------------------------------------------------------- */

async function automation(name, { userId = A } = {}) {
    const id = Number(await db.insert(
        `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun)
         VALUES (@userId, @guild, @channel, @name, 'do it', '0 3 * * *', @nextRun)`,
        { userId, guild: `dm:${userId}`, channel: `inbox:${userId}`, name, nextRun: utc(after(20 * HOUR)) }
    ));
    return { kind: 'automation', id, ref: `automation:${id}`, userId, name };
}

async function source(label, { userId = A, url = `https://example.com/${encodeURIComponent(label)}` } = {}) {
    const topicId = Number(await db.insert(
        "INSERT INTO kg_nodes (guildId, scopeKey, type, label, curation) VALUES (@guild, @scope, 'concept', @label, 'saved')",
        { guild: `dm:${userId}`, scope: `USER:${userId}`, label: `${label} topic` }
    ));
    const id = Number(await db.insert(
        `INSERT INTO followed_sources (userId, topicNodeId, url, label, kind, initialized, lastHash, lastText, etag, lastCheckedAt)
         VALUES (@userId, @topicId, @url, @label, 'page', 1, 'hash-1', 'the page as last fetched', 'etag-1', @checked)`,
        { userId, topicId, url, label, checked: utc(after(-2 * HOUR)) }
    ));
    return { kind: 'followed_source', id, ref: `followed_source:${id}`, userId, name: label, url };
}

let fires = 0;
/** One occurrence of a process, as the scheduler that owns it records it. */
async function ran(item, outcome = 'ok', { code = null, at = new Date(), key = null, phase = null, output = null } = {}) {
    fires += 1;
    const occurrenceKey = key || `fire:t${fires}`;
    expect(await processes.record({
        processKind: item.kind, processId: item.id, ownerUserId: item.userId, occurrenceKey,
        phase: phase || (item.kind === 'followed_source' ? 'execution' : 'outcome'), outcome, reasonCode: code, observedAt: at
    })).toBe(true);
    if (output) {
        await processes.record({
            processKind: item.kind, processId: item.id, ownerUserId: item.userId, occurrenceKey,
            phase: 'output', outcome: output === 'fresh' ? 'ok' : 'skipped', reasonCode: output === 'fresh' ? 'CONTENT_CHANGED' : 'NO_CHANGE',
            keepResult: true, observedAt: at
        });
    }
    // The scheduler moves an automation's next fire on once it has run.
    if (item.kind === 'automation') {
        await db.run('UPDATE automations SET nextRun = @next WHERE id = @id', { id: item.id, next: utc(new Date(at.getTime() + 20 * HOUR)) });
    }
}

const day = (offset = 0) => `day:${utc(after(offset * DAY)).slice(0, 10)}`;

/** Three failed occurrences in a row: enough for an incident. */
async function failing(item, code = 'PROVIDER_TIMEOUT') {
    if (item.kind === 'followed_source') {
        for (const offset of [-2, -1, 0]) await ran(item, 'failed', { code, key: day(offset), at: after(offset * DAY - 2 * HOUR) });
        return;
    }
    for (const hours of [3, 2, 1]) await ran(item, 'failed', { code, at: after(-hours * HOUR) });
    await db.run('UPDATE automations SET nextRun = @next WHERE id = @id', { id: item.id, next: utc(after(20 * HOUR)) });
}

const pass = (now = new Date(), userId = A) => incidents.reconcile({ userId, now });
const repairRows = (item) => db.all(
    'SELECT * FROM assistant_process_repairs WHERE processKind = @kind AND processId = @id ORDER BY id', { kind: item.kind, id: String(item.id) }
);
const latest = async (item) => (await repairRows(item)).pop() || null;
const updateFor = (item) => db.get(
    'SELECT * FROM assistant_updates WHERE audienceUserId = @userId AND identityKey = @key',
    { userId: item.userId, key: `process_repair:${item.ref}` }
);
const cardFor = async (item) => gates.card({ userId: item.userId, ref: (await updateFor(item)).id });
const decide = async (item, option, surface = 'home') => {
    const card = await cardFor(item);
    return gates.decide({ userId: item.userId, ref: card.ref, option, occurrence: card.occurrence, revision: card.revision, surface });
};
const needsYou = async (userId = A) => (await inbox.list({ userId, view: 'needs_you', limit: 20 })).needsYou;
const listed = async (item) => (await processes.list({ userId: item.userId })).processes.find(row => row.ref === item.ref);

/** An ACTIVE responsibility that may repair exactly these processes, with Attention letting it act on schedules. */
async function grant(refs, { userId = A, attempts = undefined, operations = ['process.repair'], boundary = true, autoStart = false } = {}) {
    if (boundary) await policies.setBoundary({ userId, category: 'schedule', proactiveCompute: true });
    const { responsibility } = await responsibilities.create({
        userId,
        body: {
            title: 'Keep my recurring work running',
            operations: operations.map(operation => ({ operation, resource: { kind: 'process', ids: refs } })),
            ...(attempts === undefined ? {} : { budgets: { repairAttempts: attempts } }),
            ...(autoStart ? { rules: { autoStart: true } } : {})
        }
    });
    return (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
}

let callId = 0;
const call = (name, args = {}) => ({ id: `r${++callId}`, name, arguments: JSON.stringify(args) });
function script(...rounds) {
    const queue = [...rounds];
    if (jest.isMockFunction(aiService.chat)) aiService.chat.mockClear();
    return jest.spyOn(aiService, 'chat').mockImplementation(async () => {
        const next = queue.shift();
        if (next === undefined) return { content: 'Nothing more.', toolCalls: [] };
        return typeof next === 'string' ? { content: next, toolCalls: [] } : { content: '', toolCalls: next };
    });
}
const finish = (title = 'Tried a repair') => call('finish', { outcome: 'finding', title, summary: 'What I did and what the system said.' });
const repairCall = (action = 'rerun') => call('repairProcess', { action, diagnosis: 'The provider timed out three times; it may have passed.' });

async function runOnce(...rounds) {
    const chat = script(...rounds);
    const result = await runner.tick({ wait: true });
    return { chat, result: result.results[0] };
}

/** Propose the repair attempt for a grant, queue it and run it with the scripted model. */
async function repairRun(responsibility, ...rounds) {
    const looked = await kit.look(responsibility);
    expect(looked.proposed).toHaveLength(1);
    await kit.queue(responsibility.ownerUserId, looked.proposed[0]);
    return { id: looked.proposed[0], ...(await runOnce(...rounds)) };
}

const page = (body) => ({ status: 200, text: `<html><body><main><h1>Notes</h1><p>${body}</p></main></body></html>`, headers: {} });
const redirect = (location) => Object.assign(new Error('Redirects are not followed.'), { code: 'REDIRECT_REFUSED', location });

/* ---------------------------------------------------------------------- */

describe('what counts as proof', () => {
    const row = (occurrenceKey, phase, outcome, reasonCode = null, at = '2026-11-01 10:00:00') => ({ occurrenceKey, phase, outcome, reasonCode, observedAt: at });

    test('a clean run passes, a failed or blocked one fails with its code, and nothing judged yet waits', () => {
        expect(repairs.judge([], { output: 'not_failed' })).toEqual({ state: 'waiting' });
        expect(repairs.judge([row('a', 'dispatch', 'unknown', 'STARTED')], { output: 'not_failed' })).toEqual({ state: 'waiting' });
        expect(repairs.judge([row('a', 'outcome', 'ok')], { output: 'not_failed' })).toEqual({ state: 'passed', output: null });
        expect(repairs.judge([row('a', 'outcome', 'failed', 'PROVIDER_TIMEOUT')], { output: 'not_failed' }))
            .toEqual({ state: 'failed', code: 'PROVIDER_TIMEOUT' });
        expect(repairs.judge([row('a', 'outcome', 'blocked', 'BUDGET_EXHAUSTED')], { output: 'not_failed' }))
            .toEqual({ state: 'failed', code: 'BUDGET_EXHAUSTED' });
        // One clean run does not excuse a failed one after it.
        expect(repairs.judge([row('a', 'outcome', 'ok'), row('b', 'outcome', 'failed', 'X_FAILED', '2026-11-01 11:00:00')], { output: 'not_failed' }).state)
            .toBe('failed');
    });

    test('output that failed fails the repair, and a contract that asks for freshness waits for something new', () => {
        expect(repairs.judge([row('a', 'execution', 'ok'), row('a', 'output', 'failed', 'DELIVERY_FAILED')], { output: 'not_failed' }))
            .toEqual({ state: 'failed', code: 'DELIVERY_FAILED' });
        const quiet = [row('a', 'execution', 'ok'), row('a', 'output', 'skipped', 'NO_CHANGE')];
        expect(repairs.judge(quiet, { output: 'not_failed' })).toEqual({ state: 'passed', output: 'unchanged' });
        expect(repairs.judge(quiet, { output: 'fresh' })).toEqual({ state: 'waiting', ran: true });
        expect(repairs.judge([row('a', 'execution', 'ok'), row('a', 'output', 'ok', 'CONTENT_CHANGED')], { output: 'fresh' }))
            .toEqual({ state: 'passed', output: 'fresh' });
    });

    test('the attempts a grant allows default to one, are capped, and zero leaves every repair to the person', () => {
        expect(repairs.attemptsAllowed({})).toBe(1);
        expect(repairs.attemptsAllowed(null)).toBe(1);
        expect(repairs.attemptsAllowed({ repairAttempts: 3 })).toBe(3);
        expect(repairs.attemptsAllowed({ repairAttempts: 40 })).toBe(repairs.MAX_ATTEMPTS);
        expect(repairs.attemptsAllowed({ repairAttempts: 0 })).toBe(0);
        expect(repairs.attemptsAllowed({ repairAttempts: 'many' })).toBe(1);
    });
});

describe('without a grant', () => {
    test('nothing is changed: the one repair that needs no judgement is offered once, with what it would do', async () => {
        const task = await automation('nightly import');
        await failing(task);
        const before = await db.get('SELECT nextRun FROM automations WHERE id = @id', { id: task.id });

        expect(await pass()).toMatchObject({ opened: 1, repairs: 1 });
        const [row] = await repairRows(task);
        expect(row).toMatchObject({
            status: 'PROPOSED', action: 'rerun', proposedBy: 'steward', diagnosisCode: 'PROVIDER_TIMEOUT',
            attempt: 0, actorKind: null, appliedAt: null, responsibilityId: null
        });
        expect(JSON.parse(row.planJson)).toMatchObject({
            affected: [task.ref], attempt: 1, allowed: 1, verification: { run: 'ok', output: 'not_failed', withinSeconds: 3600 }
        });
        // The process itself is untouched.
        expect(await db.get('SELECT nextRun FROM automations WHERE id = @id', { id: task.id })).toEqual(before);

        const update = await updateFor(task);
        expect(update).toMatchObject({ kind: 'process', title: '"nightly import" keeps failing: run it once more?' });
        expect(update.summary).toBe(
            'It has failed 3 times in a row (PROVIDER_TIMEOUT). Running it once now, with nothing about it changed, would show whether the cause has passed. Nothing has been done: approve that, or leave it.'
        );
        expect(JSON.parse(update.gateJson)).toEqual({ kind: 'process_repair', id: task.ref, occurrence: row.id * 2 });
        expect(JSON.parse(update.actionsJson)).toEqual([{ kind: 'open_process', id: task.ref }]);
        expect(await needsYou()).toBe(1);

        const card = await cardFor(task);
        expect(card).toMatchObject({ state: 'open', title: '"nightly import" keeps failing: run it once more?' });
        expect(card.options.map(option => option.id)).toEqual(['approve', 'decline']);
        // The Processes list carries the same card.
        expect((await listed(task)).repair).toMatchObject({ status: 'proposed', action: 'rerun', ask: { state: 'open', ref: card.ref } });

        // Asked once: later passes add nothing.
        expect(await pass(after(5 * 60000))).toMatchObject({ repairs: 0 });
        expect(await repairRows(task)).toHaveLength(1);
    });

    test('approved, it is run as the person\'s own act, proved by the run after it, and watched for one more normal run', async () => {
        const task = await automation('nightly import');
        await failing(task);
        await pass();

        const decided = await decide(task, 'approve', 'processes');
        expect(decided.decided.message).toBe('"nightly import" is being run now. You will be told how it went.');
        // The question is replaced by what is being done: nothing is left to answer.
        expect(decided.current).toBeNull();
        const applied = await latest(task);
        expect(applied).toMatchObject({ status: 'VERIFYING', actorKind: 'person', attempt: 1, proposedBy: 'steward', rollback: null });
        expect(applied.appliedAt).toBeTruthy();
        expect(JSON.parse(applied.resultJson)).toEqual({ launch: 'started' });
        // It was made due now; the scheduler that owns it does the run.
        const due = await db.get('SELECT nextRun FROM automations WHERE id = @id', { id: task.id });
        expect(new Date(`${String(due.nextRun).replace(' ', 'T')}Z`).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
        expect(await needsYou()).toBe(0);
        expect(await updateFor(task)).toMatchObject({ title: 'Repairing "nightly import"', gateJson: null });

        // Nothing has run yet: still waiting.
        expect(await pass(after(60000))).toMatchObject({ repairs: 0 });
        expect((await latest(task)).status).toBe('VERIFYING');

        await ran(task, 'ok', { at: after(2 * 60000) });
        expect(await pass(after(3 * 60000))).toMatchObject({ repairs: 1 });
        const verified = await latest(task);
        expect(verified.status).toBe('OBSERVING');
        expect(JSON.parse(verified.resultJson).verified).toMatchObject({ run: 'ok', dependentsFreed: 0 });
        const told = await updateFor(task);
        expect(told.title).toBe('Repaired "nightly import"');
        expect(told.summary).toBe(
            'As you approved, I ran it once more with nothing changed, and the run after that worked. I am watching its next scheduled run before calling it fixed.'
        );

        // Its next run on its own schedule works too.
        await ran(task, 'ok', { at: after(20 * HOUR) });
        expect(await pass(after(20 * HOUR + 60000))).toMatchObject({ repairs: 1 });
        expect(await latest(task)).toMatchObject({ status: 'SUCCEEDED', rollback: null, direction: null });
        expect((await updateFor(task)).title).toBe('The repair of "nightly import" held');
        expect((await listed(task)).repair).toMatchObject({ status: 'succeeded', ask: null });
        expect(await needsYou()).toBe(0);
    });

    test('a repair that fails its check is counted, nothing is left changed, and the person is asked what to do', async () => {
        const task = await automation('nightly import');
        await failing(task);
        await pass();
        await decide(task, 'approve');

        await ran(task, 'failed', { code: 'PROVIDER_TIMEOUT', at: after(2 * 60000) });
        expect(await pass(after(3 * 60000))).toMatchObject({ repairs: 1 });
        const failed = await latest(task);
        expect(failed).toMatchObject({ status: 'FAILED', stopCode: 'PROVIDER_TIMEOUT', rollback: 'none', direction: 'asked', attempt: 1 });
        const update = await updateFor(task);
        expect(update.title).toBe('"nightly import" still fails after 1 repair attempt');
        expect(update.summary).toBe(
            'As you approved, I ran it once more with nothing changed, but the run after it failed (PROVIDER_TIMEOUT). Nothing about it was changed, so there is nothing to undo. That was the only attempt allowed, so I will not try again. Pause it, or leave it running as it is.'
        );
        expect(JSON.parse(update.gateJson)).toEqual({ kind: 'process_repair', id: task.ref, occurrence: failed.id * 2 + 1 });
        expect(await needsYou()).toBe(1);
        const card = await cardFor(task);
        expect(card.options.map(option => option.id)).toEqual(['pause', 'leave']);

        // Nothing more is tried, however long it keeps failing.
        await ran(task, 'failed', { code: 'PROVIDER_TIMEOUT', at: after(HOUR) });
        expect(await pass(after(HOUR + 60000))).toMatchObject({ repairs: 0 });
        expect(await repairRows(task)).toHaveLength(1);

        const paused = await decide(task, 'pause', 'inbox');
        expect(paused.decided.message).toBe('Paused "nightly import". Nothing new will start, and you can resume it from Processes.');
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: task.id })).isEnabled).toBe(0);
        expect(await db.get('SELECT stage, actorKind FROM assistant_process_lifecycle WHERE processId = @id', { id: String(task.id) }))
            .toEqual({ stage: 'PAUSED', actorKind: 'person' });
        expect(await latest(task)).toMatchObject({ status: 'FAILED', direction: 'pause' });
        expect(await needsYou()).toBe(0);
    });

    test('"leave it running" is an answer too: the question closes and no repair is offered again for this problem', async () => {
        const task = await automation('nightly import');
        await failing(task);
        await pass();
        await decide(task, 'approve');
        await ran(task, 'failed', { code: 'PROVIDER_TIMEOUT', at: after(2 * 60000) });
        await pass(after(3 * 60000));

        const left = await decide(task, 'leave');
        expect(left.decided.message).toBe('"nightly import" is left running. I will not try to repair it again for this problem.');
        expect(left.current).toMatchObject({ state: 'resolved', outcome: 'You chose to leave "nightly import" running.' });
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: task.id })).isEnabled).toBe(1);
        await ran(task, 'failed', { code: 'PROVIDER_TIMEOUT', at: after(HOUR) });
        expect(await pass(after(HOUR + 60000))).toMatchObject({ repairs: 0 });
        expect(await repairRows(task)).toHaveLength(1);
        expect(await needsYou()).toBe(0);
    });

    test('no run inside the hour allowed is a failed repair, not an open-ended wait', async () => {
        const task = await automation('nightly import');
        await failing(task);
        await pass();
        await decide(task, 'approve');
        expect(await pass(after(59 * 60000))).toMatchObject({ repairs: 0 });
        expect(await pass(after(61 * 60000))).toMatchObject({ repairs: 1 });
        expect(await latest(task)).toMatchObject({ status: 'FAILED', stopCode: 'VERIFY_TIMEOUT', direction: 'asked' });
        expect((await updateFor(task)).summary).toContain('but no run finished in the time allowed.');
    });

    test('declined, it is not offered again for the same problem', async () => {
        const task = await automation('nightly import');
        await failing(task);
        await pass();
        const declined = await decide(task, 'decline');
        expect(declined.decided.message).toBe('"nightly import" is left as it is.');
        expect(declined.current).toMatchObject({ state: 'resolved', outcome: 'You left "nightly import" as it is.' });
        expect(await latest(task)).toMatchObject({ status: 'DECLINED', appliedAt: null });
        await ran(task, 'failed', { code: 'PROVIDER_TIMEOUT', at: after(HOUR) });
        expect(await pass(after(HOUR + 60000))).toMatchObject({ repairs: 0 });
        expect(await repairRows(task)).toHaveLength(1);
        expect(await needsYou()).toBe(0);
    });

    test('an offer is withdrawn when the process recovers by itself, and an answer to the old card is refused as stale', async () => {
        const task = await automation('nightly import');
        await failing(task);
        await pass();
        const card = await cardFor(task);
        await ran(task, 'ok', { at: after(60000) });
        await pass(after(2 * 60000));
        expect(await latest(task)).toMatchObject({ status: 'WITHDRAWN', stopCode: 'NO_INCIDENT' });
        expect(await needsYou()).toBe(0);
        await expect(gates.decide({
            userId: A, ref: card.ref, option: 'approve', occurrence: card.occurrence, revision: card.revision, surface: 'home'
        })).rejects.toMatchObject({ status: 409, code: 'STALE_GATE' });
        expect((await latest(task)).appliedAt).toBeNull();
    });

    test('a card shown before the repair changed cannot approve it, and another person has no card at all', async () => {
        const task = await automation('nightly import');
        await failing(task);
        await pass();
        const card = await cardFor(task);
        const row = await latest(task);
        await expect(repairs.approve({ userId: A, repairId: row.id, expectedRevision: row.revision + 1 }))
            .rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
        await expect(repairs.approve({ userId: B, repairId: row.id })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
        await expect(repairs.decline({ userId: B, repairId: row.id })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
        await expect(gates.decide({
            userId: B, ref: card.ref, option: 'approve', occurrence: card.occurrence, revision: card.revision, surface: 'home'
        })).rejects.toMatchObject({ status: 404 });
        expect((await latest(task)).status).toBe('PROPOSED');
    });

    test('nothing is offered for a cause a rerun cannot change, a kind that cannot be rerun, a process that is off, or a person without Attention', async () => {
        const forbidden = await source('licence page');
        await failing(forbidden, 'SOURCE_FORBIDDEN');
        const off = await automation('old export');
        await failing(off);
        await db.run('UPDATE automations SET isEnabled = 0 WHERE id = @id', { id: off.id });
        const projectId = await kit.project({ owner: A, slug: 'pipeline' });
        const triggerId = Number(await db.insert(
            `INSERT INTO project_triggers (projectId, userId, name, kind, schedule, action, nextRun)
             VALUES (@projectId, @userId, 'render', 'cron', '0 4 * * *', 'render', @nextRun)`,
            { projectId, userId: A, nextRun: utc(after(20 * HOUR)) }
        ));
        const trigger = { kind: 'project_trigger', id: triggerId, ref: `project_trigger:${triggerId}`, userId: A };
        for (const hours of [3, 2, 1]) await ran(trigger, 'failed', { code: 'JOB_FAILED', at: after(-hours * HOUR), phase: 'outcome' });

        const result = await pass();
        expect(result.opened).toBeGreaterThanOrEqual(2);
        expect(result.repairs).toBe(0);
        expect(await db.all('SELECT id FROM assistant_process_repairs', {})).toEqual([]);

        // B has not turned Attention on: incidents are not announced, and no repair is offered.
        const theirs = await automation('their import', { userId: B });
        await failing(theirs);
        expect(await pass(new Date(), B)).toMatchObject({ repairs: 0 });
        expect(await repairRows(theirs)).toEqual([]);
    });
});

describe('the pilot gate', () => {
    test('while the pilot is owner-only, an ordinary person is offered nothing, cannot delegate repair, and the owner can', async () => {
        const access = require('@goobster/core/services/assistantAccessService');
        const task = await automation('nightly import');
        await failing(task);
        // Offered while the pilot was open to everyone...
        expect(await pass()).toMatchObject({ opened: 1, repairs: 1 });
        expect(await needsYou()).toBe(1);
        // ...and withdrawn once it is the owner's alone.
        await access.recordDecision({ scope: 'owner' });
        expect(await pass(after(60000))).toMatchObject({ repairs: 0 });
        expect(await latest(task)).toMatchObject({ status: 'WITHDRAWN', stopCode: 'PILOT_ONLY' });
        expect(await needsYou()).toBe(0);
        await expect(repairs.approve({ userId: A, repairId: (await latest(task)).id })).rejects.toMatchObject({ code: 'NOT_OPEN' });
        const fresh = await automation('weekly digest');
        await failing(fresh, 'RUN_FAILED');
        expect(await pass(after(2 * 60000))).toMatchObject({ repairs: 0 });
        expect(await repairRows(fresh)).toEqual([]);
        await expect(grant([task.ref])).rejects.toMatchObject({ code: 'PILOT_ONLY' });

        await policies.enroll({ userId: OWNER, initiative: 'assist' });
        const own = await automation('owner import', { userId: OWNER });
        await failing(own);
        expect(await pass(new Date(), OWNER)).toMatchObject({ opened: 1, repairs: 1 });
        expect((await latest(own)).status).toBe('PROPOSED');
        const responsibility = await grant([own.ref], { userId: OWNER });
        expect(responsibility.status).toBe('ACTIVE');
    });

    test('a repair run queued while the pilot was open ends before any model call once it is closed', async () => {
        const access = require('@goobster/core/services/assistantAccessService');
        const task = await automation('nightly import');
        await failing(task);
        const responsibility = await grant([task.ref]);
        await pass();
        const looked = await kit.look(responsibility);
        expect(looked.proposed).toHaveLength(1);
        await kit.queue(A, looked.proposed[0]);

        await access.recordDecision({ scope: 'owner' });
        const { chat, result } = await runOnce([repairCall()], [finish()]);
        expect(chat).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'SUPERSEDED', stopCode: 'PILOT_ONLY' });
        expect(await repairRows(task)).toEqual([]);
        expect((await db.get('SELECT nextRun FROM automations WHERE id = @id', { id: task.id })).nextRun > utc(after(HOUR))).toBe(true);
    });
});

describe('with a grant, through a delegated run', () => {
    test('the failing process becomes work for the grant, the run is told typed state only, and repairProcess applies under authorize()', async () => {
        const task = await automation('nightly import');
        await processes.putContract({ userId: A, kind: 'automation', id: task.id, body: { purpose: 'Import yesterday\'s orders' } });
        await failing(task);
        const responsibility = await grant([task.ref], { attempts: 2 });
        // A grant with attempts: the steward leaves it to the run.
        expect(await pass()).toMatchObject({ opened: 1, repairs: 0 });
        expect(await repairRows(task)).toEqual([]);

        const { id, chat, result } = await repairRun(responsibility, [repairCall('rerun')], [finish()]);
        expect(result).toMatchObject({ status: 'COMPLETED' });
        const initiative = await kit.row(id);
        expect(initiative).toMatchObject({ sourceKind: 'process_incident', sourceRevision: 'a1', title: 'Repair "nightly import"' });
        expect(JSON.parse(initiative.originJson)).toMatchObject({ kind: 'process_incident', ref: task.ref, attempt: 1 });

        // What the model was given.
        const [messages, options] = chat.mock.calls[0];
        expect(messages[0].content).toMatch(/A repair is one of the listed actions and nothing else/);
        expect(messages[0].content).toMatch(/You do not decide whether the repair worked/);
        expect(messages[1].content).toContain('<<<EVIDENCE');
        expect(messages[1].content).toContain('nightly import');
        expect(messages[1].content).toContain('Purpose: Import yesterday\'s orders');
        expect(messages[1].content).toContain('Failed runs in a row: 3. Cause code of the latest failure: PROVIDER_TIMEOUT.');
        expect(messages[1].content).toContain('Repair attempts: 0 used of 2 allowed.');
        expect(messages[1].content).toMatch(/Repairs available for it now:\n- rerun - /);
        expect(messages[1].content).not.toContain('follow_redirect -');
        expect(messages[1].content).not.toContain('do it');
        const offered = (options.functions || options.tools || []).map(tool => tool.name || tool.function?.name);
        if (offered.length) expect(offered).toContain('repairProcess');

        const operations = await db.all('SELECT tool, status, operation, resourceKind, resourceId, effect, resultText FROM assistant_run_operations ORDER BY id', {});
        expect(operations[0]).toMatchObject({
            tool: 'repairProcess', status: 'SUCCEEDED', operation: 'process.repair', resourceKind: 'process', resourceId: task.ref, effect: 'write'
        });
        expect(operations[0].resultText).toBe(
            'Ran "nightly import" once more to test it. The result is not in yet: the system checks it, undoes the change if it fails, and tells the person.'
        );

        const applied = await latest(task);
        expect(applied).toMatchObject({
            status: 'VERIFYING', action: 'rerun', actorKind: 'assistant', proposedBy: 'run', attempt: 1,
            responsibilityId: responsibility.id, initiativeId: id,
            diagnosisNote: 'The provider timed out three times; it may have passed.'
        });
        expect(applied.attemptKey).toMatch(/^assistant_run:\d+:\d+$/);
        expect(JSON.parse(applied.planJson)).toMatchObject({ attempt: 1, allowed: 2, rollback: 'none' });

        // The run's own report names the change; the repair's update says it is being checked, under which grant.
        const all = (await updates.list({ userId: A })).updates;
        const report = all.find(update => update.initiativeId === id);
        expect(report.summary).toContain('Ran "nightly import" once more to test it.');
        expect(report.componentIds).toContain('processes');
        const state = await updateFor(task);
        expect(state.title).toBe('Repairing "nightly import"');
        expect(state.summary).toContain('Under "Keep my recurring work running", I ran it once more with nothing changed.');
        expect(state.summary).toContain('Diagnosis: The provider timed out three times; it may have passed.');
        expect(state.responsibilityId).toBe(responsibility.id);
        expect(await needsYou()).toBe(0);

        // Where the work item came from, for the portal.
        const origins = await originRuns.origins({ userId: A, initiatives: [initiatives.present(initiative)] });
        expect(origins.get(id)).toEqual({
            kind: 'process_incident', available: true, ref: task.ref, processName: 'nightly import', attempt: 1, link: '/assistant#processes'
        });
        expect((await originRuns.origins({ userId: B, initiatives: [initiatives.present(initiative)] })).get(id))
            .toMatchObject({ available: false, processName: null });
    });

    test('a failed attempt is followed by the next only while attempts are left, and then the person is asked', async () => {
        const task = await automation('nightly import');
        await failing(task);
        const responsibility = await grant([task.ref], { attempts: 2 });
        await pass();
        await repairRun(responsibility, [repairCall()], [finish()]);
        // While it is being checked, no second attempt is proposed.
        expect((await kit.look(responsibility, after(30000))).proposed).toEqual([]);

        await ran(task, 'failed', { code: 'PROVIDER_TIMEOUT', at: after(2 * 60000) });
        expect(await pass(after(3 * 60000))).toMatchObject({ repairs: 1 });
        expect(await latest(task)).toMatchObject({ status: 'FAILED', stopCode: 'PROVIDER_TIMEOUT', direction: null, rollback: 'none' });
        const first = await updateFor(task);
        expect(first.title).toBe('A repair of "nightly import" did not work');
        expect(first.summary).toContain('1 of 2 attempts used.');
        expect(first.gateJson).toBeNull();
        expect(await needsYou()).toBe(0);

        const second = await repairRun(responsibility, [repairCall()], [finish('Tried again')]);
        expect((await kit.row(second.id)).sourceRevision).toBe('a2');
        const [, evidence] = second.chat.mock.calls[0][0];
        expect(evidence.content).toContain('Repairs already tried for this problem:\n- attempt 1: rerun, failed (PROVIDER_TIMEOUT)');
        expect(evidence.content).toContain('Repair attempts: 1 used of 2 allowed.');
        expect(await latest(task)).toMatchObject({ status: 'VERIFYING', attempt: 2 });

        await ran(task, 'failed', { code: 'PROVIDER_TIMEOUT', at: after(10 * 60000) });
        expect(await pass(after(11 * 60000))).toMatchObject({ repairs: 1 });
        expect(await latest(task)).toMatchObject({ status: 'FAILED', attempt: 2, direction: 'asked' });
        const asked = await updateFor(task);
        expect(asked.title).toBe('"nightly import" still fails after 2 repair attempts');
        expect(asked.summary).toContain('That was the last of 2 attempts allowed, so I will not try again.');
        expect(await needsYou()).toBe(1);
        // The cap holds: no third attempt, from the grant or from the steward.
        expect((await kit.look(responsibility, after(12 * 60000))).proposed).toEqual([]);
        expect(await pass(after(13 * 60000))).toMatchObject({ repairs: 0 });
        expect(await repairRows(task)).toHaveLength(2);
    });

    test('a second repairProcess in the same run applies nothing, and an action that is not available is refused by the service', async () => {
        const task = await automation('nightly import');
        await failing(task);
        const responsibility = await grant([task.ref], { attempts: 3 });
        await pass();
        await repairRun(responsibility,
            [call('repairProcess', { action: 'follow_redirect', diagnosis: 'maybe it moved' })],
            [repairCall('rerun')],
            [call('repairProcess', { action: 'rerun', diagnosis: 'once more for luck' })],
            [finish()]);
        const texts = (await db.all("SELECT resultText FROM assistant_run_operations WHERE tool = 'repairProcess' ORDER BY id", {})).map(row => row.resultText);
        expect(texts[0]).toBe('Not applied (ACTION_NOT_AVAILABLE): only rerun can help here.');
        expect(texts[1]).toMatch(/^Ran "nightly import" once more to test it\./);
        expect(texts[2]).toBe('Not applied (REPAIR_IN_PROGRESS).');
        expect((await repairRows(task)).filter(row => row.appliedAt)).toHaveLength(1);
        // Only what was applied is reported as a change.
        const report = (await updates.list({ userId: A })).updates.find(update => update.initiativeId != null);
        expect(report.summary.match(/Ran "nightly import"/g)).toHaveLength(1);
        expect(report.summary).not.toContain('Not applied');
    });

    test('the grant must name the process and Attention must let it act on schedules: otherwise nothing is proposed and the person is offered the repair', async () => {
        const task = await automation('nightly import');
        const other = await automation('weekly digest');
        await failing(task);
        const elsewhere = await grant([other.ref]);
        await pass();
        expect((await kit.look(elsewhere)).proposed).toEqual([]);
        expect((await latest(task))).toMatchObject({ status: 'PROPOSED', proposedBy: 'steward' });

        await db.run('DELETE FROM assistant_process_repairs', {});
        await db.run('DELETE FROM assistant_updates', {});
        await policies.setBoundary({ userId: A, category: 'schedule', proactiveCompute: false });
        const named = await grant([task.ref], { boundary: false });
        expect((await kit.look(named)).proposed).toEqual([]);
        expect(await pass(after(60000))).toMatchObject({ repairs: 1 });
        expect((await latest(task))).toMatchObject({ status: 'PROPOSED', proposedBy: 'steward' });
    });

    test('a grant that allows no attempts never applies by itself: the person is asked each time', async () => {
        const task = await automation('nightly import');
        await failing(task);
        const responsibility = await grant([task.ref], { attempts: 0 });
        expect(await pass()).toMatchObject({ repairs: 1 });
        expect((await kit.look(responsibility)).proposed).toEqual([]);
        expect(await latest(task)).toMatchObject({ status: 'PROPOSED', proposedBy: 'steward' });
    });

    test('the tool is offered only to a repair run of an owner with the capability, and names no process itself', async () => {
        const spec = runs.TOOLS.repairProcess;
        const grants = [{ operation: 'process.repair', resource: { kind: 'process', ids: ['automation:1'] } }];
        const origin = { kind: 'process_incident', ref: 'automation:1' };
        expect(spec.available({ origin, grants, capabilities: { repair: true } })).toBe(true);
        expect(spec.available({ origin: { kind: 'chat_message' }, grants, capabilities: { repair: true } })).toBe(false);
        expect(spec.available({ origin: null, grants, capabilities: { repair: true } })).toBe(false);
        expect(spec.available({ origin, grants, capabilities: { repair: false } })).toBe(false);
        expect(spec.available({ origin, grants: [{ operation: 'process.pause' }], capabilities: { repair: true } })).toBe(false);
        expect(Object.keys(spec.definition.parameters.properties)).toEqual(['action', 'diagnosis']);
        expect(spec.definition.parameters.properties.action.enum).toEqual(repairs.ACTIONS);
        expect(spec.needs({}, { origin })).toEqual({ operation: 'process.repair', resource: { kind: 'process', id: 'automation:1' } });
        expect(spec.needs({ ref: 'automation:2' }, { origin: { kind: 'chat_message' } })).toEqual({ refuse: 'NO_PROCESS' });
        expect(spec.effect).toBe('write');
    });

    test('a run that resumes after a crash finds the repair it applied instead of applying another', async () => {
        const task = await automation('nightly import');
        await failing(task);
        const responsibility = await grant([task.ref], { attempts: 3 });
        await pass();
        await repairRun(responsibility, [repairCall()], [finish()]);
        const applied = await latest(task);
        const [, runId, opId] = applied.attemptKey.split(':');
        const spec = runs.TOOLS.repairProcess;
        const ctx = { run: { id: Number(runId), ownerUserId: A, responsibilityId: responsibility.id }, opId: Number(opId), origin: { kind: 'process_incident', ref: task.ref } };
        expect(await spec.reconcile({}, ctx)).toEqual({ state: 'done', result: expect.stringMatching(/^Ran "nightly import" once more to test it\./) });
        expect(await spec.reconcile({}, { ...ctx, opId: Number(opId) + 1000 })).toEqual({ state: 'absent' });
        // The same operation asked again changes nothing.
        const again = await repairs.repair({
            owner: A, ref: task.ref, action: 'rerun', responsibilityId: responsibility.id, attemptKey: applied.attemptKey
        });
        expect(again.applied).toBe(true);
        expect(await repairRows(task)).toHaveLength(1);
    });
});

describe('the host\'s stop-all', () => {
    test('holds the assistant\'s repairs where they are and proposes no new ones, while a person\'s own approval still runs', async () => {
        const task = await automation('nightly import');
        const mine = await automation('weekly digest');
        await failing(task);
        const responsibility = await grant([task.ref], { attempts: 2 });
        await pass();
        await repairRun(responsibility, [repairCall()], [finish()]);
        await ran(task, 'failed', { code: 'PROVIDER_TIMEOUT', at: after(2 * 60000) });
        // A cause of its own: two processes failing for one upstream cause are one outage, which is not repaired.
        await failing(mine, 'RUN_FAILED');

        await control.pauseAll();
        try {
            // The failed check is not acted on, and no further attempt is proposed.
            const held = await pass(after(3 * 60000));
            expect((await latest(task)).status).toBe('VERIFYING');
            expect((await kit.look(responsibility, after(4 * 60000))).proposed).toEqual([]);
            // Asking is still allowed, and so is the person's own answer.
            expect(held.repairs).toBe(1);
            expect(await latest(mine)).toMatchObject({ status: 'PROPOSED', proposedBy: 'steward' });
            await decide(mine, 'approve');
            expect(await latest(mine)).toMatchObject({ status: 'VERIFYING', actorKind: 'person' });
            await ran(mine, 'ok', { at: after(5 * 60000) });
            await pass(after(6 * 60000));
            expect((await latest(mine)).status).toBe('OBSERVING');
            expect((await latest(task)).status).toBe('VERIFYING');
        } finally {
            await control.resumeAll();
        }
        await pass(after(7 * 60000));
        expect(await latest(task)).toMatchObject({ status: 'FAILED', stopCode: 'PROVIDER_TIMEOUT' });
    });
});

describe('a followed source', () => {
    test('rerun is one check now under the usual limits; a quiet result proves it unless the contract asks for something new', async () => {
        const feed = await source('release notes');
        await failing(feed, 'SOURCE_UNAVAILABLE');
        await pass();
        expect(await latest(feed)).toMatchObject({ status: 'PROPOSED', action: 'rerun' });
        sources.fetch = jest.fn(async () => ({ status: 304, text: '', headers: {} }));

        const decided = await decide(feed, 'approve');
        expect(sources.fetch).toHaveBeenCalledTimes(1);
        expect(decided.decided.message).toBe('"release notes" ran, and it worked. Its next scheduled run is being watched.');
        const verified = await latest(feed);
        expect(verified).toMatchObject({ status: 'OBSERVING', actorKind: 'person' });
        expect(JSON.parse(verified.resultJson)).toMatchObject({ launch: 'ran', verified: { run: 'ok', output: 'unchanged' } });
        expect((await updateFor(feed)).title).toBe('Repaired "release notes"');
        // Its next ordinary check that day is the normal run that settles it.
        await db.run('UPDATE followed_sources SET nextCheckAt = @past, lastCheckedAt = @past WHERE id = @id', { id: feed.id, past: utc(after(-2 * 60000)) });
        await sources.poll(await db.get('SELECT * FROM followed_sources WHERE id = @id', { id: feed.id }));
        await pass(after(60000));
        expect((await latest(feed)).status).toBe('SUCCEEDED');
    });

    test('where the contract asks for fresh output, a clean but quiet check keeps waiting and a new result proves it', async () => {
        const feed = await source('release notes');
        await processes.putContract({ userId: A, kind: 'followed_source', id: feed.id, body: { purpose: 'Tell me about releases', freshnessSeconds: 6 * 3600 } });
        await failing(feed, 'SOURCE_UNAVAILABLE');
        await pass();
        expect(JSON.parse((await latest(feed)).planJson).verification).toEqual({ run: 'ok', output: 'fresh', withinSeconds: 6 * 3600 });
        sources.fetch = jest.fn(async () => ({ status: 304, text: '', headers: {} }));
        const decided = await decide(feed, 'approve');
        expect(decided.decided.message).toBe('"release notes" is being run now. You will be told how it went.');
        expect((await latest(feed)).status).toBe('VERIFYING');
        // More than the plain hour, less than the freshness the contract states: still waiting.
        await pass(after(2 * HOUR));
        expect((await latest(feed)).status).toBe('VERIFYING');
        await ran(feed, 'ok', { key: day(0), at: after(3 * HOUR), output: 'fresh' });
        await pass(after(3 * HOUR + 60000));
        const verified = await latest(feed);
        expect(verified.status).toBe('OBSERVING');
        expect(JSON.parse(verified.resultJson).verified).toMatchObject({ output: 'fresh' });
        expect((await updateFor(feed)).summary).toContain('the run after that worked and produced something new.');
    });

    test('a check the per-source limit defers is launched again by the next pass, not counted as a failure', async () => {
        const feed = await source('release notes');
        await failing(feed, 'SOURCE_UNAVAILABLE');
        await pass();
        // Checked a few seconds ago: a manual check has to wait a minute.
        await db.run('UPDATE followed_sources SET lastCheckedAt = @now WHERE id = @id', { id: feed.id, now: utc(new Date()) });
        sources.fetch = jest.fn(async () => ({ status: 304, text: '', headers: {} }));
        await decide(feed, 'approve');
        expect(sources.fetch).not.toHaveBeenCalled();
        expect(JSON.parse((await latest(feed)).resultJson)).toEqual({ launch: 'waiting' });
        await db.run('UPDATE followed_sources SET lastCheckedAt = @past WHERE id = @id', { id: feed.id, past: utc(after(-5 * 60000)) });
        await pass(after(60000));
        expect(sources.fetch).toHaveBeenCalledTimes(1);
        await pass(after(2 * 60000));
        expect((await latest(feed)).status).toBe('OBSERVING');
    });

    test('follow_redirect on the same site: the address is changed under the grant, baselined, proved, and put back when its next check fails', async () => {
        const feed = await source('release notes', { url: 'https://example.com/notes' });
        await failing(feed, 'REDIRECT_REFUSED');
        const responsibility = await grant([feed.ref]);
        expect(await pass()).toMatchObject({ repairs: 0 });
        sources.fetch = jest.fn()
            .mockRejectedValueOnce(redirect('/notes/v2'))
            .mockResolvedValueOnce(page('The notes moved here.'));

        const { chat, result } = await repairRun(responsibility, [repairCall('follow_redirect')], [finish()]);
        expect(result.status).toBe('COMPLETED');
        expect(chat.mock.calls[0][0][1].content).toMatch(/Repairs available for it now:\n- follow_redirect - /);
        expect(chat.mock.calls[0][0][1].content).not.toContain('- rerun -');
        // Nothing the source ever fetched is in the prompt, and neither is its address.
        expect(chat.mock.calls[0][0][1].content).not.toContain('the page as last fetched');
        expect(chat.mock.calls[0][0][1].content).not.toContain('example.com');

        const moved = await db.get('SELECT url, initialized, lastText, etag FROM followed_sources WHERE id = @id', { id: feed.id });
        expect(moved).toMatchObject({ url: 'https://example.com/notes/v2', initialized: 1, etag: null });
        expect(moved.lastText).toContain('The notes moved here.');
        // The first check at the new address is a baseline: it raises nothing.
        expect(await db.all('SELECT id FROM followed_source_entries WHERE sourceId = @id AND isChange = 1', { id: feed.id })).toEqual([]);
        const verified = await latest(feed);
        expect(verified).toMatchObject({ status: 'OBSERVING', action: 'follow_redirect', actorKind: 'assistant', responsibilityId: responsibility.id });
        expect(JSON.parse(verified.patchJson)).toEqual({ address: 'https://example.com/notes/v2' });
        expect(JSON.parse(verified.snapshotJson)).toEqual({ address: 'https://example.com/notes' });
        expect(JSON.parse(verified.planJson)).toMatchObject({ rollback: 'restore_address' });
        const op = await db.get("SELECT resultText FROM assistant_run_operations WHERE tool = 'repairProcess'", {});
        expect(op.resultText).toMatch(/^Pointed "release notes" at the address it now redirects to: the run after it worked\./);
        expect((await updateFor(feed)).summary).toContain('pointed it at the address it now redirects to (https://example.com/notes/v2), and the run after that worked.');

        // Its next ordinary check fails: the old address is put back.
        sources.fetch = jest.fn(async () => ({ status: 500, text: '', headers: {} }));
        await db.run('UPDATE followed_sources SET nextCheckAt = @past, lastCheckedAt = @past WHERE id = @id', { id: feed.id, past: utc(after(-2 * 60000)) });
        await sources.poll(await db.get('SELECT * FROM followed_sources WHERE id = @id', { id: feed.id }));
        await pass(after(60000));
        expect(await latest(feed)).toMatchObject({ status: 'FAILED', stopCode: 'RELAPSED', rollback: 'restored', direction: 'asked' });
        expect(JSON.parse((await latest(feed)).resultJson).failed).toMatchObject({ code: 'RELAPSED', cause: 'SOURCE_UNAVAILABLE' });
        expect((await db.get('SELECT url, initialized FROM followed_sources WHERE id = @id', { id: feed.id }))).toEqual({ url: 'https://example.com/notes', initialized: 0 });
        expect((await updateFor(feed)).summary).toContain('but its next scheduled run failed again. I put its previous address back.');
    });

    test('an address the person changed again in the meantime is left as they set it', async () => {
        const feed = await source('release notes', { url: 'https://example.com/notes' });
        await failing(feed, 'REDIRECT_REFUSED');
        const responsibility = await grant([feed.ref]);
        await pass();
        sources.fetch = jest.fn()
            .mockRejectedValueOnce(redirect('https://example.com/notes/v2'))
            .mockResolvedValueOnce(page('The notes moved here.'));
        await repairRun(responsibility, [repairCall('follow_redirect')], [finish()]);
        await db.run("UPDATE followed_sources SET url = 'https://example.com/mine' WHERE id = @id", { id: feed.id });
        await ran(feed, 'failed', { code: 'SOURCE_UNAVAILABLE', key: day(0), at: after(60000) });
        await pass(after(2 * 60000));
        expect(await latest(feed)).toMatchObject({ status: 'FAILED', rollback: 'kept' });
        expect((await db.get('SELECT url FROM followed_sources WHERE id = @id', { id: feed.id })).url).toBe('https://example.com/mine');
        expect((await updateFor(feed)).summary).toContain('Its address was changed again after that, so I left it as it is now.');
    });

    test('a redirect to another site is never followed by the assistant: the person is asked, and their approval applies it', async () => {
        const feed = await source('release notes', { url: 'https://example.com/notes' });
        await failing(feed, 'REDIRECT_REFUSED');
        const responsibility = await grant([feed.ref], { attempts: 2 });
        await pass();
        sources.fetch = jest.fn().mockRejectedValueOnce(redirect('https://elsewhere.example.net/notes'));

        await repairRun(responsibility, [repairCall('follow_redirect')], [finish('Asked about the new address')]);
        const op = await db.get("SELECT resultText, status FROM assistant_run_operations WHERE tool = 'repairProcess'", {});
        expect(op.resultText).toBe('Not applied (NEEDS_APPROVAL): the new address is on a different site, so the person has been asked to approve it. Nothing was changed.');
        expect((await db.get('SELECT url FROM followed_sources WHERE id = @id', { id: feed.id })).url).toBe('https://example.com/notes');
        const proposal = await latest(feed);
        expect(proposal).toMatchObject({ status: 'PROPOSED', action: 'follow_redirect', proposedBy: 'run', appliedAt: null, responsibilityId: responsibility.id });
        const update = await updateFor(feed);
        expect(update.title).toBe('"release notes" has moved: use its new address?');
        expect(update.summary).toContain('Its address now redirects to https://elsewhere.example.net/notes, on a different site (elsewhere.example.net), so I did not follow it.');
        expect(await needsYou()).toBe(1);
        // It waits for the person: the grant proposes nothing more meanwhile, and it used no attempt.
        expect((await kit.look(responsibility, after(60000))).proposed).toEqual([]);

        sources.fetch = jest.fn().mockResolvedValueOnce(page('The notes live here now.'));
        const card = await cardFor(feed);
        expect(card.options[0]).toMatchObject({ id: 'approve', label: 'Use the new address' });
        await decide(feed, 'approve');
        expect((await db.get('SELECT url FROM followed_sources WHERE id = @id', { id: feed.id })).url).toBe('https://elsewhere.example.net/notes');
        expect(await latest(feed)).toMatchObject({ status: 'OBSERVING', actorKind: 'person', attempt: 1 });
        // No second request was made to find the address: the one the person saw is the one applied.
        expect(sources.fetch).toHaveBeenCalledTimes(1);
    });

    test('a redirect that leads nowhere usable, or none at all, applies nothing and uses no attempt', async () => {
        const feed = await source('release notes', { url: 'https://example.com/notes' });
        await failing(feed, 'REDIRECT_REFUSED');
        const responsibility = await grant([feed.ref]);
        await pass();
        sources.fetch = jest.fn().mockRejectedValueOnce(redirect('http://127.0.0.1/internal'));
        await repairRun(responsibility, [repairCall('follow_redirect')], [finish()]);
        const op = await db.get("SELECT resultText FROM assistant_run_operations WHERE tool = 'repairProcess'", {});
        expect(op.resultText).toBe('Not applied (REDIRECT_UNUSABLE).');
        expect(await repairRows(feed)).toEqual([]);
        expect((await db.get('SELECT url FROM followed_sources WHERE id = @id', { id: feed.id })).url).toBe('https://example.com/notes');
    });
});

describe('what depends on it', () => {
    test('a repair is not proved while a process that was waiting on it is still blocked', async () => {
        const upstream = await automation('nightly import');
        const downstream = await automation('morning report');
        await processes.putContract({ userId: A, kind: 'automation', id: downstream.id, body: { purpose: 'Report on the import', dependsOn: [upstream.ref] } });
        await ran(downstream, 'ok', { at: after(-5 * HOUR) });
        await failing(upstream);
        await pass();
        await decide(upstream, 'approve');
        const applied = await latest(upstream);
        expect(JSON.parse(applied.planJson)).toMatchObject({ affected: [upstream.ref, downstream.ref], dependents: [downstream.ref] });

        await ran(upstream, 'ok', { at: after(2 * 60000) });
        await pass(after(3 * 60000));
        const verified = await latest(upstream);
        expect(verified.status).toBe('OBSERVING');
        expect(JSON.parse(verified.resultJson).verified).toMatchObject({ dependentsFreed: 1 });
        expect((await updateFor(upstream)).summary).toContain('1 process that depended on it can run again.');
    });

    test('DEPENDENTS_STILL_BLOCKED fails the repair when the dependent stays blocked by it', async () => {
        const upstream = await automation('nightly import');
        const downstream = await automation('morning report');
        await failing(upstream);
        await pass();
        await decide(upstream, 'approve');
        const applied = await latest(upstream);
        // Recorded at apply as waiting on it, and still blocked by it when the check is read.
        await db.run('UPDATE assistant_process_repairs SET planJson = @plan WHERE id = @id', {
            id: applied.id, plan: JSON.stringify({ ...JSON.parse(applied.planJson), dependents: [downstream.ref] })
        });
        await ran(upstream, 'ok', { at: after(2 * 60000) });
        const real = processes.assess.bind(processes);
        jest.spyOn(processes, 'assess').mockImplementation(async (params) => {
            const assessed = await real(params);
            const entry = assessed.processes.find(candidate => candidate.ref === downstream.ref);
            entry.assessment.health.blockedBy = upstream.ref;
            return assessed;
        });
        await repairs.steward({ owner: A, now: after(3 * 60000) });
        expect(await latest(upstream)).toMatchObject({ status: 'FAILED', stopCode: 'DEPENDENTS_STILL_BLOCKED' });
        expect((await updateFor(upstream)).summary).toContain('but what depends on it is still blocked.');
    });
});

describe('typed causes from a followed source', () => {
    test.each([
        [410, 'TARGET_GONE'], [404, 'SOURCE_NOT_FOUND'], [403, 'SOURCE_FORBIDDEN'], [401, 'SOURCE_FORBIDDEN'], [503, 'SOURCE_UNAVAILABLE']
    ])('HTTP %i is recorded as %s', async (status, code) => {
        const feed = await source('release notes');
        sources.fetch = jest.fn(async () => ({ status, text: '', headers: {} }));
        await db.run('UPDATE followed_sources SET nextCheckAt = NULL WHERE id = @id', { id: feed.id });
        expect((await sources.poll(await db.get('SELECT * FROM followed_sources WHERE id = @id', { id: feed.id }))).status).toBe('failed');
        const rows = await db.all(
            "SELECT outcome, reasonCode FROM assistant_process_observations WHERE processKind = 'followed_source' AND processId = @id", { id: String(feed.id) }
        );
        expect(rows).toEqual([{ outcome: 'failed', reasonCode: code }]);
    });

    test('an address that is gone for good ends what the source was for: a retirement candidate, never a repair', async () => {
        const feed = await source('release notes');
        await processes.putContract({ userId: A, kind: 'followed_source', id: feed.id, body: { purpose: 'Tell me about releases' } });
        sources.fetch = jest.fn(async () => ({ status: 410, text: '', headers: {} }));
        await db.run('UPDATE followed_sources SET nextCheckAt = NULL WHERE id = @id', { id: feed.id });
        await sources.poll(await db.get('SELECT * FROM followed_sources WHERE id = @id', { id: feed.id }));
        const { processes: assessed } = await processes.assess({ userId: A });
        expect(assessed.find(entry => entry.ref === feed.ref).assessment).toMatchObject({
            relevance: 'retirement_candidate', reasons: { relevance: 'TARGET_GONE' }
        });
        // Checking it again cannot bring the address back, so running it once more is never offered.
        await failing(feed, 'TARGET_GONE');
        expect(await incidents.reconcile({ userId: A })).toMatchObject({ opened: 1, repairs: 0 });
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_process_repairs WHERE ownerUserId = @owner', { owner: A })).toMatchObject({ n: 0 });
    });

    test('a refused redirect carries where it pointed, and the probe reports it without following or storing anything', async () => {
        const feed = await source('release notes', { url: 'https://example.com/notes' });
        sources.fetch = jest.fn().mockRejectedValue(redirect('/notes/v2#top'));
        expect(await sources.redirectTarget({ userId: A, sourceId: feed.id }))
            .toEqual({ status: 'redirect', address: 'https://example.com/notes/v2', sameHost: true });
        sources.fetch = jest.fn().mockRejectedValue(redirect('https://other.example.org/x'));
        expect(await sources.redirectTarget({ userId: A, sourceId: feed.id })).toMatchObject({ status: 'redirect', sameHost: false });
        sources.fetch = jest.fn().mockRejectedValue(redirect('https://example.com/notes'));
        expect(await sources.redirectTarget({ userId: A, sourceId: feed.id })).toEqual({ status: 'unusable' });
        sources.fetch = jest.fn().mockResolvedValue(page('fine'));
        expect(await sources.redirectTarget({ userId: A, sourceId: feed.id })).toEqual({ status: 'none' });
        await expect(sources.redirectTarget({ userId: B, sourceId: feed.id })).rejects.toMatchObject({ status: 404 });
        expect(await db.get('SELECT url, lastText FROM followed_sources WHERE id = @id', { id: feed.id }))
            .toEqual({ url: 'https://example.com/notes', lastText: 'the page as last fetched' });
        // Re-addressing only happens from the address the caller read.
        expect(await sources.stewardReaddress({ id: feed.id, from: 'https://example.com/other', to: 'https://example.com/notes/v2' }))
            .toMatchObject({ changed: false });
    });
});

describe('records', () => {
    test('repairs are the person\'s own data: listed with the process, erased with the account, exported, and pruned when old', async () => {
        const task = await automation('nightly import');
        await failing(task);
        await pass();
        await decide(task, 'approve');
        await ran(task, 'failed', { code: 'PROVIDER_TIMEOUT', at: after(2 * 60000) });
        await pass(after(3 * 60000));
        await decide(task, 'leave');

        const detail = await processes.get({ userId: A, kind: 'automation', id: task.id });
        expect(detail.repairs).toHaveLength(1);
        expect(detail.repairs[0]).toMatchObject({
            status: 'failed', action: 'rerun', attempt: 1, allowed: 1, actor: 'person', stopCode: 'PROVIDER_TIMEOUT',
            rollback: 'none', direction: 'leave', diagnosisCode: 'PROVIDER_TIMEOUT'
        });
        await expect(processes.get({ userId: B, kind: 'automation', id: task.id })).rejects.toMatchObject({ status: 404 });
        expect(INVENTORY.some(entry => entry[0] === 'assistant_process_repairs')).toBe(true);

        // Not old enough, then old enough; a question still open is never pruned.
        expect(await repairs.prune({ days: 180, now: after(100 * DAY) })).toEqual({ repairs: 0 });
        const audit = await privacy.auditUser({ userId: A });
        expect(audit.byTable.assistant_process_repairs).toBe(1);
        await steward.sweep({ now: after(200 * DAY) });
        // The steward's retention runs at most every six hours; ask directly as well.
        await repairs.prune({ days: 180, now: after(200 * DAY) });
        expect(await repairRows(task)).toEqual([]);

        const again = await automation('second import');
        await failing(again);
        await pass();
        expect(await repairRows(again)).toHaveLength(1);
        const forgotten = await privacy.forgetUser({ userId: A });
        expect(forgotten.processRepairs).toBe(1);
        expect(await db.all('SELECT id FROM assistant_process_repairs', {})).toEqual([]);
    });

    test('repairs of a process that no longer exists are removed by retention', async () => {
        const task = await automation('nightly import');
        await failing(task);
        await pass();
        await db.run('DELETE FROM automations WHERE id = @id', { id: task.id });
        expect(await repairs.prune({ days: 180 })).toEqual({ repairs: 1 });
    });
});
