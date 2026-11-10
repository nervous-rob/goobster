/**
 * Feedback on delegated work and what is learned from it (DA-10, ADR 0031;
 * documentation/delegated_feedback.md). Throwaway database, no provider,
 * no network.
 *
 * The acceptance scenarios, in the order of the plan:
 *  1. "Wrong time" changes delivery timing and nothing about topic selection.
 *  2. "Wrong" opens a correction on the cited note and deletes no evidence.
 *  3. "Less of this" lowers a named adapter's rate and shows the current
 *     rate with a reset.
 *  4. "Stop this responsibility" is the ordinary confirmed pause or revoke.
 *  5. Ignoring an item is weak feedback and cannot silence a source alone.
 *  6. Feedback and derived signals are in the export, the report and erasure.
 *  7. No learned signal widens a grant, raises a budget or skips authorization.
 * Plus: the owner-only pilot gate, the host's stop-all, and that nobody can
 * answer for somebody else's item.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-feedback-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const feedback = require('@goobster/core/services/assistantFeedbackService');
const weights = require('@goobster/core/services/assistant/sourceWeights');
const caps = require('@goobster/core/services/assistant/proposalCaps');
const SOURCES = require('@goobster/core/services/assistant/sources');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const updates = require('@goobster/core/services/assistantUpdateService');
const access = require('@goobster/core/services/assistantAccessService');
const control = require('@goobster/core/services/assistantControlService');
const steward = require('@goobster/core/services/assistantStewardService');
const attention = require('@goobster/core/services/attentionService');
const policies = require('@goobster/core/services/attentionPolicyService');
const userSettings = require('@goobster/core/services/userSettingsService');
const kg = require('@goobster/core/services/knowledgeGraphService');
const changes = require('@goobster/core/services/knowledgeChangeSetService');
const privacyService = require('@goobster/core/services/privacyService');
const dormantData = require('@goobster/core/services/dormantDataService');
const { snapshot, INVENTORY } = require('@goobster/core/services/accountExportData');
const { DisabledGateway } = require('@goobster/core/gateway');
const kit = require('./helpers/opportunityKit');
const { useState } = require('./helpers/featureFixtures');

const { A, B, OWNER } = kit;
const DAY = 86_400_000;
const days = (n, minutes = 0) => new Date(Date.now() + n * DAY + minutes * 60_000);
const utc = kit.utc;

afterAll(async () => {
    initiatives.stopListening();
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    jest.restoreAllMocks();
    await kit.reset();
    for (const table of [
        'assistant_feedback', 'assistant_source_weights', 'kg_change_sets', 'kg_edges', 'kg_provenance',
        'kg_node_revisions', 'kg_nodes', 'research_claims', 'user_setting_revisions', 'attention_contacts'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    await kit.openPilot();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

let slugNo = 0;
/** A responsibility of `userId` that follows one source, with its baseline taken. */
async function following(userId = A) {
    const pid = await kit.project({ owner: userId, slug: `lab-${++slugNo}` });
    const source = await kit.followed({ userId, projectId: pid, url: `https://example.org/feed-${slugNo}` });
    const grant = await kit.delegate({
        userId, projectId: pid, sources: ['followed_source'],
        operations: [
            { operation: 'read', resource: { kind: 'project', ids: [String(pid)] } },
            { operation: 'read', resource: { kind: 'process', ids: [`followed_source:${source}`] } }
        ]
    });
    await kit.look(grant);
    return { pid, source, grant };
}

/** `n` new items arrive, the person keeps them, and the source is read at `now`: the initiative ids proposed. */
async function propose({ source, grant }, n, now = days(0, 2)) {
    const ids = [];
    for (let index = 0; index < n; index += 1) ids.push(await kit.entry(source, { title: `Item ${index}` }));
    // An item is seen before it is kept: one that is already kept at first sight is history.
    await kit.look(grant, new Date(now.getTime() - 30_000));
    for (const id of ids) await kit.keep(id);
    return (await kit.look(grant, now)).proposed;
}

let keyNo = 0;
/** The finding of one piece of work: its run, and the update the person is shown. */
async function finding(initiativeId, { sentAt = null } = {}) {
    const row = await kit.row(initiativeId);
    const runId = await db.insert(
        `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId,
            status, resultTitle, resultSummary)
         VALUES (@initiativeId, @responsibilityId, 1, @u, @u, @u, 'COMPLETED', 'Found something', 'A summary.')`,
        { initiativeId: row.id, responsibilityId: row.responsibilityId, u: row.ownerUserId }
    );
    await db.run("UPDATE assistant_initiatives SET status = 'REVIEW' WHERE id = @id", { id: row.id });
    const { update } = await updates.publish({
        audience: { userId: row.ownerUserId },
        identityKey: `finding:${++keyNo}`,
        kind: 'finding',
        title: `Finding ${keyNo}`,
        summary: 'Something was found.',
        components: ['research'],
        responsibilityId: row.responsibilityId,
        initiativeId: row.id
    });
    if (sentAt) {
        await db.run(
            "UPDATE assistant_updates SET outboundKind = 'contact', outboundRevision = materialRevision, outboundAt = @at WHERE id = @id",
            { id: update.id, at: utc(sentAt) }
        );
    }
    return { updateId: update.id, runId, initiativeId: row.id, userId: row.ownerUserId };
}

let noteNo = 0;
/** A note the finding's run wrote for the person. */
async function wrote({ runId, userId }, content = 'Tomatoes need six hours of sun.') {
    const made = await kg.addGeneratedNote({
        guildId: `dm:${userId}`, userId, label: `Garden note ${++noteNo}`, content, originRunId: runId
    });
    expect(made.ok).toBe(true);
    return made.id;
}

const note = id => db.get('SELECT * FROM kg_nodes WHERE id = @id', { id });
const given = (userId = A) => db.all('SELECT * FROM assistant_feedback WHERE userId = @userId ORDER BY id', { userId });
const learned = async (grant, adapter = 'followed_source') => {
    const row = await weights.get(grant.id, adapter);
    return row ? weights.describe(row) : null;
};
const count = async (table) => Number((await db.get(`SELECT COUNT(*) AS n FROM ${table}`, {})).n);
const grantRow = id => db.get(
    'SELECT status, revision, authorityRevision, scopesJson, operationsJson, budgetsJson, rulesJson FROM assistant_responsibilities WHERE id = @id',
    { id }
);
const refusal = async (promise) => {
    try {
        await promise;
    } catch (error) {
        return { code: error.code, status: error.status };
    }
    return null;
};

