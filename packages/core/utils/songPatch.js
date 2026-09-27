/**
 * Id-keyed, last-writer-wins patches for Song Studio projects.
 *
 * A SongProject is a handful of scalar settings plus three id-keyed
 * collections (sections, tracks, clips). A patch says which entities were
 * upserted or removed and, for the ordered collections, the new id order.
 * Applying the same patch on every peer in the order the server accepted
 * it converges everyone on the same document without a CRDT, because each
 * entity is replaced whole.
 *
 * Tracks are the exception: two people commonly work inside the same track
 * at once (one writing notes in the piano roll while another fixes the
 * drum pattern or the level), so a changed track that already exists on
 * both sides travels as a `tracks.edit` entry instead of a whole upsert:
 *
 *   { id, set: { name, mute, volume, ... },            // field-level LWW
 *     performer: { set: { voiceId, octaveShift, ... }, // field-level LWW
 *                  notes: { upsert: [WrittenNote], remove: [id] }, // per note
 *                  steps: { "3": true, "7": false } } } // per drum step
 *
 * Every leaf is still last-writer-wins, but the leaves are small enough
 * that concurrent edits to different parts of one track both survive. The
 * written lane stays monophonic: a note landing on an occupied step evicts
 * the note that was there.
 *
 * The browser mirror is apps/web/src/music-lab/lib/songPatch.cjs; the two
 * must stay behaviourally identical (tests/studioSongPatch.test.js runs
 * both against the same fixtures). Pure JS: no DB, no Node APIs.
 */

const SETTINGS_KEYS = [
    'name', 'bpm', 'swing', 'keyRoot', 'rhythmId', 'resolution',
    'grooveId', 'fills', 'masterVolume', 'reverbWet'
];

const COLLECTIONS = [
    { key: 'sections', ordered: true },
    { key: 'tracks', ordered: true, mergeable: true },
    { key: 'clips', ordered: false }
];

/** Performer keys handled per element rather than as one value. */
const PERFORMER_NOTES_KEY = 'writtenNotes';
const PERFORMER_STEPS_KEY = 'drumSteps';

const MAX_ID_LENGTH = 64;

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function validId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function byId(list) {
    const map = new Map();
    for (const item of Array.isArray(list) ? list : []) {
        if (isRecord(item) && validId(item.id)) map.set(item.id, item);
    }
    return map;
}

function allHaveIds(list) {
    return Array.isArray(list) && list.every(item => isRecord(item) && validId(item.id));
}

/**
 * Field-level diff of two flat records (keys in `skip` are handled by the
 * caller). A key that vanished is sent as null.
 */
function diffFields(prev, next, skip) {
    const set = {};
    let changed = false;
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const key of keys) {
        if (skip.has(key)) continue;
        const before = prev[key];
        const after = next[key];
        if (before === undefined && after === undefined) continue;
        if (sameJson(before, after)) continue;
        set[key] = after === undefined ? null : after;
        changed = true;
    }
    return changed ? set : null;
}

/**
 * Diff two versions of one track into an edit entry, or null when the pair
 * cannot be merged field by field (then the caller upserts the whole track).
 */
function diffTrack(prev, next) {
    if (!isRecord(prev.performer) || !isRecord(next.performer)) return null;
    const edit = { id: next.id };
    const trackSet = diffFields(prev, next, new Set(['id', 'performer']));
    if (trackSet) edit.set = trackSet;

    const performer = {};
    const perfSet = diffFields(prev.performer, next.performer, new Set([PERFORMER_NOTES_KEY, PERFORMER_STEPS_KEY])) || {};

    const notesBefore = prev.performer[PERFORMER_NOTES_KEY];
    const notesAfter = next.performer[PERFORMER_NOTES_KEY];
    if (!sameJson(notesBefore, notesAfter)) {
        if (allHaveIds(notesBefore) && allHaveIds(notesAfter)) {
            const before = byId(notesBefore);
            const after = byId(notesAfter);
            const notes = {};
            const upsert = [];
            for (const [id, note] of after) {
                const old = before.get(id);
                if (!old || !sameJson(old, note)) upsert.push(note);
            }
            const remove = [...before.keys()].filter(id => !after.has(id));
            if (upsert.length) notes.upsert = upsert;
            if (remove.length) notes.remove = remove;
            if (Object.keys(notes).length) performer.notes = notes;
        } else {
            perfSet[PERFORMER_NOTES_KEY] = notesAfter === undefined ? null : notesAfter;
        }
    }

    const stepsBefore = prev.performer[PERFORMER_STEPS_KEY];
    const stepsAfter = next.performer[PERFORMER_STEPS_KEY];
    if (!sameJson(stepsBefore, stepsAfter)) {
        if (Array.isArray(stepsBefore) && Array.isArray(stepsAfter) && stepsBefore.length === stepsAfter.length) {
            const steps = {};
            stepsAfter.forEach((on, index) => {
                if (Boolean(on) !== Boolean(stepsBefore[index])) steps[String(index)] = Boolean(on);
            });
            if (Object.keys(steps).length) performer.steps = steps;
        } else {
            perfSet[PERFORMER_STEPS_KEY] = stepsAfter === undefined ? null : stepsAfter;
        }
    }

    if (Object.keys(perfSet).length) performer.set = perfSet;
    if (Object.keys(performer).length) edit.performer = performer;
    return edit.set || edit.performer ? edit : null;
}

