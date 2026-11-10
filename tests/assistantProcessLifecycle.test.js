/**
 * Pausing, archiving, restoring and cleaning up processes (DA-5b), against
 * a throwaway database.
 *
 * The properties under test: a pause is part of the launch claim, so
 * nothing starts behind it, and work that had already started is counted
 * and left to finish; an archive deletes nothing and cannot be switched on
 * anywhere until restored; a restore comes back paused and a resume is
 * checked when it is asked for; a cleanup removes exactly the rows its
 * previewed manifest names, never what a person kept or was sent, and not
 * at all once anything it was made against has changed; the assistant
 * pauses or archives only under a grant that names the process and is
 * honoured at that moment, asks otherwise, and takes an ignored result as
 * no reason for either; and none of it crosses from one person to another.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-lifecycle-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const lifecycle = require('@goobster/core/services/assistantProcessLifecycleService');
const processes = require('@goobster/core/services/assistantProcessService');
const incidents = require('@goobster/core/services/assistantIncidentService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const policies = require('@goobster/core/services/attentionPolicyService');
const automations = require('@goobster/core/services/automationManagerService');
const AutomationService = require('@goobster/core/services/automationService');
const webTasks = require('@goobster/core/services/webTaskService');
const triggers = require('@goobster/core/services/projectTriggerService');
const watches = require('@goobster/core/services/attentionWatchService');
const sources = require('@goobster/core/services/followedSourceService');
const steward = require('@goobster/core/services/assistantStewardService');
const privacy = require('@goobster/core/services/privacyService');
const { DEFAULTS } = require('@goobster/core/services/assistant/processes/assessment');
const { useState } = require('./helpers/featureFixtures');

const A = '760000000000000001';
const B = '760000000000000002';
const DAY = 86400000;
const utc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const later = (ms) => new Date(Date.now() + ms);

const TABLES = [
    'assistant_update_receipts', 'assistant_updates', 'assistant_process_cleanups', 'assistant_process_lifecycle',
    'assistant_process_incident_members', 'assistant_process_incidents', 'assistant_process_observations',
    'assistant_process_contracts', 'assistant_responsibility_revisions', 'assistant_responsibilities',
    'attention_notices', 'attention_watches', 'attention_items', 'attention_policies', 'inbox_items',
    'followed_source_entries', 'followed_sources', 'project_trigger_deliveries', 'project_triggers', 'observatory_jobs',
    'project_members', 'observatory_projects', 'spitball_expeditions', 'kg_nodes', 'automations', 'work_failures'
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

/* ---------------------------------------------------------------------- */
/* Fixtures                                                                */
/* ---------------------------------------------------------------------- */

async function automation(name, { userId = A, nextRun = later(30 * DAY), channelId = `inbox:${userId}` } = {}) {
    const id = Number(await db.insert(
        `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun)
         VALUES (@userId, @guild, @channelId, @name, 'do it', '0 3 * * *', @nextRun)`,
        { userId, guild: `dm:${userId}`, channelId, name, nextRun: utc(nextRun) }
    ));
    return { kind: 'automation', id, ref: `automation:${id}`, userId };
}

async function project(userId = A, slug = 'pipeline') {
    return Number(await db.insert(
        'INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, @slug, @slug)', { userId, slug }
    ));
}

async function eventTrigger(projectId, name, { userId = A, sourceTriggerId = null } = {}) {
    const id = Number(await db.insert(
        `INSERT INTO project_triggers (projectId, userId, name, kind, eventTopic, action, sourceTriggerId)
         VALUES (@projectId, @userId, @name, 'event', 'job_completed', 'render', @sourceTriggerId)`,
        { projectId, userId, name, sourceTriggerId }
    ));
    return { kind: 'project_trigger', id, ref: `project_trigger:${id}`, userId, projectId };
}

async function job(projectId, { status = 'COMPLETED', finishedAt = new Date(Date.now() - 60000), triggerId = null, userId = A } = {}) {
    const id = Number(await db.insert(
        `INSERT INTO observatory_jobs (projectId, userId, language, code, status, finishedAt, startedBy, triggerId)
         VALUES (@projectId, @userId, 'python', 'print(1)', @status, @finishedAt, @startedBy, @triggerId)`,
        { projectId, userId, status, finishedAt: status === 'RUNNING' ? null : utc(finishedAt), startedBy: triggerId ? 'trigger' : 'chat', triggerId }
    ));
    return db.get('SELECT * FROM observatory_jobs WHERE id = @id', { id });
}

async function watch(label, { userId = A, status = 'ARMED', itemId = null } = {}) {
    const id = Number(await db.insert(
        `INSERT INTO attention_watches (userId, guildId, label, topic, promptText, status, itemId, expiresAt)
         VALUES (@userId, @guild, @label, 'observatory.job_completed', 'tell me', @status, @itemId, @expiresAt)`,
        { userId, guild: `dm:${userId}`, label, status, itemId, expiresAt: utc(later(30 * DAY)) }
    ));
    return { kind: 'attention_watch', id, ref: `attention_watch:${id}`, userId };
}

async function source(label, { userId = A } = {}) {
    const topicId = Number(await db.insert(
        "INSERT INTO kg_nodes (guildId, scopeKey, type, label, curation) VALUES (@guild, @scope, 'concept', @label, 'saved')",
        { guild: `dm:${userId}`, scope: `USER:${userId}`, label: `${label} topic` }
    ));
    const id = Number(await db.insert(
        `INSERT INTO followed_sources (userId, topicNodeId, url, label, kind, initialized, lastHash, lastText, etag)
         VALUES (@userId, @topicId, @url, @label, 'page', 1, 'hash-1', 'the page as last fetched', 'etag-1')`,
        { userId, topicId, url: `https://example.com/${encodeURIComponent(label)}`, label }
    ));
    return { kind: 'followed_source', id, ref: `followed_source:${id}`, userId };
}

async function entry(sourceId, key, { kept = 0, expeditionId = null } = {}) {
    return Number(await db.insert(
        `INSERT INTO followed_source_entries (sourceId, entryKey, url, title, contentHash, extractedText, kept, expeditionId)
         VALUES (@sourceId, @key, 'https://example.com/e', @key, 'h', 'fetched text', @kept, @expeditionId)`,
        { sourceId, key, kept, expeditionId }
    ));
}

let goals = 0;
async function goal(state, userId = A) {
    goals += 1;
    return Number(await db.insert(
        `INSERT INTO attention_items (guildId, userId, kind, subject, state) VALUES (@guild, @userId, 'goal', @subject, @state)`,
        { guild: `dm:${userId}`, userId, state, subject: `ship release ${goals}` }
    ));
}

