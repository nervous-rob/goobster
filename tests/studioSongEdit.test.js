/**
 * Song Studio editing helpers (apps/web/src/music-lab/lib/songEdit.cjs):
 * undo history coalescing, clip splitting, track ordering, the song file
 * format round trip, and the transport clock. Pure functions, no DOM.
 */
'use strict';

const {
    SONG_FILE_FORMAT,
    SONG_FILE_VERSION,
    createHistory,
    recordHistory,
    undoHistory,
    redoHistory,
    splitClipAt,
    mergeAdjacentClips,
    moveTrack,
    duplicateTrack,
    songDurationSeconds,
    elapsedSeconds,
    formatClock,
    serializeSongProject,
    parseSongProjectFile,
    songFileName
} = require('../apps/web/src/music-lab/lib/songEdit.cjs');

let counter = 0;
const makeId = (prefix) => `${prefix}-${++counter}`;

function chord(root = 'C') {
    return { root, quality: 'major', extension: 'none', inversion: 0, voicing: 'closed', register: 'mid' };
}

function track(id, role, extra = {}) {
    return {
        id,
        name: `${role} track`,
        role,
        performer: { id, role, enabled: true, mute: false, volume: -8, ...extra },
        mute: false,
        solo: false,
        volume: -8
    };
}

function project() {
    return {
        id: 'song-1',
        name: 'Test Song',
        bpm: 120,
        swing: 0.1,
        keyRoot: 'D',
        rhythmId: '4-4',
        resolution: 'eighth',
        fills: { frequency: 'section', length: 'long' },
        sections: [
            { id: 'sec-a', kind: 'verse', name: 'Verse', measures: 8, chords: [chord('D'), chord('G')], measuresPerChord: 2 },
            { id: 'sec-b', kind: 'chorus', name: 'Chorus', measures: 8, chords: [chord('A')], measuresPerChord: 1 }
        ],
        tracks: [
            track('t-kick', 'kick', { drumSteps: [true, false, true, false, true, false, true, false] }),
            track('t-bass', 'bass', { voiceId: 'soft-brass', contourId: 'root-anchor', octaveShift: 0 }),
            track('t-lead', 'melody', {
                voiceId: 'glass-pad',
                melodyMode: 'written',
                writtenNotes: [{ id: 'wn-1', measure: 0, sub: 0, pitch: 4, durSubs: 2 }]
            })
        ],
        clips: [
            { id: 'c-1', trackId: 't-kick', startMeasure: 0, lengthMeasures: 16 },
            { id: 'c-2', trackId: 't-bass', startMeasure: 8, lengthMeasures: 8 },
            { id: 'c-3', trackId: 't-lead', startMeasure: 4, lengthMeasures: 4 }
        ],
        masterVolume: -2,
        reverbWet: 0.28
    };
}

describe('undo history', () => {
    test('records snapshots, undoes and redoes in order', () => {
        let h = createHistory(10);
        h = recordHistory(h, 'v0', 1000);
        h = recordHistory(h, 'v1', 5000);
        expect(h.past).toEqual(['v0', 'v1']);

        const u1 = undoHistory(h, 'v2');
        expect(u1.snapshot).toBe('v1');
        expect(u1.history.future).toEqual(['v2']);

        const u2 = undoHistory(u1.history, 'v1');
        expect(u2.snapshot).toBe('v0');
        expect(undoHistory(u2.history, 'v0')).toBeNull();

        const r1 = redoHistory(u2.history, 'v0');
        expect(r1.snapshot).toBe('v1');
        expect(r1.history.past).toEqual(['v0']);
        expect(r1.history.future).toEqual(['v2']);
    });

    test('coalesces a burst of edits into one snapshot and clears redo on new edits', () => {
        let h = createHistory(10);
        h = recordHistory(h, 'before-drag', 1000);
        h = recordHistory(h, 'mid-drag-1', 1200);
        h = recordHistory(h, 'mid-drag-2', 1500);
        expect(h.past).toEqual(['before-drag']);

        // A pause ends the burst.
        h = recordHistory(h, 'after-pause', 2500);
        expect(h.past).toEqual(['before-drag', 'after-pause']);

        const undone = undoHistory(h, 'current');
        expect(undone.history.future).toEqual(['current']);
        // Editing after an undo always records (lastPushAt reset) and drops the redo branch.
        const branched = recordHistory(undone.history, 'branch-point', 2600);
        expect(branched.future).toEqual([]);
        expect(branched.past).toEqual(['before-drag', 'branch-point']);
    });

    test('drops the oldest snapshots past the limit', () => {
        let h = createHistory(3);
        for (let i = 0; i < 6; i++) h = recordHistory(h, `v${i}`, i * 10_000);
        expect(h.past).toEqual(['v3', 'v4', 'v5']);
    });
});

