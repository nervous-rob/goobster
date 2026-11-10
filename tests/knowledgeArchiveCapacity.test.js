/**
 * Capacity with archiving (DA-11b, ADR 0027): the live cap counts live notes
 * only, so archiving makes room; a note the person saved is never evicted to
 * make room; the archive itself is bounded, oldest generated notes first; and
 * restoring into a full scope is refused rather than forced.
 *
 * The caps are lowered for this file so the limits are reachable.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-kg-capacity-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/config/knowledgeGraphConfig', () => ({
    ...jest.requireActual('@goobster/core/config/knowledgeGraphConfig'),
    MAX_NODES_USER: 3,
    MAX_ARCHIVED_PER_SCOPE: 2
}));

const db = require('@goobster/core/db');
const kg = require('@goobster/core/services/knowledgeGraphService');

const A = '792000000000000001';
const scope = `dm:${A}`;
const scopeKey = `USER:${A}`;

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    for (const table of ['kg_edges', 'kg_provenance', 'kg_node_revisions', 'kg_nodes']) await db.run(`DELETE FROM ${table}`, {});
});

const generated = (label) => kg.addGeneratedNote({ guildId: scope, userId: A, label, content: `${label} text` });
const archive = (note) => kg.archiveNote({ guildId: scope, userId: A, nodeId: note.id, by: 'run' });
const labels = async (archived) => (await db.all(
    `SELECT label FROM kg_nodes WHERE scopeKey = @scopeKey AND archivedAt IS ${archived ? 'NOT NULL' : 'NULL'} ORDER BY id`, { scopeKey }
)).map(row => row.label);

describe('capacity and the archive', () => {
    test('a full scope refuses a new generated note until something is archived, then has room', async () => {
        const notes = [await generated('one'), await generated('two'), await generated('three')];
        expect(notes.every(note => note.ok)).toBe(true);
        expect(await generated('four')).toEqual({ ok: false, code: 'CAPACITY' });

        await archive(notes[0]);
        expect(await generated('four')).toMatchObject({ ok: true });
        expect(await labels(false)).toEqual(['two', 'three', 'four']);
    });

    test('saved notes are never evicted, and restoring into a full scope is refused', async () => {
        const saved = await kg.createUserNote({ guildId: scope, userId: A, label: 'Mine', content: 'My words.' });
        const gen = await generated('machine');
        await archive(gen);
        await generated('x');
        await generated('y');
        // Mine, x, y fill the cap of three; the archived note cannot come back yet.
        expect(await kg.restoreNote({ guildId: scope, userId: A, nodeId: gen.id })).toEqual({ ok: false, code: 'CAPACITY' });
        await kg.pruneScope(scope, scopeKey);
        expect((await db.get('SELECT archivedAt FROM kg_nodes WHERE id = @id', { id: saved.id })).archivedAt).toBeNull();
        expect(await labels(false)).toEqual(['Mine', 'x', 'y']);
    });

    test('the archive is bounded: the oldest generated notes go first and a saved archived note stays', async () => {
        const mine = await kg.createUserNote({ guildId: scope, userId: A, label: 'Mine', content: 'My words.' });
        await kg.archiveNote({ guildId: scope, userId: A, nodeId: mine.id, by: 'user' });
        const gen = [await generated('g1'), await generated('g2'), await generated('g3')];
        for (const [index, note] of gen.entries()) {
            await archive(note);
            await db.run('UPDATE kg_nodes SET archivedAt = @at WHERE id = @id', { id: note.id, at: `2026-01-0${index + 1} 00:00:00` });
        }
        await kg.pruneScope(scope, scopeKey);
        expect(await labels(true)).toEqual(['Mine', 'g2', 'g3']);
    });
});
