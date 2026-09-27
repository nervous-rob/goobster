/**
 * Id-keyed song patches: the server helper (packages/core/utils/songPatch.js)
 * and its browser mirror (apps/web/src/music-lab/lib/songPatch.cjs) must
 * diff and apply identically, converge under concurrent edits, and shrug
 * off malformed input.
 */

const server = require('@goobster/core/utils/songPatch');
const browser = require('../apps/web/src/music-lab/lib/songPatch.cjs');

function project(overrides = {}) {
    return {
        id: 'song-1',
        name: 'Demo',
        bpm: 100,
        swing: 0,
        keyRoot: 'C',
        rhythmId: '4-4',
        resolution: 'eighth',
        sections: [
            { id: 's1', kind: 'verse', name: 'Verse', measures: 8, chords: [{ root: 'C', quality: 'major' }], measuresPerChord: 1 },
            { id: 's2', kind: 'chorus', name: 'Chorus', measures: 8, chords: [{ root: 'F', quality: 'major' }], measuresPerChord: 1 }
        ],
        tracks: [
            { id: 't1', name: 'Kick', role: 'kick', performer: { id: 't1', role: 'kick', enabled: true, mute: false, volume: -2 }, mute: false, solo: false, volume: -2 },
            { id: 't2', name: 'Lead', role: 'melody', performer: { id: 't2', role: 'melody', enabled: true, mute: false, volume: -8 }, mute: false, solo: false, volume: -8 }
        ],
        clips: [
            { id: 'c1', trackId: 't1', startMeasure: 0, lengthMeasures: 16 },
            { id: 'c2', trackId: 't2', startMeasure: 8, lengthMeasures: 8 }
        ],
        masterVolume: -2,
        reverbWet: 0.28,
        ...overrides
    };
}