/* ------------------------------------------------------------------ */

describe('less of this: a named adapter proposes less, and it can be reset', () => {
    test('each one halves what the source may propose a day, down to nothing; reset puts it back', async () => {
        const kept = await following();
        const first = await propose(kept, 6);
        expect(first).toHaveLength(caps.DEFAULT_MAX_PER_DAY);
        expect(await learned(kept.grant)).toBeNull();

        const said = await feedback.give({ userId: A, initiativeId: first[0], kind: 'less_of_this' });
        expect(said).toMatchObject({
            existing: false,
            feedback: {
                kind: 'less_of_this', initiativeId: first[0], responsibilityId: kept.grant.id, adapter: 'followed_source',
                effect: { code: 'RATE_LOWERED', from: 1, to: 0.5, usual: 3, cap: 2 }
            }
        });
        expect(said.message).toMatch(/up to 2 a day/);
        expect(said.state.given).toEqual(['less_of_this']);
        expect(said.state.offered).not.toContain('less_of_this');
        // The current rate is shown against the usual one.
        expect(await feedback.learned({ userId: A })).toEqual([expect.objectContaining({
            responsibilityId: kept.grant.id, adapter: 'followed_source', weight: 0.5, usual: 3, cap: 2, stopped: false
        })]);

        // The next day the source may propose two, not three.
        expect(await propose(kept, 5, days(1))).toHaveLength(2);
        const overview = await initiatives.sourcesOverview({ userId: A, id: kept.grant.id, now: days(1) });
        expect(overview.today).toEqual([expect.objectContaining({ sourceKind: 'followed_source', proposed: 2, cap: 2 })]);

        await feedback.give({ userId: A, initiativeId: first[1], kind: 'less_of_this' });
        expect(await learned(kept.grant)).toMatchObject({ weight: 0.25, cap: 1 });
        expect(await propose(kept, 4, days(2))).toHaveLength(1);

        const last = await feedback.give({ userId: A, initiativeId: first[2], kind: 'less_of_this' });
        expect(last.feedback.effect).toMatchObject({ code: 'RATE_LOWERED', to: 0, cap: 0 });
        expect(last.message).toMatch(/proposes nothing/);
        expect(await learned(kept.grant)).toMatchObject({ weight: 0, cap: 0, stopped: true });
        expect(await propose(kept, 3, days(3))).toEqual([]);
        // There is nothing lower to go to, so it is no longer offered.
        const [open] = await kit.rows("status = 'CANDIDATE'");
        const states = await feedback.statesForInitiatives({ userId: A, rows: [open] });
        expect(states.get(Number(open.id)).offered).toEqual(['stop_responsibility']);

        const reset = await feedback.resetRate({ userId: A, responsibilityId: kept.grant.id, adapter: 'followed_source' });
        expect(reset).toEqual({ reset: true, learned: [] });
        expect(await propose(kept, 5, days(4))).toHaveLength(caps.DEFAULT_MAX_PER_DAY);
        // The feedback itself stays on record.
        expect((await given()).map(row => row.kind)).toEqual(['less_of_this', 'less_of_this', 'less_of_this']);
    });

    test('saying it twice about the same item changes nothing the second time', async () => {
        const kept = await following();
        const [id] = await propose(kept, 1);
        await feedback.give({ userId: A, initiativeId: id, kind: 'less_of_this' });
        const again = await feedback.give({ userId: A, initiativeId: id, kind: 'less_of_this' });
        expect(again.existing).toBe(true);
        expect(await given()).toHaveLength(1);
        expect(await learned(kept.grant)).toMatchObject({ weight: 0.5 });

        // Two clicks at once are one answer too.
        const [other] = await propose(kept, 1, days(1));
        const both = await Promise.all([
            feedback.give({ userId: A, initiativeId: other, kind: 'less_of_this' }),
            feedback.give({ userId: A, initiativeId: other, kind: 'less_of_this' })
        ]);
        expect(both.map(result => result.existing).sort()).toEqual([false, true]);
        expect(await learned(kept.grant)).toMatchObject({ weight: 0.25 });
    });

    test('it is one adapter of one responsibility: another responsibility keeps its rate', async () => {
        const one = await following();
        const two = await following();
        const [id] = await propose(one, 1);
        await feedback.give({ userId: A, initiativeId: id, kind: 'less_of_this' });
        expect(await learned(two.grant)).toBeNull();
        expect(await propose(two, 5, days(1))).toHaveLength(caps.DEFAULT_MAX_PER_DAY);
    });

    test('work the person asked for is never slowed, whatever was learned', async () => {
        const kept = await following();
        // A stored weight for an adapter that does not learn is not read.
        for (const kind of ['conversation_request', 'project_plan_step']) {
            expect(weights.learnsFrom(SOURCES[kind])).toBe(false);
            await db.run(
                `INSERT INTO assistant_source_weights (responsibilityId, ownerUserId, adapter, weight, dismissals)
                 VALUES (@rid, @u, @kind, 0, 10)`,
                { rid: kept.grant.id, u: A, kind }
            );
            const base = SOURCES[kind].dailyCap?.({}) ?? null;
            expect(await weights.capFor({ responsibilityId: kept.grant.id, sourceKind: kind, adapter: SOURCES[kind], source: {} })).toBe(base);
        }
        // A chat request made by name is taken; only an implied one learns.
        expect(weights.learnsFrom(SOURCES.chat_request, { implied: false })).toBe(false);
        expect(weights.learnsFrom(SOURCES.chat_request, { implied: true })).toBe(true);
        await db.run(
            `INSERT INTO assistant_source_weights (responsibilityId, ownerUserId, adapter, weight) VALUES (@rid, @u, 'chat_request', 0)`,
            { rid: kept.grant.id, u: A }
        );
        const byName = { implied: false, origin: { implied: false } };
        expect(await weights.capFor({ responsibilityId: kept.grant.id, sourceKind: 'chat_request', adapter: SOURCES.chat_request, source: byName }))
            .toBe(SOURCES.chat_request.dailyCap(byName) ?? null);
        const implied = { implied: true, origin: { implied: true } };
        expect(await weights.capFor({ responsibilityId: kept.grant.id, sourceKind: 'chat_request', adapter: SOURCES.chat_request, source: implied })).toBe(0);
    });
});