let fires = 0;
async function observed(item, { phase = 'outcome', outcome = 'ok', reasonCode = null, at = new Date(Date.now() - 3600000) } = {}) {
    fires += 1;
    expect(await processes.record({
        processKind: item.kind, processId: item.id, ownerUserId: item.userId,
        occurrenceKey: `fire:t${fires}`, phase, outcome, reasonCode, observedAt: at
    })).toBe(true);
}

const contract = (item, body) => processes.putContract({ userId: item.userId, kind: item.kind, id: item.id, body });
const act = (item, action, extra = {}) => lifecycle.act({ userId: item.userId, kind: item.kind, id: item.id, action, ...extra });
const stage = async (item) => (await db.get(
    'SELECT * FROM assistant_process_lifecycle WHERE processKind = @kind AND processId = @id', { kind: item.kind, id: String(item.id) }
)) || null;
const listed = async (item, now = new Date()) => (await processes.list({ userId: item.userId, now })).processes.find(row => row.ref === item.ref);
const pass = (now = new Date(), userId = A) => incidents.reconcile({ userId, now });
const updateFor = (item) => db.get(
    'SELECT * FROM assistant_updates WHERE audienceUserId = @userId AND identityKey = @key',
    { userId: item.userId, key: `process_relevance:${item.ref}` }
);

/** An ACTIVE responsibility granting the named operations on exactly these processes. */
async function grant(operations, refs, userId = A) {
    const { responsibility } = await responsibilities.create({
        userId,
        body: {
            title: 'Keep my recurring work tidy',
            operations: operations.map(operation => ({ operation, resource: { kind: 'process', ids: refs } }))
        }
    });
    return (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
}

/** A process whose stated purpose is over while it is still switched on. */
async function finishedPurpose(item, state = 'resolved') {
    const itemId = await goal(state, item.userId);
    await contract(item, { purpose: 'Tell me when the release ships', attentionItemId: itemId });
    await observed(item);
    return itemId;
}

/* ---------------------------------------------------------------------- */

describe('pause', () => {
    test('stops future fires in the claim itself, records who paused it, and is safe to repeat', async () => {
        const task = await automation('nightly import', { nextRun: new Date(Date.now() - 60000) });
        const result = await act(task, 'pause', { expectedRevision: 0 });
        expect(result).toMatchObject({
            action: 'pause', changed: true, started: { count: 0, policy: 'finish' },
            process: { ref: task.ref, enabled: false },
            lifecycle: { stage: 'paused', actor: 'person', reasonCode: 'PERSON', revision: 1 },
            controls: ['resume', 'archive']
        });
        // It was due: the scheduler can no longer claim it.
        const scheduler = new AutomationService(null);
        expect(await scheduler.getDueAutomations()).toEqual([]);
        expect(await scheduler.claimDueRun({ id: task.id, name: 'nightly import', schedule: '0 3 * * *' })).toBe(false);

        const again = await act(task, 'pause');
        expect(again).toMatchObject({ changed: false, lifecycle: { stage: 'paused', revision: 1 } });
        expect(await listed(task)).toMatchObject({
            enabled: false, assessment: { execution: 'unknown', reasons: { execution: 'PAUSED' } }
        });
    });

    test('a stale revision is refused, and so is a process that is already off somewhere else', async () => {
        const task = await automation('nightly import');
        await expect(act(task, 'pause', { expectedRevision: 4 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
        await automations.setEnabledById({ id: task.id, enabled: false });
        await expect(act(task, 'pause')).rejects.toMatchObject({ code: 'NOT_RUNNING', status: 409 });
        // Switched off where it was made, it is resumed there, not here.
        await expect(act(task, 'resume')).rejects.toMatchObject({ code: 'NOT_PAUSED_HERE' });
        expect(await stage(task)).toBeNull();
        await expect(act(task, 'explode')).rejects.toMatchObject({ code: 'INVALID_ACTION', status: 400 });
    });

    test('a pause that lands while a run is under way fences the next launch and counts the run, which finishes', async () => {
        const task = await automation('nightly import', { nextRun: new Date(Date.now() - 60000) });
        const scheduler = new AutomationService(null);
        let finish;
        const reached = new Promise((atWork) => {
            jest.spyOn(scheduler, 'executeInboxAutomation').mockImplementation(() => new Promise((resolve) => {
                finish = resolve;
                atWork();
            }));
        });
        const [due] = await scheduler.getDueAutomations();
        expect(await scheduler.claimDueRun(due)).toBe(true);
        const running = scheduler._executeClaimedAutomation(due);
        // The pause arrives only once the run has reached its work.
        await reached;

        const result = await act(task, 'pause');
        expect(result.started).toEqual({ count: 1, policy: 'finish' });
        expect(result.lifecycle.started).toEqual({ count: 1, policy: 'finish' });
        // Nothing new can start, even made due again by hand.
        await db.run('UPDATE automations SET nextRun = @due WHERE id = @id', { id: task.id, due: utc(new Date(Date.now() - 1000)) });
        expect(await scheduler.getDueAutomations()).toEqual([]);
        expect(await scheduler.claimDueRun(due)).toBe(false);

        // The run that had started is not cut off: it finishes and is recorded.
        finish();
        expect(await running).toEqual({ outcome: 'ok' });
        const row = await db.get('SELECT isEnabled, lastRun FROM automations WHERE id = @id', { id: task.id });
        expect(row.isEnabled).toBe(0);
        expect(row.lastRun).toBeTruthy();
        const outcomes = await db.all(
            "SELECT outcome FROM assistant_process_observations WHERE processId = @id AND phase = 'outcome'", { id: String(task.id) }
        );
        expect(outcomes).toEqual([{ outcome: 'ok' }]);
        expect((await stage(task)).stage).toBe('PAUSED');
    });

    test('an event trigger drops deliveries waiting to retry, counts the stage it had started, and claims nothing more', async () => {
        const projectId = await project();
        const trigger = await eventTrigger(projectId, 'render on finish');
        const full = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: trigger.id });
        const dispatching = await job(projectId);
        const waiting = await job(projectId);
        expect(await triggers.claimEventFire(full, dispatching)).toBe(true);
        expect(await triggers.claimEventFire(full, waiting)).toBe(true);
        await db.run(
            "UPDATE project_trigger_deliveries SET status = 'RETRYABLE', nextAttemptAt = @soon WHERE sourceJobId = @id",
            { id: waiting.id, soon: utc(new Date(Date.now() - 1000)) }
        );
        await job(projectId, { status: 'RUNNING', triggerId: trigger.id });

        const result = await act(trigger, 'pause');
        // One dispatch in flight and one stage still running: both finish.
        expect(result.started).toEqual({ count: 2, policy: 'finish' });
        const deliveries = await db.all('SELECT sourceJobId, status FROM project_trigger_deliveries ORDER BY id', {});
        expect(deliveries).toEqual([
            { sourceJobId: dispatching.id, status: 'STARTED' },
            { sourceJobId: waiting.id, status: 'SKIPPED' }
        ]);
        // A new event, and a retry of the dropped one, claim nothing.
        const whilePaused = await job(projectId);
        expect(await triggers.claimEventFire(full, whilePaused)).toBe(false);
        expect(await triggers.claimEventFire(full, waiting)).toBe(false);
        expect(await triggers.evaluateJobSettled(whilePaused.id)).toBe(0);
        expect(await triggers.retryEventDeliveries()).toBe(0);
        expect(await db.all('SELECT id FROM project_trigger_deliveries WHERE sourceJobId = @id', { id: whilePaused.id })).toEqual([]);

        // Resuming does not replay what settled while it was paused.
        const resumed = await act(trigger, 'resume');
        expect(resumed).toMatchObject({ changed: true, skipped: 1, lifecycle: { stage: 'active' }, process: { enabled: true } });
        expect(await db.get('SELECT status, detail FROM project_trigger_deliveries WHERE sourceJobId = @id', { id: whilePaused.id }))
            .toEqual({ status: 'SKIPPED', detail: 'settled while the trigger was paused' });
        expect(await triggers.catchUpEventTriggers()).toBe(0);
        const afterwards = await job(projectId);
        const now = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: trigger.id });
        expect(await triggers.claimEventFire(now, afterwards)).toBe(true);
    });

    test('a paused watch is not claimed by its event, a turn already running is counted, and an ended watch cannot be resumed', async () => {
        const idle = await watch('when the build finishes');
        const firing = await watch('when the report lands', { status: 'FIRING' });
        const turn = jest.spyOn(watches, '_runTurn').mockResolvedValue();

        expect((await act(idle, 'pause')).started).toEqual({ count: 0, policy: 'finish' });
        expect((await act(firing, 'pause')).started).toEqual({ count: 1, policy: 'finish' });
        await watches.onEvent({ topic: 'observatory.job_completed', payload: { userId: A } });
        expect(turn).not.toHaveBeenCalled();
        expect(await db.get('SELECT status, fireCount FROM attention_watches WHERE id = @id', { id: idle.id })).toEqual({ status: 'ARMED', fireCount: 0 });
        expect(await listed(idle)).toMatchObject({ enabled: false, lifecycle: { stage: 'paused' } });

        await act(idle, 'resume');
        await watches.onEvent({ topic: 'observatory.job_completed', payload: { userId: A } });
        expect(turn).toHaveBeenCalledTimes(1);
        expect((await db.get('SELECT status FROM attention_watches WHERE id = @id', { id: idle.id })).status).toBe('FIRED');

        // The paused one expired meanwhile: there is nothing left to resume.
        await db.run("UPDATE attention_watches SET status = 'EXPIRED' WHERE id = @id", { id: firing.id });
        expect((await listed(firing)).controls).toEqual(['archive']);
        await expect(act(firing, 'resume')).rejects.toMatchObject({ code: 'ENDED', status: 409 });
    });

    test('a followed source drops a check that was fetching, and stores nothing from it', async () => {
        const feed = await source('release notes');
        await db.run('UPDATE followed_sources SET claimToken = @token, claimUntil = @until WHERE id = @id',
            { id: feed.id, token: 'in-flight', until: utc(later(60000)) });
        const result = await act(feed, 'pause');
        expect(result.started).toEqual({ count: 1, policy: 'abandon' });
        expect(await db.get('SELECT enabled, claimToken FROM followed_sources WHERE id = @id', { id: feed.id })).toEqual({ enabled: 0, claimToken: null });
        // The fetcher's own write is fenced on the token the pause cleared.
        const late = await db.run("UPDATE followed_sources SET lastText = 'late write' WHERE id = @id AND claimToken = 'in-flight'", { id: feed.id });
        expect(late.changes).toBe(0);
    });

    test('pausing says which of the person\'s processes depend on it', async () => {
        const projectId = await project();
        const upstream = await eventTrigger(projectId, 'ingest');
        const downstream = await eventTrigger(projectId, 'render', { sourceTriggerId: upstream.id });
        const result = await act(upstream, 'pause');
        expect(result.dependents).toEqual([{ ref: downstream.ref, name: 'render', enabled: true }]);
        const detail = await processes.get({ userId: A, kind: upstream.kind, id: upstream.id });
        expect(detail.dependents).toEqual([{ ref: downstream.ref, name: 'render', enabled: true }]);
    });
});

