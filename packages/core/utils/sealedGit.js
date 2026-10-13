/**
 * Sealed git plumbing shared by workspace history (ADR 0014) and project
 * repositories (ADR 0015). Every git call made on behalf of a project goes
 * through here, from the host process, never from the sandbox:
 *
 *   - explicit GIT_DIR and GIT_WORK_TREE (the git directory is always a
 *     sibling of the workspace, never inside it);
 *   - HOME inside the git directory, GIT_CONFIG_NOSYSTEM and a nonexistent
 *     global config, so no operator or system git configuration leaks in;
 *   - no pager, no terminal prompt, no optional locks, C locale;
 *   - GIT_ALLOW_PROTOCOL pinned (https by default) so a remote can never
 *     be a local path, ssh or an ext:: command;
 *   - a fixed committer; the author is whatever the caller resolves.
 *
 * Nothing here knows about tokens. A credential helper is an extra
 * environment entry a caller adds for one call (see projectRepoService).
 */

const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');

const COMMITTER_NAME = 'goobster';
const AUTHOR_DOMAIN = 'history.goobster.invalid';
const GIT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/** True when `<gitCommand> --version` answers. */
function probeGit(gitCommand) {
    try {
        const res = spawnSync(gitCommand || 'git', ['--version'], {
            stdio: 'ignore', windowsHide: true, timeout: 10_000
        });
        return res.status === 0;
    } catch {
        return false;
    }
}

/**
 * The sealed environment for one repository.
 * @param {Object} params
 * @param {string} params.gitDir
 * @param {string} params.workTree
 * @param {string|null} [params.author] author name (default: the committer)
 * @param {string|null} [params.authorEmail] author email (default: <author>@AUTHOR_DOMAIN)
 * @param {string} [params.allowProtocol] GIT_ALLOW_PROTOCOL value
 * @param {Object} [params.extra] more entries (a credential helper, for one call)
 */
function sealedEnv({ gitDir, workTree, author = null, authorEmail = null, allowProtocol = 'https', extra = {} }) {
    const name = author || COMMITTER_NAME;
    const env = {
        PATH: process.env.PATH || process.env.Path || '',
        GIT_DIR: gitDir,
        GIT_WORK_TREE: path.resolve(workTree),
        HOME: gitDir,
        XDG_CONFIG_HOME: path.join(gitDir, 'xdg'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: path.join(gitDir, 'no-global-config'),
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_ALLOW_PROTOCOL: allowProtocol,
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        LC_ALL: 'C',
        GIT_COMMITTER_NAME: COMMITTER_NAME,
        GIT_COMMITTER_EMAIL: `${COMMITTER_NAME}@${AUTHOR_DOMAIN}`,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: authorEmail || `${name}@${AUTHOR_DOMAIN}`,
        ...extra
    };
    if (process.platform === 'win32') {
        for (const key of ['SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) {
            if (process.env[key] && !(key in env)) env[key] = process.env[key];
        }
    }
    return env;
}

/**
 * Run one git command. Rejects with { status: 500, code: 'GIT_FAILED',
 * gitStatus, gitStderr } unless allowFail is set, in which case a non-zero
 * exit resolves normally; an over-long output rejects with
 * { status: 413, code: 'TOO_LARGE' }.
 * @returns {Promise<{ stdout: string|Buffer, stderr: string, status: number }>}
 */
function runGit(gitCommand, args, {
    cwd, env, input = null, binary = false, maxBuffer = DEFAULT_MAX_BUFFER, allowFail = false, timeoutMs = GIT_TIMEOUT_MS
} = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile(gitCommand || 'git', args, {
            cwd,
            env,
            encoding: binary ? 'buffer' : 'utf8',
            maxBuffer,
            timeout: timeoutMs,
            windowsHide: true
        }, (error, stdout, stderr) => {
            const status = error && typeof error.code === 'number' ? error.code : (error ? -1 : 0);
            const err = String(stderr || '').trim();
            if (error && (!allowFail || typeof error.code !== 'number')) {
                if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                    const tooLarge = new Error('That output is too large to show.');
                    tooLarge.status = 413;
                    tooLarge.code = 'TOO_LARGE';
                    reject(tooLarge);
                    return;
                }
                const failure = new Error(`git ${args[0]} failed (${status}): ${err || error.message}`);
                failure.status = 500;
                failure.code = 'GIT_FAILED';
                failure.gitStatus = status;
                failure.gitStderr = err;
                reject(failure);
                return;
            }
            resolve({ stdout, stderr: err, status });
        });
        if (input != null) {
            child.stdin.on('error', () => { /* git closed early */ });
            child.stdin.end(input);
        }
    });
}

/** Per-key promise chains: one repository is never worked by two callers at once. */
class SerialQueues {
    constructor() {
        this._queues = new Map();
    }

    run(key, fn) {
        const prev = this._queues.get(key) || Promise.resolve();
        const next = prev.catch(() => {}).then(fn);
        this._queues.set(key, next);
        next.finally(() => {
            if (this._queues.get(key) === next) this._queues.delete(key);
        }).catch(() => {});
        return next;
    }
}

/** Recursive byte count of a directory (budget checks). */
function dirBytes(dir) {
    const fs = require('node:fs');
    let bytes = 0;
    const walk = (current) => {
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
                try { bytes += fs.statSync(full).size; } catch { /* raced away */ }
            }
        }
    };
    walk(dir);
    return bytes;
}

module.exports = {
    COMMITTER_NAME,
    AUTHOR_DOMAIN,
    GIT_TIMEOUT_MS,
    probeGit,
    sealedEnv,
    runGit,
    SerialQueues,
    dirBytes
};
