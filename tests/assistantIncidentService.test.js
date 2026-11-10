/**
 * Process incidents and their announcements (DA-5a), against a throwaway
 * database with an explicit clock.
 *
 * The properties under test: an incident opens on the third failure running
 * and not before; one success does not close it and one failure during the
 * cooldown reopens the same one; a recovery is announced once, after the
 * cooldown; failures with one upstream cause are one incident and one
 * interruption; a process waiting on a failing one joins that incident; a
 * stall is held against a process only for time this installation was
 * itself running; nothing is opened or said for a person with Attention off;
 * a purpose that is over produces one request and one candidate and
 * changes nothing; an ignored result alone produces nothing; and one person's
 * incidents never reach another.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-incident-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const incidents = require('@goobster/core/services/assistantIncidentService');
const processes = require('@goobster/core/services/assistantProcessService');
const policies = require('@goobster/core/services/attentionPolicyService');
const steward = require('@goobster/core/services/assistantStewardService');
const instanceState = require('@goobster/core/services/instanceStateService');
const { DEFAULTS } = require('@goobster/core/services/assistant/processes/assessment');
const { useState } = require('./helpers/featureFixtures');

const A = '750000000000000001';
const B = '750000000000000002';
const HOUR = 3600000;
/** The start of the story. Every test names its own times as hours after it. */
const T0 = new Date('2026-06-01T00:00:00Z').getTime();
const at = (hours) => new Date(T0 + hours * HOUR);
const utc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

const TABLES = [
    'assistant_update_receipts', 'assistant_updates', 'assistant_process_incident_members', 'assistant_process_incidents',
    'assistant_process_observations', 'assistant_process_contracts', 'assistant_process_lifecycle', 'attention_notices',
    'attention_items', 'attention_policies', 'inbox_items', 'instance_state', 'automations'
];