describe('archive and restore', () => {
    test('archive needs a pause first, deletes nothing, and records how the process stood', async () => {
        const task = await automation('nightly import');
        await contract(task, { purpose: 'Bring in last night\'s numbers' });
        await observed(task, { outcome: 'ok' });
        await db.run(
            "INSERT INTO inbox_items (userId, kind, title, sourceType, sourceId) VALUES (@userId, 'task', 'Result', 'automation', @id)",
            { userId: A, id: String(task.id) }
        );
        await expect(act(task, 'archive')).rejects.toMatchObject({ code: 'PAUSE_FIRST', status: 409 });

        await act(task, 'pause');
        const archived = await act(task, 'archive');
        expect(archived).toMatchObject({
            changed: true,
            lifecycle: {
                stage: 'archived', actor: 'person',
                final: { execution: 'unknown', relevance: 'dormant', reasons: { execution: 'PAUSED' } }
            },
            controls: ['restore', 'preview_cleanup', 'cleanup']
        });
        expect(archived.lifecycle.final.lastOkAt).toBeTruthy();
        // The definition, its contract, its history and its results are all still there.
        const row = await db.get('SELECT name, promptText, schedule, isEnabled, archivedAt FROM automations WHERE id = @id', { id: task.id });
        expect(row).toMatchObject({ name: 'nightly import', promptText: 'do it', schedule: '0 3 * * *', isEnabled: 0 });
        expect(row.archivedAt).toBeTruthy();
        expect(await db.all('SELECT id FROM assistant_process_contracts', {})).toHaveLength(1);
        expect(await db.all('SELECT id FROM assistant_process_observations', {})).toHaveLength(1);
        expect(await db.all('SELECT id FROM inbox_items', {})).toHaveLength(1);

        const { processes: all, counts } = await processes.list({ userId: A });
        expect(all[0]).toMatchObject({ archived: true, enabled: false, assessment: { reasons: { execution: 'ARCHIVED', relevance: 'ARCHIVED' } } });
        expect(counts).toMatchObject({ total: 0, archived: 1, unknown: 0 });
        expect((await act(task, 'archive')).changed).toBe(false);
    });

    test('an archived process cannot be switched on from any of the places it could be before', async () => {
        const task = await automation('nightly import');
        await act(task, 'pause');
        await act(task, 'archive');
        await expect(automations.setEnabledById({ id: task.id, enabled: true })).rejects.toMatchObject({ code: 'ARCHIVED' });
        await expect(automations.setEnabled({ userId: A, scope: `dm:${A}`, name: 'nightly import', enabled: true })).rejects.toMatchObject({ code: 'ARCHIVED' });
        await expect(webTasks.setAutomationEnabled({ userId: A, automationId: task.id, enabled: true })).rejects.toMatchObject({ status: 409, code: 'ARCHIVED' });
        await expect(automations.triggerNow({ id: task.id })).rejects.toMatchObject({ code: 'PAUSED' });
        await expect(act(task, 'resume')).rejects.toMatchObject({ code: 'RESTORE_FIRST' });
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: task.id })).isEnabled).toBe(0);

        const projectId = await project();
        const trigger = await eventTrigger(projectId, 'render on finish');
        await act(trigger, 'pause');
        await act(trigger, 'archive');
        await expect(triggers.update({ userId: A, project: 'pipeline', trigger: trigger.id, isEnabled: true }))
            .rejects.toMatchObject({ status: 409, code: 'TRIGGER_ARCHIVED' });
        // An edit that does not switch it on is still the person's to make, and leaves it off.
        const renamed = await triggers.update({ userId: A, project: 'pipeline', trigger: trigger.id, name: 'render when done' });
        expect(renamed).toMatchObject({ name: 'render when done', isEnabled: false, archived: true });

        const feed = await source('release notes');
        await act(feed, 'pause');
        await act(feed, 'archive');
        await expect(sources.setEnabled({ userId: A, sourceId: feed.id, enabled: true })).rejects.toMatchObject({ status: 409, code: 'SOURCE_ARCHIVED' });
        expect((await db.get('SELECT enabled FROM followed_sources WHERE id = @id', { id: feed.id })).enabled).toBe(0);
    });

    test('restore brings the definition back paused; only an explicit resume starts it again', async () => {
        const task = await automation('nightly import');
        await act(task, 'pause');
        await act(task, 'archive');
        await expect(act(task, 'pause')).rejects.toMatchObject({ code: 'ARCHIVED' });

        const restored = await act(task, 'restore');
        expect(restored).toMatchObject({
            changed: true, notRestored: null, process: { enabled: false },
            lifecycle: { stage: 'paused', actor: 'person', reasonCode: 'RESTORED', archivedAt: null },
            controls: ['resume', 'archive']
        });
        const row = await db.get('SELECT isEnabled, nextRun, archivedAt FROM automations WHERE id = @id', { id: task.id });
        expect(row).toEqual({ isEnabled: 0, nextRun: null, archivedAt: null });
        expect(await new AutomationService(null).getDueAutomations()).toEqual([]);
        await expect(act(task, 'restore')).rejects.toMatchObject({ code: 'NOT_ARCHIVED' });

        const resumed = await act(task, 'resume');
        expect(resumed).toMatchObject({ changed: true, process: { enabled: true }, lifecycle: { stage: 'active' }, controls: ['pause'] });
        const after = await db.get('SELECT isEnabled, nextRun FROM automations WHERE id = @id', { id: task.id });
        expect(after.isEnabled).toBe(1);
        expect(after.nextRun > utc(new Date())).toBe(true);
    });

    test('a resume is refused while what the process depends on is not running, or its project is out of reach', async () => {
        const projectId = await project();
        const upstream = await eventTrigger(projectId, 'ingest');
        const downstream = await eventTrigger(projectId, 'render', { sourceTriggerId: upstream.id });
        await act(downstream, 'pause');
        await act(upstream, 'pause');
        await expect(act(downstream, 'resume')).rejects.toMatchObject({
            code: 'DEPENDENCY_BLOCKED', status: 409, details: { blockedBy: [upstream.ref] }
        });
        expect((await db.get('SELECT isEnabled FROM project_triggers WHERE id = @id', { id: downstream.id })).isEnabled).toBe(0);
        await act(upstream, 'resume');
        expect((await act(downstream, 'resume')).changed).toBe(true);

        // The project changed hands while it was paused.
        await act(downstream, 'pause');
        await db.run('UPDATE observatory_projects SET userId = @B WHERE id = @id', { B, id: projectId });
        await expect(act(downstream, 'resume')).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE', status: 409 });
        expect((await db.get('SELECT isEnabled FROM project_triggers WHERE id = @id', { id: downstream.id })).isEnabled).toBe(0);
    });

    test('switching a paused process back on where it was made is followed, not fought', async () => {
        const task = await automation('nightly import');
        await act(task, 'pause');
        await automations.setEnabledById({ id: task.id, enabled: true });
        expect(await listed(task)).toMatchObject({ enabled: true, controls: ['pause'] });
        await pass();
        expect(await stage(task)).toMatchObject({ stage: 'ACTIVE', reasonCode: 'RESUMED_ELSEWHERE' });
    });
});