describe('weak feedback: what a person does, or leaves alone', () => {
    test('dismissing lowers the rate slowly and never below one a day; starting works it back', async () => {
        const kept = await following();
        const [a, b, c] = await propose(kept, 3);
        const act = async (id, action) => {
            const current = await initiatives.get({ userId: A, id });
            return initiatives.act({ userId: A, id, action, expectedRevision: current.revision });
        };
        await act(a, 'cancel');
        expect(await learned(kept.grant)).toMatchObject({ dismissals: 1, acceptances: 0, weight: 1, cap: 3 });
        // No feedback row: the dismissed item is the record.
        expect(await given()).toEqual([]);

        // Many more of the same (the same bookkeeping, without thirty proposals).
        const row = await kit.row(b);
        for (let n = 0; n < 4; n += 1) await feedback.noteDecision(row, 'cancel');
        expect(await learned(kept.grant)).toMatchObject({ dismissals: 5, cap: 2 });
        for (let n = 0; n < 40; n += 1) await feedback.noteDecision(row, 'cancel');
        const floor = await learned(kept.grant);
        expect(floor).toMatchObject({ dismissals: weights.WEAK_MAX, weight: 1, cap: 1, stopped: false });
        expect(await propose(kept, 4, days(1))).toHaveLength(1);

        // Starting a proposal counts the other way, and so does accepting a result.
        await act(c, 'queue');
        expect(await learned(kept.grant)).toMatchObject({ acceptances: 1 });
        for (let n = 0; n < 5; n += 1) await feedback.noteDecision({ ...row, status: 'REVIEW' }, 'accept');
        expect(await learned(kept.grant)).toMatchObject({ cap: 3 });
        // Starting something that was waiting, or stopping something already started, is not a signal.
        expect(await feedback.noteDecision({ ...row, status: 'WAITING' }, 'queue')).toBe(false);
        expect(await feedback.noteDecision({ ...row, status: 'QUEUED' }, 'cancel')).toBe(false);
    });

    test('a proposal left alone for a week counts once, as one dismissal', async () => {
        const kept = await following();
        const [a, b] = await propose(kept, 2);
        expect(await feedback.sweepIgnored({ now: days(6) })).toEqual({ recorded: 0 });
        expect(await feedback.sweepIgnored({ now: days(8) })).toEqual({ recorded: 2 });
        expect(await feedback.sweepIgnored({ now: days(9) })).toEqual({ recorded: 0 });
        const rows = await given();
        expect(rows.map(row => [row.kind, Number(row.initiativeId), row.updateId, row.effectCode, row.effectJson])).toEqual([
            ['ignored', a, null, 'COUNTED', '{"item":"proposal"}'],
            ['ignored', b, null, 'COUNTED', '{"item":"proposal"}']
        ]);
        expect(await learned(kept.grant)).toMatchObject({ dismissals: 2, weight: 1, cap: 3 });

        // Dismissing it afterwards is the same dismissal, not a second one.
        const current = await initiatives.get({ userId: A, id: a });
        await initiatives.act({ userId: A, id: a, action: 'cancel', expectedRevision: current.revision });
        expect(await learned(kept.grant)).toMatchObject({ dismissals: 2 });
        // "ignored" is the steward's word: a person cannot say it, and it does not hide what they can say.
        expect(await refusal(feedback.give({ userId: A, initiativeId: b, kind: 'ignored' }))).toEqual({ code: 'INVALID_KIND', status: 400 });
        const states = await feedback.statesForInitiatives({ userId: A, rows: [await kit.row(b)] });
        expect(states.get(b)).toMatchObject({ given: [], offered: ['less_of_this', 'stop_responsibility'] });
    });

    test('a finding nobody opened for a week counts once; one that was read does not', async () => {
        const kept = await following();
        const [a, b] = await propose(kept, 2);
        const unread = await finding(a);
        const read = await finding(b);
        await updates.acknowledge({ userId: A, items: [{ id: read.updateId, revision: 1 }] });
        expect(await feedback.sweepIgnored({ now: days(8) })).toEqual({ recorded: 1 });
        const [row] = await given();
        expect(row).toMatchObject({ kind: 'ignored', initiativeId: unread.initiativeId, updateId: null, effectJson: '{"item":"finding"}' });
        expect(await learned(kept.grant)).toMatchObject({ dismissals: 1 });
    });

    test('the steward runs it, and it does nothing while the host has stopped delegated work', async () => {
        const kept = await following();
        await propose(kept, 1);
        await control.pauseAll();
        expect(await feedback.sweepIgnored({ now: days(8) })).toEqual({ recorded: 0, skipped: 'paused' });
        expect((await steward.sweep({ now: days(8) })).ignored).toEqual({ recorded: 0, skipped: 'paused' });
        expect(await given()).toEqual([]);
        await control.resumeAll();
        // The stop-all withdrew nothing; the pass after it is lifted records the item.
        expect((await steward.sweep({ now: days(8, 10) })).ignored).toEqual({ recorded: 1 });
    });

    test('ignoring alone cannot silence a source', async () => {
        for (const dismissals of [0, 1, 5, 10, 500]) {
            for (const usual of [1, 2, 3, 10]) {
                expect(weights.scale(usual, { weight: 1, dismissals, acceptances: 0 })).toBeGreaterThanOrEqual(1);
            }
        }
        // The counters stop at a lead of ten, so the way back is always short.
        const kept = await following();
        for (let n = 0; n < 25; n += 1) {
            await weights.count({ responsibility: kept.grant, adapter: 'followed_source', signal: 'dismissals' });
        }
        expect(await weights.get(kept.grant.id, 'followed_source')).toMatchObject({ dismissals: weights.WEAK_MAX, acceptances: 0, weight: 1 });
    });
});

