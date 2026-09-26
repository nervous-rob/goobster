/**
 * Pure Song Studio editing helpers: undo history, clip surgery, track
 * ordering, the song file format, and transport clock math. No DOM, no
 * Tone.js, no React — CommonJS so Jest can require() it while Vite interops
 * the same file behind the `songEdit.ts` façade.
 */

const SONG_FILE_FORMAT = 'goobster-studio-song';
const SONG_FILE_VERSION = 1;

const ROLES = ['kick', 'snare', 'hihat', 'chords', 'bass', 'melody'];
const SECTION_KINDS = ['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'outro', 'custom'];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const LIMITS = {
    bpm: [40, 200],
    swing: [0, 0.5],
    sectionMeasures: [1, 16],
    sectionChords: [1, 8],
    volume: [-24, 0],
    masterVolume: [-24, 0],
    reverbWet: [0, 0.6],
    maxSections: 64,
    maxTracks: 32,
    maxClips: 2048,
    maxNameLength: 40
};

// --- Undo / redo ------------------------------------------------------------

/**
 * A bounded snapshot stack. `recordHistory` is called with the state *before*
 * an edit; edits that land within `coalesceMs` of each other (slider drags,
 * step-grid painting) collapse into the first snapshot so one undo reverts
 * the whole gesture.
 */
function createHistory(limit = 100) {
    return { past: [], future: [], lastPushAt: 0, limit };
}

function recordHistory(history, snapshot, now, coalesceMs = 600) {
    const withinBurst = history.past.length > 0 && now - history.lastPushAt < coalesceMs;
    if (withinBurst) {
        return { ...history, future: [], lastPushAt: now };
    }
    const past = [...history.past, snapshot];
    if (past.length > history.limit) past.splice(0, past.length - history.limit);
    return { ...history, past, future: [], lastPushAt: now };
}

/** Returns `{ history, snapshot }` to restore, or null when nothing to undo. */
function undoHistory(history, current) {
    if (!history.past.length) return null;
    const past = history.past.slice(0, -1);
    const snapshot = history.past[history.past.length - 1];
    return {
        history: { ...history, past, future: [...history.future, current], lastPushAt: 0 },
        snapshot
    };
}

function redoHistory(history, current) {
    if (!history.future.length) return null;
    const future = history.future.slice(0, -1);
    const snapshot = history.future[history.future.length - 1];
    return {
        history: { ...history, past: [...history.past, current], future, lastPushAt: 0 },
        snapshot
    };
}

// --- Clips -----------------------------------------------------------------

/**
 * Splits a clip at an absolute measure boundary. A cut outside the clip, or
 * on its first measure, is a no-op and returns the same array instance.
 */
function splitClipAt(clips, clipId, measure, makeId) {
    const index = clips.findIndex(c => c.id === clipId);
    if (index < 0) return clips;
    const clip = clips[index];
    const cut = Math.round(measure);
    if (cut <= clip.startMeasure || cut >= clip.startMeasure + clip.lengthMeasures) return clips;
    const left = { ...clip, lengthMeasures: cut - clip.startMeasure };
    const right = {
        ...clip,
        id: makeId('clip'),
        startMeasure: cut,
        lengthMeasures: clip.startMeasure + clip.lengthMeasures - cut
    };
    const next = [...clips];
    next.splice(index, 1, left, right);
    return next;
}

/** Merges a track's clips where one ends exactly where the next begins. */
function mergeAdjacentClips(clips, trackId) {
    const mine = clips.filter(c => c.trackId === trackId).sort((a, b) => a.startMeasure - b.startMeasure);
    if (mine.length < 2) return clips;
    const merged = [];
    mine.forEach(clip => {
        const last = merged[merged.length - 1];
        if (last && last.startMeasure + last.lengthMeasures >= clip.startMeasure) {
            const end = Math.max(last.startMeasure + last.lengthMeasures, clip.startMeasure + clip.lengthMeasures);
            merged[merged.length - 1] = { ...last, lengthMeasures: end - last.startMeasure };
        } else {
            merged.push({ ...clip });
        }
    });
    if (merged.length === mine.length) return clips;
    return [...clips.filter(c => c.trackId !== trackId), ...merged];
}

// --- Tracks ----------------------------------------------------------------

function moveTrack(tracks, trackId, direction) {
    const index = tracks.findIndex(t => t.id === trackId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= tracks.length) return tracks;
    const next = [...tracks];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    return next;
}

/** Clones a track (and its clips) directly beneath the original. */
function duplicateTrack(project, trackId, makeId) {
    const index = project.tracks.findIndex(t => t.id === trackId);
    if (index < 0) return project;
    const source = project.tracks[index];
    const id = makeId(`track-${source.role}`);
    const name = `${source.name} (copy)`.slice(0, LIMITS.maxNameLength);
    const clone = {
        ...source,
        id,
        name,
        solo: false,
        performer: {
            ...source.performer,
            id,
            displayName: source.performer.displayName ? name : undefined,
            writtenNotes: source.performer.writtenNotes
                ? source.performer.writtenNotes.map(n => ({ ...n, id: makeId('wn') }))
                : undefined,
            drumSteps: source.performer.drumSteps ? [...source.performer.drumSteps] : undefined
        }
    };
    const tracks = [...project.tracks];
    tracks.splice(index + 1, 0, clone);
    const clips = [
        ...project.clips,
        ...project.clips.filter(c => c.trackId === trackId).map(c => ({ ...c, id: makeId('clip'), trackId: id }))
    ];
    return { ...project, tracks, clips };
}

