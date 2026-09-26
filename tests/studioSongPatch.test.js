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
        expect(patch.tracks.upsert.map(t => t.id)).toEqual(['t2', 't3']);
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