describe('useful and already knew: a counter and nothing else', () => {
    test('each moves one counter of the adapter and leaves the rate rule alone', async () => {
        const kept = await following();
        const [a, b] = await propose(kept, 2);
        const one = await finding(a);
        const two = await finding(b);
        const before = await grantRow(kept.grant.id);

        const useful = await feedback.give({ userId: A, updateId: one.updateId, kind: 'useful' });
        expect(useful.feedback).toMatchObject({ kind: 'useful', updateId: one.updateId, initiativeId: a, adapter: 'followed_source', effect: { code: 'COUNTED' } });
        expect(await learned(kept.grant)).toMatchObject({ acceptances: 1, dismissals: 0, weight: 1, cap: 3 });
        await feedback.give({ userId: A, updateId: two.updateId, kind: 'already_knew' });
        expect(await learned(kept.grant)).toMatchObject({ acceptances: 1, dismissals: 1, weight: 1, cap: 3 });
        expect(await grantRow(kept.grant.id)).toEqual(before);
        // Both can be said about the same finding; each only once.
        const both = await feedback.give({ userId: A, updateId: one.updateId, kind: 'already_knew' });
        expect(both.state.given).toEqual(['useful', 'already_knew']);
        expect((await feedback.give({ userId: A, updateId: one.updateId, kind: 'useful' })).existing).toBe(true);
        expect(await learned(kept.grant)).toMatchObject({ acceptances: 1, dismissals: 2 });
    });
});

describe('wrong time: when, never what', () => {
    /** Tomorrow at a UTC hour. */
    const at = (hour, minute = 0) => {
        const today = new Date();
        return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1, hour, minute, 0));
    };

    test('the hour it was sent is avoided for delegated work; topic selection and Attention\'s own notices are untouched', async () => {
        const kept = await following();
        const [a] = await propose(kept, 1);
        const sent = await finding(a, { sentAt: at(14, 20) });
        const before = await grantRow(kept.grant.id);

        const said = await feedback.give({ userId: A, updateId: sent.updateId, kind: 'wrong_time' });
        expect(said.feedback.effect).toEqual({ code: 'HOUR_AVOIDED', hour: 14 });
        expect(said.message).toMatch(/between 14:00 and 15:00/);
        expect((await policies.get(A)).avoidHours).toEqual([14]);

        // Delivery timing changed: delegated work waits out that hour, and only that hour.
        expect(await attention.contactAllowed({ userId: A, reason: 'assistant', now: at(14, 30) })).toMatchObject({ allowed: false, code: 'WRONG_TIME' });
        expect(await attention.contactAllowed({ userId: A, reason: 'assistant', now: at(15, 0) })).toMatchObject({ allowed: true });
        expect(await attention.contactAllowed({ userId: A, reason: 'assistant', now: at(13, 59) })).toMatchObject({ allowed: true });
        // Attention's own notices are not delegated work.
        expect(await attention.contactAllowed({ userId: A, reason: 'attention', now: at(14, 30) })).toMatchObject({ allowed: true });

        // Nothing about what is looked for changed: no learned rate, the same grant, the same proposals.
        expect(await count('assistant_source_weights')).toBe(0);
        expect(await grantRow(kept.grant.id)).toEqual(before);
        expect(await propose(kept, 5, days(1))).toHaveLength(caps.DEFAULT_MAX_PER_DAY);
    });

    test('it is shown in Settings, where it is removed', async () => {
        const kept = await following();
        const [a] = await propose(kept, 1);
        const sent = await finding(a, { sentAt: at(7, 5) });
        await feedback.give({ userId: A, updateId: sent.updateId, kind: 'wrong_time' });

        const settings = await userSettings.getSettings({ userId: A });
        expect(settings.sections.initiative.values.avoidHours).toEqual([7]);
        await userSettings.updateSection({
            userId: A, section: 'initiative', changes: { avoidHours: [] },
            expectedRevision: settings.sections.initiative.revision
        });
        expect((await policies.get(A)).avoidHours).toEqual([]);
        expect(await attention.contactAllowed({ userId: A, reason: 'assistant', now: at(7, 30) })).toMatchObject({ allowed: true });
        // The settings route takes whole, different hours only.
        const fresh = await userSettings.getSettings({ userId: A });
        for (const bad of [[24], [1, 1], [1.5], ['3'], Array.from({ length: 13 }, (_, hour) => hour)]) {
            expect(await refusal(userSettings.updateSection({
                userId: A, section: 'initiative', changes: { avoidHours: bad }, expectedRevision: fresh.sections.initiative.revision
            }))).toMatchObject({ code: 'BAD_AVOID_HOURS' });
        }
    });

    test('it is not offered for a finding that never left the portal, and half a day is the most it marks', async () => {
        const kept = await following();
        const [a, b] = await propose(kept, 2);
        const home = await finding(a);
        expect((await feedback.stateForUpdate({ userId: A, updateId: home.updateId })).offered).not.toContain('wrong_time');
        expect(await refusal(feedback.give({ userId: A, updateId: home.updateId, kind: 'wrong_time' }))).toEqual({ code: 'NOT_OFFERED', status: 409 });

        await policies.setAvoidHours({ userId: A, hours: Array.from({ length: policies.MAX_AVOID_HOURS }, (_, hour) => hour) });
        const sent = await finding(b, { sentAt: at(20) });
        expect(await refusal(feedback.give({ userId: A, updateId: sent.updateId, kind: 'wrong_time' }))).toEqual({ code: 'AVOID_HOURS_FULL', status: 409 });
        expect(await given()).toEqual([]);
    });
});