describe.each([
    ['server', server],
    ['browser', browser]
])('songPatch (%s)', (_label, { diffProject, applyPatch, isEmptyPatch }) => {
    test('identical projects produce no patch', () => {
        const a = project();
        expect(diffProject(a, { ...a })).toBeNull();
        expect(diffProject(a, a)).toBeNull();
    });

    test('settings diff carries only changed keys and nulls a removed one', () => {
        const before = project({ grooveId: 'funk' });
        const after = { ...before, bpm: 120, grooveId: undefined };
        const patch = diffProject(before, after);
        expect(patch).toEqual({ settings: { bpm: 120, grooveId: null } });
        const applied = applyPatch(before, patch);
        expect(applied.bpm).toBe(120);
        expect('grooveId' in applied).toBe(false);
        expect(applied.sections).toBe(before.sections);
    });

    test('collection diff upserts changed entities, removes missing ones and sends order for new ones', () => {
        const before = project();
        const after = {
            ...before,
            tracks: [
                { ...before.tracks[1], volume: -3 },
                { id: 't3', name: 'Bass', role: 'bass', performer: { id: 't3', role: 'bass', enabled: true, mute: false, volume: -6 }, mute: false, solo: false, volume: -6 }
            ],
            clips: [before.clips[1], { id: 'c3', trackId: 't3', startMeasure: 0, lengthMeasures: 4 }]
        };
        const patch = diffProject(before, after);
        expect(patch.tracks.remove).toEqual(['t1']);
        // t2 already exists on both sides, so its change is a field edit.
        expect(patch.tracks.edit).toEqual([{ id: 't2', set: { volume: -3 } }]);
        expect(patch.tracks.upsert.map(t => t.id)).toEqual(['t3']);
        expect(patch.tracks.order).toEqual(['t2', 't3']);
        expect(patch.clips.remove).toEqual(['c1']);
        expect(patch.clips.upsert.map(c => c.id)).toEqual(['c3']);
        expect(patch.clips.order).toBeUndefined();
        expect(applyPatch(before, patch)).toEqual(after);
    });

    test('reordering alone produces just an order list', () => {
        const before = project();
        const after = { ...before, sections: [before.sections[1], before.sections[0]] };
        const patch = diffProject(before, after);
        expect(patch).toEqual({ sections: { order: ['s2', 's1'] } });
        expect(applyPatch(before, patch).sections.map(s => s.id)).toEqual(['s2', 's1']);
    });

    test('removing a track prunes its clips even when the patch forgot them', () => {
        const before = project();
        const applied = applyPatch(before, { tracks: { remove: ['t2'] } });
        expect(applied.tracks.map(t => t.id)).toEqual(['t1']);
        expect(applied.clips.map(c => c.id)).toEqual(['c1']);
    });

    test('malformed entries are ignored and unknown keys dropped', () => {
        const before = project();
        const applied = applyPatch(before, {
            settings: { bpm: 90, evil: 'x' },
            tracks: { upsert: [null, 'nope', { name: 'no id' }, { id: 't1', name: 'Kick 2', role: 'kick', performer: {}, mute: false, solo: false, volume: -1 }] },
            clips: { order: ['c2', 'c1'] },
            bogus: { upsert: [{ id: 'z' }] }
        });
        expect(applied.bpm).toBe(90);
        expect(applied.evil).toBeUndefined();
        expect(applied.bogus).toBeUndefined();
        expect(applied.tracks[0].name).toBe('Kick 2');
        expect(applied.tracks).toHaveLength(2);
        expect(applied.clips.map(c => c.id)).toEqual(['c1', 'c2']);
        expect(applyPatch(before, null)).toBe(before);
    });

    test('isEmptyPatch', () => {
        expect(isEmptyPatch(null)).toBe(true);
        expect(isEmptyPatch({})).toBe(true);
        expect(isEmptyPatch({ settings: {} })).toBe(true);
        expect(isEmptyPatch({ tracks: { upsert: [] } })).toBe(true);
        expect(isEmptyPatch({ settings: { bpm: 1 } })).toBe(false);
        expect(isEmptyPatch({ clips: { remove: ['c1'] } })).toBe(false);
    });

    test('two peers converge when their patches are applied in the same order', () => {
        const base = project();
        const editA = { ...base, tracks: base.tracks.map(t => (t.id === 't1' ? { ...t, volume: -5 } : t)) };
        const editB = { ...base, tracks: base.tracks.map(t => (t.id === 't1' ? { ...t, volume: -10 } : t)), bpm: 130 };
        const patchA = diffProject(base, editA);
        const patchB = diffProject(base, editB);
        // Server accepted A then B; each peer replays the stream on top of
        // its own local edit and re-applies its echo.
        const serverState = applyPatch(applyPatch(base, patchA), patchB);
        const peerA = applyPatch(applyPatch(editA, patchA), patchB);
        const peerB = applyPatch(applyPatch(editB, patchA), patchB);
        expect(peerA).toEqual(serverState);
        expect(peerB).toEqual(serverState);
        expect(serverState.tracks[0].volume).toBe(-10);
        expect(serverState.bpm).toBe(130);
    });

    // --- Field-level track edits -------------------------------------------

    function withLead(notes, extra = {}) {
        const base = project();
        return {
            ...base,
            tracks: base.tracks.map(t => (t.id === 't2'
                ? { ...t, performer: { ...t.performer, melodyMode: 'written', writtenNotes: notes, ...extra } }
                : t))
        };
    }
    const note = (id, measure, sub, pitch = 0, durSubs = 1) => ({ id, measure, sub, pitch, durSubs });
    const lead = p => p.tracks.find(t => t.id === 't2');
    const kick = p => p.tracks.find(t => t.id === 't1');

    test('a changed existing track travels as a field-level edit, a new track as a whole upsert', () => {
        const before = withLead([note('n1', 0, 0)]);
        const after = {
            ...before,
            tracks: before.tracks.map(t => (t.id === 't2'
                ? { ...t, name: 'Lead 2', volume: -4, performer: { ...t.performer, octaveShift: 1, writtenNotes: [note('n1', 0, 0), note('n2', 0, 4, 7)] } }
                : t))
        };
        const patch = diffProject(before, after);
        expect(patch.tracks.upsert).toBeUndefined();
        expect(patch.tracks.order).toBeUndefined();
        expect(patch.tracks.edit).toEqual([{
            id: 't2',
            set: { name: 'Lead 2', volume: -4 },
            performer: { set: { octaveShift: 1 }, notes: { upsert: [note('n2', 0, 4, 7)] } }
        }]);
        expect(applyPatch(before, patch)).toEqual(after);

        const added = { ...before, tracks: [...before.tracks, { ...before.tracks[0], id: 't3', name: 'Snare', role: 'snare' }] };
        const addPatch = diffProject(before, added);
        expect(addPatch.tracks.edit).toBeUndefined();
        expect(addPatch.tracks.upsert.map(t => t.id)).toEqual(['t3']);
        expect(addPatch.tracks.order).toEqual(['t1', 't2', 't3']);
    });

    test('notes written by two people on the same track both survive', () => {
        const base = withLead([note('n1', 0, 0)]);
        const editA = withLead([note('n1', 0, 0), note('a1', 1, 0, 4)]);
        const editB = withLead([note('n1', 0, 0), note('b1', 2, 2, 9)], { octaveShift: -1 });
        const patchA = diffProject(base, editA);
        const patchB = diffProject(base, editB);
        expect(patchA.tracks.edit[0].performer.notes).toEqual({ upsert: [note('a1', 1, 0, 4)] });

        const serverState = applyPatch(applyPatch(base, patchA), patchB);
        const peerA = applyPatch(applyPatch(editA, patchA), patchB);
        const peerB = applyPatch(applyPatch(editB, patchA), patchB);
        expect(lead(serverState).performer.writtenNotes.map(n => n.id).sort()).toEqual(['a1', 'b1', 'n1']);
        expect(lead(serverState).performer.octaveShift).toBe(-1);
        expect(peerA).toEqual(serverState);
        expect(peerB).toEqual(serverState);
    });

    test('a removed note stays removed and a resized note keeps its new length', () => {
        const base = withLead([note('n1', 0, 0), note('n2', 0, 4)]);
        const removeN1 = withLead([note('n2', 0, 4)]);
        const growN2 = withLead([note('n1', 0, 0), note('n2', 0, 4, 0, 3)]);
        const patchRemove = diffProject(base, removeN1);
        const patchGrow = diffProject(base, growN2);
        expect(patchRemove.tracks.edit[0].performer.notes).toEqual({ remove: ['n1'] });
        const merged = applyPatch(applyPatch(base, patchRemove), patchGrow);
        expect(lead(merged).performer.writtenNotes).toEqual([note('n2', 0, 4, 0, 3)]);
    });

    test('two notes landing on one step: the later accepted one keeps the lane monophonic', () => {
        const base = withLead([]);
        const a = withLead([note('a1', 3, 2, 4)]);
        const b = withLead([note('b1', 3, 2, 11)]);
        const merged = applyPatch(applyPatch(base, diffProject(base, a)), diffProject(base, b));
        expect(lead(merged).performer.writtenNotes).toEqual([note('b1', 3, 2, 11)]);
    });

    test('drum steps toggle independently, and a pattern of a new length replaces the whole grid', () => {
        const steps = n => Array.from({ length: 8 }, (_, i) => n.includes(i));
        const withKick = (pattern, extra = {}) => {
            const base = project();
            return { ...base, tracks: base.tracks.map(t => (t.id === 't1' ? { ...t, performer: { ...t.performer, drumSteps: pattern, ...extra } } : t)) };
        };
        const base = withKick(steps([0, 4]));
        const a = withKick(steps([0, 2, 4]));
        const b = withKick(steps([4]), { volume: -1 });
        const patchA = diffProject(base, a);
        const patchB = diffProject(base, b);
        expect(patchA.tracks.edit[0].performer).toEqual({ steps: { 2: true } });
        expect(patchB.tracks.edit[0].performer).toEqual({ set: { volume: -1 }, steps: { 0: false } });
        const merged = applyPatch(applyPatch(base, patchA), patchB);
        expect(kick(merged).performer.drumSteps).toEqual(steps([2, 4]));
        expect(kick(merged).performer.volume).toBe(-1);

        const longer = withKick(Array.from({ length: 16 }, (_, i) => i % 4 === 0));
        const patchLonger = diffProject(base, longer);
        expect(patchLonger.tracks.edit[0].performer.set.drumSteps).toHaveLength(16);
        expect(kick(applyPatch(base, patchLonger)).performer.drumSteps).toHaveLength(16);
    });

    test('an edit for a track somebody removed first is dropped, and malformed edits are ignored', () => {
        const base = withLead([note('n1', 0, 0)]);
        const removed = { ...base, tracks: base.tracks.filter(t => t.id !== 't2') };
        const edited = withLead([note('n1', 0, 0), note('n2', 1, 0)]);
        const merged = applyPatch(applyPatch(base, diffProject(base, removed)), diffProject(base, edited));
        expect(merged.tracks.map(t => t.id)).toEqual(['t1']);
        expect(merged.clips.map(c => c.id)).toEqual(['c1']);

        const junk = applyPatch(base, {
            tracks: { edit: [null, 'x', { id: 'nope', set: { name: 'ghost' } }, { id: 't1', set: { id: 'hijack', name: 'Boom' }, performer: { steps: { 99: true, '-1': true, x: true } } }] }
        });
        expect(junk.tracks.map(t => t.id)).toEqual(['t1', 't2']);
        expect(kick(junk).name).toBe('Boom');
        expect(kick(junk).performer.drumSteps).toBeUndefined();
    });

    test('a field-level edit counts as a non-empty patch', () => {
        expect(isEmptyPatch({ tracks: { edit: [] } })).toBe(true);
        expect(isEmptyPatch({ tracks: { edit: [{ id: 't1', set: { name: 'x' } }] } })).toBe(false);
    });
});

