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
    { key: 'tracks', ordered: true },
    { key: 'clips', ordered: false }
];

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

    for (const { key, ordered } of COLLECTIONS) {
        const before = byId(prev[key]);
        const after = byId(next[key]);
        const change = {};
        const upsert = [];
        for (const [id, item] of after) {
            const old = before.get(id);
            if (!old || !sameJson(old, item)) upsert.push(item);
        }
        const remove = [...before.keys()].filter(id => !after.has(id));
        if (upsert.length) change.upsert = upsert;
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

function applyCollection(list, change, ordered) {
    const current = byId(list);
    const removed = new Set(Array.isArray(change.remove) ? change.remove.filter(validId) : []);
    for (const id of removed) current.delete(id);
    for (const item of Array.isArray(change.upsert) ? change.upsert : []) {
        if (!isRecord(item) || !validId(item.id) || removed.has(item.id)) continue;
        current.set(item.id, item);
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
    applyPatch,
    isEmptyPatch,
    validateProjectShape
};