// --- Transport clock -------------------------------------------------------

/** Seconds per grid step: eighths are half a beat, sixteenths a quarter. */
function stepSeconds(bpm, resolution) {
    const perBeat = 60 / Math.max(1, bpm);
    return resolution === 'sixteenth' ? perBeat / 4 : perBeat / 2;
}

function songDurationSeconds({ totalMeasures, subdivisions, bpm, resolution }) {
    return Math.max(0, totalMeasures) * Math.max(1, subdivisions) * stepSeconds(bpm, resolution);
}

function elapsedSeconds({ measure, sub, subdivisions, bpm, resolution }) {
    return (measure * Math.max(1, subdivisions) + sub) * stepSeconds(bpm, resolution);
}

/** m:ss, with hours folded into minutes (a song is never that long). */
function formatClock(seconds) {
    const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    const minutes = Math.floor(whole / 60);
    const secs = whole % 60;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

// --- Song files ------------------------------------------------------------

function serializeSongProject(project, exportedAt = new Date().toISOString()) {
    return JSON.stringify({ format: SONG_FILE_FORMAT, version: SONG_FILE_VERSION, exportedAt, project }, null, 2);
}

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function num(value, [min, max], fallback) {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, n));
}

function int(value, range, fallback) {
    return Math.round(num(value, range, fallback));
}

function str(value, fallback, max = 80) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

const CHORD_QUALITIES = ['major', 'minor', 'diminished', 'augmented', 'sus2', 'sus4'];
const CHORD_EXTENSIONS = ['none', '6', '7', 'maj7', '9', 'dim7'];
const CHORD_VOICINGS = ['closed', 'open', 'drop2', 'spread', 'cluster'];
const REGISTERS = ['low', 'mid', 'high'];

function sanitizeChord(raw) {
    if (!isRecord(raw)) return null;
    if (!NOTE_NAMES.includes(raw.root)) return null;
    return {
        root: raw.root,
        quality: CHORD_QUALITIES.includes(raw.quality) ? raw.quality : 'major',
        extension: CHORD_EXTENSIONS.includes(raw.extension) ? raw.extension : 'none',
        inversion: int(raw.inversion, [0, 4], 0),
        voicing: CHORD_VOICINGS.includes(raw.voicing) ? raw.voicing : 'closed',
        register: REGISTERS.includes(raw.register) ? raw.register : 'mid'
    };
}

function sanitizeSection(raw, makeId) {
    if (!isRecord(raw)) return null;
    const chords = Array.isArray(raw.chords) ? raw.chords.map(sanitizeChord).filter(Boolean) : [];
    if (!chords.length) return null;
    const kind = SECTION_KINDS.includes(raw.kind) ? raw.kind : 'custom';
    return {
        id: str(raw.id, makeId('section'), 64),
        kind,
        name: str(raw.name, kind === 'custom' ? 'Section' : kind[0].toUpperCase() + kind.slice(1), 24),
        measures: int(raw.measures, LIMITS.sectionMeasures, 8),
        chords: chords.slice(0, LIMITS.sectionChords[1]),
        measuresPerChord: [1, 2, 4].includes(raw.measuresPerChord) ? raw.measuresPerChord : 1
    };
}

function sanitizePerformer(raw, role, id) {
    const p = isRecord(raw) ? raw : {};
    const out = {
        id,
        role,
        enabled: true,
        mute: false,
        volume: num(p.volume, LIMITS.volume, -8)
    };
    if (typeof p.displayName === 'string' && p.displayName.trim()) out.displayName = p.displayName.trim().slice(0, 28);
    if (typeof p.voiceId === 'string') out.voiceId = p.voiceId.slice(0, 64);
    if (Array.isArray(p.drumSteps)) out.drumSteps = p.drumSteps.slice(0, 64).map(Boolean);
    if (typeof p.contourId === 'string') out.contourId = p.contourId.slice(0, 64);
    if (typeof p.octaveShift === 'number') out.octaveShift = int(p.octaveShift, [-2, 2], 0);
    if (p.melodyMode === 'written' || p.melodyMode === 'contour') out.melodyMode = p.melodyMode;
    if (Array.isArray(p.writtenNotes)) {
        out.writtenNotes = p.writtenNotes
            .filter(isRecord)
            .slice(0, 4096)
            .map((n, i) => ({
                id: str(n.id, `wn-import-${i}`, 64),
                measure: int(n.measure, [0, 4096], 0),
                sub: int(n.sub, [0, 64], 0),
                pitch: int(n.pitch, [-48, 48], 0),
                durSubs: int(n.durSubs, [1, 64], 1)
            }));
    }
    if (p.harmonyMode === 'follow' || p.harmonyMode === 'own') out.harmonyMode = p.harmonyMode;
    if (Array.isArray(p.customChords)) out.customChords = p.customChords.map(sanitizeChord).filter(Boolean);
    if (CHORD_VOICINGS.includes(p.voicingOverride)) out.voicingOverride = p.voicingOverride;
    if (REGISTERS.includes(p.registerOverride)) out.registerOverride = p.registerOverride;
    return out;
}