afterAll(async () => {
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`, {});
    await policies.enroll({ userId: A, initiative: 'assist' });
});

/** A daily automation whose next run is far ahead, so only its observations decide its health. */
async function automation(name, { userId = A, nextRun = at(24 * 60) } = {}) {
    const id = await db.insert(
        `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun)
         VALUES (@userId, 'g1', 'c1', @name, 'do it', '0 3 * * *', @nextRun)`,
        { userId, name, nextRun: utc(nextRun) }
    );
    return { id: Number(id), ref: `automation:${id}`, userId };
}

let fires = 0;
/** One finished occurrence of a process at `hours` after the start. */
async function ran(process, hours, outcome, reasonCode = outcome === 'failed' ? 'RUN_FAILED' : null) {
    fires += 1;
    const recorded = await processes.record({
        processKind: 'automation', processId: process.id, ownerUserId: process.userId,
        occurrenceKey: `fire:${fires}`, phase: 'outcome', outcome, reasonCode, observedAt: at(hours)
    });
    expect(recorded).toBe(true);
}

const contract = (process, body) => processes.putContract({ userId: process.userId, kind: 'automation', id: process.id, body });
const pass = (hours, options = {}) => incidents.reconcile({ userId: A, now: at(hours), ...options });
const rows = (userId = A) => db.all('SELECT * FROM assistant_process_incidents WHERE ownerUserId = @userId ORDER BY id', { userId });
const updatesFor = (prefix, userId = A) => db.all(
    "SELECT * FROM assistant_updates WHERE audienceUserId = @userId AND identityKey LIKE @like ORDER BY id",
    { userId, like: `${prefix}%` }
);

describe('opening an incident', () => {
    test('two failures running are a degraded process and no incident; the third opens one and says so once', async () => {
        const job = await automation('nightly import');
        await ran(job, 1, 'ok');
        await ran(job, 2, 'failed');
        await ran(job, 3, 'failed');
        expect(await pass(4)).toMatchObject({ owners: 1, opened: 0 });
        expect(await rows()).toHaveLength(0);
        expect(await updatesFor('process_incident:')).toHaveLength(0);

        await ran(job, 5, 'failed');
        expect(await pass(6)).toMatchObject({ opened: 1, reopened: 0, resolved: 0 });
        const [incident] = await rows();
        expect(incident).toMatchObject({
            incidentKey: `process:${job.ref}`, occurrence: 1, status: 'OPEN', causeCode: 'RUN_FAILED', criticality: 'normal'
        });
        const [update] = await updatesFor('process_incident:');
        expect(update).toMatchObject({
            identityKey: `process_incident:${incident.id}`, kind: 'process', materialRevision: 1,
            title: '"nightly import" keeps failing'
        });
        expect(update.summary).toContain('Nothing was changed.');
        expect(Number(incident.updateId)).toBe(Number(update.id));

        // The Inbox holds the record; no Discord message is sent for it.
        const filed = await db.all('SELECT discordStatus FROM inbox_items WHERE userId = @userId', { userId: A });
        expect(filed).toEqual([{ discordStatus: 'skipped' }]);

        // Later passes that find the same thing say nothing new.
        await ran(job, 7, 'failed');
        expect(await pass(8)).toMatchObject({ opened: 0, reopened: 0 });
        expect(await rows()).toHaveLength(1);
        expect((await updatesFor('process_incident:'))[0].materialRevision).toBe(1);
        expect(await db.all('SELECT id FROM inbox_items WHERE userId = @userId', { userId: A })).toHaveLength(1);
    });

    test('the catalog shows the incident on the process it belongs to', async () => {
        const job = await automation('nightly import');
        const other = await automation('weekly digest');
        for (const hour of [1, 2, 3]) await ran(job, hour, 'failed');
        await ran(other, 1, 'ok');
        await pass(4);

        const listed = await processes.list({ userId: A, now: at(4) });
        const byRef = new Map(listed.processes.map(entry => [entry.ref, entry]));
        expect(byRef.get(job.ref)).toMatchObject({
            assessment: { execution: 'blocked', reasons: { execution: 'FAILING_REPEATEDLY' } },
            incident: { status: 'OPEN', role: 'failing', state: 'failing', members: 1 }
        });
        expect(byRef.get(other.ref)).toMatchObject({ assessment: { execution: 'healthy' }, incident: null });

        const { incidents: open } = await incidents.list({ userId: A });
        expect(open).toHaveLength(1);
        expect(open[0].members).toEqual([{ ref: job.ref, name: 'nightly import', role: 'failing', state: 'failing' }]);
        expect((await incidents.list({ userId: B })).incidents).toEqual([]);
    });

    test('nothing is opened or said for a person who has not turned Attention on', async () => {
        const job = await automation('quiet job', { userId: B });
        for (const hour of [1, 2, 3, 4]) await ran(job, hour, 'failed');
        expect(await incidents.reconcile({ userId: B, now: at(5) })).toMatchObject({ owners: 1, opened: 0 });
        expect(await incidents.reconcile({ now: at(5) })).toMatchObject({ owners: 0, opened: 0 });
        expect(await rows(B)).toHaveLength(0);
        expect(await db.all('SELECT id FROM assistant_updates', {})).toHaveLength(0);
        // The assessment itself is still there to read.
        const listed = await processes.list({ userId: B, now: at(5) });
        expect(listed.processes[0].assessment.execution).toBe('blocked');
    });

    test('with the assistant switched off the pass does nothing', async () => {
        const job = await automation('nightly import');
        for (const hour of [1, 2, 3]) await ran(job, hour, 'failed');
        useState({ inactive: ['assistant'] });
        expect(await pass(4)).toEqual({ owners: 0, opened: 0, reopened: 0, recovering: 0, resolved: 0, relevance: 0, paused: 0, archived: 0, repairs: 0 });
        expect(await incidents.healthCandidates({ userId: A })).toEqual([]);
        expect(await incidents.relevanceCandidates({ userId: A })).toEqual([]);
        useState();
        expect(await rows()).toHaveLength(0);
    });
});

describe('recovery', () => {
    async function opened() {
        const job = await automation('nightly import');
        for (const hour of [1, 2, 3]) await ran(job, hour, 'failed');
        await pass(4);
        return job;
    }

    test('one success keeps the incident open; the second starts the cooldown; nothing is announced yet', async () => {
        const job = await opened();
        await ran(job, 5, 'ok');
        expect(await pass(6)).toMatchObject({ recovering: 0, resolved: 0 });
        expect((await rows())[0].status).toBe('OPEN');
        expect((await incidents.list({ userId: A })).incidents[0].members[0].state).toBe('recovering');

        await ran(job, 7, 'ok');
        expect(await pass(8)).toMatchObject({ recovering: 1, resolved: 0 });
        const [incident] = await rows();
        expect(incident).toMatchObject({ status: 'RECOVERING', recoveringSince: utc(at(8)) });
        expect((await updatesFor('process_incident:'))[0].materialRevision).toBe(1);

        // Still inside the cooldown a day minus an hour later.
        expect(await pass(8 + DEFAULTS.cooldownSeconds / 3600 - 1)).toMatchObject({ resolved: 0 });
        expect((await rows())[0].status).toBe('RECOVERING');
    });

    test('a failure during the cooldown reopens the same incident without a second announcement', async () => {
        const job = await opened();
        await ran(job, 5, 'ok');
        await ran(job, 6, 'ok');
        await pass(7);
        expect((await rows())[0].status).toBe('RECOVERING');

        await ran(job, 9, 'failed');
        expect(await pass(10)).toMatchObject({ opened: 0, reopened: 1 });
        const all = await rows();
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ status: 'OPEN', occurrence: 1, recoveringSince: null });
        const announced = await updatesFor('process_incident:');
        expect(announced).toHaveLength(1);
        expect(announced[0].materialRevision).toBe(1);

        // A flapping process is one incident however often it flaps.
        await ran(job, 11, 'ok');
        await ran(job, 12, 'ok');
        await pass(13);
        await ran(job, 14, 'failed');
        expect(await pass(15)).toMatchObject({ opened: 0, reopened: 1 });
        expect(await rows()).toHaveLength(1);
        expect(await incidents.healthCandidates({ userId: A })).toHaveLength(1);
    });

    test('after the cooldown the incident resolves with one closing revision, and a later streak is a new occurrence', async () => {
        const job = await opened();
        await ran(job, 5, 'ok');
        await ran(job, 6, 'ok');
        await pass(7);
        expect(await pass(7 + 24)).toMatchObject({ resolved: 1 });
        const [incident] = await rows();
        expect(incident).toMatchObject({ status: 'RESOLVED', resolution: 'recovered', resolvedAt: utc(at(31)) });
        const [update] = await updatesFor('process_incident:');
        expect(update).toMatchObject({ materialRevision: 2, title: '"nightly import" is working again' });
        expect((await incidents.list({ userId: A })).incidents).toEqual([]);
        expect((await processes.list({ userId: A, now: at(32) })).processes[0].incident).toBeNull();

        // Resolved stays resolved.
        expect(await pass(40)).toMatchObject({ opened: 0, resolved: 0 });
        expect((await updatesFor('process_incident:'))[0].materialRevision).toBe(2);

        for (const hour of [50, 51, 52]) await ran(job, hour, 'failed');
        expect(await pass(53)).toMatchObject({ opened: 1 });
        const all = await rows();
        expect(all.map(row => [row.status, row.occurrence])).toEqual([['RESOLVED', 1], ['OPEN', 2]]);
        expect(await updatesFor('process_incident:')).toHaveLength(2);
    });

    test('an incident already open runs to its end after Attention is turned off, and says nothing more', async () => {
        const job = await opened();
        await policies.disable(A);
        await ran(job, 5, 'ok');
        await ran(job, 6, 'ok');
        expect(await pass(7)).toMatchObject({ recovering: 1 });
        // The unattended pass still finds the person through the open incident.
        expect(await incidents.reconcile({ now: at(7 + 24) })).toMatchObject({ owners: 1, resolved: 1 });
        expect((await rows())[0]).toMatchObject({ status: 'RESOLVED', resolution: 'recovered' });
        expect((await updatesFor('process_incident:'))[0].materialRevision).toBe(1);
    });

    test('a process that is deleted takes its incident with it, without a recovery message', async () => {
        const job = await opened();
        await db.run('DELETE FROM automations WHERE id = @id', { id: job.id });
        expect(await pass(5)).toMatchObject({ recovering: 1 });
        expect(await pass(5 + 24)).toMatchObject({ resolved: 1 });
        expect((await rows())[0]).toMatchObject({ status: 'RESOLVED', resolution: 'removed' });
        expect((await updatesFor('process_incident:'))[0].materialRevision).toBe(1);
    });
});

describe('grouping', () => {
    test('failures with one upstream cause are one incident and one interruption', async () => {
        const first = await automation('nightly import');
        const second = await automation('weekly digest');
        const third = await automation('price check');
        await ran(first, 1, 'failed', 'PROVIDER_UNAVAILABLE');
        await ran(first, 2, 'failed', 'PROVIDER_UNAVAILABLE');
        await ran(second, 2, 'failed', 'PROVIDER_UNAVAILABLE');
        await ran(third, 2, 'ok');

        expect(await pass(3)).toMatchObject({ opened: 1 });
        const [incident] = await rows();
        expect(incident).toMatchObject({ incidentKey: 'cause:PROVIDER_UNAVAILABLE', causeCode: 'PROVIDER_UNAVAILABLE', status: 'OPEN' });
        const { incidents: open } = await incidents.list({ userId: A });
        expect(open[0].members.map(member => [member.ref, member.role])).toEqual([[first.ref, 'failing'], [second.ref, 'failing']]);
        const [update] = await updatesFor('process_incident:');
        expect(update.title).toBe('2 of your processes are blocked by the same problem');
        expect(update.summary).toContain('(PROVIDER_UNAVAILABLE)');

        const candidates = await incidents.healthCandidates({ userId: A });
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({ key: `process_health:${incident.id}`, category: 'schedule' });

        // A third process hit by the same outage joins it: one more revision, still one incident.
        await ran(third, 4, 'failed', 'PROVIDER_UNAVAILABLE');
        expect(await pass(5)).toMatchObject({ opened: 0 });
        expect(await rows()).toHaveLength(1);
        const revised = (await updatesFor('process_incident:'))[0];
        expect(revised).toMatchObject({ materialRevision: 2, title: '3 of your processes are blocked by the same problem' });
        expect(await incidents.healthCandidates({ userId: A })).toHaveLength(1);
    });

    test('the same failure code in two processes is not one outage unless the code names something upstream', async () => {
        const first = await automation('nightly import');
        const second = await automation('weekly digest');
        for (const hour of [1, 2, 3]) {
            await ran(first, hour, 'failed', 'RUN_FAILED');
            await ran(second, hour, 'failed', 'RUN_FAILED');
        }
        expect(await pass(4)).toMatchObject({ opened: 2 });
        expect((await rows()).map(row => row.incidentKey).sort()).toEqual([`process:${first.ref}`, `process:${second.ref}`].sort());
    });

    test('a process that depends on a failing one joins its incident instead of getting its own', async () => {
        const upstream = await automation('nightly import');
        const downstream = await automation('morning summary');
        await contract(downstream, { purpose: 'Summarise what the import brought in', dependsOn: [upstream.ref] });
        for (const hour of [1, 2, 3]) await ran(upstream, hour, 'failed');
        await ran(downstream, 3, 'ok');

        expect(await pass(4)).toMatchObject({ opened: 1 });
        const { incidents: open } = await incidents.list({ userId: A });
        expect(open).toHaveLength(1);
        expect(open[0].key).toBe(`process:${upstream.ref}`);
        expect(open[0].members.map(member => [member.ref, member.role]).sort()).toEqual(
            [[upstream.ref, 'failing'], [downstream.ref, 'dependent']].sort()
        );
        const [update] = await updatesFor('process_incident:');
        expect(update.summary).toContain('"morning summary" cannot run until it does.');

        const listed = await processes.list({ userId: A, now: at(4) });
        const waiting = listed.processes.find(entry => entry.ref === downstream.ref);
        expect(waiting.assessment).toMatchObject({
            execution: 'blocked', reasons: { execution: 'DEPENDENCY_BLOCKED' }, health: { blockedBy: upstream.ref }
        });
        expect(waiting.incident).toMatchObject({ role: 'dependent' });
    });

    test('the most critical failing process sets how loudly the incident may land', async () => {
        const job = await automation('payroll export');
        await contract(job, { purpose: 'Pay people on time', criticality: 'high' });
        for (const hour of [1, 2, 3]) await ran(job, hour, 'failed');
        await pass(4);
        expect((await rows())[0].criticality).toBe('high');
        const [candidate] = await incidents.healthCandidates({ userId: A });
        expect(candidate).toMatchObject({ urgency: 0.9, importance: 0.9 });
    });
});

describe('stalls', () => {
    test('a schedule a day overdue opens an incident, counting only time this installation was running', async () => {
        const job = await automation('nightly import', { nextRun: at(0) });
        await ran(job, -24, 'ok');

        // An hour and a bit late: stalled, and not yet an incident.
        expect(await pass(2)).toMatchObject({ opened: 0 });
        expect((await processes.list({ userId: A, now: at(2) })).processes[0].assessment).toMatchObject({
            execution: 'stalled', reasons: { execution: 'SCHEDULE_OVERDUE' }
        });

        // A day late, but this installation only came back an hour ago: nothing is opened,
        // and still nothing 23 hours after it came back.
        expect(await pass(25, { upSince: at(24) })).toMatchObject({ opened: 0 });
        expect(await pass(47, { upSince: at(24) })).toMatchObject({ opened: 0 });
        expect(await rows()).toHaveLength(0);

        // A full day of running without the process running is the process's stall.
        expect(await pass(48.5, { upSince: at(24) })).toMatchObject({ opened: 1 });
        const [incident] = await rows();
        expect(incident).toMatchObject({ incidentKey: `process:${job.ref}`, causeCode: 'SCHEDULE_OVERDUE' });
        const [update] = await updatesFor('process_incident:');
        expect(update.title).toBe('"nightly import" has stopped running');
        expect(update.summary).not.toContain('SCHEDULE_OVERDUE');
    });

    test('the steward restarts the stall clock after a gap in its own passes', async () => {
        const job = await automation('nightly import', { nextRun: at(0) });
        await ran(job, -24, 'ok');
        const minutes = (hours, extra) => new Date(at(hours).getTime() + extra * 60000);
        const beat = async () => instanceState.get(steward.HEARTBEAT_KEY);

        // Last pass two days ago: this installation was down across the missed run.
        await instanceState.set(steward.HEARTBEAT_KEY, { at: at(-23).toISOString(), since: at(-200).toISOString() });
        expect((await steward.sweep({ now: at(25), retention: false })).incidents).toMatchObject({ opened: 0 });
        expect(await beat()).toEqual({ at: at(25).toISOString(), since: at(25).toISOString() });

        // Passes that follow each other keep the same start, and the stall is still young.
        expect((await steward.sweep({ now: minutes(25, 5), retention: false })).incidents).toMatchObject({ opened: 0 });
        expect(await beat()).toEqual({ at: minutes(25, 5).toISOString(), since: at(25).toISOString() });
        expect(await rows()).toHaveLength(0);

        // A day of unbroken passes later the process still has not run: that is its stall.
        await instanceState.set(steward.HEARTBEAT_KEY, { at: minutes(49, 0).toISOString(), since: at(25).toISOString() });
        expect((await steward.sweep({ now: minutes(49, 5), retention: false })).incidents).toMatchObject({ opened: 1 });
        expect((await rows())[0].causeCode).toBe('SCHEDULE_OVERDUE');
    });
});

describe('relevance', () => {
    async function goal(state, userId = A) {
        return Number(await db.insert(
            `INSERT INTO attention_items (guildId, userId, kind, subject, state) VALUES (@guild, @userId, 'goal', 'ship the release', @state)`,
            { guild: `dm:${userId}`, userId, state }
        ));
    }

    test('a process whose goal is resolved while it is still on gets one request and one candidate, and is left alone', async () => {
        const job = await automation('release watch');
        const itemId = await goal('resolved');
        await contract(job, { purpose: 'Tell me when the release ships', attentionItemId: itemId });
        await ran(job, 1, 'ok');

        expect(await pass(2)).toMatchObject({ opened: 0, relevance: 1 });
        const [update] = await updatesFor('process_relevance:');
        expect(update).toMatchObject({
            identityKey: `process_relevance:${job.ref}`, kind: 'process', materialRevision: 1,
            title: '"release watch" may no longer be needed'
        });
        expect(update.summary).toBe('The goal it was set up for is resolved. It is still switched on. Nothing was changed: pause it, or say it should keep running.');
        // With no grant naming the process it only asks (tests/assistantProcessLifecycle.test.js); the process is untouched.
        expect(JSON.parse(update.gateJson)).toEqual({ kind: 'process_retirement', id: job.ref, occurrence: 1 });
        expect(update.gateResolvedAt).toBeNull();
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: job.id })).isEnabled).toBe(1);

        expect(await pass(3)).toMatchObject({ relevance: 0 });
        expect(await updatesFor('process_relevance:')).toHaveLength(1);

        const candidates = await incidents.relevanceCandidates({ userId: A, now: at(3) });
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({ key: `process_relevance:${job.ref}:r1:GOAL_RESOLVED`, category: 'schedule' });

        // Once raised, the same candidate is not offered again.
        await db.run(
            "INSERT INTO attention_notices (userId, dedupeKey, title) VALUES (@userId, @key, 'x')",
            { userId: A, key: candidates[0].key }
        );
        expect(await incidents.relevanceCandidates({ userId: A, now: at(3) })).toEqual([]);
    });

    test('without a stated purpose nothing is suggested, whatever else is known', async () => {
        const job = await automation('mystery job');
        const itemId = await goal('resolved');
        await contract(job, { attentionItemId: itemId });
        await ran(job, 1, 'ok');
        expect(await pass(2)).toMatchObject({ relevance: 0 });
        expect(await incidents.relevanceCandidates({ userId: A, now: at(2) })).toEqual([]);
        expect((await processes.list({ userId: A, now: at(2) })).processes[0].assessment).toMatchObject({
            relevance: 'unknown', reasons: { relevance: 'PURPOSE_UNKNOWN' }
        });
    });

    test('results nobody opened are a signal on the process and never a suggestion to retire it', async () => {
        const job = await automation('daily digest');
        await contract(job, { purpose: 'A morning digest of my feeds' });
        await ran(job, 1, 'ok');
        for (let index = 0; index < DEFAULTS.ignoredResults + 1; index += 1) {
            await db.run(
                `INSERT INTO inbox_items (userId, kind, title, sourceType, sourceId, createdAt)
                 VALUES (@userId, 'task', 'Digest', 'automation', @id, @at)`,
                { userId: A, id: String(job.id), at: utc(at(1 + index)) }
            );
        }
        const [entry] = (await processes.list({ userId: A, now: at(10) })).processes;
        expect(entry.assessment).toMatchObject({ relevance: 'active', signals: { resultsIgnored: true } });
        expect(await pass(10)).toMatchObject({ relevance: 0, opened: 0 });
        expect(await incidents.relevanceCandidates({ userId: A, now: at(10) })).toEqual([]);
        expect(await db.all('SELECT id FROM assistant_updates', {})).toHaveLength(0);
    });

    test('a review date the person set, once passed, is one candidate keyed on that date', async () => {
        const job = await automation('quarterly report');
        await contract(job, { purpose: 'The quarterly numbers', reviewAt: at(5).toISOString() });
        await ran(job, 1, 'ok');
        expect(await incidents.relevanceCandidates({ userId: A, now: at(4) })).toEqual([]);
        const candidates = await incidents.relevanceCandidates({ userId: A, now: at(6) });
        expect(candidates.map(candidate => candidate.key)).toEqual([`process_review:${job.ref}:2026-06-01`]);
    });
});

describe('attention candidates and retention', () => {
    test('an incident is offered once: not again after it was raised, and not while it is recovering', async () => {
        const job = await automation('nightly import');
        for (const hour of [1, 2, 3]) await ran(job, hour, 'failed');
        await pass(4);
        const [candidate] = await incidents.healthCandidates({ userId: A });
        expect(candidate).toMatchObject({ title: '"nightly import" keeps failing', confidence: 0.9 });
        expect(await incidents.healthCandidates({ userId: B })).toEqual([]);

        await db.run(
            "INSERT INTO attention_notices (userId, dedupeKey, title) VALUES (@userId, @key, 'x')",
            { userId: A, key: candidate.key }
        );
        expect(await incidents.healthCandidates({ userId: A })).toEqual([]);

        await db.run('DELETE FROM attention_notices', {});
        await ran(job, 5, 'ok');
        await ran(job, 6, 'ok');
        await pass(7);
        expect(await incidents.healthCandidates({ userId: A })).toEqual([]);
    });

    test('resolved incidents are kept 180 days, then removed with their members', async () => {
        const job = await automation('nightly import');
        for (const hour of [1, 2, 3]) await ran(job, hour, 'failed');
        await pass(4);
        await ran(job, 5, 'ok');
        await ran(job, 6, 'ok');
        await pass(7);
        await pass(7 + 24);
        expect((await rows())[0].status).toBe('RESOLVED');

        expect(await incidents.prune({ now: at(31 + 179 * 24) })).toEqual({ incidents: 0 });
        expect(await rows()).toHaveLength(1);
        expect(await incidents.prune({ now: at(31 + 181 * 24) })).toEqual({ incidents: 1 });
        expect(await rows()).toHaveLength(0);
        expect(await db.all('SELECT * FROM assistant_process_incident_members', {})).toHaveLength(0);
    });

    test('an open incident is never pruned', async () => {
        const job = await automation('nightly import');
        for (const hour of [1, 2, 3]) await ran(job, hour, 'failed');
        await pass(4);
        expect(await incidents.prune({ now: at(400 * 24) })).toEqual({ incidents: 0 });
        expect(await rows()).toHaveLength(1);
    });
});
