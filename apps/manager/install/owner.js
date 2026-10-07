/**
 * The first operator account, created and checked in a child process
 * (./ownerChild.js) against the installation's own database, so the manager
 * never binds its own database facade to it. The password goes to the child
 * on stdin; the result carries codes, never a value.
 */

const path = require('node:path');
const childProcess = require('node:child_process');
const { ManagerError } = require('../errors');
const { sqlitePathOf } = require('./dbInit');

const CHILD = path.join(__dirname, 'ownerChild.js');
const TIMEOUT_MS = 60_000;

const MESSAGES = {
    BAD_LOGIN_NAME: 'Login names are 3-32 characters: letters, digits, dots, dashes, or underscores, starting with a letter or digit.',
    WEAK_PASSWORD: 'That password is too short or too common. Use a long phrase that does not contain the login name.',
    LOGIN_NAME_TAKEN: 'That login name is already in use.',
    ACCOUNT_EXISTS: 'This installation already has an account. Sign in with it, or use the Host room to invite another person.',
    DAILY_CAP_REQUIRED: 'Account creation is paused until a daily spending cap is set.'
};
const INVALID = new Set(['BAD_LOGIN_NAME', 'WEAK_PASSWORD', 'LOGIN_NAME_TAKEN']);

function childEnv({ roots, settings, database }) {
    const env = { ...process.env, GOOBSTER_DATA_DIR: roots.data, GOOBSTER_WORKSPACE_ROOT: roots.code, GOOBSTER_IDENTITY_NATIVE_LOGIN: '1' };
    if (database.engine === 'postgres') {
        env.GOOBSTER_DB_URL = settings.dbUrl;
        delete env.GOOBSTER_DB_PATH;
    } else {
        delete env.GOOBSTER_DB_URL;
        env.GOOBSTER_DB_PATH = sqlitePathOf(roots, settings);
    }
    return env;
}

function run({ request, roots, settings, database, execFile = childProcess.execFile }) {
    return new Promise((resolve) => {
        const child = execFile(process.execPath, [CHILD], { env: childEnv({ roots, settings, database }), timeout: TIMEOUT_MS, maxBuffer: 1 << 16 }, (error, stdout) => {
            let parsed = null;
            try {
                parsed = JSON.parse(String(stdout).trim().split('\n').pop());
            } catch { }
            resolve(parsed && typeof parsed === 'object' ? parsed : { ok: false, code: error && error.killed ? 'TIMEOUT' : 'CHILD_FAILED' });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(request));
    });
}

/** @returns {Promise<{ loginName: string }>} */
async function createOwner({ input, roots, settings, database, execFile }) {
    const out = await run({ request: { mode: 'create', ...input }, roots, settings, database, execFile });
    if (out.ok) return { loginName: out.loginName };
    const code = typeof out.code === 'string' ? out.code : 'OWNER_FAILED';
    throw new ManagerError(INVALID.has(code) ? 400 : 409, code === 'ACCOUNT_EXISTS' ? code : (INVALID.has(code) ? code : 'OWNER_FAILED'),
        MESSAGES[code] || 'The owner account could not be created.', INVALID.has(code) || code === 'ACCOUNT_EXISTS' ? null : { cause: code });
}

/** @returns {Promise<{ ok: boolean, accounts?: number, operators?: number, code?: string }>} */
function checkOwner({ roots, settings, database, execFile }) {
    return run({ request: { mode: 'check' }, roots, settings, database, execFile });
}

module.exports = { createOwner, checkOwner, childEnv };