function sanitizeTrack(raw, makeId) {
    if (!isRecord(raw) || !ROLES.includes(raw.role)) return null;
    const id = str(raw.id, makeId(`track-${raw.role}`), 64);
    return {
        id,
        name: str(raw.name, raw.role, 28),
        role: raw.role,
        performer: sanitizePerformer(raw.performer, raw.role, id),
        mute: Boolean(raw.mute),
        solo: Boolean(raw.solo),
        volume: num(raw.volume, LIMITS.volume, -8)
    };
}

/**
 * Parses a song file (or a bare project object) into a SongProject the
 * Studio can trust. Unknown fields are dropped, numbers are clamped, clips
 * that point at missing tracks or fall outside the song are removed, and
 * the project gets a fresh id so importing never clobbers an existing song.
 */
function parseSongProjectFile(text, makeId) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, error: 'That file is not valid JSON.' };
    }
    let project = raw;
    if (isRecord(raw) && raw.format === SONG_FILE_FORMAT) {
        if (typeof raw.version === 'number' && raw.version > SONG_FILE_VERSION) {
            return { ok: false, error: `This song was exported by a newer Studio (file version ${raw.version}).` };
        }
        project = raw.project;
    }
    if (!isRecord(project) || !Array.isArray(project.sections) || !Array.isArray(project.tracks)) {
        return { ok: false, error: 'That file does not look like a Song Studio export.' };
    }

    const sections = project.sections.slice(0, LIMITS.maxSections).map(s => sanitizeSection(s, makeId)).filter(Boolean);
    if (!sections.length) return { ok: false, error: 'The song has no playable sections.' };
    const usedSectionIds = new Set();
    sections.forEach(s => {
        while (usedSectionIds.has(s.id)) s.id = makeId('section');
        usedSectionIds.add(s.id);
    });

    const tracks = project.tracks.slice(0, LIMITS.maxTracks).map(t => sanitizeTrack(t, makeId)).filter(Boolean);
    const usedTrackIds = new Set();
    tracks.forEach(t => {
        while (usedTrackIds.has(t.id)) {
            t.id = makeId(`track-${t.role}`);
            t.performer.id = t.id;
        }
        usedTrackIds.add(t.id);
    });

    const totalMeasures = sections.reduce((a, s) => a + s.measures, 0);
    const clips = (Array.isArray(project.clips) ? project.clips : [])
        .slice(0, LIMITS.maxClips)
        .filter(c => isRecord(c) && usedTrackIds.has(c.trackId))
        .map(c => {
            const start = int(c.startMeasure, [0, Math.max(0, totalMeasures - 1)], 0);
            const length = int(c.lengthMeasures, [1, Math.max(1, totalMeasures - start)], 1);
            return { id: makeId('clip'), trackId: c.trackId, startMeasure: start, lengthMeasures: length };
        })
        .filter(c => c.startMeasure < totalMeasures);

    let fills;
    if (isRecord(project.fills) && ['section', 'every4', 'every8'].includes(project.fills.frequency)) {
        fills = { frequency: project.fills.frequency, length: project.fills.length === 'long' ? 'long' : 'short' };
    }

    return {
        ok: true,
        project: {
            id: makeId('song'),
            name: str(project.name, 'Imported song', LIMITS.maxNameLength),
            bpm: int(project.bpm, LIMITS.bpm, 100),
            swing: num(project.swing, LIMITS.swing, 0),
            keyRoot: NOTE_NAMES.includes(project.keyRoot) ? project.keyRoot : 'C',
            rhythmId: str(project.rhythmId, '4-4', 64),
            resolution: project.resolution === 'sixteenth' ? 'sixteenth' : 'eighth',
            grooveId: typeof project.grooveId === 'string' ? project.grooveId.slice(0, 64) : undefined,
            fills,
            sections,
            tracks,
            clips,
            masterVolume: int(project.masterVolume, LIMITS.masterVolume, -2),
            reverbWet: num(project.reverbWet, LIMITS.reverbWet, 0.28)
        }
    };
}

/** Filesystem-safe download name for a song. */
function songFileName(name, extension) {
    const base = String(name || 'song').replace(/[\\/:*?"<>|]+/g, '').trim() || 'song';
    return `${base}.${extension}`;
}

module.exports = {
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
    stepSeconds,
    songDurationSeconds,
    elapsedSeconds,
    formatClock,
    serializeSongProject,
    parseSongProjectFile,
    songFileName
};