/**
 * Diff two projects into a patch, or null when nothing changed.
 * Only the keys that actually differ appear; a setting that vanished is
 * sent as `null` so the receiver deletes it.
 */
function diffProject(prev, next) {
    if (prev === next) return null;
    const patch = {};

    const settings = {};
    let settingsChanged = false;
    for (const key of SETTINGS_KEYS) {
        const before = prev[key];
        const after = next[key];
        if (before === undefined && after === undefined) continue;
        if (sameJson(before, after)) continue;
        settings[key] = after === undefined ? null : after;
        settingsChanged = true;
    }
    if (settingsChanged) patch.settings = settings;

    for (const { key, ordered, mergeable } of COLLECTIONS) {
        const before = byId(prev[key]);
        const after = byId(next[key]);
        const change = {};
        const upsert = [];
        const edit = [];
        for (const [id, item] of after) {
            const old = before.get(id);
            if (!old) {
                upsert.push(item);
                continue;
            }
            if (sameJson(old, item)) continue;
            const merged = mergeable ? diffTrack(old, item) : null;
            if (merged) edit.push(merged);
            else upsert.push(item);
        }
        const remove = [...before.keys()].filter(id => !after.has(id));
        if (upsert.length) change.upsert = upsert;
        if (edit.length) change.edit = edit;
        if (remove.length) change.remove = remove;
        if (ordered) {
            const beforeOrder = [...before.keys()].filter(id => after.has(id));
            const afterOrder = [...after.keys()];
            if (!sameJson(beforeOrder, afterOrder) || upsert.some(item => !before.has(item.id))) {
                change.order = afterOrder;
            }
        }
        if (Object.keys(change).length) patch[key] = change;
    }

    return Object.keys(patch).length ? patch : null;
}

function applyFieldSet(target, set) {
    if (!isRecord(set)) return target;
    const next = { ...target };
    for (const [key, value] of Object.entries(set)) {
        if (key === 'id') continue;
        if (value === null || value === undefined) delete next[key];
        else next[key] = value;
    }
    return next;
}

function noteStepKey(note) {
    return `${Number(note.measure)}:${Number(note.sub)}`;
}

