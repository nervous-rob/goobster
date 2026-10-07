/**
 * `defaults.set`: change the instance defaults - what a person inherits for a
 * preference they have not set themselves (documentation/manager_configuration.md,
 * "Instance defaults versus enforced policy"). A default never caps, blocks
 * or overwrites anything; the enforced limits are not changed here.
 *
 * Input (allow-list):
 *   { changes: [{ id, action: 'set'|'remove', value? }], expectedRevision?: integer, acknowledgeRetention?: boolean }
 *
 * Defaults live in the application database, so this kind is available only
 * to a claimed installation whose database is reachable (409
 * APP_DB_UNAVAILABLE otherwise); nothing is queued for later. `expectedRevision`
 * is the `defaults.revision` the configuration report returned.
 *
 * A chat-history retention default is destructive for everyone who has not
 * chosen their own window - their conversations older than the window are
 * purged at their next retention sweep - so setting one needs
 * `acknowledgeRetention: true`, and the plan carries a warning either way.
 */

const { lazy } = require('../../lazy');
const { ManagerError } = require('../../errors');
const files = require('../../store/files');
const view = require('../../configView');
const { probeAppDatabase } = require('../../appDatabase');

const catalog = lazy('@goobster/core/config/fieldCatalog');

const MAX_CHANGES = 16;
const INPUT_KEYS = new Set(['changes', 'expectedRevision', 'acknowledgeRetention']);
const CHANGE_KEYS = new Set(['id', 'action', 'value']);
const RETENTION = 'defaults.memory.chatHistoryRetentionDays';

