/**
 * `config.set`: change installation settings in config.json through the
 * field catalog, the same descriptors the effective report and the
 * generated reference read.
 *
 * Input (allow-list):
 *   { changes: [{ id, action: 'set'|'remove', value? }], expectedRevision: string|null, force?: boolean }
 *
 * - `expectedRevision` is the `revision` the configuration report returned
 *   (null when config.json does not exist yet). A different file is a
 *   409 REVISION_CONFLICT at plan, validate and apply.
 * - A secret's value travels only in the engine's in-memory private input.
 *   The plan and the journal carry `{ id, action, secret: true }`; a restart
 *   between plan and apply means planning again (409 PLAN_INPUT_LOST).
 * - A mask ("••••", "[redacted]", "sk-…[redacted]", a fingerprint) is never
 *   a value: 400 MASK_IS_NOT_A_VALUE. Saving what the report showed would
 *   otherwise overwrite a secret with its own mask.
 * - A field the environment (or the host's database policy) controls is
 *   409 ENV_CONTROLLED / DB_CONTROLLED unless `force: true`, and then the
 *   plan records that the change will be ineffective.
 * - validate runs the dependency rules: turning off the mail credentials
 *   while open sign-up is on is 409 DEPENDENCY_CONFLICT (the M1 rule);
 *   dropping a credential an active feature needs, or mail that has verified
 *   addresses, is a plan warning.
 * - apply writes through configFile.write() (validate first, atomic, 0600)
 *   and returns `restartRequired`: the manager does not restart anything
 *   (the supervisor, #325, does).
 */

const { lazy } = require('../../lazy');
const { ManagerError } = require('../../errors');
const files = require('../../store/files');
const view = require('../../configView');
const { probeAppDatabase } = require('../../appDatabase');

const catalog = lazy('@goobster/core/config/fieldCatalog');
const configFile = lazy('@goobster/core/config/configFile');

const MAX_CHANGES = 64;
const INPUT_KEYS = new Set(['changes', 'expectedRevision', 'force']);
const CHANGE_KEYS = new Set(['id', 'action', 'value']);
const REVISION_SHAPE = /^[0-9a-f]{16}$/;

function mailConfigured(report) {
    const field = (id) => report.fields.find(entry => entry.id === id);
    const text = (id) => {
        const entry = field(id);
        return entry && typeof entry.value === 'string' ? entry.value.trim() : '';
    };
    const present = (id) => Boolean(field(id) && field(id).present);
    const explicit = text('mail.provider').toLowerCase();
    const smtpReady = present('mail.smtp.url') || text('mail.smtp.host') !== '';
    const resendReady = present('mail.resend.apiKey');
    const provider = explicit || (smtpReady ? 'smtp' : (resendReady ? 'resend' : ''));
    if (provider !== 'smtp' && provider !== 'resend') return false;
    if (text('mail.from') === '') return false;
    return provider === 'smtp' ? smtpReady : resendReady;
}

function openSignUp(report) {
    const value = (id) => {
        const entry = report.fields.find(item => item.id === id);
        return entry ? entry.value : undefined;
    };
    return value('identity.nativeLogin') === true && value('identity.registration') === 'open';
}

function parseInput(input) {
    if (!files.isPlainObject(input)) throw new ManagerError(400, 'INVALID_INPUT', 'The input must be an object.');
    for (const key of Object.keys(input)) {
        if (!INPUT_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'The input has a field config.set does not accept.');
    }
    const { changes, expectedRevision, force } = input;
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES) {
        throw new ManagerError(400, 'INVALID_INPUT', `"changes" must list between 1 and ${MAX_CHANGES} changes.`);
    }
    if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !REVISION_SHAPE.test(expectedRevision))) {
        throw new ManagerError(400, 'INVALID_INPUT', '"expectedRevision" is required: the revision the configuration report returned, or null when config.json does not exist.');
    }
    if (force !== undefined && typeof force !== 'boolean') throw new ManagerError(400, 'INVALID_INPUT', '"force" must be true or false.');

    const seen = new Set();
    const parsed = [];
    for (const change of changes) {
        if (!files.isPlainObject(change)) throw new ManagerError(400, 'INVALID_INPUT', 'Each change must be an object.');
        for (const key of Object.keys(change)) {
            if (!CHANGE_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'A change has a field config.set does not accept.');
        }
        const field = typeof change.id === 'string' ? catalog.get(change.id) : null;
        if (!field) throw new ManagerError(400, 'UNKNOWN_FIELD', 'That is not a setting this installation knows.', typeof change.id === 'string' && change.id.length <= 80 ? { id: change.id } : null);
        if (seen.has(field.id)) throw new ManagerError(400, 'DUPLICATE_CHANGE', 'Each setting may change once per request.', { id: field.id });
        seen.add(field.id);
        if (!catalog.filePath(field)) {
            throw new ManagerError(400, 'NOT_IN_CONFIG_FILE', field.section === 'defaults'
                ? 'Instance defaults are changed with defaults.set, not config.set.'
                : 'That setting is not stored in config.json.', { id: field.id });
        }
        if (change.action === 'remove') {
            if (change.value !== undefined) throw new ManagerError(400, 'INVALID_INPUT', 'A removal takes no value.', { id: field.id });
            parsed.push({ field, action: 'remove' });
            continue;
        }
        if (change.action !== 'set') throw new ManagerError(400, 'INVALID_INPUT', '"action" must be "set" or "remove".', { id: field.id });
        parsed.push({ field, action: 'set', raw: change.value });
    }
    return { changes: parsed, expectedRevision, force: force === true };
}