describe('wrong and keep this wording: the note the finding wrote', () => {
    test('wrong marks the note disputed through a revision, deletes nothing, and can be undone', async () => {
        const kept = await following();
        const [a] = await propose(kept, 1);
        const found = await finding(a);
        const id = await wrote(found);
        await db.run(
            `INSERT INTO research_claims (expeditionId, cycle, claim, status) VALUES (1, 1, 'Tomatoes need sun', 'supported')`, {}
        ).catch(() => {});
        const claims = await count('research_claims');
        const evidence = await count('kg_provenance');
        const before = await note(id);
        const weightRows = await count('assistant_source_weights');

        const said = await feedback.give({ userId: A, updateId: found.updateId, kind: 'wrong' });
        expect(said.feedback.effect).toMatchObject({ code: 'CORRECTION_OPENED', changeSetIds: [expect.any(Number)] });
        expect(said.message).toMatch(/Nothing was deleted/);

        const after = await note(id);
        expect(after).toMatchObject({ claimStatus: 'disputed', content: before.content, archivedAt: null, generated: 1 });
        expect(Number(after.revision)).toBe(Number(before.revision) + 1);
        // The evidence stays: the provenance, the earlier text, and every research claim.
        expect(await count('kg_provenance')).toBe(evidence);
        expect(await count('research_claims')).toBe(claims);
        expect(await count('kg_nodes')).toBe(1);
        // One thing changed: no rate was learned from "wrong".
        expect(await count('assistant_source_weights')).toBe(weightRows);

        // The correction is an ordinary change to the person's notes, with its Undo.
        const { changes: listed } = await changes.overview({ userId: A, guildId: `dm:${A}` });
        expect(listed).toEqual([expect.objectContaining({ id: said.feedback.effect.changeSetIds[0], kind: 'direct_change', status: 'APPLIED', policy: 'FEEDBACK_WRONG' })]);
        await changes.revert({ id: listed[0].id, userId: A });
        expect(await note(id)).toMatchObject({ claimStatus: 'current', content: before.content });
        // Said once: it is not offered again for this finding.
        expect((await feedback.stateForUpdate({ userId: A, updateId: found.updateId })).given).toEqual(['wrong']);
    });

    test('keep this wording makes the note the person\'s own; a later run cannot rewrite it', async () => {
        const kept = await following();
        const [a] = await propose(kept, 1);
        const found = await finding(a);
        const id = await wrote(found, 'Water in the morning.');
        const before = await note(id);

        const said = await feedback.give({ userId: A, updateId: found.updateId, kind: 'keep_wording' });
        expect(said.feedback.effect).toMatchObject({ code: 'NOTE_SAVED', changeSetIds: [expect.any(Number)] });
        expect(await note(id)).toMatchObject({ curation: 'saved', generated: 0, content: 'Water in the morning.', source: before.source });
        expect(await kg.amendGeneratedNote({
            guildId: `dm:${A}`, userId: A, nodeId: id, content: 'Rewritten.', expectedRevision: Number(before.revision) + 1
        })).toEqual({ ok: false, code: 'NOT_GENERATED' });
        expect((await feedback.stateForUpdate({ userId: A, updateId: found.updateId })).offered).not.toContain('keep_wording');

        const { changes: listed } = await changes.overview({ userId: A, guildId: `dm:${A}` });
        expect(listed[0]).toMatchObject({ policy: 'FEEDBACK_KEEP', kept: true, status: 'APPLIED' });
        await changes.revert({ id: listed[0].id, userId: A });
        expect(await note(id)).toMatchObject({ curation: before.curation, generated: 1 });
    });

    test('neither is offered when the run wrote no note, and a note the run only confirmed is not its own', async () => {
        const kept = await following();
        const [a, b] = await propose(kept, 2);
        const earlier = await finding(a);
        const later = await finding(b);
        const id = await wrote(earlier);
        // The later run confirmed the earlier run's note: evidence, not authorship.
        await kg.addProvenance({ nodeId: id, sourceKind: 'tool', sourceId: later.runId });

        const state = await feedback.stateForUpdate({ userId: A, updateId: later.updateId });
        expect(state.offered).toEqual(['useful', 'already_knew', 'less_of_this', 'stop_responsibility']);
        expect(await refusal(feedback.give({ userId: A, updateId: later.updateId, kind: 'wrong' }))).toEqual({ code: 'NOT_OFFERED', status: 409 });
        expect(await note(id)).toMatchObject({ claimStatus: 'current' });
        expect((await feedback.stateForUpdate({ userId: A, updateId: earlier.updateId })).offered).toEqual(
            ['useful', 'already_knew', 'wrong', 'less_of_this', 'keep_wording', 'stop_responsibility']
        );
        // A proposal has found nothing yet.
        const [c] = await propose(kept, 1, days(1));
        expect(await refusal(feedback.give({ userId: A, initiativeId: c, kind: 'wrong' }))).toEqual({ code: 'NOT_OFFERED', status: 409 });
    });
});