test('the server helper and the browser mirror agree on every fixture', () => {
    const before = project({ grooveId: 'g' });
    const after = {
        ...before,
        name: 'Renamed',
        grooveId: undefined,
        sections: [before.sections[1], { ...before.sections[0], measures: 4 }],
        tracks: [before.tracks[1]],
        clips: [{ ...before.clips[1], lengthMeasures: 4 }]
    };
    const serverPatch = server.diffProject(before, after);
    const browserPatch = browser.diffProject(before, after);
    expect(browserPatch).toEqual(serverPatch);
    expect(browser.applyPatch(before, serverPatch)).toEqual(server.applyPatch(before, browserPatch));
    expect(server.applyPatch(before, serverPatch)).toEqual(after);
});

describe('validateProjectShape (server)', () => {
    const { validateProjectShape } = server;
    test('accepts a well-formed project', () => {
        expect(validateProjectShape(project())).toBeNull();
    });
    test('rejects non-objects, missing lists, bad ids, duplicates, orphans and over-limit lists', () => {
        expect(validateProjectShape(null)).toMatch(/object/);
        expect(validateProjectShape({ ...project(), name: 5 })).toMatch(/name/);
        expect(validateProjectShape({ ...project(), clips: 'x' })).toMatch(/clips/);
        expect(validateProjectShape({ ...project(), tracks: [{ name: 'no id' }] })).toMatch(/id/);
        const dup = project();
        dup.sections = [dup.sections[0], dup.sections[0]];
        expect(validateProjectShape(dup)).toMatch(/Duplicate/);
        expect(validateProjectShape({ ...project(), clips: [{ id: 'c9', trackId: 'ghost' }] })).toMatch(/track/);
        expect(validateProjectShape(project(), { tracks: 1 })).toMatch(/Too many tracks/);
    });
});
