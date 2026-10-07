/**
 * `features.set`: change which features are requested, through
 * `featureState.write()` and its revision rule. A change is written as
 * `pendingActive` (documentation/feature_state.md): it takes effect at the
 * next restart, which the supervisor (#325) performs and promotes. A
 * feature whose package is not installed is never activated, and a
 * dependency is never enabled on the operator's behalf.
 *
 * Input (allow-list): { changes: { <featureId>: boolean, ... }, expectedRevision?: integer|null }
 */

const { ManagerError } = require('../../errors');
const files = require('../../store/files');

const MAX_CHANGES = 64;
const ID_SHAPE = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
const INPUT_KEYS = new Set(['changes', 'expectedRevision']);

function memoryFs() {
    const data = new Map();
    return {
        existsSync: (p) => data.has(p),
        readFileSync: (p) => {
            if (!data.has(p)) {
                const error = new Error('ENOENT');
                error.code = 'ENOENT';
                throw error;
            }
            return data.get(p);
        },
        writeFileSync: (p, text) => { data.set(p, String(text)); },
        renameSync: (from, to) => { data.set(to, data.get(from)); data.delete(from); },
        mkdirSync: () => {},
        unlinkSync: (p) => { data.delete(p); }
    };
}

function mapStateError(error) {
    if (error instanceof ManagerError) return error;
    switch (error && error.code) {
    case 'STALE_REVISION':
        return new ManagerError(409, 'REVISION_CONFLICT', 'features.json changed since this plan was made; reload and plan again.',
            { expected: error.expected, actual: error.actual });
    case 'DEPENDENCY_CONFLICT':
        return new ManagerError(409, 'DEPENDENCY_CONFLICT', error.message, { conflicts: error.conflicts });
    case 'UNKNOWN_FEATURE':
    case 'CORE_IMMUTABLE':
    case 'INVALID_STATE':
        return new ManagerError(400, error.code, error.message, error.feature ? { feature: error.feature } : null);
    case 'CORRUPT_STATE':
    case 'UNSUPPORTED_VERSION':
    case 'STATE_UNREADABLE':
        return new ManagerError(409, 'FEATURE_STATE_UNREADABLE',
            'features.json cannot be used; it was left as it is. Fix or restore it, then plan again.', { cause: error.code });
    default:
        return error;
    }
}

function parseInput(input, catalog) {
    if (!files.isPlainObject(input)) throw new ManagerError(400, 'INVALID_INPUT', 'The input must be an object.');
    for (const key of Object.keys(input)) {
        if (!INPUT_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'The input has a field features.set does not accept.');
    }
    const { changes, expectedRevision } = input;
    if (!files.isPlainObject(changes)) throw new ManagerError(400, 'INVALID_INPUT', '"changes" must be an object of feature id to true or false.');
    const ids = Object.keys(changes);
    if (ids.length === 0 || ids.length > MAX_CHANGES) {
        throw new ManagerError(400, 'INVALID_INPUT', `"changes" must name between 1 and ${MAX_CHANGES} features.`);
    }
    const out = {};
    for (const id of ids) {
        const known = ID_SHAPE.test(id) ? catalog.get(id) : null;
        if (!known || id === catalog.CORE_ID) {
            throw new ManagerError(400, id === catalog.CORE_ID ? 'CORE_IMMUTABLE' : 'UNKNOWN_FEATURE',
                id === catalog.CORE_ID ? '"core" is always available.' : 'Unknown feature id.',
                ID_SHAPE.test(id) ? { feature: id } : null);
        }
        if (typeof changes[id] !== 'boolean') throw new ManagerError(400, 'INVALID_INPUT', `"${id}" must be true or false.`);
        out[id] = changes[id];
    }
    if (expectedRevision !== undefined && expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
        throw new ManagerError(400, 'INVALID_INPUT', '"expectedRevision" must be null or a non-negative integer.');
    }
    return { changes: out, expectedRevision: expectedRevision === undefined ? null : expectedRevision };
}