describe('cleanup', () => {
    async function archivedSource() {
        const feed = await source('release notes');
        const expeditionId = Number(await db.insert(
            "INSERT INTO spitball_expeditions (userId, guildId, seed) VALUES (@A, @guild, 'what changed')", { A, guild: `dm:${A}` }
        ));
        const ids = {
            fetchedOne: await entry(feed.id, 'one'),
            fetchedTwo: await entry(feed.id, 'two'),
            kept: await entry(feed.id, 'kept', { kept: 1 }),
            researched: await entry(feed.id, 'researched', { expeditionId })
        };
        await contract(feed, { purpose: 'Follow the release notes' });
        await observed(feed, { phase: 'execution' });
        await observed(feed, { phase: 'execution' });
        await act(feed, 'pause');
        await act(feed, 'archive');
        return { feed, ids };
    }

    test('only an archived process can be cleaned, and only from the manifest that was previewed', async () => {
        const task = await automation('nightly import');
        await expect(act(task, 'preview_cleanup')).rejects.toMatchObject({ code: 'ARCHIVE_FIRST' });
        await act(task, 'pause');
        await expect(act(task, 'preview_cleanup')).rejects.toMatchObject({ code: 'ARCHIVE_FIRST' });
        await act(task, 'archive');
        await expect(act(task, 'cleanup')).rejects.toMatchObject({ code: 'MANIFEST_REQUIRED', status: 400 });
        const { cleanup } = await act(task, 'preview_cleanup');
        await expect(act(task, 'cleanup', { cleanupId: cleanup.id, manifestHash: 'not-the-hash' })).rejects.toMatchObject({ code: 'MANIFEST_MISMATCH' });
        await expect(act(task, 'cleanup', { cleanupId: cleanup.id + 99, manifestHash: cleanup.manifestHash })).rejects.toMatchObject({ code: 'MANIFEST_NOT_FOUND' });
        expect((await stage(task)).stage).toBe('ARCHIVED');
    });

    test('it removes exactly what the process alone derived and leaves what a person kept, researched or was sent', async () => {
        const { feed, ids } = await archivedSource();
        await db.run(
            "INSERT INTO inbox_items (userId, kind, title, sourceType, sourceId) VALUES (@A, 'notice', 'unrelated', 'automation', '1')", { A }
        );
        const preview = await act(feed, 'preview_cleanup');
        expect(preview.cleanup).toMatchObject({
            status: 'PREVIEWED',
            removes: { observations: 2, sourceEntries: 2, sourceCache: true },
            keeps: { definition: true, contract: true, keptEntries: 2 },
            more: false
        });
        // A preview changes nothing.
        expect(await db.all('SELECT id FROM followed_source_entries', {})).toHaveLength(4);

        const applied = await act(feed, 'cleanup', { cleanupId: preview.cleanup.id, manifestHash: preview.cleanup.manifestHash });
        expect(applied).toMatchObject({
            changed: true,
            lifecycle: { stage: 'cleaned', cleaned: { observations: 2, sourceEntries: 2, sourceCache: true } },
            cleanup: {
                status: 'APPLIED',
                result: { removed: { observations: 2, sourceEntries: 2, sourceCache: true }, skipped: { observations: 0, sourceEntries: 0 } }
            }
        });
        const left = await db.all('SELECT id FROM followed_source_entries ORDER BY id', {});
        expect(left.map(row => Number(row.id))).toEqual([ids.kept, ids.researched]);
        expect(await db.all('SELECT id FROM assistant_process_observations', {})).toEqual([]);
        // The definition and its contract are untouched; the cache is gone and it will start from a new baseline.
        const row = await db.get('SELECT label, url, enabled, initialized, lastText, lastHash, etag FROM followed_sources WHERE id = @id', { id: feed.id });
        expect(row).toMatchObject({ label: 'release notes', enabled: 0, initialized: 0, lastText: null, lastHash: null, etag: null });
        expect(await db.all('SELECT id FROM assistant_process_contracts', {})).toHaveLength(1);
        expect(await db.all('SELECT id FROM inbox_items', {})).toHaveLength(1);
        expect(await db.all('SELECT id FROM spitball_expeditions', {})).toHaveLength(1);

        // Confirming the same manifest again does nothing more.
        const repeat = await act(feed, 'cleanup', { cleanupId: preview.cleanup.id, manifestHash: preview.cleanup.manifestHash });
        expect(repeat).toMatchObject({ changed: false, cleanup: { status: 'APPLIED' } });

        // Restoring says what is not coming back, and comes back paused.
        const restored = await act(feed, 'restore');
        expect(restored).toMatchObject({
            notRestored: { observations: 2, sourceEntries: 2, sourceCache: true },
            lifecycle: { stage: 'paused' }, process: { enabled: false }
        });
        expect(await db.all('SELECT id FROM followed_source_entries', {})).toHaveLength(2);
    });

    test('an entry the person kept after the preview is left alone and reported as skipped', async () => {
        const { feed, ids } = await archivedSource();
        const { cleanup } = await act(feed, 'preview_cleanup');
        await db.run('UPDATE followed_source_entries SET kept = 1 WHERE id = @id', { id: ids.fetchedOne });
        const applied = await act(feed, 'cleanup', { cleanupId: cleanup.id, manifestHash: cleanup.manifestHash });
        expect(applied.cleanup.result).toMatchObject({ removed: { sourceEntries: 1 }, skipped: { sourceEntries: 1 } });
        expect(await db.get('SELECT id FROM followed_source_entries WHERE id = @id', { id: ids.fetchedOne })).toBeTruthy();
    });

    test('a manifest stops being valid when the contract or the definition changes, when it expires, or after a restore', async () => {
        const { feed } = await archivedSource();
        const before = async () => (await db.all('SELECT id FROM followed_source_entries', {})).length;

        const first = (await act(feed, 'preview_cleanup')).cleanup;
        const current = await processes.get({ userId: A, kind: feed.kind, id: feed.id });
        await contract(feed, { purpose: 'Follow the release notes closely', expectedRevision: current.contract.revision });
        await expect(act(feed, 'cleanup', { cleanupId: first.id, manifestHash: first.manifestHash })).rejects.toMatchObject({ code: 'MANIFEST_STALE', status: 409 });
        expect((await db.get('SELECT status FROM assistant_process_cleanups WHERE id = @id', { id: first.id })).status).toBe('INVALIDATED');

        const second = (await act(feed, 'preview_cleanup')).cleanup;
        await db.run("UPDATE followed_sources SET label = 'renamed since' WHERE id = @id", { id: feed.id });
        await expect(act(feed, 'cleanup', { cleanupId: second.id, manifestHash: second.manifestHash })).rejects.toMatchObject({ code: 'MANIFEST_STALE' });

        const third = (await act(feed, 'preview_cleanup')).cleanup;
        await expect(act(feed, 'cleanup', {
            cleanupId: third.id, manifestHash: third.manifestHash, now: later(lifecycle.MANIFEST_TTL_MS + 60000)
        })).rejects.toMatchObject({ code: 'MANIFEST_EXPIRED' });
        expect((await db.get('SELECT status FROM assistant_process_cleanups WHERE id = @id', { id: third.id })).status).toBe('EXPIRED');

        const fourth = (await act(feed, 'preview_cleanup')).cleanup;
        await act(feed, 'restore');
        await expect(act(feed, 'cleanup', { cleanupId: fourth.id, manifestHash: fourth.manifestHash })).rejects.toMatchObject({ code: 'MANIFEST_STALE' });
        expect(await before()).toBe(4);
        expect(await db.all('SELECT id FROM assistant_process_observations', {})).toHaveLength(2);
    });

    test('it is refused while another process still depends on this one', async () => {
        const projectId = await project();
        const upstream = await eventTrigger(projectId, 'ingest');
        const downstream = await eventTrigger(projectId, 'render', { sourceTriggerId: upstream.id });
        await observed(upstream, { phase: 'dispatch' });
        await act(upstream, 'pause');
        await act(upstream, 'archive');
        const { cleanup, dependents } = await act(upstream, 'preview_cleanup');
        expect(dependents).toEqual([{ ref: downstream.ref, name: 'render', enabled: true }]);
        expect(cleanup.keeps).toMatchObject({ definition: true, deliveries: 0, jobs: 0 });
        await expect(act(upstream, 'cleanup', { cleanupId: cleanup.id, manifestHash: cleanup.manifestHash })).rejects.toMatchObject({
            code: 'DEPENDENTS_EXIST', status: 409, details: { dependents: [expect.objectContaining({ ref: downstream.ref })] }
        });
        expect(await db.all('SELECT id FROM assistant_process_observations', {})).toHaveLength(1);
        // Once the dependent is itself archived, the same manifest applies.
        await act(downstream, 'pause');
        await act(downstream, 'archive');
        const applied = await act(upstream, 'cleanup', { cleanupId: cleanup.id, manifestHash: cleanup.manifestHash });
        expect(applied.cleanup.result.removed.observations).toBe(1);
    });

    test('a trigger\'s delivery records and the jobs it started are never in a manifest', async () => {
        const projectId = await project();
        const trigger = await eventTrigger(projectId, 'render on finish');
        const full = await db.get('SELECT * FROM project_triggers WHERE id = @id', { id: trigger.id });
        const settled = await job(projectId);
        await triggers.claimEventFire(full, settled);
        await db.run("UPDATE project_trigger_deliveries SET status = 'DELIVERED'", {});
        await job(projectId, { triggerId: trigger.id });
        await observed(trigger, { phase: 'dispatch' });
        await act(trigger, 'pause');
        await act(trigger, 'archive');
        const { cleanup } = await act(trigger, 'preview_cleanup');
        expect(cleanup).toMatchObject({ removes: { observations: 1, sourceEntries: 0, sourceCache: false }, keeps: { deliveries: 1, jobs: 1 } });
        await act(trigger, 'cleanup', { cleanupId: cleanup.id, manifestHash: cleanup.manifestHash });
        expect(await db.all('SELECT id FROM project_trigger_deliveries', {})).toHaveLength(1);
        expect(await db.all('SELECT id FROM observatory_jobs', {})).toHaveLength(2);
        expect(await db.get('SELECT id FROM project_triggers WHERE id = @id', { id: trigger.id })).toBeTruthy();
    });
});

