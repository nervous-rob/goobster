/**
 * Read-only commands of the native inspection: one process per call, argv as
 * an array (never a shell), a minimal environment. Every program and every
 * first argument is on a closed list, because this runs as the manager's own
 * unprivileged account and only ever looks: nothing that installs, starts,
 * stops or writes can be spelled through it. (Changes go through the privileged
 * helper, apps/manager/privileged.) A fake binary first on PATH answers in tests.
 */

const childProcess = require('node:child_process');
const { NativeError } = require('./errors');

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/** program -> argument vectors that may begin a call (an empty list means any argument vector) */
const ALLOWED = Object.freeze({
    pg_lsclusters: [],
    pg_dump: ['--version'],
    pg_isready: [],
    'dpkg-query': ['-W'],
    'apt-cache': ['policy'],
    rpm: ['-q'],
    dnf: ['-q'],
    df: [],
    findmnt: [],
    getenforce: [],
    systemctl: ['is-active', 'is-enabled', 'list-unit-files', 'show', 'is-system-running'],
    uname: ['-m']
});

function assertAllowed(file, args) {
    const base = String(file).split('/').pop();
    if (!Object.prototype.hasOwnProperty.call(ALLOWED, base)) throw new NativeError('FORBIDDEN_COMMAND', `"${base}" is not a command the native inspection runs.`);
    const leads = ALLOWED[base];
    if (leads.length > 0 && !leads.includes(args[0])) throw new NativeError('FORBIDDEN_COMMAND', `"${base} ${args[0] || ''}" is not a read-only call the native inspection makes.`);
    if (base === 'dnf' && !args.includes('--cacheonly')) throw new NativeError('FORBIDDEN_COMMAND', 'dnf is only ever asked from its cache.');
}

/**
 * @param {Object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {Function} [options.execFile]
 * @returns {{ run: (file: string, args: string[], options?: { timeoutMs?: number }) => Promise<{ code: number|null, stdout: string, stderr: string, missing: boolean }> }}
 */
function createRunner({ env = process.env, execFile = childProcess.execFile } = {}) {
    const childEnv = { PATH: env.PATH || '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C', LANG: 'C', ...(env.FAKE_NATIVE_STATE ? { FAKE_NATIVE_STATE: env.FAKE_NATIVE_STATE } : {}), ...(env.GOOBSTER_PG_BIN ? { GOOBSTER_PG_BIN: env.GOOBSTER_PG_BIN } : {}) };

    function run(file, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        assertAllowed(file, args);
        return new Promise((resolve) => {
            execFile(file, args, { env: childEnv, timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
                if (!error) {
                    resolve({ code: 0, stdout: String(stdout), stderr: String(stderr), missing: false });
                    return;
                }
                resolve({ code: typeof error.code === 'number' ? error.code : null, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: error.code === 'ENOENT' });
            });
        });
    }

    return { run };
}

module.exports = { createRunner, assertAllowed, ALLOWED, DEFAULT_TIMEOUT_MS };