describe('clips', () => {
    test('splitClipAt cuts a clip into two contiguous halves', () => {
        const clips = project().clips;
        const next = splitClipAt(clips, 'c-1', 6, makeId);
        const kick = next.filter(c => c.trackId === 't-kick');
        expect(kick).toHaveLength(2);
        expect(kick[0]).toMatchObject({ id: 'c-1', startMeasure: 0, lengthMeasures: 6 });
        expect(kick[1]).toMatchObject({ trackId: 't-kick', startMeasure: 6, lengthMeasures: 10 });
        expect(kick[1].id).not.toBe('c-1');
        // Other tracks untouched, order preserved.
        expect(next.map(c => c.trackId)).toEqual(['t-kick', 't-kick', 't-bass', 't-lead']);
    });

    test('splitClipAt is a no-op on the first bar, past the end, or for unknown clips', () => {
        const clips = project().clips;
        expect(splitClipAt(clips, 'c-2', 8, makeId)).toBe(clips);
        expect(splitClipAt(clips, 'c-2', 16, makeId)).toBe(clips);
        expect(splitClipAt(clips, 'c-2', 3, makeId)).toBe(clips);
        expect(splitClipAt(clips, 'nope', 10, makeId)).toBe(clips);
    });

    test('mergeAdjacentClips joins touching and overlapping clips on one track only', () => {
        const clips = [
            { id: 'a', trackId: 't1', startMeasure: 0, lengthMeasures: 4 },
            { id: 'b', trackId: 't1', startMeasure: 4, lengthMeasures: 4 },
            { id: 'c', trackId: 't1', startMeasure: 6, lengthMeasures: 6 },
            { id: 'd', trackId: 't1', startMeasure: 14, lengthMeasures: 2 },
            { id: 'e', trackId: 't2', startMeasure: 4, lengthMeasures: 4 }
        ];
        const merged = mergeAdjacentClips(clips, 't1');
        const t1 = merged.filter(c => c.trackId === 't1');
        expect(t1).toEqual([
            { id: 'a', trackId: 't1', startMeasure: 0, lengthMeasures: 12 },
            { id: 'd', trackId: 't1', startMeasure: 14, lengthMeasures: 2 }
        ]);
        expect(merged.find(c => c.id === 'e')).toEqual(clips[4]);
        expect(mergeAdjacentClips(clips, 't2')).toBe(clips);
    });
});

describe('tracks', () => {
    test('moveTrack reorders and refuses to move past either end', () => {
        const tracks = project().tracks;
        expect(moveTrack(tracks, 't-bass', -1).map(t => t.id)).toEqual(['t-bass', 't-kick', 't-lead']);
        expect(moveTrack(tracks, 't-bass', 1).map(t => t.id)).toEqual(['t-kick', 't-lead', 't-bass']);
        expect(moveTrack(tracks, 't-kick', -1)).toBe(tracks);
        expect(moveTrack(tracks, 't-lead', 1)).toBe(tracks);
        expect(moveTrack(tracks, 'missing', 1)).toBe(tracks);
    });

    test('duplicateTrack clones the track, its performer, and its clips beneath the original', () => {
        const next = duplicateTrack(project(), 't-lead', makeId);
        expect(next.tracks.map(t => t.role)).toEqual(['kick', 'bass', 'melody', 'melody']);
        const clone = next.tracks[3];
        expect(clone.id).not.toBe('t-lead');
        expect(clone.name).toBe('melody track (copy)');
        expect(clone.performer.id).toBe(clone.id);
        expect(clone.performer.writtenNotes).toHaveLength(1);
        expect(clone.performer.writtenNotes[0].id).not.toBe('wn-1');
        expect(clone.performer.writtenNotes[0].pitch).toBe(4);
        const cloneClips = next.clips.filter(c => c.trackId === clone.id);
        expect(cloneClips).toEqual([expect.objectContaining({ startMeasure: 4, lengthMeasures: 4 })]);
        // The source's clips are still there.
        expect(next.clips.filter(c => c.trackId === 't-lead')).toHaveLength(1);
    });
});

