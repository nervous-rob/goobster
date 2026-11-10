/**
 * Delegated knowledge work (DA-11b, ADR 0027): saved-note proposals and
 * direct edits, note connections, archiving, confirmation, and the review
 * of a withdrawn source - through the real runner with a scripted model, the
 * real gate registry, and a throwaway database (no provider, no network).
 *
 * The properties under test: a proposal shows a diff and changes nothing,
 * and applying it is the person's own gate decision, never a tool; a note
 * that moved since the run read it makes the proposal STALE instead of
 * overwriting a human edit; an applied change is reverted only while the
 * note is still at the revision the change produced; a direct edit exists
 * only under a grant that names it and is always revertible; conflicting
 * evidence disputes a claim and keeps the person's words; confirming a
 * finding adds evidence once, never a note or a notice, and a finding cannot
 * confirm itself; retracting a source finds what rests on it and deletes
 * nothing; and every tool is behind the owner-only pilot gate.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-knowledge-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runs = require('@goobster/core/services/assistantRunService');
const runner = require('@goobster/core/services/assistantRunnerService');
const updates = require('@goobster/core/services/assistantUpdateService');
const gates = require('@goobster/core/services/assistantGateService');
const policies = require('@goobster/core/services/attentionPolicyService');
const access = require('@goobster/core/services/assistantAccessService');
const identityService = require('@goobster/core/services/identityService');
const instanceState = require('@goobster/core/services/instanceStateService');
const kg = require('@goobster/core/services/knowledgeGraphService');
const changes = require('@goobster/core/services/knowledgeChangeSetService');
const impact = require('@goobster/core/services/knowledgeImpactService');
const privacyService = require('@goobster/core/services/privacyService');
const { useState } = require('./helpers/featureFixtures');

const A = `77${String(process.pid).padStart(8, '0')}00000001`;
const B = `77${String(process.pid).padStart(8, '0')}00000002`;
const scope = `dm:${A}`;
const READ_NOTES = { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } };
const grant = (operation) => ({ operation, resource: { kind: 'knowledge', ids: ['personal'] } });
const PROPOSE = [READ_NOTES, grant('kg.saved.propose')];

afterAll(async () => {
    initiatives.stopListening();
    useState();
    await db.run('DELETE FROM app_accounts WHERE principalId IN (@a, @b)', { a: A, b: B });
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    runner._reset();
    for (const table of [
        'kg_change_sets', 'assistant_run_operations', 'assistant_runs', 'assistant_initiatives', 'assistant_source_cursors',
        'assistant_update_receipts', 'assistant_updates', 'assistant_responsibility_revisions', 'assistant_responsibilities',
        'attention_policies', 'attention_items', 'inbox_items', 'usage_reservations', 'work_failures',
        'project_mission_evidence', 'project_missions', 'observatory_projects', 'research_claims', 'research_sources',
        'spitball_expeditions', 'kg_edges', 'kg_provenance', 'kg_node_revisions', 'kg_nodes'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    await instanceState.remove(access.KEY_PILOT);
    await db.run('DELETE FROM app_accounts WHERE principalId IN (@a, @b)', { a: A, b: B });
    await identityService.ensureLegacyPrincipal({ discordId: A, displayName: 'owner' });
    await identityService.grantAccount({ principalId: A, entitlement: 'bootstrap', role: 'operator' });
    await identityService.ensureLegacyPrincipal({ discordId: B, displayName: 'member' });
    await identityService.grantAccount({ principalId: B, entitlement: 'bootstrap', role: 'member' });
});

let callId = 0;
let goalSeq = 0;
const call = (name, args = {}) => ({ id: `c${++callId}`, name, arguments: JSON.stringify(args) });
function script(...rounds) {
    const queue = [...rounds];
    return jest.spyOn(aiService, 'chat').mockImplementation(async () => {
        const next = queue.shift();
        if (next === undefined) return { content: 'Nothing more.', toolCalls: [] };
        return typeof next === 'string' ? { content: next, toolCalls: [] } : { content: '', toolCalls: next };
    });
}
const FINISH = [call('finish', { outcome: 'no_change', title: 'Checked the notes' })];
const offeredTo = (chat) => chat.mock.calls[0][1].functions.map(tool => tool.name);

async function queued({ userId = A, operations = PROPOSE } = {}) {
    await policies.enroll({ userId, initiative: 'assist' });
    const item = await db.insert(
        `INSERT INTO attention_items (guildId, userId, kind, subject, goal, state)
         VALUES (@guildId, @userId, 'goal', @subject, 'Keep my garden notes accurate', 'active')`,
        { guildId: `dm:${userId}`, userId, subject: `notes-${++goalSeq}` }
    );
    const { responsibility } = await responsibilities.create({
        userId, body: { title: 'Keep my garden notes accurate', operations, attentionItemId: item }
    });
    const active = (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
    await db.run('UPDATE attention_items SET goal = @goal WHERE id = @id', { id: item, goal: `Keep my garden notes accurate, take ${++goalSeq}` });
    const [id] = (await initiatives.reconcileResponsibility(active.id)).proposed;
    const row = await initiatives.get({ userId, id });
    const initiative = (await initiatives.act({ userId, id, action: 'queue', expectedRevision: row.revision })).initiative;
    return { grant: active, initiative };
}

const saved = (label, content) => kg.createUserNote({ guildId: scope, userId: A, label, content });
const noteRow = (id) => db.get('SELECT * FROM kg_nodes WHERE id = @id', { id });
const setRows = () => db.all('SELECT * FROM kg_change_sets ORDER BY id', {});
const operations = () => db.all('SELECT tool, status, refusalCode, resultText FROM assistant_run_operations ORDER BY id', {});

/** The gate card a person is shown for a change set, and a decision on it as them. */
async function cardOf(setId, userId = A) {
    const row = await db.get('SELECT updateId FROM kg_change_sets WHERE id = @id', { id: setId });
    return gates.card({ userId, ref: String(row.updateId) });
}
async function decide(setId, option, { userId = A, card = null } = {}) {
    const row = await db.get('SELECT updateId FROM kg_change_sets WHERE id = @id', { id: setId });
    const shown = card || await cardOf(setId, userId);
    return gates.decide({ userId, ref: String(row.updateId), option, occurrence: shown.occurrence, revision: shown.revision, surface: 'home' });
}