function checkValues(parsed, before) {
    const out = [];
    for (const change of parsed.changes) {
        const { field } = change;
        if (change.action === 'remove') {
            out.push({ field, action: 'remove' });
            continue;
        }
        const entry = before.fields.find(item => item.id === field.id);
        if (typeof change.raw === 'string' && catalog.isMaskedValue(change.raw, { fingerprint: entry ? entry.fingerprint : null })) {
            throw new ManagerError(400, 'MASK_IS_NOT_A_VALUE', 'That is the masked display of a secret, not a value. Enter the new value, or leave the setting alone.', { id: field.id });
        }
        if (field.secret && typeof change.raw !== 'string') {
            throw new ManagerError(400, 'INVALID_VALUE', 'The value is not valid for this setting.', { id: field.id, reason: 'TYPE' });
        }
        const checked = catalog.validateValue(field, change.raw);
        if (!checked.ok) {
            throw new ManagerError(400, 'INVALID_VALUE', field.secret ? 'The value is not valid for this setting.' : checked.message,
                { id: field.id, reason: checked.code });
        }
        if (field.secret && (checked.value === null || checked.value === undefined || checked.value === '')) {
            throw new ManagerError(400, 'INVALID_VALUE', 'A secret needs a value; use "remove" to clear it.', { id: field.id, reason: 'EMPTY' });
        }
        out.push({ field, action: 'set', value: checked.value });
    }
    return out;
}

function applyToDoc(base, changes) {
    const doc = JSON.parse(JSON.stringify(base || {}));
    for (const change of changes) {
        const primary = catalog.filePath(change.field);
        if (change.action === 'remove') {
            for (const dotted of [primary, ...change.field.legacyConfigPaths]) catalog.deletePath(doc, dotted);
        } else {
            catalog.setPath(doc, primary, change.value);
        }
    }
    return doc;
}

function mapFileError(error) {
    if (error instanceof ManagerError) return error;
    switch (error && error.code) {
    case 'STALE_REVISION':
        return new ManagerError(409, 'REVISION_CONFLICT', 'config.json changed since this plan was made; reload and plan again.',
            { expected: error.details && error.details.expected, actual: error.details && error.details.actual });
    case 'INVALID_CONFIG':
        return new ManagerError(409, 'INVALID_CONFIG', 'The resulting configuration is not valid; nothing was written.',
            { problems: ((error.details && error.details.problems) || []).map(problem => ({ id: problem.id || null, code: problem.code || null })).slice(0, 20) });
    case 'CONFIG_BUSY':
        return new ManagerError(409, 'CONFIG_BUSY', 'Another process is writing config.json; try again in a moment.');
    case 'CONFIG_UNREADABLE':
        return new ManagerError(409, 'CONFIG_UNREADABLE', 'config.json cannot be read; it was left as it is. Fix or restore it, then plan again.');
    default:
        return new ManagerError(500, 'WRITE_FAILED', 'config.json could not be written; it was left as it was.');
    }
}

