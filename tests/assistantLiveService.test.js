/**
 * Live updates for Home and the Responsibilities page (DA-9,
 * documentation/delegated_delivery.md), against a throwaway database.
 *
 * The properties under test: producers announce a change with a person and
 * the kinds that changed and nothing else; a stream gets only its own
 * person's changes, coalesced so a burst is one event followed by at most
 * one more per interval and always a trailing one; the pilot gate and the
 * feature state are asked again before every forwarded event; the portal
 * stream forwards it as an `assistant` event with refetch hints and
 * rechecks the session first; and a display signal never makes Attention
 * sweep.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-live-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const live = require('@goobster/core/services/assistantLiveService');
const domainEventBus = require('@goobster/core/services/domainEventBus');
const updates = require('@goobster/core/services/assistantUpdateService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runner = require('@goobster/core/services/assistantRunnerService');
const access = require('@goobster/core/services/assistantAccessService');
const instanceState = require('@goobster/core/services/instanceStateService');
const attention = require('@goobster/core/services/attentionService');
const policies = require('@goobster/core/services/attentionPolicyService');
const identityService = require('@goobster/core/services/identityService');
const sessions = require('@goobster/core/services/webSessionService');
const aiService = require('@goobster/core/services/aiService');
const perplexity = require('@goobster/core/services/perplexityService');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const { DisabledGateway } = require('@goobster/core/gateway/disabledGateway');
const { useState } = require('./helpers/featureFixtures');

const OWNER = '791000000000000001';
const MEMBER = '791000000000000002';
const OTHER = '791000000000000003';
const READ_WEB = { operation: 'read', resource: { kind: 'web' } };
const FAST = { minIntervalMs: 120, settleMs: 10 };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Everything published on `assistant.changed` while `work` runs. */
async function announced(work) {
    const seen = [];
    const stop = domainEventBus.subscribe(live.TOPIC, event => seen.push(event.payload));
    try {
        await work();
    } finally {
        stop();
    }
    return seen;
}

async function owner(userId = OWNER) {
    await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: 'owner' });
    await identityService.grantAccount({ principalId: userId, entitlement: 'bootstrap', role: 'operator' });
}

const finding = (overrides = {}) => ({
    audience: { userId: OWNER },
    identityKey: 'finding:frost',
    kind: 'finding',
    title: 'Frost expected Thursday',
    summary: 'Cover the seedlings.',
    components: ['research'],
    ...overrides
});

beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    runner._reset();
    for (const table of [
        'assistant_run_operations', 'assistant_runs', 'assistant_initiatives', 'assistant_source_cursors',
        'assistant_update_receipts', 'assistant_updates', 'assistant_responsibility_revisions', 'assistant_responsibilities',
        'attention_state', 'attention_policies', 'attention_items', 'inbox_items', 'usage_reservations',
        'project_members', 'observatory_projects', 'app_accounts'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    await instanceState.remove(access.KEY_PILOT);
    await owner();
});