describe('transport clock', () => {
    test('song length follows measures, grid, tempo, and resolution', () => {
        // 16 bars of 4/4 eighths at 120 BPM = 16 × 2 s = 32 s.
        expect(songDurationSeconds({ totalMeasures: 16, subdivisions: 8, bpm: 120, resolution: 'eighth' })).toBeCloseTo(32);
        // Same song on a sixteenth grid has 16 steps per bar of half the length.
        expect(songDurationSeconds({ totalMeasures: 16, subdivisions: 16, bpm: 120, resolution: 'sixteenth' })).toBeCloseTo(32);
        expect(elapsedSeconds({ measure: 4, sub: 4, subdivisions: 8, bpm: 120, resolution: 'eighth' })).toBeCloseTo(9);
    });

    test('formatClock renders m:ss and tolerates garbage', () => {
        expect(formatClock(0)).toBe('0:00');
        expect(formatClock(9.9)).toBe('0:09');
        expect(formatClock(125)).toBe('2:05');
        expect(formatClock(NaN)).toBe('0:00');
        expect(formatClock(-3)).toBe('0:00');
    });
});

describe('song files', () => {
    test('round-trips a project through export and import with a fresh id', () => {
        const source = project();
        const text = serializeSongProject(source, '2026-01-01T00:00:00.000Z');
        const envelope = JSON.parse(text);
        expect(envelope).toMatchObject({ format: SONG_FILE_FORMAT, version: SONG_FILE_VERSION });

        const parsed = parseSongProjectFile(text, makeId);
        expect(parsed.ok).toBe(true);
        const p = parsed.project;
        expect(p.id).not.toBe(source.id);
        expect(p).toMatchObject({
            name: 'Test Song',
            bpm: 120,
            swing: 0.1,
            keyRoot: 'D',
            rhythmId: '4-4',
            resolution: 'eighth',
            fills: { frequency: 'section', length: 'long' },
            masterVolume: -2,
            reverbWet: 0.28
        });
        expect(p.sections.map(s => s.id)).toEqual(['sec-a', 'sec-b']);
        expect(p.sections[0].chords).toEqual(source.sections[0].chords);
        expect(p.tracks.map(t => t.id)).toEqual(['t-kick', 't-bass', 't-lead']);
        expect(p.tracks[0].performer.drumSteps).toEqual(source.tracks[0].performer.drumSteps);
        expect(p.tracks[2].performer.writtenNotes).toEqual(source.tracks[2].performer.writtenNotes);
        expect(p.clips.map(c => [c.trackId, c.startMeasure, c.lengthMeasures])).toEqual([
            ['t-kick', 0, 16],
            ['t-bass', 8, 8],
            ['t-lead', 4, 4]
        ]);
    });

    test('accepts a bare project object and clamps hostile values', () => {
        const hostile = {
            ...project(),
            name: 'x'.repeat(200),
            bpm: 9999,
            swing: -4,
            keyRoot: 'H',
            masterVolume: 40,
            reverbWet: 3,
            tracks: [
                track('t-kick', 'kick'),
                { id: 'evil', role: 'laser', name: 'nope' },
                track('t-lead', 'melody', { octaveShift: 12, voicingOverride: 'nonsense', registerOverride: 'high' })
            ],
            clips: [
                { id: 'c-1', trackId: 't-kick', startMeasure: -5, lengthMeasures: 400 },
                { id: 'c-2', trackId: 'missing-track', startMeasure: 0, lengthMeasures: 4 },
                { id: 'c-3', trackId: 't-lead', startMeasure: 15, lengthMeasures: 10 },
                'garbage'
            ],
            sections: [
                { id: 's', kind: 'verse', name: 'V', measures: 99, chords: [chord('E'), { root: 'Z' }], measuresPerChord: 3 },
                { id: 's2', kind: 'nonsense', measures: 4, chords: [{ root: 'F', quality: 'weird', voicing: 'huh' }], measuresPerChord: 2 }
            ],
            extraField: { nested: true }
        };
        const parsed = parseSongProjectFile(JSON.stringify(hostile), makeId);
        expect(parsed.ok).toBe(true);
        const p = parsed.project;
        expect(p.name).toHaveLength(40);
        expect(p.bpm).toBe(200);
        expect(p.swing).toBe(0);
        expect(p.keyRoot).toBe('C');
        expect(p.masterVolume).toBe(0);
        expect(p.reverbWet).toBe(0.6);
        expect(p.extraField).toBeUndefined();

        expect(p.sections[0]).toMatchObject({ measures: 16, measuresPerChord: 1 });
        expect(p.sections[0].chords).toHaveLength(1);
        expect(p.sections[1]).toMatchObject({ kind: 'custom', name: 'Section', measuresPerChord: 2 });
        expect(p.sections[1].chords[0]).toMatchObject({ root: 'F', quality: 'major', voicing: 'closed' });

        expect(p.tracks.map(t => t.role)).toEqual(['kick', 'melody']);
        expect(p.tracks[1].performer.octaveShift).toBe(2);
        expect(p.tracks[1].performer.voicingOverride).toBeUndefined();
        expect(p.tracks[1].performer.registerOverride).toBe('high');

        // 16 + 4 = 20 measures: the kick clip is clamped to the song, the
        // orphan is dropped, the lead clip is trimmed to the end.
        expect(p.clips).toEqual([
            expect.objectContaining({ trackId: 't-kick', startMeasure: 0, lengthMeasures: 20 }),
            expect.objectContaining({ trackId: 't-lead', startMeasure: 15, lengthMeasures: 5 })
        ]);
    });

    test('dedupes colliding section and track ids', () => {
        const p = project();
        p.sections[1].id = 'sec-a';
        p.tracks[1].id = 't-kick';
        p.tracks[1].performer.id = 't-kick';
        const parsed = parseSongProjectFile(JSON.stringify(p), makeId);
        expect(parsed.ok).toBe(true);
        const sectionIds = parsed.project.sections.map(s => s.id);
        expect(new Set(sectionIds).size).toBe(2);
        const trackIds = parsed.project.tracks.map(t => t.id);
        expect(new Set(trackIds).size).toBe(3);
        parsed.project.tracks.forEach(t => expect(t.performer.id).toBe(t.id));
    });

    test('rejects non-JSON, non-song shapes, empty songs, and newer file versions', () => {
        expect(parseSongProjectFile('{not json', makeId)).toEqual({ ok: false, error: expect.stringMatching(/JSON/) });
        expect(parseSongProjectFile('[1,2,3]', makeId).ok).toBe(false);
        expect(parseSongProjectFile(JSON.stringify({ name: 'x' }), makeId).ok).toBe(false);
        expect(parseSongProjectFile(JSON.stringify({ ...project(), sections: [] }), makeId)).toEqual({
            ok: false,
            error: expect.stringMatching(/sections/)
        });
        expect(parseSongProjectFile(JSON.stringify({ ...project(), sections: [{ chords: [] }] }), makeId).ok).toBe(false);
        const future = { format: SONG_FILE_FORMAT, version: SONG_FILE_VERSION + 1, project: project() };
        expect(parseSongProjectFile(JSON.stringify(future), makeId)).toEqual({
            ok: false,
            error: expect.stringMatching(/newer/)
        });
    });

    test('songFileName strips characters that are unsafe on disk', () => {
        expect(songFileName('My Song: Take 2?', 'json')).toBe('My Song Take 2.json');
        expect(songFileName('///', 'wav')).toBe('song.wav');
        expect(songFileName('', 'json')).toBe('song.json');
    });
});