describe('stop this responsibility: the ordinary pause or revoke', () => {
    test('it needs the confirmed choice and the revision the person saw, and then it is the ordinary action', async () => {
        const kept = await following();
        const [a] = await propose(kept, 1);
        const state = (await feedback.statesForInitiatives({ userId: A, rows: [await kit.row(a)] })).get(a);
        expect(state.stop).toEqual({ responsibilityId: kept.grant.id, revision: kept.grant.revision, title: kept.grant.title, actions: ['pause', 'revoke'] });

        // Nothing happens without the confirmation's two fields.
        expect(await refusal(feedback.give({ userId: A, initiativeId: a, kind: 'stop_responsibility' }))).toEqual({ code: 'INVALID_STOP', status: 400 });
        expect(await refusal(feedback.give({ userId: A, initiativeId: a, kind: 'stop_responsibility', stop: 'archive', expectedRevision: state.stop.revision })))
            .toEqual({ code: 'INVALID_STOP', status: 400 });
        expect(await refusal(feedback.give({ userId: A, initiativeId: a, kind: 'stop_responsibility', stop: 'pause' }))).toEqual({ code: 'BAD_REQUEST', status: 400 });
        // A responsibility that changed since is the ordinary conflict.
        expect(await refusal(feedback.give({ userId: A, initiativeId: a, kind: 'stop_responsibility', stop: 'pause', expectedRevision: state.stop.revision + 5 })))
            .toEqual({ code: 'REVISION_CONFLICT', status: 409 });
        expect(await given()).toEqual([]);
        expect(await grantRow(kept.grant.id)).toMatchObject({ status: 'ACTIVE', revision: kept.grant.revision });

        const revisions = await count('assistant_responsibility_revisions');
        const said = await feedback.give({ userId: A, initiativeId: a, kind: 'stop_responsibility', stop: 'pause', expectedRevision: state.stop.revision });
        expect(said.feedback.effect).toEqual({ code: 'PAUSED', responsibilityId: kept.grant.id });
        // Exactly what the Responsibilities page's Pause does: one new revision, by its owner.
        expect(await grantRow(kept.grant.id)).toMatchObject({ status: 'PAUSED', revision: kept.grant.revision + 1 });
        expect(await count('assistant_responsibility_revisions')).toBe(revisions + 1);
        const last = await db.get('SELECT * FROM assistant_responsibility_revisions WHERE responsibilityId = @id ORDER BY revision DESC LIMIT 1', { id: kept.grant.id });
        expect(last).toMatchObject({ changedBy: A, changeKind: 'pause' });
        expect(await count('assistant_source_weights')).toBe(0);
        // A paused one can still be revoked from its next item, never resumed from feedback.
        expect(said.state.stop).toBeNull();
        const [next] = await kit.rows(`id <> ${a} AND status = 'CANDIDATE'`);
        expect(next).toBeUndefined();
    });

    test('revoke from a finding ends it, as revoking does', async () => {
        const kept = await following();
        const [a] = await propose(kept, 1);
        const found = await finding(a);
        const said = await feedback.give({
            userId: A, updateId: found.updateId, kind: 'stop_responsibility', stop: 'revoke', expectedRevision: kept.grant.revision
        });
        expect(said.feedback.effect.code).toBe('REVOKED');
        expect(await grantRow(kept.grant.id)).toMatchObject({ status: 'REVOKED' });
        expect((await feedback.stateForUpdate({ userId: A, updateId: found.updateId })).offered).not.toContain('stop_responsibility');
    });
});

describe('nothing learned widens anything', () => {
    test('no combination of signals yields more than the adapter\'s own cap', () => {
        for (const usual of [0, 1, 2, 3, 5, 10]) {
            for (const weight of [1, 0.75, 0.5, 0.25, 0.1, 0, 7, -1, NaN]) {
                for (const dismissals of [0, 3, 5, 10, 99]) {
                    for (const acceptances of [0, 1, 10, 99, 100000]) {
                        const cap = weights.scale(usual, { weight, dismissals, acceptances });
                        expect(cap).toBeLessThanOrEqual(usual);
                        expect(cap).toBeGreaterThanOrEqual(0);
                    }
                }
            }
        }
    });

    test('praise never raises a cap, and an uncapped adapter stays uncapped until something lowered it', async () => {
        const kept = await following();
        for (let n = 0; n < 30; n += 1) await weights.count({ responsibility: kept.grant, adapter: 'followed_source', signal: 'acceptances' });
        expect(await weights.capFor({ responsibilityId: kept.grant.id, sourceKind: 'followed_source', adapter: SOURCES.followed_source, source: {} }))
            .toBe(SOURCES.followed_source.MAX_PER_DAY);
        expect(await propose(kept, 6)).toHaveLength(SOURCES.followed_source.MAX_PER_DAY);

        const uncapped = { adapter: SOURCES.attention_item, sourceKind: 'attention_item', responsibilityId: kept.grant.id, source: {} };
        expect(await weights.capFor(uncapped)).toBeNull();
        await weights.count({ responsibility: kept.grant, adapter: 'attention_item', signal: 'acceptances' });
        expect(await weights.capFor(uncapped)).toBeNull();
        await weights.lower({ responsibility: kept.grant, adapter: 'attention_item' });
        expect(await weights.capFor(uncapped)).toBe(2);
    });

    test('every kind but "stop" leaves the grant, its budgets and its authority exactly as they were', async () => {
        const kept = await following();
        const [a, b] = await propose(kept, 2);
        const found = await finding(a, { sentAt: new Date() });
        await wrote(found);
        const before = await grantRow(kept.grant.id);
        const usage = await count('usage_reservations');

        for (const kind of ['useful', 'already_knew', 'wrong', 'less_of_this', 'wrong_time', 'keep_wording']) {
            const said = await feedback.give({ userId: A, updateId: found.updateId, kind });
            expect(said.existing).toBe(false);
        }
        await feedback.give({ userId: A, initiativeId: b, kind: 'less_of_this' });
        expect(await grantRow(kept.grant.id)).toEqual(before);
        expect(await count('usage_reservations')).toBe(usage);
        // What was recorded is codes, ids and numbers: no sentence of the finding or the note.
        const stored = JSON.stringify(await given()) + JSON.stringify(await db.all('SELECT * FROM assistant_source_weights', {}));
        expect(stored).not.toMatch(/Tomatoes|Something was found|Finding \d|Garden note/);
        // And a run is authorized as before: the grant decides, the weight is never read there.
        const stopped = await learned(kept.grant);
        expect(stopped.weight).toBe(0.25);
        expect(await responsibilities.get({ userId: A, id: kept.grant.id })).toMatchObject({ status: 'ACTIVE', revision: kept.grant.revision });
    });
});

