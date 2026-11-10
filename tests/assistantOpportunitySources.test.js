/**
 * The followed-source, failed-run and CI-verdict opportunity sources, and
 * the owner-only pilot gate in front of all four DA-8 sources (ADR 0026).
 * Throwaway database, no provider, no network, no GitHub call.
 *
 * Acceptance scenarios covered here: one investigation per failure cause
 * (three retries of a broken script, or a changed line number, are one
 * problem); a skipped CI run is not a pass; a flood cannot exceed the cap;
 * what existed when the person delegated is history; a source that can no
 * longer be read stops proposing at once; and a closed pilot stops every
 * source for everyone but the owner.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-opportunity-sources-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const access = require('@goobster/core/services/assistantAccessService');
const control = require('@goobster/core/services/assistantControlService');
const projectService = require('@goobster/core/services/projectService');
const caps = require('@goobster/core/services/assistant/proposalCaps');
const followedSource = require('@goobster/core/services/assistant/sources/followedSource');
const jobFailure = require('@goobster/core/services/assistant/sources/jobFailure');
const ciVerdict = require('@goobster/core/services/assistant/sources/ciVerdict');
const kit = require('./helpers/opportunityKit');
const { useState } = require('./helpers/featureFixtures');

const { A, B, OWNER } = kit;

afterAll(async () => {
    initiatives.stopListening();
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    jest.restoreAllMocks();
    await kit.reset();
    await kit.openPilot();
});

const later = (minutes = 1) => new Date(Date.now() + minutes * 60_000);

describe('followed_source: an item the person kept', () => {
    async function setup({ kept = 0 } = {}) {
        const pid = await kit.project();
        const source = await kit.followed({ projectId: pid });
        const earlier = await kit.entry(source, { title: 'Old item', kept });
        const ops = [
            { operation: 'read', resource: { kind: 'project', ids: [String(pid)] } },
            { operation: 'read', resource: { kind: 'process', ids: [`followed_source:${source}`] } }
        ];
        const grant = await kit.delegate({ projectId: pid, sources: ['followed_source'], operations: ops });
        return { pid, source, earlier, grant };
    }

    test('an item kept before delegating is history; keeping one afterwards proposes work, once', async () => {
        const { source, earlier, grant } = await setup({ kept: 1 });
        expect(await kit.rows()).toEqual([]);
        expect((await kit.look(grant)).proposed).toEqual([]);

        const fresh = await kit.entry(source, { title: 'New benchmark results' });
        // A new entry nobody kept is observed and never proposed.
        expect((await kit.look(grant)).proposed).toEqual([]);
        expect(await kit.rows()).toEqual([]);
        await kit.keep(fresh);
        expect((await kit.look(grant, later())).proposed).toHaveLength(1);
        expect((await kit.look(grant, later(2))).proposed).toEqual([]);

        const [item] = await kit.rows();
        expect(item).toMatchObject({
            sourceKind: 'followed_source', sourceId: `entry:${fresh}`, status: 'CANDIDATE', ownerUserId: A,
            title: 'Kept an item from "Research feed"'
        });
        expect(JSON.parse(item.originJson)).toEqual({ kind: 'followed_source_entry', followedSourceId: source, entryId: fresh });
        expect(JSON.stringify(item)).not.toMatch(/benchmark/i);
        expect(earlier).toBeLessThan(fresh);
    });

    test('un-keeping withdraws the proposal; keeping it again is the same opportunity, not a second', async () => {
        const { source, grant } = await setup();
        const fresh = await kit.entry(source, { title: 'A paper' });
        await kit.look(grant);
        await kit.keep(fresh);
        const [id] = (await kit.look(grant, later())).proposed;
        await kit.keep(fresh, 0);
        expect((await kit.look(grant, later(2))).superseded).toBe(1);
        expect(await kit.row(id)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'SOURCE_GONE' });
        await kit.keep(fresh, 1);
        expect((await kit.look(grant, later(3))).proposed).toEqual([]);
        expect(await kit.rows()).toHaveLength(1);
    });

    test('unfollowing, or a responsibility that stopped naming the source, stops it at once', async () => {
        const { source, grant } = await setup();
        const one = await kit.entry(source, { title: 'One' });
        const two = await kit.entry(source, { title: 'Two' });
        await kit.look(grant);
        await kit.keep(one);
        await kit.keep(two);
        const [a, b] = (await kit.look(grant, later())).proposed;
        await db.run("UPDATE assistant_responsibilities SET scopesJson = '{\"sources\":[]}' WHERE id = @id", { id: grant.id });
        expect((await kit.look(grant, later(2))).superseded).toBe(2);
        expect(await kit.row(a)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'SOURCE_NOT_COVERED' });
        expect(b).toBeTruthy();

        await db.run('DELETE FROM followed_sources WHERE id = @id', { id: source });
        expect(await followedSource.stale(await kit.fresh(grant.id))).toEqual([]);
    });

    test('a source nobody named in a grant is not read, and a source of another person never is', async () => {
        const pid = await kit.project();
        const mine = await kit.followed({ projectId: pid, label: 'Mine' });
        const theirs = await kit.followed({ userId: B, projectId: await kit.project({ owner: B, slug: 'theirs' }), label: 'Theirs', url: 'https://example.org/other' });
        const grant = await kit.delegate({
            projectId: pid, sources: ['followed_source'],
            operations: [
                { operation: 'read', resource: { kind: 'project', ids: [String(pid)] } },
                { operation: 'read', resource: { kind: 'process', ids: [`followed_source:${mine}`] } }
            ]
        });
        const unnamed = await kit.entry(mine, { title: 'Mine one' });
        const others = await kit.entry(theirs, { title: 'Theirs one', kept: 1 });
        await kit.look(grant);
        await kit.keep(unnamed);
        expect((await kit.look(grant, later())).proposed).toHaveLength(1);
        const read = await followedSource.read(await kit.fresh(grant.id));
        expect(read.map(source => source.sourceId)).toEqual([`entry:${unnamed}`]);
        expect(read.map(source => source.sourceId)).not.toContain(`entry:${others}`);
    });

    test('a flood of kept items cannot exceed the daily cap', async () => {
        const { source, grant } = await setup();
        const ids = [];
        for (let n = 0; n < 6; n += 1) ids.push(await kit.entry(source, { title: `Item ${n}` }));
        await kit.look(grant);
        for (const id of ids) await kit.keep(id);
        const outcome = await kit.look(grant, later());
        expect(outcome.proposed).toHaveLength(caps.DEFAULT_MAX_PER_DAY);
        expect(outcome.capped).toBe(6 - caps.DEFAULT_MAX_PER_DAY);
        expect((await kit.look(grant, later(2))).proposed).toEqual([]);
        expect(await kit.rows()).toHaveLength(caps.DEFAULT_MAX_PER_DAY);
    });

    test('the look-back counts kept items as history and shows a few', async () => {
        const { source, grant } = await setup({ kept: 1 });
        await kit.entry(source, { title: 'Another', kept: 1 });
        const overview = await followedSource.lookback(await kit.fresh(grant.id));
        expect(overview).toEqual({ sources: 1, ignored: 2, examples: ['Kept an item from "Research feed"', 'Kept an item from "Research feed"'] });
    });
});

describe('job_failure: one investigation per failure cause', () => {
    async function setup({ before = [] } = {}) {
        const pid = await kit.project();
        for (const stderr of before) await kit.job(pid, { stderr });
        const grant = await kit.delegate({ projectId: pid, sources: ['job_failure'] });
        return { pid, grant };
    }

    test('causeOf ignores line numbers, timestamps and library frames, and tells exceptions and files apart', () => {
        const base = { status: 'FAILED', exitCode: 1, language: 'python', assetVersionId: null };
        const cause = (stderrTail, overrides = {}) => jobFailure.causeOf({ ...base, stderrTail, error: null, ...overrides }).cause;
        expect(cause(kit.trace({ line: 12 }))).toBe(cause(kit.trace({ line: 99 })));
        expect(cause(kit.trace({ file: '/home/ada/.cache/work/analysis/load.py' }))).toBe(cause(kit.trace({ file: '/workspace/analysis/load.py' })));
        expect(cause(kit.trace({ detail: "'price'" }))).toBe(cause(kit.trace({ detail: "'cost'" })));
        expect(cause(kit.trace({ kind: 'ValueError' }))).not.toBe(cause(kit.trace({ kind: 'KeyError' })));
        expect(cause(kit.trace({ file: '/workspace/analysis/other.py' }))).not.toBe(cause(kit.trace()));
        expect(cause(kit.trace(), { exitCode: 2 })).not.toBe(cause(kit.trace()));
        expect(cause(kit.trace(), { status: 'TIMED_OUT' })).not.toBe(cause(kit.trace()));
        // No exception and no frame of the person's own: the language and asset version stand for it.
        expect(cause('killed', { assetVersionId: 4 })).toBe(cause('Killed', { assetVersionId: 4 }));
        expect(cause('killed', { assetVersionId: 4 })).not.toBe(cause('killed', { assetVersionId: 5 }));
        expect(jobFailure.causeOf({ ...base, stderrTail: kit.trace(), error: null })).toMatchObject({ kind: 'KeyError', file: 'analysis/load.py' });
    });

    test('failures before delegating are history; three retries of one broken script are one problem', async () => {
        const { pid, grant } = await setup({ before: [kit.trace({ kind: 'ImportError', detail: 'no module named old' })] });
        expect((await kit.look(grant)).proposed).toEqual([]);

        await kit.job(pid, { stderr: kit.trace({ line: 12 }) });
        await kit.job(pid, { stderr: kit.trace({ line: 14 }) });
        await kit.job(pid, { stderr: kit.trace({ line: 20, detail: "'cost'" }) });
        const outcome = await kit.look(grant);
        expect(outcome.proposed).toHaveLength(1);
        expect((await kit.look(grant, later())).proposed).toEqual([]);

        // A later retry of the same broken script is still that problem.
        await kit.job(pid, { stderr: kit.trace({ line: 31 }) });
        expect((await kit.look(grant, later(2))).proposed).toEqual([]);

        // A different cause is a new investigation.
        await kit.job(pid, { stderr: kit.trace({ kind: 'ZeroDivisionError', detail: 'division by zero' }) });
        expect((await kit.look(grant, later(3))).proposed).toHaveLength(1);

        const items = await kit.rows();
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ sourceKind: 'job_failure', status: 'CANDIDATE', title: 'A python run failed' });
        expect(JSON.parse(items[0].originJson)).toMatchObject({ kind: 'job_failure', projectId: pid, status: 'FAILED' });
        expect(JSON.stringify(items)).not.toMatch(/load\.py|price|KeyError/);
    });

    test('a cause that was already failing when the person delegated is not new', async () => {
        const { pid, grant } = await setup({ before: [kit.trace()] });
        await kit.look(grant);
        await kit.job(pid, { stderr: kit.trace({ line: 77 }) });
        expect((await kit.look(grant, later())).proposed).toEqual([]);
    });

    test('only the person\'s own failed runs: not the assistant\'s, another member\'s, or a cancelled one', async () => {
        const pid = await kit.project({ members: [B] });
        const grant = await kit.delegate({ projectId: pid, sources: ['job_failure'] });
        await kit.look(grant);
        await kit.job(pid, { userId: B, stderr: kit.trace({ kind: 'KeyError' }) });
        await kit.job(pid, { startedBy: 'assistant', stderr: kit.trace({ kind: 'ValueError' }) });
        await kit.job(pid, { status: 'CANCELLED', stderr: kit.trace({ kind: 'TypeError' }) });
        await kit.job(pid, { status: 'INTERRUPTED', createdAt: kit.utc(new Date(Date.now() - 2 * 86_400_000)), stderr: kit.trace({ kind: 'OSError' }) });
        expect((await kit.look(grant, later())).proposed).toEqual([]);
        await kit.job(pid, { status: 'TIMED_OUT', exitCode: null, stderr: null });
        const [id] = (await kit.look(grant, later(2))).proposed;
        expect(await kit.row(id)).toMatchObject({ title: 'A python run failed (timed out)' });
    });

    test('a job that is still running holds the cursor; it is read when it finishes', async () => {
        const { pid, grant } = await setup();
        await kit.look(grant);
        const running = await kit.job(pid, { status: 'RUNNING', exitCode: null });
        await kit.job(pid, { stderr: kit.trace({ kind: 'ValueError' }) });
        const outcome = await kit.look(grant, later());
        expect(outcome.proposed).toEqual([]);
        await db.run("UPDATE observatory_jobs SET status = 'FAILED', exitCode = 1, stderrTail = @t, finishedAt = datetime('now') WHERE id = @id", { id: running, t: kit.trace() });
        expect((await kit.look(grant, later(2))).proposed).toHaveLength(2);
    });

    test('a restart that replays the log finds its own work and adds nothing', async () => {
        const { pid, grant } = await setup();
        await kit.look(grant);
        await kit.job(pid, { stderr: kit.trace() });
        const [id] = (await kit.look(grant, later())).proposed;
        await db.run("UPDATE assistant_source_cursors SET sourceRevision = '0' WHERE responsibilityId = @id AND sourceKind = 'job_failure'", { id: grant.id });
        expect((await kit.look(grant, later(2))).proposed).toEqual([]);
        expect(await kit.rows()).toHaveLength(1);
        expect((await kit.row(id)).status).toBe('CANDIDATE');
    });

    test('a flood of different failures cannot exceed the daily cap', async () => {
        const { pid, grant } = await setup();
        await kit.look(grant);
        for (let n = 0; n < 7; n += 1) await kit.job(pid, { stderr: kit.trace({ file: `/workspace/step${n}.py` }) });
        const outcome = await kit.look(grant, later());
        expect(outcome.proposed).toHaveLength(caps.DEFAULT_MAX_PER_DAY);
        expect(outcome.capped).toBe(7 - caps.DEFAULT_MAX_PER_DAY);
        expect((await kit.look(grant, later(2))).proposed).toEqual([]);
    });

    test('a project the grant does not cover, or the person can no longer see, is not read', async () => {
        const pid = await kit.project();
        const grant = await kit.delegate({ projectId: pid, sources: ['job_failure'] });
        await kit.look(grant);
        await kit.job(pid, { stderr: kit.trace() });
        const [id] = (await kit.look(grant, later())).proposed;
        await db.run('DELETE FROM project_members WHERE projectId = @id', { id: pid });
        await db.run("UPDATE observatory_projects SET userId = @other WHERE id = @id", { id: pid, other: B });
        // The person lost the project: the attempt is withdrawn, never started, and nothing more is read.
        expect((await kit.look(grant, later(2))).superseded).toBe(1);
        expect(await kit.row(id)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'SOURCE_NOT_COVERED' });
        expect(await jobFailure.read(await kit.fresh(grant.id), {})).toBeNull();
    });

    test('the look-back shows the failures that count as history', async () => {
        const { grant } = await setup({ before: [kit.trace(), kit.trace({ line: 5 }), kit.trace({ kind: 'ValueError' })] });
        const overview = await jobFailure.lookback(await kit.fresh(grant.id));
        expect(overview).toMatchObject({ sources: 1, ignored: 2 });
        expect(overview.examples).toHaveLength(2);
    });
});

describe('ci_verdict: a settled verdict on a watched branch', () => {
    async function setup({ state = 'success', mode = 'notify', branches = null } = {}) {
        const pid = await kit.project();
        const repoId = await kit.repo(pid);
        const watchId = await kit.watch({ repoId, projectId: pid, mode, state });
        const resource = { kind: 'repository', ids: ['acme/widgets'], projectId: String(pid), ...(branches ? { branches } : {}) };
        const grant = await kit.delegate({
            projectId: pid, sources: ['ci_verdict'],
            operations: [{ operation: 'read', resource: { kind: 'project', ids: [String(pid)] } }, { operation: 'read', resource }]
        });
        return { pid, repoId, watchId, grant };
    }

    test('a branch that was already red when the person delegated is history; a new failure is proposed once', async () => {
        const { watchId, grant } = await setup({ state: 'failure' });
        expect((await kit.look(grant)).proposed).toEqual([]);
        expect(ciVerdict.lookback).toBeInstanceOf(Function);
        expect(await ciVerdict.lookback(await kit.fresh(grant.id))).toMatchObject({ sources: 1, ignored: 1, examples: ['CI failed on acme/widgets main'] });

        await kit.settle(watchId, 'bbbbbbb2', 'failure');
        expect((await kit.look(grant, later())).proposed).toHaveLength(1);
        expect((await kit.look(grant, later(2))).proposed).toEqual([]);
        // The same verdict polled again is not another one.
        await kit.settle(watchId, 'bbbbbbb2', 'failure');
        expect((await kit.look(grant, later(3))).proposed).toEqual([]);

        const [item] = await kit.rows();
        expect(item).toMatchObject({ sourceKind: 'ci_verdict', sourceId: `watch:${watchId}`, title: 'CI failed on acme/widgets main', status: 'CANDIDATE' });
        expect(JSON.parse(item.originJson)).toMatchObject({ kind: 'ci_verdict', repo: 'acme/widgets', branch: 'main', sha: 'bbbbbbb2', state: 'failure', recovered: false });
    });

    test('skipped is not passing: it neither recovers a red branch nor erases that it was red', async () => {
        const { watchId, grant } = await setup();
        await kit.look(grant);
        await kit.settle(watchId, 'sha-red', 'failure');
        await kit.look(grant, later());
        // CI that did not run says nothing: no proposal, and the branch is still known to have been red.
        for (const [n, state] of ['skipped', 'incomplete', 'pending', 'none'].entries()) {
            await kit.settle(watchId, `sha-${state}`, state);
            expect((await kit.look(grant, later(2 + n))).proposed).toEqual([]);
        }
        expect(await kit.rows()).toHaveLength(1);
        const cursor = await db.get("SELECT sourceRevision FROM assistant_source_cursors WHERE sourceKind = 'ci_verdict'", {});
        expect(ciVerdict.parseCursor(cursor.sourceRevision)).toEqual({ sha: 'sha-none', state: 'none', settled: 'failure' });

        // Real checks passing afterwards is the recovery.
        await kit.settle(watchId, 'sha-green', 'success');
        const [id] = (await kit.look(grant, later(10))).proposed;
        expect(await kit.row(id)).toMatchObject({ title: 'CI is green again on acme/widgets main' });
        expect(JSON.parse((await kit.row(id)).originJson)).toMatchObject({ recovered: true, state: 'success' });
    });

    test('green after green, and skipped after green, propose nothing', async () => {
        const { watchId, grant } = await setup();
        await kit.look(grant);
        await kit.settle(watchId, 'sha-2', 'success');
        await kit.settle(watchId, 'sha-3', 'skipped');
        await kit.settle(watchId, 'sha-4', 'success');
        expect((await kit.look(grant, later())).proposed).toEqual([]);
        expect(await kit.rows()).toEqual([]);
    });

    test('a newer head commit replaces an open verdict: the old attempt is withdrawn, the new one proposed', async () => {
        const { watchId, grant } = await setup();
        await kit.look(grant);
        await kit.settle(watchId, 'sha-red-1', 'failure');
        const [first] = (await kit.look(grant, later())).proposed;
        await kit.settle(watchId, 'sha-red-2', 'failure');
        const outcome = await kit.look(grant, later(2));
        expect(outcome.superseded).toBe(1);
        expect(outcome.proposed).toHaveLength(1);
        expect(await kit.row(first)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'SOURCE_MOVED' });
    });

    test('a watch in fix mode belongs to the watch; the adapter leaves its verdicts alone', async () => {
        const { watchId, grant } = await setup({ mode: 'fix' });
        await kit.look(grant);
        await kit.settle(watchId, 'sha-red', 'failure');
        expect((await kit.look(grant, later())).proposed).toEqual([]);
        expect(await kit.rows()).toEqual([]);
    });

    test('it never calls GitHub and never touches a token', async () => {
        const ci = jest.spyOn(projectService.repos, 'ci').mockRejectedValue(new Error('must not be called'));
        const { watchId, grant } = await setup();
        await kit.look(grant);
        await kit.settle(watchId, 'sha-red', 'failure');
        expect((await kit.look(grant, later())).proposed).toHaveLength(1);
        expect(ci).not.toHaveBeenCalled();
    });

    test('only the branches the grant names are read; a watch of another person is never read', async () => {
        const pid = await kit.project();
        const repoId = await kit.repo(pid);
        const main = await kit.watch({ repoId, projectId: pid, branch: 'main' });
        const dev = await kit.watch({ repoId, projectId: pid, branch: 'dev' });
        const theirs = await kit.watch({ repoId, projectId: pid, userId: B, branch: 'main' });
        const grant = await kit.delegate({
            projectId: pid, sources: ['ci_verdict'],
            operations: [
                { operation: 'read', resource: { kind: 'project', ids: [String(pid)] } },
                { operation: 'read', resource: { kind: 'repository', ids: ['acme/widgets'], projectId: String(pid), branches: ['main'] } }
            ]
        });
        await kit.look(grant);
        for (const id of [main, dev, theirs]) await kit.settle(id, 'sha-red', 'failure');
        const outcome = await kit.look(grant, later());
        expect(outcome.proposed).toHaveLength(1);
        expect((await kit.rows())[0].sourceId).toBe(`watch:${main}`);
    });

    test('a flood of red branches cannot exceed the daily cap', async () => {
        const pid = await kit.project();
        const repoId = await kit.repo(pid);
        const watches = [];
        for (const branch of ['b1', 'b2', 'b3', 'b4', 'b5']) watches.push(await kit.watch({ repoId, projectId: pid, branch }));
        const grant = await kit.delegate({
            projectId: pid, sources: ['ci_verdict'],
            operations: [
                { operation: 'read', resource: { kind: 'project', ids: [String(pid)] } },
                { operation: 'read', resource: { kind: 'repository', ids: ['acme/widgets'], projectId: String(pid) } }
            ]
        });
        await kit.look(grant);
        for (const id of watches) await kit.settle(id, 'sha-red', 'failure');
        const outcome = await kit.look(grant, later());
        expect(outcome.proposed).toHaveLength(caps.DEFAULT_MAX_PER_DAY);
        expect(outcome.capped).toBe(2);
        expect((await kit.look(grant, later(2))).proposed).toEqual([]);
    });

    test('deleting the watch takes its open verdict away', async () => {
        const { watchId, grant } = await setup();
        await kit.look(grant);
        await kit.settle(watchId, 'sha-red', 'failure');
        const [id] = (await kit.look(grant, later())).proposed;
        await db.run('DELETE FROM project_ci_watches WHERE id = @id', { id: watchId });
        expect((await kit.look(grant, later(2))).superseded).toBe(1);
        expect(await kit.row(id)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'SOURCE_GONE' });
    });
});

describe('the owner-only pilot gate', () => {
    const named = (pid) => ({
        projectId: pid, sources: ['job_failure'],
        operations: [{ operation: 'read', resource: { kind: 'project', ids: [String(pid)] } }]
    });

    test('until the pilot decision is recorded only the owner can activate a responsibility that names a wider source', async () => {
        await db.run('DELETE FROM instance_state', {});
        const policies = require('@goobster/core/services/attentionPolicyService');
        for (const userId of [A, OWNER]) await policies.enroll({ userId, initiative: 'assist' });
        const pidA = await kit.project();
        const pidO = await kit.project({ owner: OWNER, slug: 'owners' });
        const make = async (userId, pid) => (await responsibilities.create({
            userId, body: { title: 'Watch my runs', scopes: { sources: ['job_failure'] }, projectId: pid, operations: named(pid).operations }
        })).responsibility;
        const mine = await make(A, pidA);
        await expect(responsibilities.act({ userId: A, id: mine.id, action: 'activate', expectedRevision: mine.revision }))
            .rejects.toMatchObject({ code: 'PILOT_ONLY', status: 409, details: { capability: 'sources', sources: ['job_failure'] } });
        expect((await responsibilities.get({ userId: A, id: mine.id })).status).toBe('DRAFT');

        const owners = await make(OWNER, pidO);
        expect((await responsibilities.act({ userId: OWNER, id: owners.id, action: 'activate', expectedRevision: owners.revision })).responsibility.status).toBe('ACTIVE');

        // A responsibility that names only the sources that shipped before is not gated.
        const plain = (await responsibilities.create({ userId: A, body: { title: 'Plain', scopes: { sources: ['knowledge'] }, operations: [{ operation: 'read', resource: { kind: 'knowledge' } }] } })).responsibility;
        expect((await responsibilities.act({ userId: A, id: plain.id, action: 'activate', expectedRevision: plain.revision })).responsibility.status).toBe('ACTIVE');

        // With the pilot open the person can.
        await kit.openPilot();
        expect((await responsibilities.act({ userId: A, id: mine.id, action: 'activate', expectedRevision: mine.revision })).responsibility.status).toBe('ACTIVE');
    });

    test('closing the pilot withdraws what the capability proposed and notices nothing more, for everyone but the owner', async () => {
        const pid = await kit.project();
        const grant = await kit.delegate(named(pid));
        await kit.look(grant);
        await kit.job(pid, { stderr: kit.trace() });
        const [id] = (await kit.look(grant, later())).proposed;
        await kit.job(pid, { stderr: kit.trace({ kind: 'ValueError' }) });

        await access.recordDecision({ scope: 'owner' });
        const closed = await kit.look(grant, later(2));
        expect(closed).toMatchObject({ proposed: [], superseded: 1 });
        expect(await kit.row(id)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'PILOT_ONLY' });
        expect(await kit.rows()).toHaveLength(1);

        // Reopened, what happened meanwhile (after delegating, so not history) is read.
        await kit.openPilot();
        expect((await kit.look(grant, later(3))).proposed).toHaveLength(1);
    });

    test('work proposed while the capability was open does not start once it is closed', async () => {
        const pid = await kit.project();
        const grant = await kit.delegate(named(pid));
        await kit.look(grant);
        await kit.job(pid, { stderr: kit.trace() });
        const [id] = (await kit.look(grant, later())).proposed;
        await kit.queue(A, id);
        await access.recordDecision({ scope: 'owner' });

        const chat = jest.spyOn(require('@goobster/core/services/aiService'), 'chat').mockResolvedValue({ content: 'x', toolCalls: [] });
        const runner = require('@goobster/core/services/assistantRunnerService');
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'SUPERSEDED', stopCode: 'PILOT_ONLY' });
        expect(chat).not.toHaveBeenCalled();
        expect(await kit.row(id)).toMatchObject({ status: 'SUPERSEDED', stopCode: 'PILOT_ONLY' });
    });

    test('the owner keeps the capability while the pilot is closed', async () => {
        const pid = await kit.project({ owner: OWNER });
        const grant = await kit.delegate({ userId: OWNER, ...named(pid) });
        await access.recordDecision({ scope: 'owner' });
        await kit.look(grant);
        await kit.job(pid, { userId: OWNER, stderr: kit.trace() });
        expect((await kit.look(grant, later())).proposed).toHaveLength(1);
    });

    test('the host\'s stop-all holds every source still, and nothing is baselined or lost meanwhile', async () => {
        const pid = await kit.project();
        const grant = await kit.delegate(named(pid));
        await kit.look(grant);
        await control.pauseAll();
        await kit.job(pid, { stderr: kit.trace() });
        expect(await kit.look(grant, later())).toMatchObject({ proposed: [] });
        await control.resumeAll();
        expect((await kit.look(grant, later(2))).proposed).toHaveLength(1);
    });
});
