/**
 * `owner.create`: the first operator account, with no Discord involved. It
 * drives the existing native sign-in path (an operator invitation, then
 * registration) against the installation's own database in a child process
 * (install/owner.js), so a person who has no Discord application can still
 * sign in to the portal.
 *
 * Input (allow-list): { loginName: string, password: string, displayName?: string }
 *
 * The password travels only in the engine's in-memory private input and then
 * on the child's stdin; the plan and the journal say that an account was
 * asked for ("created: loginName provided"), never the name or the password.
 * A restart between plan and apply means planning again (409 PLAN_INPUT_LOST).
 * Refused when the installation already has an account (409 ACCOUNT_EXISTS):
 * this is the first-operator path, not an account manager.
 */

const { ManagerError } = require('../../errors');
const files = require('../../store/files');
const model = require('../../install/model');
const owner = require('../../install/owner');

const INPUT_KEYS = new Set(['loginName', 'password', 'displayName']);
const LOGIN_NAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

function allowed(state, via) {
    if (state.state === 'claimed') return ['bridge', 'setup', 'recovery'].includes(via);
    if (state.state === 'recovery') return via === 'recovery';
    return false;
}

function parseInput(input) {
    if (!files.isPlainObject(input)) throw new ManagerError(400, 'INVALID_INPUT', 'The input must be an object.');
    for (const key of Object.keys(input)) {
        if (!INPUT_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'The input has a field owner.create does not accept.');
    }
    const loginName = typeof input.loginName === 'string' ? input.loginName.trim().toLowerCase() : '';
    if (!LOGIN_NAME.test(loginName) || /^\d+$/.test(loginName) || loginName.startsWith('usr_')) {
        throw new ManagerError(400, 'BAD_LOGIN_NAME', 'Login names are 3-32 characters: letters, digits, dots, dashes, or underscores, starting with a letter or digit.', { field: 'loginName' });
    }
    const password = input.password;
    if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        throw new ManagerError(400, 'WEAK_PASSWORD', `Passwords need ${PASSWORD_MIN} to ${PASSWORD_MAX} characters - a phrase works well.`, { field: 'password' });
    }
    if (password.toLowerCase().includes(loginName)) {
        throw new ManagerError(400, 'WEAK_PASSWORD', 'The password must not contain the login name.', { field: 'password' });
    }
    let displayName = null;
    if (input.displayName !== undefined && input.displayName !== null && input.displayName !== '') {
        if (typeof input.displayName !== 'string' || input.displayName.length > 100) {
            throw new ManagerError(400, 'INVALID_INPUT', '"displayName" must be text up to 100 characters.', { field: 'displayName' });
        }
        displayName = input.displayName.trim();
    }
    return { loginName, password, displayName };
}

function createKinds({ settings }) {
    function target(ctx) {
        const read = ctx.store.readInstallation();
        if (read.status !== 'ok') throw new ManagerError(409, 'NOT_INSTALLED', 'There is no installation record; install first.');
        const doc = read.doc;
        const roots = model.isManaged(doc) ? doc.roots : {
            code: settings.root, data: settings.dataDir, config: settings.configPath, cache: settings.dataDir, logs: settings.dataDir, uploads: settings.dataDir, managerStore: settings.storeDir
        };
        const database = doc.database || { engine: settings.dbUrl ? 'postgres' : 'sqlite', external: Boolean(settings.dbUrl) };
        return { roots, database };
    }

    const deps = () => ({ createOwner: owner.createOwner, ...(settings.installDeps || {}) });

    return [{
        kind: 'owner.create',
        public: true,
        allowed,
        plan(input, ctx) {
            const parsed = parseInput(input);
            target(ctx);
            return { plan: { target: 'owner', effect: 'create-first-operator', account: 'provided' }, revision: null, privateInput: parsed };
        },
        validate(record, ctx) {
            if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
            target(ctx);
        },
        steps: [{
            name: 'create-owner',
            async run(record, ctx) {
                if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
                const { roots, database } = target(ctx);
                const out = await deps().createOwner({ input: ctx.input, roots, settings, database });
                ctx.scratch.created = { loginName: out.loginName };
                return { detail: { created: true } };
            }
        }],
        result: (scratch) => (scratch.created ? { created: true } : null)
    }];
}

module.exports = { createKinds, parseInput, allowed };