describe('the pilot gate, and whose item it is', () => {
    test('until the pilot decision only the owner gives feedback; what was learned stays visible and resettable', async () => {
        const mine = await following(A);
        const theirs = await following(OWNER);
        const [a] = await propose(mine, 1);
        const [o] = await propose(theirs, 1);
        const found = await finding(a);
        await feedback.give({ userId: A, initiativeId: a, kind: 'less_of_this' });
        await access.recordDecision({ scope: 'owner' });

        expect(await refusal(feedback.give({ userId: A, updateId: found.updateId, kind: 'useful' }))).toEqual({ code: 'PILOT_ONLY', status: 403 });
        expect(await feedback.stateForUpdate({ userId: A, updateId: found.updateId })).toMatchObject({ offered: [], stop: null, given: ['less_of_this'] });
        const states = await feedback.statesForInitiatives({ userId: A, rows: [await kit.row(a)] });
        expect(states.get(a)).toMatchObject({ offered: [], stop: null, given: ['less_of_this'] });
        // Weak signals are not counted for them either.
        expect(await feedback.noteDecision(await kit.row(a), 'cancel')).toBe(false);
        expect(await feedback.sweepIgnored({ now: days(8) })).toEqual({ recorded: 1 });
        expect((await given(A)).map(row => row.kind)).toEqual(['less_of_this']);
        expect((await given(OWNER)).map(row => row.kind)).toEqual(['ignored']);
        // What was learned before still applies, is still shown, and can still be reset.
        expect(await feedback.learned({ userId: A })).toEqual([expect.objectContaining({ weight: 0.5, cap: 2 })]);
        expect(await feedback.resetRate({ userId: A, responsibilityId: mine.grant.id, adapter: 'followed_source' })).toMatchObject({ reset: true });

        // The owner is inside the pilot.
        const said = await feedback.give({ userId: OWNER, initiativeId: o, kind: 'less_of_this' });
        expect(said.feedback.effect.code).toBe('RATE_LOWERED');
        expect(Object.keys(access.CAPABILITIES)).toContain(feedback.CAPABILITY);
    });

    test('giving feedback is the person\'s own act and works while the host has stopped delegated work', async () => {
        const kept = await following();
        const [a] = await propose(kept, 1);
        await control.pauseAll();
        const said = await feedback.give({ userId: A, initiativeId: a, kind: 'less_of_this' });
        expect(said.feedback.effect.code).toBe('RATE_LOWERED');
        const stop = await feedback.give({
            userId: A, initiativeId: a, kind: 'stop_responsibility', stop: 'pause', expectedRevision: kept.grant.revision
        });
        expect(stop.feedback.effect.code).toBe('PAUSED');
    });

    test('nobody answers for somebody else\'s item, or for a project\'s shared finding', async () => {
        const kept = await following(A);
        const [a] = await propose(kept, 1);
        const found = await finding(a);
        for (const target of [{ updateId: found.updateId }, { initiativeId: a }, { updateId: 999999 }, { initiativeId: 'x' }]) {
            expect(await refusal(feedback.give({ userId: B, ...target, kind: 'less_of_this' }))).toEqual({ code: 'NOT_FOUND', status: 404 });
        }
        expect(await feedback.stateForUpdate({ userId: B, updateId: found.updateId })).toBeNull();
        expect((await feedback.statesForInitiatives({ userId: B, rows: [await kit.row(a)] })).size).toBe(0);
        expect(await refusal(feedback.resetRate({ userId: B, responsibilityId: kept.grant.id, adapter: 'followed_source' }))).toEqual({ code: 'NOT_FOUND', status: 404 });
        expect(await refusal(feedback.resetRate({ userId: A, responsibilityId: kept.grant.id, adapter: 'nope' }))).toEqual({ code: 'INVALID_SOURCE', status: 404 });

        const { update: shared } = await updates.publish({
            audience: { projectId: kept.pid },
            producerUserId: A,
            identityKey: 'finding:shared',
            kind: 'finding',
            title: 'A shared finding',
            components: ['research'],
            responsibilityId: kept.grant.id,
            initiativeId: a
        });
        expect(await refusal(feedback.give({ userId: A, updateId: shared.id, kind: 'useful' }))).toEqual({ code: 'NOT_FOUND', status: 404 });
        expect(await given(A)).toEqual([]);
        expect(await given(B)).toEqual([]);
    });

    test('a request waiting for a decision takes a decision, not feedback', async () => {
        const kept = await following();
        const { update } = await updates.publish({
            audience: { userId: A }, identityKey: 'gate:1', kind: 'question', title: 'A request', components: ['research'],
            responsibilityId: kept.grant.id, gate: { kind: 'question', id: 'gate:1' }
        });
        expect(await feedback.stateForUpdate({ userId: A, updateId: update.id })).toMatchObject({ offered: [], stop: null });
        expect(await refusal(feedback.give({ userId: A, updateId: update.id, kind: 'stop_responsibility', stop: 'pause', expectedRevision: 1 })))
            .toEqual({ code: 'NOT_OFFERED', status: 409 });
    });
});

describe('the portal routes', () => {
    let server;
    let port;
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };

    function request({ method = 'GET', reqPath, body, headers = {} }) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
            const req = http.request({
                host: '127.0.0.1', port, path: reqPath, method,
                headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers }
            }, (res) => {
                let raw = '';
                res.on('data', chunk => { raw += chunk; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(raw); } catch { /* not JSON */ }
                    resolve({ status: res.statusCode, headers: res.headers, json });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }
    const cookieFor = async (userId) => {
        const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name: 'person' } });
        return (res.headers['set-cookie'] || []).find(c => c.startsWith('goobster_web_session=')).split(';')[0];
    };

    beforeAll(async () => {
        const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
        const app = express();
        app.use(createWebAppApp(createWebAppContext({ gateway: new DisabledGateway(), config: { webapp: { enabled: true, devMode: true } }, logger: quiet })));
        await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
        port = server.address().port;
    });
    afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

    test('work items and Home say what may be said; the answer is posted, shown on the responsibility, and reset there', async () => {
        const kept = await following();
        const [a, b] = await propose(kept, 2);
        const found = await finding(b);
        const cookie = await cookieFor(A);
        const post = (reqPath, body) => request({ method: 'POST', reqPath, body, headers: { cookie } });

        const list = await request({ reqPath: '/api/app/assistant/initiatives', headers: { cookie } });
        expect(list.status).toBe(200);
        const item = list.json.initiatives.find(entry => entry.id === a);
        expect(item.feedback).toMatchObject({ offered: ['less_of_this', 'stop_responsibility'], given: [], adapter: 'followed_source' });

        const home = await request({ reqPath: '/api/app/home', headers: { cookie } });
        const brief = home.json.assistant.brief.find(entry => entry.id === found.updateId);
        expect(brief.feedback.offered).toEqual(['useful', 'already_knew', 'less_of_this', 'stop_responsibility']);

        const said = await post(`/api/app/assistant/initiatives/${a}/feedback`, { kind: 'less_of_this' });
        expect(said.status).toBe(200);
        expect(said.json.feedback.effect).toMatchObject({ code: 'RATE_LOWERED', cap: 2 });
        const useful = await post(`/api/app/assistant/updates/${found.updateId}/feedback`, { kind: 'useful' });
        expect(useful.json).toMatchObject({ existing: false, state: { given: ['useful'] } });
        expect((await post(`/api/app/assistant/updates/${found.updateId}/feedback`, { kind: 'wrong_time' })).status).toBe(409);
        expect((await post(`/api/app/assistant/updates/${found.updateId}/feedback`, { kind: 'louder' })).json.error).toMatchObject({ code: 'INVALID_KIND' });

        const mine = await request({ reqPath: '/api/app/assistant/responsibilities', headers: { cookie } });
        expect(mine.json.learned).toEqual([expect.objectContaining({ responsibilityId: kept.grant.id, adapter: 'followed_source', usual: 3, cap: 2, acceptances: 1 })]);
        const reset = await post(`/api/app/assistant/responsibilities/${kept.grant.id}/sources/followed_source/reset`, {});
        expect(reset.json).toEqual({ reset: true, learned: [] });

        // Somebody else, and nobody.
        const other = await cookieFor(B);
        expect((await request({ method: 'POST', reqPath: `/api/app/assistant/initiatives/${a}/feedback`, body: { kind: 'less_of_this' }, headers: { cookie: other } })).status).toBe(404);
        expect((await request({ method: 'POST', reqPath: `/api/app/assistant/initiatives/${a}/feedback`, body: { kind: 'less_of_this' } })).status).toBe(401);
        // The gate reaches the route.
        await access.recordDecision({ scope: 'owner' });
        const refused = await post(`/api/app/assistant/updates/${found.updateId}/feedback`, { kind: 'already_knew' });
        expect(refused.status).toBe(403);
        expect(refused.json.error.code).toBe('PILOT_ONLY');
    });
});