describe('the assistant, when a purpose is over', () => {
    test('with no grant it asks once, changes nothing, and stops asking when the person says keep it', async () => {
        const task = await automation('release watch');
        await finishedPurpose(task);
        expect(await pass()).toMatchObject({ relevance: 1, paused: 0, archived: 0 });
        let update = await updateFor(task);
        expect(update.title).toBe('"release watch" may no longer be needed');
        expect(JSON.parse(update.gateJson)).toEqual({ kind: 'process_retirement', id: task.ref, occurrence: 1 });
        expect(update.gateResolvedAt).toBeNull();
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: task.id })).isEnabled).toBe(1);
        expect(await stage(task)).toBeNull();
        expect((await listed(task)).controls).toEqual(['pause', 'keep']);
        expect(await pass()).toMatchObject({ relevance: 0 });

        const kept = await act(task, 'keep');
        expect(kept).toMatchObject({ changed: true, lifecycle: { stage: 'active', kept: { revision: 1, reason: 'GOAL_RESOLVED' } }, controls: ['pause'] });
        update = await updateFor(task);
        expect(update.gateResolvedAt).toBeTruthy();
        expect(await pass()).toMatchObject({ relevance: 0, paused: 0 });
        expect((await updateFor(task)).materialRevision).toBe(1);
        expect(await incidents.relevanceCandidates({ userId: A })).toEqual([]);

        // A changed contract is a new question, asked as a new occurrence.
        const current = await processes.get({ userId: A, kind: task.kind, id: task.id });
        await contract(task, {
            purpose: 'Tell me when the release ships, then stop', attentionItemId: current.contract.attentionItemId,
            expectedRevision: current.contract.revision
        });
        expect(await pass()).toMatchObject({ relevance: 1 });
        update = await updateFor(task);
        expect(JSON.parse(update.gateJson).occurrence).toBe(2);
        expect(update.gateResolvedAt).toBeNull();
        await expect(act(await automation('still useful'), 'keep')).rejects.toMatchObject({ code: 'NOT_A_CANDIDATE' });
    });

    test('the question is answered where it is shown: pause it, or keep it, through the same act as the Processes list', async () => {
        const gates = require('@goobster/core/services/assistantGateService');
        const inbox = require('@goobster/core/services/inboxService');
        const task = await automation('release watch');
        const other = await automation('weekly digest');
        await finishedPurpose(task);
        await finishedPurpose(other);
        await pass();

        // The Inbox's Needs-you view carries one decision card per request.
        const page = await inbox.list({ userId: A, view: 'needs_you', limit: 10 });
        const cards = page.items.map(item => item.decision).filter(Boolean);
        expect(cards).toHaveLength(2);
        const card = await gates.card({ userId: A, ref: (await updateFor(task)).id });
        expect(card).toMatchObject({
            kind: 'process_retirement', state: 'open', title: '"release watch" may no longer be needed',
            detail: 'The goal it was set up for is resolved. It is still switched on.',
            occurrence: 1, revision: 'c1:GOAL_RESOLVED:l0'
        });
        expect(card.options.map(option => option.id)).toEqual(['pause', 'keep']);
        // Not theirs: it does not exist for anyone else.
        expect(await gates.card({ userId: B, ref: card.ref })).toBeNull();
        await expect(gates.decide({
            userId: B, ref: card.ref, option: 'pause', occurrence: 1, revision: card.revision, surface: 'home'
        })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

        const paused = await gates.decide({
            userId: A, ref: card.ref, option: 'pause', occurrence: card.occurrence, revision: card.revision, surface: 'home'
        });
        expect(paused.decided).toMatchObject({ kind: 'process_retirement', option: 'pause', message: 'Paused "release watch". Nothing new will start.' });
        expect(paused.current).toMatchObject({ state: 'resolved', outcome: '"release watch" is paused.', options: [] });
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: task.id })).isEnabled).toBe(0);
        expect(await stage(task)).toMatchObject({ stage: 'PAUSED', actorKind: 'person', reasonCode: 'PERSON' });
        expect((await updateFor(task)).gateResolvedAt).toBeTruthy();
        // The same card pressed again, in another tab, decides nothing.
        await expect(gates.decide({
            userId: A, ref: card.ref, option: 'keep', occurrence: card.occurrence, revision: card.revision, surface: 'inbox'
        })).rejects.toMatchObject({ status: 409, code: 'STALE_GATE' });
        expect((await stage(task)).keptRevision).toBeNull();

        // Keep, for the other one. A card shown before the process changed is refused.
        const second = await gates.card({ userId: A, ref: (await updateFor(other)).id });
        await act(other, 'pause');
        await act(other, 'resume');
        await db.run('UPDATE assistant_process_lifecycle SET keptRevision = NULL, keptReason = NULL, keptAt = NULL WHERE processId = @id', { id: String(other.id) });
        await pass();
        await expect(gates.decide({
            userId: A, ref: second.ref, option: 'keep', occurrence: second.occurrence, revision: second.revision, surface: 'home'
        })).rejects.toMatchObject({ status: 409, code: 'STALE_GATE' });
        const again = await gates.card({ userId: A, ref: second.ref });
        expect(again).toMatchObject({ state: 'open', occurrence: 2 });
        const kept = await gates.decide({
            userId: A, ref: again.ref, option: 'keep', occurrence: again.occurrence, revision: again.revision, surface: 'inbox'
        });
        expect(kept.decided.message).toBe('"weekly digest" stays on.');
        expect(kept.current).toMatchObject({ state: 'resolved', outcome: 'You chose to keep "weekly digest" running.' });
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: other.id })).isEnabled).toBe(1);
        expect(await pass()).toMatchObject({ relevance: 0, paused: 0 });
        expect((await inbox.list({ userId: A, view: 'needs_you', limit: 10 })).needsYou).toBe(0);
    });

    test('a grant that names the process is not enough while Attention does not let it act on schedules', async () => {
        const task = await automation('release watch');
        await finishedPurpose(task);
        await grant(['process.pause'], [task.ref]);
        // The default boundary for schedules allows reading, not acting.
        expect(await pass()).toMatchObject({ relevance: 1, paused: 0 });
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: task.id })).isEnabled).toBe(1);
        // Looking for work a grant covers is not a refused action: nothing is written to the failure ledger.
        expect(await db.all('SELECT id FROM work_failures', {})).toEqual([]);
    });

    test('inside its grant it pauses, says so with the way back, and leaves it alone once the person resumes', async () => {
        const task = await automation('release watch');
        const other = await automation('unrelated watch');
        await finishedPurpose(task);
        await finishedPurpose(other);
        const responsibility = await grant(['process.pause'], [task.ref]);
        await policies.setBoundary({ userId: A, category: 'schedule', proactiveCompute: true });

        expect(await pass()).toMatchObject({ relevance: 1, paused: 1, archived: 0 });
        expect((await db.get('SELECT isEnabled, nextRun FROM automations WHERE id = @id', { id: task.id }))).toEqual({ isEnabled: 0, nextRun: null });
        expect(await stage(task)).toMatchObject({
            stage: 'PAUSED', actorKind: 'assistant', responsibilityId: responsibility.id, reasonCode: 'RETIRE_GOAL_RESOLVED'
        });
        const update = await updateFor(task);
        expect(update).toMatchObject({ title: 'Paused "release watch"', gateJson: null, responsibilityId: responsibility.id });
        expect(update.summary).toBe(
            'The goal it was set up for is resolved. I paused it under "Keep my recurring work tidy". Nothing was deleted, and you can resume it from Processes.'
        );
        // The grant names one process: the other is only asked about.
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: other.id })).isEnabled).toBe(1);
        expect(JSON.parse((await updateFor(other)).gateJson).kind).toBe('process_retirement');
        expect(await pass()).toMatchObject({ relevance: 0, paused: 0 });

        // The person resumes it: that is their answer, and it is not paused again.
        const resumed = await act(task, 'resume');
        expect(resumed.lifecycle).toMatchObject({ stage: 'active', actor: 'person', kept: { reason: 'GOAL_RESOLVED' } });
        expect(await pass()).toMatchObject({ paused: 0 });
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: task.id })).isEnabled).toBe(1);
    });

    test('switching it back on where it was made also counts as the person\'s answer', async () => {
        const task = await automation('release watch');
        await finishedPurpose(task);
        await grant(['process.pause'], [task.ref]);
        await policies.setBoundary({ userId: A, category: 'schedule', proactiveCompute: true });
        expect(await pass()).toMatchObject({ paused: 1 });
        await automations.setEnabledById({ id: task.id, enabled: true });
        expect(await pass()).toMatchObject({ paused: 0, relevance: 0 });
        expect(await stage(task)).toMatchObject({ stage: 'ACTIVE', reasonCode: 'RESUMED_ELSEWHERE', keptReason: 'GOAL_RESOLVED' });
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: task.id })).isEnabled).toBe(1);
    });

    test('a revoked grant, or a process others depend on, gets a request instead of a pause', async () => {
        const projectId = await project();
        const upstream = await eventTrigger(projectId, 'ingest');
        const downstream = await eventTrigger(projectId, 'render', { sourceTriggerId: upstream.id });
        await finishedPurpose(upstream);
        const task = await automation('release watch');
        await finishedPurpose(task);
        const responsibility = await grant(['process.pause'], [upstream.ref, task.ref]);
        await policies.setBoundary({ userId: A, category: 'schedule', proactiveCompute: true });
        await responsibilities.act({ userId: A, id: responsibility.id, action: 'pause', expectedRevision: responsibility.revision });

        expect(await pass()).toMatchObject({ relevance: 2, paused: 0 });
        const paused = await responsibilities.get({ userId: A, id: responsibility.id });
        await responsibilities.act({ userId: A, id: responsibility.id, action: 'resume', expectedRevision: paused.revision });
        expect(await pass()).toMatchObject({ paused: 1 });
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: task.id })).isEnabled).toBe(0);
        // "render" still runs on "ingest": it is left on and the request says why.
        expect((await db.get('SELECT isEnabled FROM project_triggers WHERE id = @id', { id: upstream.id })).isEnabled).toBe(1);
        expect((await updateFor(upstream)).summary).toContain('1 other process of yours depends on it.');
        expect((await db.get('SELECT isEnabled FROM project_triggers WHERE id = @id', { id: downstream.id })).isEnabled).toBe(1);
    });

    test('a watch on a branch that merged becomes a candidate and follows the grant: paused now, archived after a week', async () => {
        const branch = await watch('when the release branch changes');
        await contract(branch, { purpose: 'Tell me about pushes to the release branch' });
        await observed(branch, { phase: 'execution', outcome: 'ok', reasonCode: 'TARGET_MERGED' });
        expect(await listed(branch)).toMatchObject({ assessment: { relevance: 'retirement_candidate', reasons: { relevance: 'TARGET_MERGED' } } });
        const responsibility = await grant(['process.pause', 'process.archive'], [branch.ref]);
        await policies.setBoundary({ userId: A, category: 'schedule', proactiveCompute: true });

        const start = new Date();
        expect(await pass(start)).toMatchObject({ paused: 1, archived: 0 });
        expect((await updateFor(branch)).summary).toContain('What it was watching has been merged. I paused it');
        expect(await db.get('SELECT status, archivedAt FROM attention_watches WHERE id = @id', { id: branch.id })).toEqual({ status: 'ARMED', archivedAt: null });
        expect((await db.get('SELECT pausedAt FROM attention_watches WHERE id = @id', { id: branch.id })).pausedAt).toBeTruthy();

        // Not before the week is up.
        expect(await pass(new Date(start.getTime() + 6 * DAY))).toMatchObject({ archived: 0 });
        expect((await stage(branch)).stage).toBe('PAUSED');
        expect(await pass(new Date(start.getTime() + 8 * DAY))).toMatchObject({ archived: 1 });
        expect(await stage(branch)).toMatchObject({ stage: 'ARCHIVED', actorKind: 'assistant', responsibilityId: responsibility.id });
        expect((await db.get('SELECT archivedAt FROM attention_watches WHERE id = @id', { id: branch.id })).archivedAt).toBeTruthy();
        const update = await updateFor(branch);
        expect(update.title).toBe('Archived "when the release branch changes"');
        expect(update.summary).toContain('you can restore it from Processes');
        // It never goes further on its own: nothing is cleaned up.
        expect(await pass(new Date(start.getTime() + 60 * DAY))).toMatchObject({ archived: 0 });
        expect(await db.all('SELECT id FROM assistant_process_cleanups', {})).toEqual([]);
        expect(await db.all('SELECT id FROM assistant_process_observations', {})).toHaveLength(1);
    });

    test('what the person paused themselves is never archived for them, and a pause grant alone never archives', async () => {
        const mine = await automation('paused by me');
        const theirs = await automation('paused by the assistant');
        await finishedPurpose(mine);
        await finishedPurpose(theirs);
        await policies.setBoundary({ userId: A, category: 'schedule', proactiveCompute: true });
        await act(mine, 'pause');
        await grant(['process.pause'], [theirs.ref]);
        await grant(['process.archive'], [mine.ref]);
        const start = new Date();
        expect(await pass(start)).toMatchObject({ paused: 1 });
        expect(await pass(new Date(start.getTime() + 30 * DAY))).toMatchObject({ archived: 0 });
        expect((await stage(mine)).stage).toBe('PAUSED');
        expect((await stage(theirs)).stage).toBe('PAUSED');
    });

    test('results nobody opened give no authority to retire a process, with or without a grant', async () => {
        const digest = await automation('daily digest');
        await contract(digest, { purpose: 'A morning digest of my feeds' });
        await observed(digest);
        for (let index = 0; index < DEFAULTS.ignoredResults + 2; index += 1) {
            await db.run(
                "INSERT INTO inbox_items (userId, kind, title, sourceType, sourceId) VALUES (@A, 'task', 'Digest', 'automation', @id)",
                { A, id: String(digest.id) }
            );
        }
        await grant(['process.pause', 'process.archive'], [digest.ref]);
        await policies.setBoundary({ userId: A, category: 'schedule', proactiveCompute: true });
        expect(await listed(digest)).toMatchObject({ assessment: { relevance: 'active', signals: { resultsIgnored: true } }, controls: ['pause'] });
        expect(await pass()).toMatchObject({ relevance: 0, paused: 0, archived: 0 });
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: digest.id })).isEnabled).toBe(1);
        expect(await db.all('SELECT id FROM assistant_updates', {})).toEqual([]);
        expect(await stage(digest)).toBeNull();
    });

    test('a request is closed when the reason for it goes away, and nothing happens for a person with Attention off', async () => {
        const task = await automation('release watch');
        const itemId = await finishedPurpose(task);
        await pass();
        expect((await updateFor(task)).gateResolvedAt).toBeNull();
        await db.run("UPDATE attention_items SET state = 'active' WHERE id = @id", { id: itemId });
        await pass();
        expect((await updateFor(task)).gateResolvedAt).toBeTruthy();

        const theirs = await automation('their watch', { userId: B });
        await finishedPurpose(theirs);
        await grant(['process.pause'], [theirs.ref], B).catch(() => null);
        expect(await pass(new Date(), B)).toMatchObject({ relevance: 0, paused: 0 });
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: theirs.id })).isEnabled).toBe(1);
    });
});