function createConfigSetKind({ settings, fs }) {
    function currentFile() {
        const file = view.readFile(settings, fs);
        if (!file.readable && file.present) {
            throw new ManagerError(409, 'CONFIG_UNREADABLE', 'config.json cannot be read; it was left as it is. Fix or restore it, then plan again.', { cause: file.error });
        }
        return file;
    }

    function ensureRevision(expected, file) {
        const actual = file.revision || null;
        if ((expected ?? null) !== actual) {
            throw new ManagerError(409, 'REVISION_CONFLICT', 'config.json is not at the expected revision; reload and plan again.', { expected: expected ?? null, actual });
        }
    }

    async function overridesFor(changes) {
        if (!changes.some(change => change.field.dbOverride)) return {};
        return (await view.readOverrides(settings, { fs })).overrides;
    }

    async function verifiedAddressCount() {
        const reachability = await probeAppDatabase(settings, { fs });
        if (!view.usable(reachability)) return null;
        try {
            return await view.withAppDatabase(async () => {
                const row = await require('@goobster/core/db').get('SELECT COUNT(*) AS c FROM account_emails WHERE verifiedAt IS NOT NULL');
                return Number(row && row.c) || 0;
            });
        } catch {
            return null;
        }
    }

    /** Everything the plan, validate and apply agree on, computed from the file as it is now. */
    async function analyse({ changes, force, createFeatureState }) {
        const file = currentFile();
        const features = view.featureStates(createFeatureState);
        const overrides = await overridesFor(changes);
        const before = view.resolve({ settings, fs, overrides, features });
        const doc = applyToDoc(file.doc, changes);
        const after = view.resolve({ settings, fs, overrides, features, fileDoc: doc });

        const notes = [];
        const planned = [];
        for (const change of changes) {
            const { field } = change;
            const entry = before.fields.find(item => item.id === field.id);
            const item = { id: field.id, section: field.section, action: change.action, apply: field.apply };
            if (field.secret) item.secret = true;
            else if (change.action === 'set') item.value = change.value;
            if (change.action === 'set' && entry && entry.envControlled) {
                if (!force) {
                    throw new ManagerError(409, 'ENV_CONTROLLED', 'The environment controls this setting, so a change here would have no effect. Change the environment, or pass force to record the file value anyway.',
                        { id: field.id, envName: entry.envName });
                }
                item.ineffective = true;
                item.controlledBy = 'env';
            }
            if (change.action === 'set' && entry && entry.controlledBy === 'db' && field.dbOverride) {
                if (!force) {
                    throw new ManagerError(409, 'DB_CONTROLLED', 'The host\'s database policy overrides this setting, so a change here would have no effect. Change the policy, or pass force to record the file value anyway.',
                        { id: field.id });
                }
                item.ineffective = true;
                item.controlledBy = 'db';
            }
            if (entry && entry.source === 'unknown-db' && field.dbOverride) {
                notes.push({ code: 'DB_STATE_UNKNOWN', id: field.id, message: 'The application database is not reachable, so a host override of this setting cannot be ruled out.' });
            }
            planned.push(item);
        }

        const conflicts = [];
        const warnings = [...notes];
        const mailBefore = mailConfigured(before);
        const mailAfter = mailConfigured(after);
        if (mailBefore && !mailAfter) {
            if (openSignUp(after)) {
                conflicts.push({
                    code: 'MAIL_REQUIRED_FOR_OPEN_REGISTRATION',
                    message: 'Open sign-up needs outbound mail, and this change would turn mail off. Switch registration back to invite-only (or turn native sign-in off) first.',
                    fields: planned.filter(item => item.id.startsWith('mail.')).map(item => item.id),
                    requires: ['identity.nativeLogin', 'identity.registration']
                });
            }
            const verified = await verifiedAddressCount();
            if (verified === null) {
                warnings.push({ code: 'VERIFIED_ADDRESSES_UNKNOWN', message: 'Turning mail off may strand verified email addresses (sign-in and recovery); the application database is not reachable to count them.' });
            } else if (verified > 0) {
                warnings.push({ code: 'VERIFIED_ADDRESSES_EXIST', count: verified, message: `${verified} account(s) have a verified email address; without mail they lose email sign-in and self-service recovery.` });
            }
        }
        const unconfigured = new Set();
        for (const change of changes) {
            if (!change.field.secret || change.action !== 'remove') continue;
            const was = before.fields.find(item => item.id === change.field.id);
            const now = after.fields.find(item => item.id === change.field.id);
            if (!was || !was.present || (now && now.present)) continue;
            for (const feature of [change.field.feature, ...change.field.alsoFeatures]) {
                if (feature === 'core') continue;
                if (features && features[feature] && features[feature].active) unconfigured.add(feature);
            }
        }
        if (unconfigured.size > 0) {
            warnings.push({
                code: 'WOULD_UNCONFIGURE',
                wouldUnconfigure: [...unconfigured].sort(),
                message: 'An active feature needs a credential this change removes; it will stop working until one is set again.'
            });
        }

        const restartRequired = planned.filter(item => item.apply === 'restart' && !item.ineffective).map(item => item.id);
        return { file, doc, planned, conflicts, warnings, restartRequired };
    }

    function hydrate(record, ctx) {
        const secrets = (ctx.input && ctx.input.secrets) || null;
        return record.plan.changes.map((item) => {
            const field = catalog.get(item.id);
            if (!field) throw new ManagerError(409, 'UNKNOWN_FIELD', 'The plan names a setting this manager does not know.');
            if (item.action === 'remove') return { field, action: 'remove' };
            if (item.secret) {
                if (!secrets || typeof secrets[item.id] !== 'string') {
                    throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The secret value for this plan is no longer held (the manager restarted, or the plan was already applied). Plan the change again.');
                }
                return { field, action: 'set', value: secrets[item.id] };
            }
            return { field, action: 'set', value: item.value };
        });
    }

    return {
        kind: 'config.set',
        public: true,
        allowed(state, via) {
            if (state.state === 'claimed') return ['bridge', 'setup', 'recovery'].includes(via);
            if (state.state === 'recovery') return via === 'recovery';
            return false;
        },
        async plan(input, ctx) {
            const parsed = parseInput(input);
            const file = currentFile();
            ensureRevision(parsed.expectedRevision, file);
            const checked = checkValues(parsed, view.resolve({ settings, fs, overrides: {} }));
            const analysis = await analyse({ changes: checked, force: parsed.force, createFeatureState: ctx.createFeatureState });
            const secrets = {};
            for (const change of checked) {
                if (change.field.secret && change.action === 'set') secrets[change.field.id] = change.value;
            }
            return {
                plan: {
                    target: 'config.json',
                    effect: analysis.restartRequired.length > 0 ? 'restart-required' : 'immediate',
                    baseRevision: file.revision || null,
                    force: parsed.force,
                    changes: analysis.planned,
                    restartRequired: analysis.restartRequired,
                    dependencies: { conflicts: analysis.conflicts, warnings: analysis.warnings }
                },
                revision: view.revisionInt(file.revision),
                privateInput: { secrets }
            };
        },
        async validate(record, ctx) {
            const changes = hydrate(record, ctx);
            const file = currentFile();
            ensureRevision(record.plan.baseRevision, file);
            const analysis = await analyse({ changes, force: record.plan.force, createFeatureState: ctx.createFeatureState });
            if (analysis.conflicts.length > 0) {
                throw new ManagerError(409, 'DEPENDENCY_CONFLICT', analysis.conflicts[0].message, { conflicts: analysis.conflicts });
            }
            const problems = configFile.validate(analysis.doc);
            if (problems.length > 0) {
                throw new ManagerError(409, 'INVALID_CONFIG', 'The resulting configuration is not valid; nothing was written.',
                    { problems: problems.map(problem => ({ id: problem.id || null, code: problem.code || null })).slice(0, 20) });
            }
        },
        steps: [
            {
                name: 'check-revision',
                async run(record, ctx) {
                    const changes = hydrate(record, ctx);
                    const file = currentFile();
                    ensureRevision(record.plan.baseRevision, file);
                    ctx.scratch.doc = applyToDoc(file.doc, changes);
                    ctx.scratch.restartRequired = record.plan.restartRequired;
                    ctx.scratch.ineffective = record.plan.changes.filter(item => item.ineffective).map(item => item.id);
                    return { changes: record.plan.changes.length };
                }
            },
            {
                name: 'write-config',
                run(record, ctx) {
                    try {
                        const out = configFile.write(settings.configPath, ctx.scratch.doc, {
                            expectedRevision: record.plan.baseRevision,
                            fs
                        });
                        ctx.scratch.revision = out.revision;
                        return { bytes: out.bytes };
                    } catch (error) {
                        throw mapFileError(error);
                    }
                }
            },
            {
                name: 'verify',
                run(record, ctx) {
                    const read = view.readFile(settings, fs);
                    if (!read.readable || read.revision !== ctx.scratch.revision) {
                        throw new ManagerError(500, 'VERIFY_FAILED', 'config.json did not read back as written.');
                    }
                    return { changes: record.plan.changes.length };
                }
            }
        ],
        result: (scratch) => ({
            revision: scratch.revision,
            restartRequired: scratch.restartRequired || [],
            ineffective: scratch.ineffective || []
        })
    };
}

function createKinds(deps) {
    return [createConfigSetKind(deps)];
}

module.exports = { createKinds, createConfigSetKind, mailConfigured, openSignUp, parseInput, applyToDoc };