describe('privacy and retention', () => {
    async function seed(userId) {
        const kept = await following(userId);
        const [a, b] = await propose(kept, 2);
        const found = await finding(a, { sentAt: new Date() });
        await feedback.give({ userId, updateId: found.updateId, kind: 'useful' });
        await feedback.give({ userId, updateId: found.updateId, kind: 'wrong_time' });
        await feedback.give({ userId, initiativeId: b, kind: 'less_of_this' });
        return { kept, found, a, b };
    }
    const mineIn = async (table, column, userId) => Number((await db.get(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = @userId`, { userId }
    )).n);

    test('feedback and what was learned are in the export and the report', async () => {
        await seed(A);
        await seed(B);
        expect(INVENTORY.map(([table]) => table)).toEqual(expect.arrayContaining(['assistant_feedback', 'assistant_source_weights', 'attention_policies']));
        const data = await snapshot(A);
        expect(data.assistant_feedback.map(row => row.kind).sort()).toEqual(['less_of_this', 'useful', 'wrong_time']);
        expect(data.assistant_feedback.every(row => row.userId === A)).toBe(true);
        expect(data.assistant_source_weights).toEqual([expect.objectContaining({ ownerUserId: A, adapter: 'followed_source', weight: 0.5, acceptances: 1 })]);
        expect(JSON.parse(data.attention_policies[0].avoidHours)).toHaveLength(1);

        const report = await privacyService.buildUserReport({ guildId: `dm:${A}`, userId: A });
        expect(report.responsibilities).toMatchObject({ feedback: 3, sourceWeights: 1, loweredSources: 1 });
        expect((await privacyService.auditUser({ userId: A })).byTable).toMatchObject({ assistant_feedback: 3, assistant_source_weights: 1 });
    });

    test('forgetting a person deletes both, audits to zero, and leaves everyone else\'s', async () => {
        await seed(A);
        await seed(B);
        const counts = await privacyService.forgetUser({ userId: A });
        expect(counts).toMatchObject({ assistantFeedback: 3, assistantSourceWeights: 1 });
        expect(await mineIn('assistant_feedback', 'userId', A)).toBe(0);
        expect(await mineIn('assistant_source_weights', 'ownerUserId', A)).toBe(0);
        expect(await policies.get(A)).toBeNull();
        const audit = await privacyService.auditUser({ userId: A });
        expect(audit.byTable).toMatchObject({ assistant_feedback: 0, assistant_source_weights: 0 });
        expect(audit.total).toBe(0);
        expect(await dormantData.auditAssistantResponsibilities(A)).toMatchObject({ feedback: 0, sourceWeights: 0 });
        expect(await mineIn('assistant_feedback', 'userId', B)).toBe(3);
        expect(await mineIn('assistant_source_weights', 'ownerUserId', B)).toBe(1);
    });

    test('feedback outlives its finding by 180 days at most; what was learned goes with an ended responsibility', async () => {
        const { kept, found, b } = await seed(A);
        const far = days(feedback.RETENTION_DAYS + 5);
        // While the finding and the work exist, their feedback is kept.
        expect(await feedback.prune({ now: far })).toEqual({ feedback: 0, weights: 0 });

        await db.run('DELETE FROM assistant_update_receipts', {});
        await db.run('DELETE FROM assistant_updates WHERE id = @id', { id: found.updateId });
        await db.run('DELETE FROM assistant_runs', {});
        await db.run('DELETE FROM assistant_initiatives WHERE id = @id', { id: found.initiativeId });
        // Not yet 180 days old.
        expect(await feedback.prune({ now: days(30) })).toEqual({ feedback: 0, weights: 0 });
        expect(await feedback.prune({ now: far })).toEqual({ feedback: 2, weights: 0 });
        expect((await given()).map(row => [row.kind, Number(row.initiativeId)])).toEqual([['less_of_this', b]]);

        await db.run("UPDATE assistant_responsibilities SET status = 'REVOKED', updatedAt = @at WHERE id = @id", { id: kept.grant.id, at: utc(new Date()) });
        expect((await steward.sweep({ now: far, retention: true })).retention.feedback).toMatchObject({ weights: 1 });
        expect(await count('assistant_source_weights')).toBe(0);
    });
});