function createDefaultsSetKind({ settings, fs }) {
    const service = () => require('@goobster/core/services/instanceDefaultsService');

    async function requireDatabase() {
        const reachability = await probeAppDatabase(settings, { fs });
        if (!view.usable(reachability)) {
            throw new ManagerError(409, 'APP_DB_UNAVAILABLE',
                'Instance defaults live in the application database, which is not reachable. Start it, then plan the change again.',
                { reason: reachability.reason || 'APP_DB_UNREACHABLE' });
        }
    }

    async function readCurrent() {
        try {
            return await view.withAppDatabase(() => service().get());
        } catch {
            throw new ManagerError(409, 'APP_DB_UNAVAILABLE', 'The application database could not be read. Try again once it is up.', { reason: 'APP_DB_OPEN_FAILED' });
        }
    }

    function parseInput(input) {
        if (!files.isPlainObject(input)) throw new ManagerError(400, 'INVALID_INPUT', 'The input must be an object.');
        for (const key of Object.keys(input)) {
            if (!INPUT_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'The input has a field defaults.set does not accept.');
        }
        const { changes, expectedRevision, acknowledgeRetention } = input;
        if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES) {
            throw new ManagerError(400, 'INVALID_INPUT', `"changes" must list between 1 and ${MAX_CHANGES} changes.`);
        }
        if (expectedRevision !== undefined && expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
            throw new ManagerError(400, 'INVALID_INPUT', '"expectedRevision" must be null or a non-negative integer.');
        }
        if (acknowledgeRetention !== undefined && typeof acknowledgeRetention !== 'boolean') {
            throw new ManagerError(400, 'INVALID_INPUT', '"acknowledgeRetention" must be true or false.');
        }
        const normalized = [];
        for (const change of changes) {
            if (!files.isPlainObject(change)) throw new ManagerError(400, 'INVALID_INPUT', 'Each change must be an object.');
            for (const key of Object.keys(change)) {
                if (!CHANGE_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'A change has a field defaults.set does not accept.');
            }
            normalized.push({ id: change.id, action: change.action, ...(change.value !== undefined ? { value: change.value } : {}) });
        }
        const checked = service().validateChanges(normalized);
        if (!checked.ok) {
            const first = checked.errors[0];
            throw new ManagerError(400, first.code === 'UNKNOWN_FIELD' ? 'UNKNOWN_FIELD' : 'INVALID_VALUE', first.message,
                { problems: checked.errors.map(error => ({ id: error.id, code: error.code })).slice(0, 20) });
        }
        return { changes: checked.normalized, expectedRevision: expectedRevision ?? null, acknowledgeRetention: acknowledgeRetention === true };
    }

    function analyse(changes, current, features) {
        const warnings = [];
        const next = service().applyChanges(current, changes);
        const retention = changes.find(change => change.id === RETENTION && change.action === 'set');
        if (retention) {
            warnings.push({
                code: 'RETENTION_DEFAULT_PURGES',
                days: retention.value,
                message: `People who have not chosen their own chat-history window will lose Study conversations older than ${retention.value} days at their next retention sweep.`
            });
        }
        const provider = catalog.getPath(next, 'chat.provider');
        if (provider) {
            const keyField = { openai: 'ai.openai.apiKey', anthropic: 'ai.anthropic.apiKey', gemini: 'ai.gemini.apiKey' }[provider];
            if (keyField) {
                const report = view.resolve({ settings, fs, overrides: {}, features });
                const entry = report.fields.find(item => item.id === keyField);
                if (!entry || !entry.present) {
                    warnings.push({
                        code: 'DEFAULT_PROVIDER_NOT_CONFIGURED',
                        message: `No ${provider} credential is configured, so this default is ignored until one is.`
                    });
                }
            }
        }
        if (catalog.getPath(next, 'chat.model') && !provider) {
            warnings.push({
                code: 'DEFAULT_MODEL_WITHOUT_PROVIDER',
                message: 'A default model applies only when the provider that wins is the host provider; set a default provider to make it unambiguous.'
            });
        }
        return { next, warnings };
    }

    return {
        kind: 'defaults.set',
        public: true,
        allowed(state, via) {
            return state.state === 'claimed' && ['bridge', 'setup', 'recovery'].includes(via);
        },
        async plan(input, ctx) {
            const parsed = parseInput(input);
            await requireDatabase();
            const current = await readCurrent();
            const revision = view.defaultsRevision(current);
            if (parsed.expectedRevision !== null && parsed.expectedRevision !== revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The instance defaults changed since they were read; reload and plan again.',
                    { expected: parsed.expectedRevision, actual: revision });
            }
            const { warnings } = analyse(parsed.changes, current, view.featureStates(ctx.createFeatureState));
            const retention = parsed.changes.some(change => change.id === RETENTION && change.action === 'set');
            if (retention && !parsed.acknowledgeRetention) {
                throw new ManagerError(400, 'ACKNOWLEDGEMENT_REQUIRED',
                    'A chat-history retention default purges older conversations for everyone without their own window. Review the warning and pass acknowledgeRetention to confirm.',
                    { warnings: warnings.filter(warning => warning.code === 'RETENTION_DEFAULT_PURGES') });
            }
            return {
                plan: {
                    target: 'instance-defaults',
                    effect: 'immediate',
                    acknowledgedRetention: parsed.acknowledgeRetention,
                    changes: parsed.changes.map(change => ({
                        id: change.id,
                        action: change.action,
                        ...(change.action === 'set' ? { value: change.value } : {})
                    })),
                    dependencies: { conflicts: [], warnings }
                },
                revision
            };
        },
        async validate(record) {
            await requireDatabase();
            const current = await readCurrent();
            const revision = view.defaultsRevision(current);
            if (revision !== record.revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The instance defaults changed since this plan was made; reload and plan again.',
                    { expected: record.revision, actual: revision });
            }
        },
        steps: [
            {
                name: 'check-revision',
                async run(record, ctx) {
                    const current = await readCurrent();
                    if (view.defaultsRevision(current) !== record.revision) {
                        throw new ManagerError(409, 'REVISION_CONFLICT', 'The instance defaults changed since this plan was made; reload and plan again.');
                    }
                    ctx.scratch.before = current;
                    return {};
                }
            },
            {
                name: 'write-defaults',
                async run(record, ctx) {
                    const changes = record.plan.changes.map(change => (change.action === 'set'
                        ? { id: change.id, action: 'set', value: change.value }
                        : { id: change.id, action: 'remove' }));
                    try {
                        const out = await view.withAppDatabase(() => service().set(changes));
                        ctx.scratch.changed = out.changed;
                        ctx.scratch.revision = view.defaultsRevision(out.after);
                    } catch (error) {
                        if (error instanceof ManagerError) throw error;
                        throw new ManagerError(500, 'WRITE_FAILED', 'The instance defaults could not be written; they were left as they were.');
                    }
                    return { changed: ctx.scratch.changed.length };
                }
            },
            {
                name: 'verify',
                async run(record, ctx) {
                    const after = await readCurrent();
                    if (view.defaultsRevision(after) !== ctx.scratch.revision) {
                        throw new ManagerError(500, 'VERIFY_FAILED', 'The instance defaults did not read back as written.');
                    }
                    return { revision: ctx.scratch.revision };
                }
            }
        ],
        result: (scratch) => ({ revision: scratch.revision, changed: scratch.changed || [], effect: 'immediate' })
    };
}

function createKinds(deps) {
    return [createDefaultsSetKind(deps)];
}

module.exports = { createKinds, createDefaultsSetKind };