function applyNoteChanges(list, change) {
    const current = byId(list);
    const removed = new Set(Array.isArray(change.remove) ? change.remove.filter(validId) : []);
    for (const id of removed) current.delete(id);
    for (const note of Array.isArray(change.upsert) ? change.upsert : []) {
        if (!isRecord(note) || !validId(note.id) || removed.has(note.id)) continue;
        // Monophonic lane: the note that lands on a step evicts whatever was there.
        const key = noteStepKey(note);
        for (const [id, other] of current) {
            if (id !== note.id && noteStepKey(other) === key) current.delete(id);
        }
        current.set(note.id, note);
    }
    // Canonical order so every peer holds the same array, not just the same set.
    return [...current.values()].sort((a, b) =>
        (Number(a.measure) - Number(b.measure))
        || (Number(a.sub) - Number(b.sub))
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function applyStepChanges(list, steps) {
    if (!Array.isArray(list)) return list;
    const next = [...list];
    for (const [index, on] of Object.entries(steps)) {
        const i = Number(index);
        if (!Number.isInteger(i) || i < 0 || i >= next.length) continue;
        next[i] = Boolean(on);
    }
    return next;
}

function applyTrackEdit(track, edit) {
    let next = applyFieldSet(track, edit.set);
    if (isRecord(edit.performer)) {
        let performer = applyFieldSet(isRecord(next.performer) ? next.performer : {}, edit.performer.set);
        if (isRecord(edit.performer.notes)) {
            performer = { ...performer, [PERFORMER_NOTES_KEY]: applyNoteChanges(performer[PERFORMER_NOTES_KEY], edit.performer.notes) };
        }
        if (isRecord(edit.performer.steps)) {
            performer = { ...performer, [PERFORMER_STEPS_KEY]: applyStepChanges(performer[PERFORMER_STEPS_KEY], edit.performer.steps) };
        }
        next = { ...next, performer };
    }
    return next;
}

function applyCollection(list, change, ordered) {
    const current = byId(list);
    const removed = new Set(Array.isArray(change.remove) ? change.remove.filter(validId) : []);
    for (const id of removed) current.delete(id);
    for (const item of Array.isArray(change.upsert) ? change.upsert : []) {
        if (!isRecord(item) || !validId(item.id) || removed.has(item.id)) continue;
        current.set(item.id, item);
    }
    // Edits to an entity somebody else removed in the meantime are dropped:
    // the removal was accepted first, so it wins.
    for (const edit of Array.isArray(change.edit) ? change.edit : []) {
        if (!isRecord(edit) || !validId(edit.id)) continue;
        const target = current.get(edit.id);
        if (!target) continue;
        current.set(edit.id, applyTrackEdit(target, edit));
    }
    if (ordered && Array.isArray(change.order)) {
        const placed = new Set();
        const next = [];
        for (const id of change.order) {
            const item = current.get(id);
            if (item && !placed.has(id)) {
                next.push(item);
                placed.add(id);
            }
        }
        for (const [id, item] of current) if (!placed.has(id)) next.push(item);
        return next;
    }
    return [...current.values()];
}

/**
 * Apply a patch to a project and return the new project. Unknown keys are
 * ignored, malformed entities are skipped, and clips whose track vanished
 * are pruned so the document keeps its one structural invariant.
 */
function applyPatch(project, patch) {
    if (!isRecord(patch)) return project;
    let next = { ...project };

    if (isRecord(patch.settings)) {
        for (const key of SETTINGS_KEYS) {
            if (!(key in patch.settings)) continue;
            const value = patch.settings[key];
            if (value === null || value === undefined) delete next[key];
            else next[key] = value;
        }
    }

    for (const { key, ordered } of COLLECTIONS) {
        if (isRecord(patch[key])) next[key] = applyCollection(next[key], patch[key], ordered);
        else if (!Array.isArray(next[key])) next[key] = [];
    }

    const trackIds = new Set(next.tracks.map(t => t.id));
    if (next.clips.some(c => !trackIds.has(c.trackId))) {
        next = { ...next, clips: next.clips.filter(c => trackIds.has(c.trackId)) };
    }
    return next;
}

function isEmptyPatch(patch) {
    if (!isRecord(patch)) return true;
    if (isRecord(patch.settings) && Object.keys(patch.settings).some(k => SETTINGS_KEYS.includes(k))) return false;
    for (const { key } of COLLECTIONS) {
        const change = patch[key];
        if (!isRecord(change)) continue;
        if ((Array.isArray(change.upsert) && change.upsert.length)
            || (Array.isArray(change.edit) && change.edit.length)
            || (Array.isArray(change.remove) && change.remove.length)
            || (Array.isArray(change.order) && change.order.length)) return false;
    }
    return true;
}

/**
 * Structural check for a project document arriving from a client. Semantic
 * sanitising (clamping numbers, dropping unknown chord qualities) is the
 * Studio's job when it loads the document; the server only guarantees the
 * shape every peer relies on: a record with three id-keyed collections and
 * unique ids inside each.
 */
function validateProjectShape(project, limits = {}) {
    if (!isRecord(project)) return 'A song must be an object.';
    if (typeof project.name !== 'string') return 'A song needs a name.';
    for (const { key } of COLLECTIONS) {
        const list = project[key];
        if (!Array.isArray(list)) return `A song needs a ${key} list.`;
        const seen = new Set();
        for (const item of list) {
            if (!isRecord(item) || !validId(item.id)) return `Every entry in ${key} needs an id.`;
            if (seen.has(item.id)) return `Duplicate id in ${key}.`;
            seen.add(item.id);
        }
        const max = limits[key];
        if (max && list.length > max) return `Too many ${key} (limit ${max}).`;
    }
    const trackIds = new Set(project.tracks.map(t => t.id));
    for (const clip of project.clips) {
        if (!trackIds.has(clip.trackId)) return 'A clip points at a track that does not exist.';
    }
    return null;
}

module.exports = {
    SETTINGS_KEYS,
    COLLECTIONS,
    diffProject,
    diffTrack,
    applyPatch,
    isEmptyPatch,
    validateProjectShape
};