/** The document to write for `changes` against the file as it is now, validated in memory. */
function compute(changes, ctx) {
    const { createFeatureState } = require('@goobster/core/features/featureState');
    const state = ctx.createFeatureState();
    const loaded = state.load();
    if (loaded.error) throw mapStateError(loaded.error);
    const revision = loaded.exists ? loaded.parsed.revision : 0;
    const seed = state.seedFromLegacy().features;
    const features = {};
    for (const id of Object.keys(seed)) {
        const entry = loaded.exists && loaded.parsed.features[id] ? loaded.parsed.features[id] : seed[id];
        features[id] = { ...entry };
    }
    const transitions = [];
    for (const [id, wanted] of Object.entries(changes)) {
        const entry = features[id];
        if (!entry.installed && wanted) {
            throw new ManagerError(409, 'FEATURE_NOT_INSTALLED', `"${id}" is not installed and cannot be activated.`, { feature: id });
        }
        const before = typeof entry.pendingActive === 'boolean' ? entry.pendingActive : entry.active;
        if (wanted === entry.active) delete entry.pendingActive;
        else entry.pendingActive = wanted;
        transitions.push({ id, from: before, to: wanted, running: entry.active });
    }
    const doc = { origin: 'operator', features };
    const dryRun = createFeatureState({ fs: memoryFs(), filePath: '/dry-run/features.json', env: {}, config: {} });
    return dryRun.write(doc, { expectedRevision: null })
        .then(() => ({ doc, revision, transitions }))
        .catch((error) => { throw mapStateError(error); });
}

function changesOf(record) {
    const changes = {};
    for (const change of record.plan.changes) changes[change.id] = change.to;
    return changes;
}

function createFeaturesSetKind() {
    const catalog = () => require('@goobster/core/features/catalog');
    return {
        kind: 'features.set',
        public: true,
        allowed(state, via) {
            if (state.state === 'claimed') return ['bridge', 'setup', 'recovery'].includes(via);
            if (state.state === 'recovery') return via === 'recovery';
            return false;
        },
        async plan(input, ctx) {
            const parsed = parseInput(input, catalog());
            const { revision, transitions } = await compute(parsed.changes, ctx);
            if (parsed.expectedRevision !== null && parsed.expectedRevision !== revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'features.json is not at the expected revision; reload and plan again.',
                    { expected: parsed.expectedRevision, actual: revision });
            }
            return {
                plan: { target: 'features.json', effect: 'pending-until-restart', changes: transitions },
                revision
            };
        },
        async validate(record, ctx) {
            const { revision } = await compute(changesOf(record), ctx);
            if (revision !== record.revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'features.json changed since this plan was made; reload and plan again.',
                    { expected: record.revision, actual: revision });
            }
        },
        steps: [
            {
                name: 'check-revision',
                async run(record, ctx) {
                    const computed = await compute(changesOf(record), ctx);
                    if (computed.revision !== record.revision) {
                        throw new ManagerError(409, 'REVISION_CONFLICT', 'features.json changed since this plan was made; reload and plan again.',
                            { expected: record.revision, actual: computed.revision });
                    }
                    ctx.scratch.doc = computed.doc;
                    return { revision: computed.revision };
                }
            },
            {
                name: 'write-features',
                async run(record, ctx) {
                    try {
                        const out = await ctx.createFeatureState().write(ctx.scratch.doc, {
                            expectedRevision: record.revision === 0 ? null : record.revision
                        });
                        ctx.scratch.revision = out.revision;
                        return { revision: out.revision };
                    } catch (error) {
                        throw mapStateError(error);
                    }
                }
            },
            {
                name: 'verify',
                run(record, ctx) {
                    const status = ctx.createFeatureState().status();
                    if (status.error || status.revision !== ctx.scratch.revision) {
                        throw new ManagerError(500, 'VERIFY_FAILED', 'features.json did not read back as written.');
                    }
                    const pending = record.plan.changes.map(change => change.id).filter(id => status.features[id].pending);
                    ctx.scratch.pending = pending;
                    return { revision: status.revision, pending };
                }
            }
        ],
        result: (scratch) => ({ revision: scratch.revision, pending: scratch.pending || [] })
    };
}

module.exports = { createFeaturesSetKind, mapStateError, parseInput };
