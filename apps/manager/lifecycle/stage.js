/**
 * Staging and promotion of a pending feature change.
 *
 *   pendingSelection(state)   the features whose pendingActive differs from active
 *   stagePayload(selection)   payload staging for newly activated features: a
 *                             no-op until selective packaging (#328) exists
 *   stageFeatures(...)        write the document the next revision runs to
 *                             <store>/lifecycle/staged-features.json
 *   promoteFeatures(...)      after every worker acknowledged: move
 *                             pendingActive into active in data/features.json
 *                             through featureState.write() and its revision rule
 *
 * data/features.json is never written before the new revision is verified,
 * and never written at all when it fails.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const files = require('../store/files');
const { ManagerError } = require('../errors');
const { mapStateError } = require('../engine/kinds/featuresSet');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');

function memoryFs() {
    const data = new Map();
    const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return {
        existsSync: (p) => data.has(p),
        readFileSync: (p) => {
            if (!data.has(p)) throw missing();
            return data.get(p);
        },
        writeFileSync: (p, text) => { data.set(p, String(text)); },
        renameSync: (from, to) => { data.set(to, data.get(from)); data.delete(from); },
        mkdirSync: () => {},
        unlinkSync: (p) => { data.delete(p); }
    };
}

/** @returns {{ id: string, from: boolean, to: boolean }[]} */
function pendingSelection(status) {
    const out = [];
    for (const [id, entry] of Object.entries(status.features || {})) {
        if (entry.pending && typeof entry.pendingActive === 'boolean') {
            out.push({ id, from: entry.requested, to: entry.pendingActive, installed: entry.installed });
        }
    }
    return out;
}

/**
 * Seam for #328 (selective payloads): make sure the package of every
 * feature this change activates is present. Today every payload ships with
 * the build, so there is nothing to stage.
 * @param {{ id: string, to: boolean }[]} _selection
 * @returns {Promise<{ staged: string[] }>}
 */
async function stagePayload(_selection) {
    return { staged: [] };
}

/** The usable features.json document, or a FEATURE_STATE_UNREADABLE refusal. */
function loadFeatures(featureState) {
    const loaded = featureState.load();
    if (loaded.error) throw mapStateError(loaded.error);
    if (!loaded.exists) {
        throw new ManagerError(409, 'NOTHING_PENDING', 'There is no features.json, so there is no pending feature change to apply.');
    }
    return loaded.parsed;
}

/** `active` := `pendingActive` for every entry, validated in memory. */
async function promotedDocument(parsed) {
    const { createFeatureState } = require('@goobster/core/features/featureState');
    const features = {};
    for (const [id, entry] of Object.entries(parsed.features)) {
        features[id] = { installed: entry.installed, active: typeof entry.pendingActive === 'boolean' ? entry.pendingActive : entry.active };
    }
    const doc = { origin: 'operator', features };
    const dryRun = createFeatureState({ fs: memoryFs(), filePath: '/dry-run/features.json', env: {}, config: {} });
    try {
        const out = await dryRun.write(doc, { expectedRevision: null });
        return { doc, normalized: out.features };
    } catch (error) {
        throw mapStateError(error);
    }
}

/**
 * Write the staged document for `revision` (the lifecycle revision) built
 * from the current features.json. Returns the features.json revision it was
 * built from, which promotion later expects.
 */
async function stageFeatures({ featureState, revision, storeDir, fs = nodeFs, now = () => new Date() }) {
    const parsed = loadFeatures(featureState);
    const { normalized } = await promotedDocument(parsed);
    const staged = {
        version: parsed.version,
        revision: parsed.revision + 1,
        updatedAt: now().toISOString().slice(0, 19).replace('T', ' '),
        origin: 'operator',
        features: normalized,
        lifecycle: { version: coreLifecycle.STAGED_VERSION, revision, fromRevision: parsed.revision }
    };
    const target = coreLifecycle.stagedFeaturesFile({ GOOBSTER_MANAGER_STATE_DIR: storeDir });
    files.ensureDir(path.dirname(target), fs);
    files.writeJsonAtomic(target, staged, fs);
    return { fromRevision: parsed.revision, changed: Object.keys(parsed.features).filter(id => typeof parsed.features[id].pendingActive === 'boolean') };
}

/**
 * Promote: write features.json with every pendingActive moved into active,
 * expecting the revision the staged document was built from. A file that
 * changed in between is refused (`FEATURES_CHANGED`) rather than merged.
 */
async function promoteFeatures({ featureState, fromRevision }) {
    const parsed = loadFeatures(featureState);
    if (parsed.revision !== fromRevision) {
        throw new ManagerError(409, 'FEATURES_CHANGED', 'features.json changed while the restart was in progress; nothing was promoted.',
            { expected: fromRevision, actual: parsed.revision });
    }
    const { doc } = await promotedDocument(parsed);
    try {
        const out = await featureState.write(doc, { expectedRevision: fromRevision });
        return { revision: out.revision };
    } catch (error) {
        throw mapStateError(error);
    }
}

module.exports = { pendingSelection, stagePayload, stageFeatures, promoteFeatures, promotedDocument, loadFeatures };