describe('boundaries', () => {
    test('one person cannot act on, or see the lifecycle of, another person\'s process', async () => {
        const task = await automation('nightly import');
        for (const action of ['pause', 'resume', 'archive', 'restore', 'keep', 'preview_cleanup', 'cleanup']) {
            await expect(lifecycle.act({ userId: B, kind: task.kind, id: task.id, action })).rejects.toMatchObject({ status: 404 });
        }
        await act(task, 'pause');
        expect((await processes.list({ userId: B })).processes).toEqual([]);
        expect((await db.get('SELECT isEnabled FROM automations WHERE id = @id', { id: task.id })).isEnabled).toBe(0);
    });

    test('with the assistant feature off the route\'s service refuses nothing silently and the steward does nothing', async () => {
        const task = await automation('release watch');
        await finishedPurpose(task);
        useState({ inactive: ['assistant'] });
        expect(await lifecycle.steward({ owner: A, entries: [], now: new Date() })).toEqual({ requested: 0, paused: 0, archived: 0 });
        expect(await pass()).toMatchObject({ owners: 0 });
    });

    test('erasing a person removes their lifecycle records and manifests and leaves everyone else\'s', async () => {
        await policies.enroll({ userId: B, initiative: 'assist' });
        const mine = await automation('mine');
        const theirs = await automation('theirs', { userId: B });
        for (const item of [mine, theirs]) {
            await act(item, 'pause');
            await act(item, 'archive');
            await act(item, 'preview_cleanup');
        }
        const report = await privacy.buildUserReport({ userId: A });
        expect(JSON.stringify(report)).toContain('archivedProcesses');
        const counts = await privacy.forgetUser({ userId: A });
        expect(counts).toMatchObject({ processLifecycle: 1, processCleanups: 1 });
        const audit = await privacy.auditUser({ userId: A });
        expect(audit.byTable).toMatchObject({ assistant_process_lifecycle: 0, assistant_process_cleanups: 0 });
        expect(await db.all('SELECT ownerUserId FROM assistant_process_lifecycle', {})).toEqual([{ ownerUserId: B }]);
        expect(await db.all('SELECT ownerUserId FROM assistant_process_cleanups', {})).toEqual([{ ownerUserId: B }]);
    });

    test('retention drops records of deleted processes, old resumed ones and stale manifests, and keeps what is still paused', async () => {
        const gone = await automation('deleted since');
        const resumed = await automation('running again');
        const paused = await automation('still paused');
        for (const item of [gone, resumed, paused]) await act(item, 'pause');
        await act(resumed, 'resume');
        await act(gone, 'archive');
        await act(gone, 'preview_cleanup');
        await act(paused, 'archive');
        await act(paused, 'preview_cleanup');
        await db.run('DELETE FROM automations WHERE id = @id', { id: gone.id });

        expect(await lifecycle.prune({ now: new Date() })).toEqual({ lifecycle: 1, cleanups: 1 });
        const far = later(200 * DAY);
        expect(await lifecycle.prune({ now: far })).toEqual({ lifecycle: 1, cleanups: 1 });
        expect(await db.all('SELECT processId, stage FROM assistant_process_lifecycle', {})).toEqual([{ processId: String(paused.id), stage: 'ARCHIVED' }]);
        // The steward's retention pass runs it.
        const swept = await steward.sweep({ now: far, retention: true });
        expect(swept.retention.lifecycle).toEqual({ lifecycle: 0, cleanups: 0 });
    });
});
