/**
 * Operation kinds that create or open the installation:
 *
 * - `claim`            first-time setup with the bootstrap credential (internal; POST /claim)
 * - `adopt`            explicit adoption of an existing installation into a
 *                      missing or unusable store (recovery session only)
 * - `recovery.unlock`  exchange a recovery credential for a short local
 *                      recovery session (internal; POST /recovery/unlock)
 *
 * The owner label is kept out of the journal: plans say that one was given.
 */

const { ManagerError } = require('../../errors');
const files = require('../../store/files');

const LABEL_SHAPE = /^[\p{L}\p{N} ._'@()-]{1,80}$/u;

function parseLabel(input, keys) {
    if (!files.isPlainObject(input)) throw new ManagerError(400, 'INVALID_INPUT', 'The input must be an object.');
    for (const key of Object.keys(input)) {
        if (!keys.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'The input has a field this operation does not accept.');
    }
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!LABEL_SHAPE.test(label)) {
        throw new ManagerError(400, 'INVALID_INPUT', '"label" must be 1 to 80 letters, digits, spaces or ._\'@()- characters.');
    }
    return label;
}

const bridgeKeyStep = {
    name: 'create-bridge-key',
    run(_record, ctx) {
        const { created } = ctx.bridge.ensureKey(ctx.scratch.installationId);
        return { created };
    }
};

function createClaimKind() {
    const keys = new Set(['label']);
    return {
        kind: 'claim',
        public: false,
        allowed: (state, via) => state.state === 'unclaimed' && via === 'bootstrap',
        plan(input) {
            const label = parseLabel(input, keys);
            return { plan: { action: 'create-installation', ownerLabel: 'provided' }, revision: null, privateInput: { label } };
        },
        steps: [
            {
                name: 'create-installation',
                run(_record, ctx) {
                    if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
                    const doc = ctx.store.createInstallation({ origin: 'claim', ownerLabel: ctx.input.label });
                    ctx.scratch.installationId = doc.installationId;
                    return { installationId: doc.installationId };
                }
            },
            bridgeKeyStep,
            {
                name: 'issue-setup-session',
                run(_record, ctx) {
                    ctx.scratch.session = ctx.sessions.issue({ kind: 'setup' });
                    return { expiresAt: ctx.scratch.session.expiresAt };
                }
            }
        ],
        result: (scratch) => ({ installationId: scratch.installationId, session: scratch.session })
    };
}

function createAdoptKind() {
    const keys = new Set(['label', 'replaceUnreadable']);
    const usable = (status) => status === 'missing';
    return {
        kind: 'adopt',
        public: true,
        allowed: (state, via) => state.state === 'recovery' && via === 'recovery',
        plan(input, ctx) {
            const label = parseLabel(input, keys);
            if (input.replaceUnreadable !== undefined && typeof input.replaceUnreadable !== 'boolean') {
                throw new ManagerError(400, 'INVALID_INPUT', '"replaceUnreadable" must be true or false.');
            }
            const replace = input.replaceUnreadable === true;
            const current = ctx.store.readInstallation();
            if (current.status === 'ok') {
                throw new ManagerError(409, 'ALREADY_INSTALLED', 'The manager store already holds a usable installation.');
            }
            if (!usable(current.status) && !replace) {
                throw new ManagerError(409, 'ADOPT_NEEDS_CONFIRMATION',
                    'installation.json exists but cannot be used. Adopting sets it aside (renamed, never deleted); '
                    + 'send "replaceUnreadable": true to confirm.', { storeFile: current.status });
            }
            return {
                plan: {
                    action: 'adopt-existing-installation',
                    storeFile: current.status,
                    setAside: !usable(current.status),
                    ownerLabel: 'provided',
                    evidence: ctx.evidence()
                },
                revision: null,
                privateInput: { label }
            };
        },
        validate(record, ctx) {
            const current = ctx.store.readInstallation();
            if (current.status === 'ok') throw new ManagerError(409, 'ALREADY_INSTALLED', 'The manager store already holds a usable installation.');
            if (current.status !== record.plan.storeFile) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The manager store changed since this plan was made; plan again.');
            }
        },
        steps: [
            {
                name: 'set-aside',
                run(record, ctx) {
                    if (!record.plan.setAside) return { skipped: true };
                    return { keptAs: ctx.store.moveAside(ctx.store.paths.installation) };
                }
            },
            {
                name: 'create-installation',
                run(_record, ctx) {
                    if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
                    const doc = ctx.store.createInstallation({ origin: 'adopt', ownerLabel: ctx.input.label });
                    ctx.scratch.installationId = doc.installationId;
                    return { installationId: doc.installationId };
                }
            },
            bridgeKeyStep
        ],
        result: (scratch) => ({ installationId: scratch.installationId })
    };
}

function createRecoveryUnlockKind() {
    return {
        kind: 'recovery.unlock',
        public: false,
        allowed: (state, via) => (state.state === 'claimed' || state.state === 'recovery') && via === 'recovery-credential',
        plan(input) {
            if (input !== undefined && (!files.isPlainObject(input) || Object.keys(input).length > 0)) {
                throw new ManagerError(400, 'INVALID_INPUT', 'recovery.unlock takes no input.');
            }
            return { plan: { action: 'issue-recovery-session' }, revision: null };
        },
        steps: [
            {
                name: 'issue-recovery-session',
                run(_record, ctx) {
                    ctx.scratch.session = ctx.sessions.issue({ kind: 'recovery' });
                    return { expiresAt: ctx.scratch.session.expiresAt };
                }
            }
        ],
        result: (scratch) => ({ session: scratch.session })
    };
}

module.exports = { createClaimKind, createAdoptKind, createRecoveryUnlockKind, LABEL_SHAPE };
