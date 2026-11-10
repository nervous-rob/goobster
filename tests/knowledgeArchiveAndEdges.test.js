/**
 * Archiving, reversible merge, edge evidence and retraction, and claim
 * state on the knowledge graph (DA-11b, ADR 0027). No run, no model: the
 * graph service on a throwaway database.
 *
 * The properties under test: an archived note leaves retrieval everywhere
 * but is kept and restorable with its connections; a merge archives the
 * dropped note as an alias instead of deleting it and an undo takes the
 * merge's own connections back out; a connection records its evidence and
 * run, a run cannot bring back one the person removed, and a retracted
 * connection is kept and restorable; capacity counts live notes only and
 * never evicts a saved one; a disputed claim stays retrievable with a
 * label, a retracted one never reads as current; and a writer meeting an
 * archived title does not bring it back.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-kg-archive-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const kg = require('@goobster/core/services/knowledgeGraphService');

const A = '791000000000000001';
const B = '791000000000000002';
const scope = (u) => `dm:${u}`;

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    for (const table of ['kg_change_sets', 'kg_edges', 'kg_provenance', 'kg_node_revisions', 'kg_nodes']) {
        await db.run(`DELETE FROM ${table}`, {});
    }
});

const saved = (label, content = `${label} text`, userId = A) => kg.createUserNote({ guildId: scope(userId), userId, label, content });
const generated = (label, content = `${label} text`, userId = A) => kg.addGeneratedNote({ guildId: scope(userId), userId, label, content });
const row = (id) => db.get('SELECT * FROM kg_nodes WHERE id = @id', { id });
const search = (query, userId = A) => kg.searchNodes({ guildId: scope(userId), scopeKey: `USER:${userId}`, query });

describe('archiving a note', () => {
    test('takes it out of retrieval everywhere, keeps it, and restoring brings its connections back', async () => {
        const beans = await generated('Garden beans', 'Beans like warm soil.');
        const frost = await saved('Frost date', 'Frost is expected on the 14th.');
        const linked = await kg.linkNotes({
            guildId: scope(A), userId: A, sourceId: frost.id, targetId: beans.id, relation: 'threatens',
            expectedSourceRevision: frost.revision, expectedTargetRevision: beans.revision, originRunId: 7
        });
        expect(linked).toMatchObject({ ok: true, created: true });
        expect((await search('beans')).map(n => n.label)).toEqual(['Garden beans']);

        const archived = await kg.archiveNote({ guildId: scope(A), userId: A, nodeId: beans.id, expectedRevision: beans.revision, by: 'run' });
        expect(archived).toMatchObject({ ok: true, revision: beans.revision + 1 });

        // Out of retrieval, notes, the map and the counts; still stored.
        expect(await search('beans')).toEqual([]);
        expect((await kg.listUserNotes({ guildId: scope(A), userId: A, view: 'all' })).notes.map(n => n.label)).toEqual(['Frost date']);
        expect((await kg.getStats(scope(A), `USER:${A}`)).nodes).toBe(1);
        expect(await kg.edgesFor(scope(A), [frost.id, beans.id], `USER:${A}`)).toEqual([]);
        expect(await row(beans.id)).toMatchObject({ archivedAt: expect.any(String), archivedBy: 'run', archiveCode: 'archived' });
        expect(await kg.listArchivedNotes({ guildId: scope(A), userId: A })).toEqual([
            expect.objectContaining({ id: beans.id, label: 'Garden beans', archiveCode: 'archived', connections: 1 })
        ]);

        const restored = await kg.restoreNote({ guildId: scope(A), userId: A, nodeId: beans.id });
        expect(restored).toMatchObject({ ok: true, wasMerge: false, connections: 1 });
        expect((await search('beans')).map(n => n.label)).toEqual(['Garden beans']);
        expect(await kg.edgesFor(scope(A), [frost.id], `USER:${A}`)).toEqual([
            expect.objectContaining({ relation: 'threatens', sourceLabel: 'Frost date', targetLabel: 'Garden beans' })
        ]);
        expect(await kg.listArchivedNotes({ guildId: scope(A), userId: A })).toEqual([]);
    });

    test('a run cannot archive a note the person saved, and a stale revision is refused', async () => {
        const mine = await saved('My words');
        const gen = await generated('Machine note');
        expect(await kg.archiveNote({ guildId: scope(A), userId: A, nodeId: mine.id, by: 'run' })).toEqual({ ok: false, code: 'SAVED_NOTE' });
        expect(await kg.archiveNote({ guildId: scope(A), userId: A, nodeId: gen.id, expectedRevision: 9, by: 'run' }))
            .toMatchObject({ ok: false, code: 'REVISION_CONFLICT', revision: gen.revision });
        expect((await row(mine.id)).archivedAt).toBeNull();
        // The person can archive their own note.
        expect(await kg.archiveNote({ guildId: scope(A), userId: A, nodeId: mine.id, by: 'user' })).toMatchObject({ ok: true });
    });

    test('another person\'s note is not found, never archived or restored', async () => {
        const theirs = await saved('Theirs', 'private', B);
        expect(await kg.archiveNote({ guildId: scope(A), userId: A, nodeId: theirs.id, by: 'user' })).toEqual({ ok: false, code: 'NOT_FOUND' });
        expect(await kg.restoreNote({ guildId: scope(A), userId: A, nodeId: theirs.id })).toEqual({ ok: false, code: 'NOT_FOUND' });
        expect((await row(theirs.id)).archivedAt).toBeNull();
    });

    test('an automated writer meeting an archived title does not bring it back or change it', async () => {
        const note = await generated('Old topic', 'Original.');
        await kg.archiveNote({ guildId: scope(A), userId: A, nodeId: note.id, by: 'run' });
        const result = await kg.upsertNode({
            guildId: scope(A), scopeKey: `USER:${A}`, subjectType: 'USER', subjectId: A, label: 'Old topic', content: 'Overwritten?', source: 'consolidation'
        });
        expect(result).toMatchObject({ archived: true, created: false });
        expect(await row(note.id)).toMatchObject({ content: 'Original.' });
        expect(await row(note.id)).toMatchObject({ archiveCode: 'archived' });
        // A connection to an archived title is refused, not created.
        const other = await saved('Other');
        expect(await kg.link({
            guildId: scope(A), scopeKey: `USER:${A}`, subjectType: 'USER', subjectId: A, source: 'Other', target: 'Old topic', relation: 'related', weight: 0.5
        })).toBeNull();
        expect(await kg.edgesFor(scope(A), [other.id], `USER:${A}`)).toEqual([]);
    });
});

describe('a reversible merge', () => {
    test('archives the dropped note as an alias, repoints connections as evidence-marked edges, and an undo retracts them', async () => {
        const keep = await saved('Tomatoes', 'Tomato plants.');
        const drop = await generated('Tomato plants', 'Longer description of tomato plants and care.');
        const other = await saved('Garden');
        await kg.link({ guildId: scope(A), scopeKey: `USER:${A}`, subjectType: 'USER', subjectId: A, source: 'Tomato plants', target: 'Garden', relation: 'part of', weight: 0.6 });

        expect(await kg.mergeNodes({ guildId: scope(A), scopeKey: `USER:${A}`, keepLabel: 'Tomatoes', dropLabel: 'Tomato plants' })).toBe(true);

        expect(await row(drop.id)).toMatchObject({ archiveCode: 'merged', mergedIntoId: keep.id, archivedBy: 'reflection' });
        expect((await search('tomato')).map(n => n.label)).toEqual(['Tomatoes']);
        const moved = await kg.edgesFor(scope(A), [keep.id], `USER:${A}`);
        expect(moved).toEqual([expect.objectContaining({ sourceLabel: 'Tomatoes', targetLabel: 'Garden', relation: 'part of' })]);
        const mergeEdge = await db.get("SELECT * FROM kg_edges WHERE sourceId = @id AND evidenceKind = 'merge'", { id: keep.id });
        expect(mergeEdge).toMatchObject({ evidenceId: drop.id, retractedAt: null });
        expect(await kg.listArchivedNotes({ guildId: scope(A), userId: A }))
            .toEqual([expect.objectContaining({ id: drop.id, archiveCode: 'merged', mergedInto: { id: keep.id, label: 'Tomatoes' } })]);

        // A writer that meets the merged-away title lands on the note that kept its meaning.
        const alias = await kg.upsertNode({ guildId: scope(A), scopeKey: `USER:${A}`, subjectType: 'USER', subjectId: A, label: 'Tomato plants', content: 'x', source: 'consolidation' });
        expect(alias).toMatchObject({ archived: true, alias: true, id: keep.id });

        const undone = await kg.restoreNote({ guildId: scope(A), userId: A, nodeId: drop.id });
        expect(undone).toMatchObject({ ok: true, wasMerge: true, unmerged: 1 });
        expect((await search('tomato')).map(n => n.label).sort()).toEqual(['Tomato plants', 'Tomatoes']);
        expect(await row(drop.id)).toMatchObject({ archivedAt: null, mergedIntoId: null });
        expect(await db.get('SELECT retractedAt, retractionCode FROM kg_edges WHERE id = @id', { id: mergeEdge.id }))
            .toMatchObject({ retractionCode: 'unmerged' });
        // The dropped note is connected to Garden again by its own edge; Tomatoes lost the merge's copy.
        expect((await kg.edgesFor(scope(A), [other.id], `USER:${A}`)).map(e => e.sourceLabel)).toEqual(['Tomato plants']);
    });

    test('a saved note that is dropped in a merge still makes the surviving note saved', async () => {
        const keep = await generated('Kept machine note');
        const drop = await saved('Dropped but saved');
        await kg.mergeNodes({ guildId: scope(A), scopeKey: `USER:${A}`, keepLabel: 'Kept machine note', dropLabel: 'Dropped but saved' });
        expect(await row(keep.id)).toMatchObject({ curation: 'saved' });
        expect((await row(drop.id)).archiveCode).toBe('merged');
    });
});

describe('connections with evidence', () => {
    async function pair() {
        const a = await saved('Alpha');
        const b = await saved('Beta');
        return { a, b };
    }
    const link = (a, b, extra = {}) => kg.linkNotes({
        guildId: scope(A), userId: A, sourceId: a.id, targetId: b.id, relation: 'supports',
        expectedSourceRevision: a.revision, expectedTargetRevision: b.revision, originRunId: 11, ...extra
    });

    test('records the evidence and the run, is idempotent, and refuses a stale revision', async () => {
        const { a, b } = await pair();
        const evidence = await saved('Evidence note');
        const made = await link(a, b, { evidenceKind: 'note', evidenceId: evidence.id });
        expect(made).toMatchObject({ ok: true, created: true, revision: 1 });
        expect(await db.get('SELECT * FROM kg_edges WHERE id = @id', { id: made.id }))
            .toMatchObject({ evidenceKind: 'note', evidenceId: evidence.id, originRunId: 11, revision: 1, retractedAt: null });
        expect(await link(a, b)).toMatchObject({ ok: true, existing: true, id: made.id });
        expect(await db.get('SELECT COUNT(*) AS n FROM kg_edges', {})).toMatchObject({ n: 1 });
        expect(await link(a, b, { relation: 'contradicts', expectedSourceRevision: 99 })).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    });

    test('a retracted connection is kept and restorable; a run cannot revive one the person removed', async () => {
        const { a, b } = await pair();
        const made = await link(a, b);

        // A run retracts: the connection leaves reads but stays, with why.
        expect(await kg.retractEdge({ guildId: scope(A), userId: A, edgeId: made.id, expectedRevision: made.revision, by: 'run' })).toMatchObject({ ok: true, revision: 2 });
        expect(await kg.edgesFor(scope(A), [a.id], `USER:${A}`)).toEqual([]);
        expect(await db.get('SELECT retractionCode FROM kg_edges WHERE id = @id', { id: made.id })).toMatchObject({ retractionCode: 'run' });
        expect((await kg.listRetractedEdges({ guildId: scope(A), userId: A })).map(e => e.id)).toEqual([made.id]);
        // Stale revision, and an edge already retracted.
        expect(await kg.retractEdge({ guildId: scope(A), userId: A, edgeId: made.id, expectedRevision: 1, by: 'run' })).toMatchObject({ ok: false, code: 'ALREADY_RETRACTED' });

        // A later run may revive what a run retracted; the person restores it too.
        expect(await link(a, b)).toMatchObject({ ok: true, revived: true });
        expect(await kg.edgesFor(scope(A), [a.id], `USER:${A}`)).toHaveLength(1);

        // The person removes it: only the person brings it back.
        const current = await db.get('SELECT revision FROM kg_edges WHERE id = @id', { id: made.id });
        await kg.retractEdge({ guildId: scope(A), userId: A, edgeId: made.id, expectedRevision: current.revision, by: 'user' });
        expect(await link(a, b)).toEqual({ ok: false, code: 'RETRACTED_BY_USER' });
        expect(await kg.restoreEdge({ guildId: scope(A), userId: A, edgeId: made.id })).toMatchObject({ ok: true });
        expect(await kg.edgesFor(scope(A), [a.id], `USER:${A}`)).toHaveLength(1);
    });

    test('an automated link does not resurrect a retracted connection', async () => {
        const { a, b } = await pair();
        const made = await link(a, b);
        await kg.retractEdge({ guildId: scope(A), userId: A, edgeId: made.id, by: 'user' });
        await kg.link({ guildId: scope(A), scopeKey: `USER:${A}`, subjectType: 'USER', subjectId: A, source: 'Alpha', target: 'Beta', relation: 'supports', weight: 0.9 });
        expect(await kg.edgesFor(scope(A), [a.id], `USER:${A}`)).toEqual([]);
    });
});

describe('claim state', () => {
    test('a disputed note stays retrievable with a label and its words; a retracted one is never offered as current', async () => {
        const note = await saved('Frost date', 'Frost is expected on the 14th.');
        const disputed = await kg.applyNoteChange({
            guildId: scope(A), userId: A, nodeId: note.id, expectedRevision: note.revision, claimStatus: 'disputed'
        });
        expect(disputed).toMatchObject({ ok: true, revision: note.revision + 1 });
        const found = await search('frost');
        expect(found).toEqual([expect.objectContaining({ label: 'Frost date', content: 'Frost is expected on the 14th.', claimStatus: 'disputed' })]);
        expect(kg.formatSubgraph({ nodes: found, edges: [] })).toContain('"Frost date" [disputed]');
        expect(await row(note.id)).toMatchObject({ curation: 'saved', source: 'user' });

        await db.run("UPDATE kg_nodes SET claimStatus = 'retracted' WHERE id = @id", { id: note.id });
        expect(await search('frost')).toEqual([]);
        // The person still sees it, with its state, in their notes.
        expect((await kg.listUserNotes({ guildId: scope(A), userId: A, view: 'all' })).notes[0]).toMatchObject({ label: 'Frost date', claimStatus: 'retracted' });
    });

    test('a change applies only at the revision read, and a snapshot restores the exact earlier state', async () => {
        const note = await saved('Plan', 'Original wording.');
        expect(await kg.applyNoteChange({ guildId: scope(A), userId: A, nodeId: note.id, expectedRevision: 99, content: 'x' }))
            .toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
        const changed = await kg.applyNoteChange({
            guildId: scope(A), userId: A, nodeId: note.id, expectedRevision: note.revision, content: 'New wording.', claimStatus: 'disputed'
        });
        expect(changed.before).toMatchObject({ content: 'Original wording.', claimStatus: 'current', curation: 'saved' });
        const back = await kg.applyNoteChange({
            guildId: scope(A), userId: A, nodeId: note.id, expectedRevision: changed.revision, snapshot: changed.before
        });
        expect(back).toMatchObject({ ok: true });
        expect(await row(note.id)).toMatchObject({ content: 'Original wording.', claimStatus: 'current', curation: 'saved' });
    });
});