describe('a saved-note proposal', () => {
    test('shows a diff and changes nothing; applying it is the person\'s own decision', async () => {
        const note = await saved('Frost date', 'Frost is expected on the 14th. Cover the beans.');
        await queued();
        const chat = script(
            [call('findNotes', { query: 'frost' })],
            [call('proposeNoteChange', {
                id: note.id, revision: note.revision,
                content: 'Frost is expected on the 9th. Cover the beans.', rationale: 'Two almanacs now say the 9th.'
            })],
            FINISH
        );
        const { results } = await runner.tick({ wait: true });
        expect(results[0]).toMatchObject({ status: 'COMPLETED', outcome: 'DONE' });

        // The model was offered no way to apply: only to propose.
        const names = offeredTo(chat);
        expect(names).toEqual(expect.arrayContaining(['findNotes', 'proposeNoteChange']));
        expect(names.filter(name => /apply|decide|approve/i.test(name))).toEqual([]);
        expect(names).not.toContain('amendSavedNote');

        // The note is untouched; one proposal is waiting.
        expect(await noteRow(note.id)).toMatchObject({ content: 'Frost is expected on the 14th. Cover the beans.', revision: note.revision });
        const [set] = await setRows();
        expect(set).toMatchObject({ kind: 'saved_note_edit', status: 'PROPOSED', nodeId: note.id, expectedRevision: note.revision, policyCode: 'PROPOSAL' });

        // The report says it is waiting, not that something changed.
        const finding = (await updates.list({ userId: A })).updates.find(update => update.kind === 'finding');
        expect(finding.summary).toContain('Waiting for you: Proposed a change to note');
        expect(finding.summary).not.toContain('Changed:');

        // The card shows what would change.
        const card = await cardOf(set.id);
        expect(card).toMatchObject({ kind: 'note_proposal', state: 'open', title: 'Suggested change to "Frost date"' });
        expect(card.diff).toEqual([
            { op: 'del', text: 'Frost is expected on the 14th.' },
            { op: 'add', text: 'Frost is expected on the 9th.' },
            { op: 'same', text: 'Cover the beans.' }
        ]);
        expect(card.options.map(option => option.id)).toEqual(['apply', 'reject']);
        // Someone else cannot see or decide it.
        expect(await cardOf(set.id, B)).toBeNull();
        await expect(decide(set.id, 'apply', { userId: B, card })).rejects.toMatchObject({ status: 404 });

        const decided = await decide(set.id, 'apply', { card });
        expect(decided.decided.message).toBe('Applied.');
        expect(await noteRow(note.id)).toMatchObject({
            content: 'Frost is expected on the 9th. Cover the beans.', revision: note.revision + 1, source: 'user', curation: 'saved'
        });
        expect((await setRows())[0]).toMatchObject({ status: 'APPLIED', decisionCode: 'APPLIED', appliedRevision: note.revision + 1 });
        expect(await cardOf(set.id)).toMatchObject({ state: 'resolved' });
        // A second press is refused as settled.
        await expect(decide(set.id, 'apply', { card })).rejects.toMatchObject({ code: 'STALE_GATE' });
    }, 60_000);

    test('dismissing it leaves the note exactly as it was', async () => {
        const note = await saved('Frost date', 'Frost on the 14th.');
        await queued();
        script([call('proposeNoteChange', { id: note.id, revision: note.revision, content: 'Frost on the 9th.', rationale: 'Almanac.' })], FINISH);
        await runner.tick({ wait: true });
        const [set] = await setRows();
        await decide(set.id, 'reject');
        expect((await setRows())[0]).toMatchObject({ status: 'REJECTED', decisionCode: 'REJECTED' });
        expect(await noteRow(note.id)).toMatchObject({ content: 'Frost on the 14th.', revision: note.revision });
    }, 60_000);

    test('a note that was edited since is never overwritten: the proposal goes STALE and the run may propose again', async () => {
        const note = await saved('Frost date', 'Frost on the 14th.');
        await queued();
        script([call('proposeNoteChange', { id: note.id, revision: note.revision, content: 'Frost on the 9th.', rationale: 'Almanac.' })], FINISH);
        await runner.tick({ wait: true });
        const [set] = await setRows();
        const card = await cardOf(set.id);

        // The person edits the note before looking at the suggestion.
        await kg.updateUserNote({ guildId: scope, userId: A, nodeId: note.id, content: 'Frost on the 12th, says my neighbour.' });
        const moved = await cardOf(set.id);
        expect(moved.detail).toMatch(/changed after this was suggested/);
        expect(moved.options.map(option => option.id)).toEqual(['reject']);

        // Pressing the old card is refused as stale and writes nothing.
        await expect(decide(set.id, 'apply', { card })).rejects.toMatchObject({ code: 'STALE_GATE', status: 409 });
        expect(await noteRow(note.id)).toMatchObject({ content: 'Frost on the 12th, says my neighbour.' });

        // Even past the card, applying finds the note moved: nothing is written and the proposal is settled as stale.
        await expect(changes.apply({ id: set.id, userId: A })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
        expect((await setRows())[0]).toMatchObject({ status: 'STALE', decisionCode: 'REVISION_CONFLICT' });
        expect(await noteRow(note.id)).toMatchObject({ content: 'Frost on the 12th, says my neighbour.' });
        expect(await cardOf(set.id)).toMatchObject({ state: 'resolved' });
        await expect(changes.apply({ id: set.id, userId: A })).rejects.toMatchObject({ code: 'NOT_OPEN' });
    }, 60_000);

    test('a proposal read at an old revision is not even filed', async () => {
        const note = await saved('Frost date', 'Frost on the 14th.');
        await kg.updateUserNote({ guildId: scope, userId: A, nodeId: note.id, content: 'Frost on the 12th.' });
        await queued();
        script([call('proposeNoteChange', { id: note.id, revision: note.revision, content: 'Frost on the 9th.', rationale: 'Almanac.' })], FINISH);
        await runner.tick({ wait: true });
        expect(await setRows()).toEqual([]);
        expect((await operations())[0].resultText).toMatch(/^Not proposed: the note changed since you read it/);
    }, 60_000);

    test('the same proposal again is not a second card, and a newer one replaces the older', async () => {
        const note = await saved('Frost date', 'Frost on the 14th.');
        await queued();
        script([
            call('proposeNoteChange', { id: note.id, revision: note.revision, content: 'Frost on the 9th.', rationale: 'Almanac.' }),
            call('proposeNoteChange', { id: note.id, revision: note.revision, content: 'Frost on the 9th.', rationale: 'Almanac.' })
        ], FINISH);
        await runner.tick({ wait: true });
        expect((await setRows()).map(row => row.status)).toEqual(['PROPOSED']);
        expect(await db.get("SELECT COUNT(*) AS n FROM assistant_updates WHERE identityKey LIKE 'kg_change_set:%'", {})).toMatchObject({ n: 1 });

        const later = await changes.propose({
            guildId: scope, userId: A, run: { id: 999, responsibilityId: (await setRows())[0].responsibilityId, responsibilityRevision: 1 },
            nodeId: note.id, expectedRevision: note.revision, content: 'Frost on the 8th.', rationale: 'A third almanac.'
        });
        expect(later.ok).toBe(true);
        expect((await setRows()).map(row => row.status)).toEqual(['STALE', 'PROPOSED']);
        expect((await setRows())[0].decisionCode).toBe('SUPERSEDED');
    }, 60_000);

    test('a note the person did not save needs no proposal, and an unchanged text is not proposed', async () => {
        const gen = await kg.addGeneratedNote({ guildId: scope, userId: A, label: 'Machine note', content: 'x' });
        const mine = await saved('Mine', 'Same text.');
        await queued();
        script([
            call('proposeNoteChange', { id: gen.id, revision: gen.revision, content: 'y', rationale: 'r' }),
            call('proposeNoteChange', { id: mine.id, revision: mine.revision, content: 'Same text.', rationale: 'r' })
        ], FINISH);
        await runner.tick({ wait: true });
        expect(await setRows()).toEqual([]);
        const results = (await operations()).map(op => op.resultText);
        expect(results[0]).toMatch(/^Not proposed: only a note the person saved needs a proposal/);
        expect(results[1]).toMatch(/^Not proposed: that would not change the note/);
    }, 60_000);

    test('what one responsibility may leave waiting is bounded', async () => {
        const { CHANGE_SETS } = require('@goobster/core/config/knowledgeGraphConfig');
        const notes = [];
        for (let i = 0; i < CHANGE_SETS.maxPerRun + 1; i += 1) notes.push(await saved(`Note ${i}`, `old ${i}`));
        await queued();
        script(notes.map(note => call('proposeNoteChange', { id: note.id, revision: note.revision, content: `new ${note.label}`, rationale: 'r' })), FINISH);
        await runner.tick({ wait: true });
        expect((await setRows()).length).toBe(CHANGE_SETS.maxPerRun);
        expect((await operations()).filter(op => /already filed as many changes/.test(op.resultText || ''))).toHaveLength(1);
    }, 60_000);
});

describe('reverting an applied change', () => {
    async function applied() {
        const note = await saved('Frost date', 'Frost on the 14th.');
        await queued();
        script([call('proposeNoteChange', { id: note.id, revision: note.revision, content: 'Frost on the 9th.', rationale: 'Almanac.' })], FINISH);
        await runner.tick({ wait: true });
        const [set] = await setRows();
        await decide(set.id, 'apply');
        return { note, set };
    }

    test('puts back exactly what was replaced', async () => {
        const { note, set } = await applied();
        expect((await changes.overview({ guildId: scope, userId: A })).changes[0]).toMatchObject({ id: set.id, status: 'APPLIED', revertible: true });
        await expect(changes.revert({ id: set.id, userId: B })).rejects.toMatchObject({ status: 404 });
        await changes.revert({ id: set.id, userId: A });
        expect(await noteRow(note.id)).toMatchObject({ content: 'Frost on the 14th.', source: 'user', curation: 'saved' });
        expect((await setRows())[0]).toMatchObject({ status: 'REVERTED' });
        await expect(changes.revert({ id: set.id, userId: A })).rejects.toMatchObject({ code: 'NOT_APPLIED' });
    }, 60_000);

    test('is refused once the note has moved on, never forced', async () => {
        const { note, set } = await applied();
        await kg.updateUserNote({ guildId: scope, userId: A, nodeId: note.id, content: 'Frost on the 10th, my own call.' });
        await expect(changes.revert({ id: set.id, userId: A })).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
        expect(await noteRow(note.id)).toMatchObject({ content: 'Frost on the 10th, my own call.' });
        expect((await setRows())[0].status).toBe('APPLIED');
    }, 60_000);

    test('asks for the archive to be undone first when the note is archived', async () => {
        const { note, set } = await applied();
        await kg.archiveNote({ guildId: scope, userId: A, nodeId: note.id, by: 'user' });
        await expect(changes.revert({ id: set.id, userId: A })).rejects.toMatchObject({ code: 'NOTE_ARCHIVED' });
    }, 60_000);
});

describe('direct editing', () => {
    test('is offered and allowed only under a grant that names it, and the edit is revertible', async () => {
        const note = await saved('Frost date', 'Frost on the 14th.');
        await queued({ operations: [READ_NOTES, grant('kg.saved.propose')] });
        const chat = script([call('amendSavedNote', { id: note.id, revision: note.revision, content: 'Frost on the 9th.', rationale: 'r' })], FINISH);
        await runner.tick({ wait: true });
        expect(offeredTo(chat)).not.toContain('amendSavedNote');
        expect((await operations())[0]).toMatchObject({ tool: 'amendSavedNote', status: 'REFUSED', refusalCode: 'UNKNOWN_TOOL' });
        expect(await noteRow(note.id)).toMatchObject({ content: 'Frost on the 14th.' });
    }, 60_000);

    test('changes the note, keeps before and after, reports it as changed, and can be reverted', async () => {
        const note = await saved('Frost date', 'Frost on the 14th.');
        await queued({ operations: [READ_NOTES, grant('kg.saved.amend')] });
        const chat = script([call('amendSavedNote', { id: note.id, revision: note.revision, content: 'Frost on the 9th.', rationale: 'Almanac.' })], FINISH);
        await runner.tick({ wait: true });
        expect(offeredTo(chat)).toContain('amendSavedNote');
        expect(offeredTo(chat)).not.toContain('proposeNoteChange');
        expect(await noteRow(note.id)).toMatchObject({ content: 'Frost on the 9th.', source: 'user', curation: 'saved', revision: note.revision + 1 });

        const [set] = await setRows();
        expect(set).toMatchObject({ kind: 'direct_change', status: 'APPLIED', policyCode: 'DIRECT_GRANT', appliedRevision: note.revision + 1 });
        expect(JSON.parse(set.beforeJson)).toMatchObject({ content: 'Frost on the 14th.', label: 'Frost date' });
        const finding = (await updates.list({ userId: A })).updates.find(update => update.kind === 'finding');
        expect(finding.summary).toContain('Changed: Changed saved note');

        await changes.revert({ id: set.id, userId: A });
        expect(await noteRow(note.id)).toMatchObject({ content: 'Frost on the 14th.' });
    }, 60_000);
});

describe('conflicting evidence', () => {
    test('disputes a claim without losing the person\'s words, and the label shows in retrieval', async () => {
        const note = await saved('Frost date', 'Frost is expected on the 14th.');
        await queued();
        script([call('proposeNoteChange', {
            id: note.id, revision: note.revision, disputeReason: 'Two almanacs say the 9th.', rationale: 'The claim conflicts with sources I found.'
        })], FINISH);
        await runner.tick({ wait: true });
        const [set] = await setRows();
        const card = await cardOf(set.id);
        expect(card.diff).toEqual([{ op: 'skip', text: '1 unchanged passage' }]);
        expect(card.detail).toMatch(/marks the note as disputed/);

        await decide(set.id, 'apply', { card });
        expect(await noteRow(note.id)).toMatchObject({ content: 'Frost is expected on the 14th.', claimStatus: 'disputed', curation: 'saved' });
        const found = await kg.searchNodes({ guildId: scope, scopeKey: `USER:${A}`, query: 'frost' });
        expect(kg.formatSubgraph({ nodes: found, edges: [] })).toContain('[disputed]');
        // The earlier text is still in the note's revision history.
        const history = await db.all('SELECT content, changeKind FROM kg_node_revisions WHERE nodeId = @id ORDER BY revisionNumber', { id: note.id });
        expect(history.map(entry => entry.content)).toContain('Frost is expected on the 14th.');
        await changes.revert({ id: set.id, userId: A });
        expect(await noteRow(note.id)).toMatchObject({ claimStatus: 'current' });
    }, 60_000);
});

describe('connections and archiving by a run', () => {
    const GRANTS = [READ_NOTES, grant('kg.edge'), grant('kg.archive'), grant('kg.generated.amend')];

    test('connects two notes with the run as evidence, retracts it, and archives only what the person did not save', async () => {
        const frost = await saved('Frost date', 'Frost on the 14th.');
        const beans = await kg.addGeneratedNote({ guildId: scope, userId: A, label: 'Garden beans', content: 'Beans.' });
        const stale = await kg.addGeneratedNote({ guildId: scope, userId: A, label: 'Stale note', content: 'old' });
        const soil = await kg.addGeneratedNote({ guildId: scope, userId: A, label: 'Soil', content: 'Loam.' });
        await kg.linkNotes({ guildId: scope, userId: A, sourceId: beans.id, targetId: soil.id, relation: 'grows in', originRunId: 90001 });
        await queued({ operations: GRANTS });
        script(
            [call('linkNotes', { sourceId: frost.id, sourceRevision: frost.revision, targetId: beans.id, targetRevision: beans.revision, relation: 'threatens' })],
            [call('linkNotes', { sourceId: beans.id, sourceRevision: beans.revision, targetId: soil.id, targetRevision: soil.revision, relation: 'grows in' }),
                call('archiveNote', { id: frost.id, revision: frost.revision }),
                call('archiveNote', { id: stale.id, revision: stale.revision })],
            FINISH
        );
        await runner.tick({ wait: true });
        const edge = await db.get("SELECT * FROM kg_edges WHERE relation = 'threatens'", {});
        expect(edge).toMatchObject({ evidenceKind: 'run', originRunId: expect.any(Number), retractedAt: null });
        expect(edge.evidenceId).toBe(edge.originRunId);

        const results = (await operations()).filter(op => op.tool !== 'finish').map(op => op.resultText);
        expect(results[0]).toMatch(/^Connected #/);
        expect(results[1]).toMatch(/^Not linked: .* already connected/);
        expect(results[2]).toMatch(/^Not archived: the person saved that note/);
        expect(results[3]).toMatch(/^Archived note #/);
        expect((await noteRow(frost.id)).archivedAt).toBeNull();
        expect(await noteRow(stale.id)).toMatchObject({ archivedBy: 'run', archiveCode: 'archived' });

        // The person's overview offers the restore.
        const overview = await changes.overview({ guildId: scope, userId: A });
        expect(overview.archived.map(note => note.label)).toEqual(['Stale note']);
        const finding = (await updates.list({ userId: A })).updates.find(update => update.kind === 'finding');
        expect(finding.summary).toMatch(/Changed: Connected #\d+.* Archived note #\d+/);
    }, 60_000);

    test('retracting a connection keeps it, and the run cannot bring back one the person removed', async () => {
        const a = await saved('Alpha', 'a');
        const b = await saved('Beta', 'b');
        const made = await kg.linkNotes({ guildId: scope, userId: A, sourceId: a.id, targetId: b.id, relation: 'supports', originRunId: 1 });
        await queued({ operations: GRANTS });
        script(
            [call('listNoteLinks', { id: a.id })],
            [call('retractNoteLink', { edgeId: made.id, revision: made.revision })],
            [call('linkNotes', { sourceId: a.id, sourceRevision: a.revision, targetId: b.id, targetRevision: b.revision, relation: 'supports' })],
            FINISH
        );
        await runner.tick({ wait: true });
        const results = (await operations()).filter(op => op.tool !== 'finish').map(op => op.resultText);
        expect(results[0]).toContain(`connection ${made.id} (revision 1)`);
        expect(results[1]).toMatch(/^Retracted connection/);
        // A run-retracted connection can be revived by a later run, but the person removing it is final.
        expect(results[2]).toMatch(/^Connected #/);
        const live = await db.get('SELECT * FROM kg_edges WHERE id = @id', { id: made.id });
        await kg.retractEdge({ guildId: scope, userId: A, edgeId: made.id, expectedRevision: live.revision, by: 'user' });
        expect(await kg.linkNotes({ guildId: scope, userId: A, sourceId: a.id, targetId: b.id, relation: 'supports' })).toEqual({ ok: false, code: 'RETRACTED_BY_USER' });
    }, 60_000);

    test('confirming a finding adds evidence once, adds no note and no notice, and a finding cannot confirm itself', async () => {
        const first = await queued({ operations: GRANTS });
        const finding = await kg.addGeneratedNote({ guildId: scope, userId: A, label: 'Frost on the 9th', content: 'Two almanacs.', originRunId: 1 });
        // The note was written by an earlier run of this same responsibility.
        const earlierInitiative = await db.insert(
            `INSERT INTO assistant_initiatives (responsibilityId, responsibilityRevision, ownerUserId, actingUserId, sourceKind, sourceId, sourceRevision, dedupeKey, title, status)
             VALUES (@r, 1, @u, @u, 'attention_item', 'old', 'r1', 'old:1', 'Earlier', 'COMPLETED')`,
            { r: first.grant.id, u: A }
        );
        const earlierRun = await db.insert(
            `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId, status)
             VALUES (@i, @r, 1, @u, @u, @u, 'COMPLETED')`,
            { i: earlierInitiative, r: first.grant.id, u: A }
        );
        await db.run('DELETE FROM kg_provenance WHERE nodeId = @id', { id: finding.id });
        await kg.addProvenance({ nodeId: finding.id, sourceKind: 'tool', sourceId: earlierRun });

        script([call('confirmNote', { id: finding.id })], FINISH);
        await runner.tick({ wait: true });
        // Same responsibility wrote it: no strengthening, no change, no notice.
        expect((await operations())[0].resultText).toMatch(/^Not confirmed: this responsibility wrote that finding/);
        expect(Number((await noteRow(finding.id)).confidence)).toBe(0.5);

        // Another responsibility's run confirms it once; repeating adds nothing.
        const other = await kg.confirmGeneratedNote({ guildId: scope, userId: A, nodeId: finding.id, runId: 4242, responsibilityId: first.grant.id + 100 });
        expect(other).toMatchObject({ ok: true, sources: 2 });
        expect(await kg.confirmGeneratedNote({ guildId: scope, userId: A, nodeId: finding.id, runId: 4242, responsibilityId: first.grant.id + 100 }))
            .toEqual({ ok: false, code: 'ALREADY_COUNTED' });
        expect(Number((await noteRow(finding.id)).confidence)).toBeCloseTo(0.55);
        expect((await db.get('SELECT COUNT(*) AS n FROM kg_nodes', {})).n).toBe(1);
        // A saved note is never confirmed by a run.
        const mine = await saved('Mine', 'x');
        expect(await kg.confirmGeneratedNote({ guildId: scope, userId: A, nodeId: mine.id, runId: 5, responsibilityId: 9 })).toEqual({ ok: false, code: 'NOT_GENERATED' });
    }, 60_000);

    test('a confirmation is evidence only: the run reports no change and files no update', async () => {
        const finding = await kg.addGeneratedNote({ guildId: scope, userId: A, label: 'Frost on the 9th', content: 'Two almanacs.', originRunId: 90002 });
        await queued({ operations: GRANTS });
        script([call('confirmNote', { id: finding.id })], FINISH);
        const { results } = await runner.tick({ wait: true });
        expect((await operations())[0].resultText).toMatch(/^Noted: note #\d+ now has 2 confirming sources/);
        expect(results[0]).toMatchObject({ status: 'COMPLETED', outcome: 'NO_CHANGE' });
        expect((await updates.list({ userId: A })).updates.filter(update => update.kind === 'finding')).toEqual([]);
        expect((await db.get('SELECT COUNT(*) AS n FROM kg_nodes', {})).n).toBe(1);
    }, 60_000);
});

describe('a withdrawn source', () => {
    async function seed() {
        const exp = await db.insert("INSERT INTO spitball_expeditions (userId, guildId, seed) VALUES (@u, @g, 'frost') ", { u: A, g: scope });
        const source = await db.insert("INSERT INTO research_sources (expeditionId, userId, title) VALUES (@e, @u, 'Old almanac')", { e: exp, u: A });
        const claim = await db.insert("INSERT INTO research_claims (sourceId, expeditionId, text) VALUES (@s, @e, 'Frost on the 14th')", { s: source, e: exp });
        const cites = await saved('Frost date', 'Frost on the 14th.');
        const quiet = await saved('Unrelated', 'Something else.');
        await kg.addProvenance({ nodeId: cites.id, sourceKind: 'research_claim', sourceId: claim });
        const project = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'garden', 'Garden')", { u: A });
        const mission = await db.insert(
            `INSERT INTO project_missions (projectId, userId, title, objective, successCriteriaJson, status)
             VALUES (@p, @u, 'Plant by the frost date', 'Plant on time', '[]', 'ACTIVE')`,
            { p: project, u: A }
        );
        await db.run(
            `INSERT INTO project_mission_evidence (missionId, userId, criterionId, kind, refId, label)
             VALUES (@m, @u, '', 'claim', @claim, 'Frost on the 14th')`,
            { m: mission, u: A, claim }
        );
        return { source, claim, cites, quiet, mission };
    }

    test('finds the notes and the active assumptions that rest on it, deletes nothing, and the person decides', async () => {
        const { source, claim, cites, quiet, mission } = await seed();
        const review = await impact.reviewRetraction({ userId: A, guildId: scope, sourceKind: 'research_source', sourceId: source, reason: 'The almanac was recalled.' });
        expect(review).toMatchObject({ affected: 1, notes: 1, assumptions: 1 });

        // Nothing was deleted or changed; the citing row is marked withdrawn.
        expect((await db.get('SELECT COUNT(*) AS n FROM kg_nodes', {})).n).toBe(2);
        expect(await noteRow(cites.id)).toMatchObject({ content: 'Frost on the 14th.', claimStatus: 'current' });
        expect(await db.get('SELECT retractedAt FROM kg_provenance WHERE sourceKind = \'research_claim\' AND sourceId = @id', { id: claim }))
            .toMatchObject({ retractedAt: expect.any(String) });
        expect(await db.get('SELECT COUNT(*) AS n FROM project_mission_evidence', {})).toMatchObject({ n: 1 });

        const shown = (await changes.overview({ guildId: scope, userId: A })).proposals[0];
        expect(shown).toMatchObject({ kind: 'source_retraction', status: 'PROPOSED' });
        expect(shown.impact).toMatchObject({ unverifiable: true, reason: 'The almanac was recalled.' });
        expect(shown.impact.notes).toEqual([expect.objectContaining({ id: cites.id, label: 'Frost date' })]);
        expect(shown.impact.assumptions).toEqual([expect.objectContaining({ missionId: mission, title: 'Plant by the frost date' })]);
        expect((await noteRow(quiet.id)).claimStatus).toBe('current');

        // Reviewing the same source again returns the same review.
        expect(await impact.reviewRetraction({ userId: A, guildId: scope, sourceKind: 'research_source', sourceId: source }))
            .toMatchObject({ id: review.id, existing: true });

        const card = await cardOf(review.id);
        expect(card).toMatchObject({ kind: 'source_retraction', state: 'open' });
        expect(card.detail).toMatch(/unverifiable, not false/);
        await decide(review.id, 'apply', { card });
        expect(await noteRow(cites.id)).toMatchObject({ content: 'Frost on the 14th.', claimStatus: 'disputed' });
        expect((await noteRow(quiet.id)).claimStatus).toBe('current');
        await changes.revert({ id: review.id, userId: A });
        expect((await noteRow(cites.id)).claimStatus).toBe('current');
    }, 60_000);

    test('says nothing when nothing rests on the source, and refuses a source that is not the person\'s', async () => {
        const exp = await db.insert("INSERT INTO spitball_expeditions (userId, guildId, seed) VALUES (@u, @g, 'x')", { u: A, g: scope });
        const lonely = await db.insert("INSERT INTO research_sources (expeditionId, userId, title) VALUES (@e, @u, 'Nobody cited me')", { e: exp, u: A });
        expect(await impact.reviewRetraction({ userId: A, guildId: scope, sourceKind: 'research_source', sourceId: lonely }))
            .toMatchObject({ affected: 0, id: null });
        expect(await setRows()).toEqual([]);
        await expect(impact.reviewRetraction({ userId: B, guildId: `dm:${B}`, sourceKind: 'research_source', sourceId: lonely }))
            .rejects.toMatchObject({ status: 404 });
    }, 60_000);
});

describe('the owner-only pilot gate', () => {
    test('somebody who is not the owner cannot activate a knowledge-work grant, and the tools vanish when the owner loses the pilot', async () => {
        await policies.enroll({ userId: B, initiative: 'assist' });
        for (const operation of ['kg.saved.propose', 'kg.saved.amend', 'kg.edge', 'kg.archive']) {
            const { responsibility } = await responsibilities.create({ userId: B, body: { title: `Try ${operation}`, operations: [READ_NOTES, grant(operation)] } });
            await expect(responsibilities.act({ userId: B, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision }))
                .rejects.toMatchObject({ code: 'PILOT_ONLY' });
        }

        // Each tool asks again before it runs.
        const ctx = { run: { id: 1, ownerUserId: B }, actor: B, scope: `dm:${B}` };
        for (const tool of ['findNotes', 'listNoteLinks', 'proposeNoteChange', 'amendSavedNote', 'linkNotes', 'retractNoteLink', 'archiveNote', 'confirmNote']) {
            expect(await runs.TOOLS[tool].guard({}, ctx)).toBe('PILOT_ONLY');
        }
        expect(await runs.TOOLS.proposeNoteChange.guard({}, { ...ctx, run: { id: 1, ownerUserId: A } })).toBeNull();

        // The owner's run loses the tools the moment they stop being the owner.
        const note = await saved('Frost date', 'Frost on the 14th.');
        await queued();
        await db.run("UPDATE app_accounts SET status = 'disabled' WHERE principalId = @id", { id: A });
        const chat = script([call('proposeNoteChange', { id: note.id, revision: note.revision, content: 'x', rationale: 'r' })], 'Not available.');
        await runner.tick({ wait: true });
        expect(offeredTo(chat).filter(name => ['findNotes', 'listNoteLinks', 'proposeNoteChange', 'amendSavedNote', 'linkNotes', 'retractNoteLink', 'archiveNote', 'confirmNote'].includes(name))).toEqual([]);
        expect(await setRows()).toEqual([]);
    }, 60_000);

    test('recording the pilot decision opens it to everyone', async () => {
        await access.recordDecision({ scope: 'everyone' });
        await policies.enroll({ userId: B, initiative: 'assist' });
        const { responsibility } = await responsibilities.create({ userId: B, body: { title: 'Propose', operations: [READ_NOTES, grant('kg.saved.propose')] } });
        await expect(responsibilities.act({ userId: B, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision }))
            .resolves.toBeTruthy();
    });
});

describe('erasure and retention', () => {
    test('/forget-me removes the change sets, which hold note text, and the audit finds none left', async () => {
        const note = await saved('Frost date', 'Frost on the 14th.');
        await queued();
        script([call('proposeNoteChange', { id: note.id, revision: note.revision, content: 'Frost on the 9th.', rationale: 'Almanac.' })], FINISH);
        await runner.tick({ wait: true });
        expect(await setRows()).toHaveLength(1);
        expect((await privacyService.auditUser({ userId: A })).byTable.kg_change_sets).toBe(1);
        await privacyService.forgetUser({ userId: A });
        expect(await setRows()).toEqual([]);
        expect((await privacyService.auditUser({ userId: A })).byTable.kg_change_sets).toBe(0);
    }, 60_000);

    test('an undecided proposal goes stale after a month, and decided ones are pruned later', async () => {
        const note = await saved('Frost date', 'Frost on the 14th.');
        await queued();
        script([call('proposeNoteChange', { id: note.id, revision: note.revision, content: 'Frost on the 9th.', rationale: 'Almanac.' })], FINISH);
        await runner.tick({ wait: true });
        const soon = new Date(Date.now() + 5 * 86400000);
        expect(await changes.expireOpen({ now: soon })).toBe(0);
        const later = new Date(Date.now() + 40 * 86400000);
        expect(await changes.expireOpen({ now: later })).toBe(1);
        const [set] = await setRows();
        expect(set).toMatchObject({ status: 'STALE', decisionCode: 'EXPIRED' });
        expect(await cardOf(set.id)).toMatchObject({ state: 'resolved' });
        expect(await changes.prune({ now: later })).toBe(0);
        expect(await changes.prune({ now: new Date(Date.now() + 400 * 86400000) })).toBe(1);
        expect(await setRows()).toEqual([]);
    }, 60_000);
});