afterAll(async () => {
    initiatives.stopListening();
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('what producers announce', () => {
    test('an update, a request, a decision and a look are announced with a person and kinds only', async () => {
        const events = await announced(async () => {
            const { update } = await updates.publish(finding({ title: 'A private title', summary: 'A private summary' }));
            await updates.publish(finding({ identityKey: 'gate:1', kind: 'question', gate: { kind: 'question', id: 'q1' } }));
            await updates.resolveGate({ audience: { userId: OWNER }, identityKey: 'gate:1' });
            await updates.acknowledge({ userId: OWNER, items: [{ id: update.id, revision: 1 }] });
            // Republishing the same fact changes nothing and announces nothing.
            await updates.publish(finding({ title: 'A private title', summary: 'A private summary' }));
        });
        expect(events).toEqual([
            { userId: OWNER, kinds: ['update'] },
            { userId: OWNER, kinds: ['update', 'gate'] },
            { userId: OWNER, kinds: ['gate'] },
            { userId: OWNER, kinds: ['update'] }
        ]);
        expect(JSON.stringify(events)).not.toMatch(/private|Frost|q1/);
    });

    test('a project update is announced to its owner and its current members', async () => {
        const projectId = await db.insert(
            "INSERT INTO observatory_projects (userId, slug, name) VALUES (@owner, 'garden', 'Garden')", { owner: OWNER }
        );
        await db.run("INSERT INTO project_members (projectId, userId, role, invitedBy) VALUES (@projectId, @userId, 'collaborator', @owner)", { projectId, userId: MEMBER, owner: OWNER });
        const events = await announced(() => updates.publish(finding({ audience: { projectId }, components: ['projects'] })));
        expect(events.map(event => event.userId).sort()).toEqual([OWNER, MEMBER]);
        expect(events.every(event => event.kinds.join() === 'update')).toBe(true);
    });

    test('a responsibility changing state, proposed work, and a run starting and finishing are announced', async () => {
        const item = await db.insert(
            `INSERT INTO attention_items (guildId, userId, kind, subject, goal, state)
             VALUES (@guildId, @userId, 'goal', 'garden', 'Finish the garden plan', 'active')`,
            { guildId: `dm:${OWNER}`, userId: OWNER }
        );
        await policies.enroll({ userId: OWNER, initiative: 'assist' });
        let draft;
        const drafted = await announced(async () => {
            ({ responsibility: draft } = await responsibilities.create({
                userId: OWNER, body: { title: 'Keep the garden plan moving', operations: [READ_WEB], attentionItemId: item }
            }));
        });
        expect(drafted).toEqual([{ userId: OWNER, kinds: ['initiative'] }]);
        const renamed = await announced(async () => {
            ({ responsibility: draft } = await responsibilities.update({
                userId: OWNER, id: draft.id, expectedRevision: draft.revision, body: { title: 'Keep the garden plan on track' }
            }));
        });
        expect(renamed).toEqual([{ userId: OWNER, kinds: ['initiative'] }]);
        let grant;
        const lifecycle = await announced(async () => {
            grant = (await responsibilities.act({ userId: OWNER, id: draft.id, action: 'activate', expectedRevision: draft.revision })).responsibility;
        });
        expect(lifecycle).toContainEqual({ userId: OWNER, kinds: ['initiative'] });

        await db.run("UPDATE attention_items SET goal = 'Finish the garden plan before the frost' WHERE id = @id", { id: item });
        let initiativeId;
        const proposed = await announced(async () => {
            [initiativeId] = (await initiatives.reconcileResponsibility(grant.id)).proposed;
        });
        expect(proposed).toContainEqual({ userId: OWNER, kinds: ['initiative'] });

        const row = await initiatives.get({ userId: OWNER, id: initiativeId });
        const queued = await announced(() => initiatives.act({ userId: OWNER, id: initiativeId, action: 'queue', expectedRevision: row.revision }));
        expect(queued).toContainEqual({ userId: OWNER, kinds: ['initiative'] });

        jest.spyOn(perplexity, 'search').mockImplementation(async () => 'results');
        jest.spyOn(aiService, 'chat').mockImplementation(async () => ({
            content: '',
            toolCalls: [{ id: 'c1', name: 'finish', arguments: JSON.stringify({ outcome: 'finding', title: 'Frost on the 14th', summary: 'Two sources agree.' }) }]
        }));
        const ran = await announced(() => runner.tick({ wait: true }));
        const kinds = new Set(ran.flatMap(event => event.kinds));
        expect([...kinds].sort()).toEqual(['initiative', 'run', 'update']);
        expect(ran.every(event => event.userId === OWNER && Object.keys(event).sort().join() === 'kinds,userId')).toBe(true);
        expect(ran.filter(event => event.kinds.includes('run')).length).toBeGreaterThanOrEqual(2);
    });

    test('work withdrawn because its source moved on is announced', async () => {
        await policies.enroll({ userId: OWNER, initiative: 'assist' });
        const { responsibility: grant } = await responsibilities.create({
            userId: OWNER, activate: true, body: { title: 'Keep the plan moving', operations: [READ_WEB] }
        });
        const id = await db.insert(
            `INSERT INTO assistant_initiatives (responsibilityId, responsibilityRevision, ownerUserId, actingUserId,
                sourceKind, sourceId, sourceRevision, dedupeKey, title, reason)
             VALUES (@rid, @rev, @u, @u, 'project_plan_step', 'step:1', 'r1', 'project_plan_step:step:1', 'Draft the bed layout', 'The step is ready.')`,
            { rid: grant.id, rev: grant.revision, u: OWNER }
        );
        jest.spyOn(initiatives.SOURCES.project_plan_step, 'stale').mockImplementation(async () => [{ id, code: 'PLAN_CHANGED' }]);
        jest.spyOn(initiatives.SOURCES.project_plan_step, 'read').mockImplementation(async () => []);

        const withdrawn = await announced(async () => {
            expect((await initiatives.reconcileResponsibility(grant.id)).superseded).toBe(1);
        });
        expect(withdrawn).toEqual([{ userId: OWNER, kinds: ['initiative'] }]);
        expect((await initiatives.get({ userId: OWNER, id })).status).toBe('SUPERSEDED');

        // Nothing left to withdraw: nothing to say.
        expect(await announced(() => initiatives.reconcileResponsibility(grant.id))).toEqual([]);
    });

    test('run progress is announced at most once per run every five seconds', async () => {
        const events = await announced(async () => {
            for (let i = 0; i < 20; i += 1) live.progress(OWNER, 4242);
            live.progress(OWNER, 4243);
            live.forgetRun(4242);
            live.progress(OWNER, 4242);
        });
        expect(events).toEqual([
            { userId: OWNER, kinds: ['run'] },
            { userId: OWNER, kinds: ['run'] },
            { userId: OWNER, kinds: ['run'] }
        ]);
        live.forgetRun(4242);
        live.forgetRun(4243);
    });

    test('an unknown kind or nobody to tell publishes nothing, and never throws', async () => {
        const events = await announced(async () => {
            live.changed(OWNER, 'nonsense');
            live.changed(null, 'update');
            live.changed([], ['update']);
            live.changed([OWNER, OWNER], ['update', 'update', 'bogus']);
        });
        expect(events).toEqual([{ userId: OWNER, kinds: ['update'] }]);
    });
});

describe('a stream\'s watch', () => {
    test('a burst is one event, then at most one per interval, and always a trailing one', async () => {
        const got = [];
        const stop = live.watch(OWNER, event => got.push(event), FAST);
        try {
            live.changed(OWNER, 'run');
            live.changed(OWNER, 'run');
            live.changed(OWNER, 'update');
            await sleep(60);
            expect(got).toHaveLength(1);
            expect(got[0].kinds).toEqual(['update', 'run']);
            expect(got[0].invalidate).toEqual(['home', 'assistant-responsibilities', 'assistant-initiatives', 'inbox']);
            expect(Object.keys(got[0]).sort()).toEqual(['at', 'invalidate', 'kinds']);

            // More changes inside the interval: nothing yet, then one event with their union.
            for (let i = 0; i < 10; i += 1) live.changed(OWNER, i % 2 ? 'initiative' : 'run');
            await sleep(30);
            expect(got).toHaveLength(1);
            await sleep(200);
            expect(got).toHaveLength(2);
            expect(got[1].kinds).toEqual(['initiative', 'run']);
            expect(got[1].invalidate).toEqual(['home', 'assistant-responsibilities', 'assistant-initiatives']);

            // Quiet since: nothing more arrives by itself.
            await sleep(200);
            expect(got).toHaveLength(2);
        } finally {
            stop();
        }
    });

    test('only the person\'s own changes are forwarded', async () => {
        const got = [];
        const stop = live.watch(OWNER, event => got.push(event), FAST);
        try {
            live.changed(OTHER, 'update');
            live.changed(MEMBER, 'gate');
            await sleep(60);
            expect(got).toEqual([]);
        } finally {
            stop();
        }
    });

    test('before the pilot decision only the owner\'s portal is told; the decision opens and closes open streams', async () => {
        const got = [];
        const stop = live.watch(MEMBER, event => got.push(event), FAST);
        try {
            live.changed(MEMBER, 'update');
            await sleep(60);
            expect(got).toEqual([]);

            await access.recordDecision({ scope: 'everyone' });
            live.changed(MEMBER, 'update');
            await sleep(200);
            expect(got).toHaveLength(1);

            await access.recordDecision({ scope: 'owner' });
            live.changed(MEMBER, 'update');
            await sleep(200);
            expect(got).toHaveLength(1);
        } finally {
            stop();
        }
    });

    test('the feature turned off stops events on a stream that is already open', async () => {
        const got = [];
        const stop = live.watch(OWNER, event => got.push(event), FAST);
        try {
            useState({ inactive: ['assistant'] });
            live.changed(OWNER, 'update');
            await sleep(60);
            expect(got).toEqual([]);
            useState();
            live.changed(OWNER, 'update');
            await sleep(200);
            expect(got).toHaveLength(1);
        } finally {
            stop();
        }
    });

    test('a closed stream gets nothing, including what was still pending', async () => {
        const got = [];
        const stop = live.watch(OWNER, event => got.push(event), FAST);
        live.changed(OWNER, 'update');
        stop();
        await sleep(60);
        live.changed(OWNER, 'update');
        await sleep(60);
        expect(got).toEqual([]);
    });
});

describe('the portal event stream', () => {
    let server;
    let base;

    beforeAll(async () => {
        const ctx = createWebAppContext({ gateway: new DisabledGateway(), config: { webapp: { enabled: true } } });
        server = http.createServer(express().use(createWebAppApp(ctx)));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });

    async function open(userId) {
        const { token } = await sessions.create({ userId, userName: 'someone' });
        const controller = new AbortController();
        const response = await fetch(`${base}/api/app/events`, {
            headers: { cookie: `goobster_web_session=${token}` }, signal: controller.signal
        });
        expect(response.status).toBe(200);
        const reader = response.body.getReader();
        let text = '';
        let done = false;
        (async () => {
            try {
                for (;;) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    text += Buffer.from(chunk.value).toString();
                }
            } catch { /* aborted */ }
            done = true;
        })();
        const until = async (predicate, timeoutMs = 3000) => {
            const started = Date.now();
            while (!predicate(text) && Date.now() - started < timeoutMs) await sleep(20);
            return text;
        };
        return { token, until, text: () => text, ended: () => done, close: () => controller.abort() };
    }

    test('a change reaches that person\'s open stream as an `assistant` event with kinds and refetch hints, and no one else\'s', async () => {
        await identityService.ensureLegacyPrincipal({ discordId: OTHER, displayName: 'other' });
        await identityService.grantAccount({ principalId: OTHER, entitlement: 'invite' });
        await access.recordDecision({ scope: 'everyone' });
        const mine = await open(OWNER);
        const theirs = await open(OTHER);
        try {
            await mine.until(text => text.includes('event: hello'));
            await theirs.until(text => text.includes('event: hello'));

            await updates.publish(finding({
                identityKey: 'gate:stream', kind: 'question', title: 'A private question', summary: 'Private text',
                gate: { kind: 'question', id: 'private-gate-id' }
            }));
            const text = await mine.until(value => value.includes('event: assistant'));
            const frame = text.split('\n\n').find(part => part.startsWith('event: assistant'));
            expect(frame).toBeTruthy();
            const data = JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
            expect(data.kinds).toEqual(['update', 'gate']);
            expect(data.invalidate).toEqual(['home', 'assistant-responsibilities', 'assistant-initiatives', 'inbox']);
            expect(Object.keys(data).sort()).toEqual(['at', 'invalidate', 'kinds']);
            expect(text).not.toMatch(/private|Private/);

            await sleep(400);
            expect(theirs.text()).not.toContain('event: assistant');
        } finally {
            mine.close();
            theirs.close();
        }
    });

    test('the session is rechecked before the event is written: a revoked session gets none', async () => {
        const stream = await open(OWNER);
        try {
            await stream.until(text => text.includes('event: hello'));
            await sessions.destroy(stream.token);
            live.changed(OWNER, 'update');
            const text = await stream.until(value => value.includes('session-revoked'));
            expect(text).toContain('session-revoked');
            expect(text).not.toContain('event: assistant');
        } finally {
            stream.close();
        }
    });
});

describe('Attention', () => {
    test('a display signal never marks a person for a sweep', async () => {
        await policies.enroll({ userId: OWNER, initiative: 'assist' });
        const dirty = jest.spyOn(attention, 'markDirty');
        await attention.onEvent({ topic: live.TOPIC, payload: { userId: OWNER, kinds: ['run'] } });
        expect(dirty).not.toHaveBeenCalled();
        await attention.onEvent({ topic: 'observatory.job.completed', payload: { userId: OWNER } });
        expect(dirty).toHaveBeenCalledTimes(1);
    });
});
