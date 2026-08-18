/**
 * Code sandbox: runs short, resource-limited snippets of Python / Node /
 * Bash on the host and returns their stdout, stderr, and any files they
 * produced (e.g. a matplotlib chart). It backs the gated `runCode` tool so
 * Goobster can write and run code for a user - the headline use case is
 * "draw me a diagram" in the web app.
 *
 * Trust boundary (the pattern used everywhere in this project - model
 * proposes, deterministic code legalizes): the model only ever hands us a
 * language + a code string. THIS service decides how it runs. Nothing here
 * trusts the snippet:
 *   - Isolation ladder, strongest first: bubblewrap (a throwaway mount
 *     namespace with the filesystem read-only, a private /tmp, and - unless
 *     network is explicitly allowed - no network); else an unprivileged
 *     user+net namespace via `unshare -rn` (drops network at least); else a
 *     plain rlimited process (best effort, logged once at startup).
 *   - POSIX rlimits on every run regardless of isolation: CPU seconds,
 *     virtual memory, max file size, and process count (fork-bomb guard).
 *   - A hard wall-clock timeout via coreutils `timeout` (SIGTERM, escalating
 *     to SIGKILL), with a Node-side kill as the backstop.
 *   - A scrubbed environment - the snippet never sees the bot's Discord
 *     token, AI keys, or any other host secret; only a tiny PATH/HOME/locale
 *     allowlist plus a headless-matplotlib nudge.
 *   - A private per-run working directory under data/sandbox; output files
 *     are collected from it (count- and size-capped) and everything is
 *     pruned after a retention window.
 *
 * Concurrency and per-user rate limits are enforced in-memory (transient,
 * re-derivable state - the allowed exception to the SQLite rule, same as the
 * web file registry).
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const logger = require('../utils/logger');
const sandboxConfig = require('../config/sandboxConfig');
const sandboxPackages = require('../config/sandboxPackages');

const SANDBOX_ROOT = path.join(require('../runtimePaths').dataDir, 'sandbox', 'runs');
const RATE_WINDOW_MS = 5 * 60 * 1000;

/** Per-language source file name and interpreter argv builder. */
const LANGUAGES = {
    python: { file: 'main.py', argv: (cfg) => [cfg.pythonCommand, 'main.py'] },
    javascript: { file: 'main.js', argv: () => ['node', 'main.js'] },
    bash: { file: 'main.sh', argv: () => ['bash', 'main.sh'] }
};
const LANGUAGE_ALIASES = {
    python: 'python', py: 'python', python3: 'python',
    javascript: 'javascript', js: 'javascript', node: 'javascript', nodejs: 'javascript',
    bash: 'bash', sh: 'bash', shell: 'bash'
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

/**
 * Probing uses find_spec, so nothing is actually imported - it is fast and
 * side-effect free. The names come from the shared toolkit catalog
 * (config/sandboxPackages.js), so the installer and the probe can never
 * drift apart.
 */
const PYTHON_PROBE_TIMEOUT_MS = 10_000;

/** Machine-readable sandbox error (the PanelError contract: status + code). */
class SandboxError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'SandboxError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Resolve `cmd` to an absolute path on PATH. `command -v` can succeed
 * while `spawn(cmd)` still ENOENTs if the child's env PATH differs, so
 * callers that wrap the tree (especially `timeout`) must spawn the
 * resolved path.
 */
function resolveOnPath(cmd) {
    try {
        const res = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
        if (res.status !== 0) return null;
        const resolved = String(res.stdout || '').trim().split(/\r?\n/)[0];
        if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {
        // not on PATH
    }
    return null;
}

/** True if `cmd` exists on PATH. */
function commandExists(cmd) {
    return Boolean(resolveOnPath(cmd));
}

/** Can we create an unprivileged user+network namespace? (`unshare -rn`) */
function detectUnshare() {
    try {
        const res = spawnSync('unshare', ['-rn', 'true'], { stdio: 'ignore' });
        return res.status === 0;
    } catch {
        return false;
    }
}

class SandboxService {
    constructor(config = sandboxConfig) {
        this.config = config;
        /** @type {Map<string, number[]>} userId -> recent run timestamps */
        this._recentRuns = new Map();
        /** Live run count for the global concurrency cap. */
        this._active = 0;
        this._isolation = null; // resolved lazily on first run
        this._pythonModules = null; // probed lazily (listPythonModules)
    }

    get enabled() {
        return this.config.enabled === true;
    }

    /**
     * Per-run scratch root. Tests pass a unique `runsDir` so parallel
     * Jest workers never delete each other's workdirs (Node reports that
     * as `spawn timeout ENOENT` when cwd vanishes mid-spawn).
     */
    _runsRoot() {
        const configured = this.config.runsDir;
        if (typeof configured === 'string' && configured.trim()) {
            return path.resolve(configured);
        }
        return SANDBOX_ROOT;
    }

    /** Languages the sandbox will accept (for tool docs / validation). */
    get languages() {
        return Object.keys(LANGUAGES);
    }

    /**
     * Which of the curated third-party modules the configured Python
     * interpreter can actually import (probed once per process with
     * importlib.util.find_spec - nothing is imported). The answer feeds the
     * tool descriptions so the model writes code against packages that
     * exist, instead of discovering a missing numpy at runtime.
     *
     * The whole catalog is probed, not just the bundles this host was told
     * to install: an operator pointing `pythonCommand` at their own venv
     * gets its astropy advertised without extra configuration.
     * @returns {string[]} importable module names (subset of the probe list)
     */
    async listPythonModules() {
        if (this._pythonModules) return this._pythonModules;
        try {
            const modules = sandboxPackages.probeModules([
                ...(this.config.extraPythonPackages || []),
                // Operator-approved installs (the overlay inventory) are
                // probed too, so an approved package is advertised the same
                // way a curated one is.
                ...(await this._approvedModules()).map(m => ({ pip: m, module: m }))
            ]);
            const probe = 'import importlib.util, json\n'
                + `mods = ${JSON.stringify(modules)}\n`
                + 'print(json.dumps([m for m in mods if importlib.util.find_spec(m) is not None]))';
            const res = spawnSync(this.config.pythonCommand, ['-c', probe], {
                timeout: PYTHON_PROBE_TIMEOUT_MS,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                // Probe with the PYTHONPATH runs will actually get (the
                // overlay, or nothing) - never the host's own PYTHONPATH,
                // which runs never see.
                env: { ...process.env, PYTHONPATH: this._overlayPath() || '' }
            });
            const parsed = res.status === 0 ? JSON.parse(String(res.stdout).trim()) : [];
            this._pythonModules = Array.isArray(parsed)
                ? parsed.filter(m => typeof m === 'string')
                : [];
        } catch {
            this._pythonModules = [];
        }
        return this._pythonModules;
    }

    /** Import names from the approved-package overlay inventory (best effort). */
    async _approvedModules() {
        try {
            return await require('./sandboxPackagesStore').modules();
        } catch {
            return []; // no database in this context - the catalog still probes
        }
    }

    /** The overlay directory runs may import from, or null when absent. */
    _overlayPath() {
        const dir = this.config.overlayDir;
        try {
            if (dir && fs.statSync(dir).isDirectory()) return dir;
        } catch { /* not created yet */ }
        return null;
    }

    /**
     * Drop the memoized probe result (an approved install just changed the
     * answer) and re-probe, so tool descriptions update without a restart.
     */
    async refreshPythonModules() {
        this._pythonModules = null;
        return await this.listPythonModules();
    }

    /**
     * One sentence for tool descriptions and import-error hints describing
     * what Python code may import here. Honest about the empty case, so the
     * model stops assuming numpy exists on a bare host.
     * @returns {string}
     */
    async pythonEnvironmentNote() {
        const mods = await this.listPythonModules();
        if (mods.length === 0) {
            return 'Python runs can import ONLY the standard library - no third-party packages '
                + '(numpy, matplotlib, ...) are installed and there is no network to install any, '
                + 'so write pure-stdlib code (the operator can add packages with `npm run sandbox-python`).';
        }
        return `Python runs can import the standard library plus exactly these third-party modules: `
            + `${mods.join(', ')}. Nothing else is installed and there is no network to install more, `
            + 'so do not import other packages.';
    }

    /**
     * Resolve (once) the strongest available isolation backend.
     * @returns {'bwrap'|'unshare'|'none'}
     */
    _resolveIsolation() {
        if (this._isolation) return this._isolation;
        if (commandExists('bwrap')) {
            this._isolation = 'bwrap';
        } else if (detectUnshare()) {
            this._isolation = 'unshare';
            logger.warn?.('[sandbox] bubblewrap (bwrap) not found; falling back to unshare namespaces. '
                + 'Install bubblewrap for full filesystem isolation.');
        } else {
            this._isolation = 'none';
            logger.warn?.('[sandbox] Neither bwrap nor unshare namespaces are available; runs are limited by '
                + 'rlimits + timeout only, with no filesystem/network isolation. Not recommended on a shared host.');
        }
        if (!commandExists('timeout')) {
            logger.warn?.('[sandbox] coreutils `timeout` not found; wall-clock timeouts fall back to a Node-side kill.');
        }
        return this._isolation;
    }

    /** Normalize a model-supplied language string to a supported key, or null. */
    _normalizeLanguage(language) {
        const key = String(language || '').trim().toLowerCase();
        return LANGUAGE_ALIASES[key] || null;
    }

    /** Sliding-window per-user rate limit (mutates state; throws when exceeded). */
    _checkRateLimit(userId) {
        if (!userId) return;
        const now = Date.now();
        const stamps = (this._recentRuns.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS);
        if (stamps.length >= this.config.runsPerWindow) {
            throw new SandboxError(429, 'RATE_LIMITED',
                `Too many sandbox runs - wait a moment (max ${this.config.runsPerWindow} per 5 minutes).`);
        }
        stamps.push(now);
        this._recentRuns.set(userId, stamps);
    }

    /** A minimal, secret-free environment for the child process. */
    _buildEnv(workdir, projectDir = null) {
        const tmp = path.join(workdir, 'tmp');
        const overlay = this._overlayPath();
        return {
            // Operator-approved packages (data/sandbox/overlay, a pip
            // --target directory) ride PYTHONPATH so the curated venv is
            // never mutated. Absent overlay = no PYTHONPATH at all.
            ...(overlay ? { PYTHONPATH: overlay } : {}),
            // The Observatory's persistent workspace, when a run belongs to
            // a project: the one directory (besides the throwaway workdir)
            // the snippet may read AND write across runs.
            ...(projectDir ? { GOOBSTER_PROJECT_DIR: projectDir } : {}),
            PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
            HOME: workdir,
            TMPDIR: tmp,
            LANG: process.env.LANG || 'C.UTF-8',
            LC_ALL: process.env.LC_ALL || 'C.UTF-8',
            // Headless plotting: matplotlib must never try to open a display,
            // and its config/cache belongs in the throwaway workdir.
            MPLBACKEND: 'Agg',
            MPLCONFIGDIR: path.join(tmp, 'mpl'),
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONUNBUFFERED: '1',
            // Keep the snippet from wandering off into a user site-packages
            // it shouldn't; the configured interpreter/venv is the source.
            PYTHONNOUSERSITE: '1'
        };
    }

    /**
     * The inner bash wrapper that applies rlimits and then execs the
     * interpreter. Shared by every isolation mode.
     */
    _wrapperScript(workdir, interpArgv) {
        const { maxCpuSeconds, maxMemoryMb, maxWriteMb } = this.config;
        const memKb = Math.round(maxMemoryMb * 1024);
        const fileKb = Math.round(maxWriteMb * 1024);
        const quoted = interpArgv.map(a => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
        return [
            `cd '${workdir.replace(/'/g, `'\\''`)}' || exit 97`,
            `ulimit -t ${maxCpuSeconds} 2>/dev/null`,
            `ulimit -v ${memKb} 2>/dev/null`,
            `ulimit -f ${fileKb} 2>/dev/null`,
            `ulimit -u 256 2>/dev/null`,
            `ulimit -c 0 2>/dev/null`,
            `exec ${quoted}`
        ].join('\n');
    }

    /**
     * Build the full argv (outermost first) for a run, based on the resolved
     * isolation backend. `timeout` is always the outermost process so it can
     * kill the whole tree.
     * @returns {{ command: string, args: string[], viaTimeout: boolean }}
     */
    _buildArgv(isolation, workdir, script, projectDir = null) {
        const { timeoutMs, allowNetwork, extraBinds } = this.config;
        const timeoutSec = Math.ceil(timeoutMs / 1000);
        const timeoutBin = resolveOnPath('timeout');

        let inner;
        if (isolation === 'bwrap') {
            const bwrap = [
                '--ro-bind', '/', '/',
                '--dev', '/dev',
                '--proc', '/proc',
                '--tmpfs', '/tmp',
                '--bind', workdir, workdir,
                '--chdir', workdir,
                '--unshare-pid', '--unshare-ipc', '--unshare-uts',
                '--die-with-parent', '--new-session'
            ];
            // Project runs additionally see their persistent workspace
            // read-write - the ONLY writable path beyond the throwaway
            // workdir (the rest of the filesystem stays read-only).
            if (projectDir) bwrap.push('--bind', projectDir, projectDir);
            if (!allowNetwork) bwrap.push('--unshare-net');
            for (const bind of extraBinds) bwrap.push('--ro-bind-try', bind, bind);
            inner = ['bwrap', ...bwrap, '--', 'bash', '-c', script];
        } else if (isolation === 'unshare') {
            // -r maps our uid to root inside a new user namespace so we may
            // create a network namespace; -n gives an empty one (no network)
            // unless the operator opted in.
            const flags = allowNetwork ? ['-r'] : ['-rn'];
            inner = ['unshare', ...flags, 'bash', '-c', script];
        } else {
            inner = ['bash', '-c', script];
        }

        if (timeoutBin) {
            return { command: timeoutBin, args: ['-k', '2', String(timeoutSec), ...inner], viaTimeout: true };
        }
        return { command: inner[0], args: inner.slice(1), viaTimeout: false };
    }

    /** Truncate a Buffer of collected output to the configured byte cap. */
    _finishStream(chunks, byteCount) {
        const cap = this.config.maxOutputBytes;
        const buf = Buffer.concat(chunks);
        if (buf.length <= cap) return { text: buf.toString('utf8'), truncated: byteCount > buf.length };
        return {
            text: buf.subarray(0, cap).toString('utf8') + `\n… [truncated, ${byteCount} bytes total]`,
            truncated: true
        };
    }

    /**
     * Collect files the snippet produced in its workdir (excluding the
     * source file and the private tmp dir), newest first, count- and
     * size-capped.
     * @returns {Array<{path:string, name:string, size:number, isImage:boolean}>}
     */
    _collectOutputs(workdir, sourceFile) {
        const { maxOutputFiles, maxFileSizeBytes } = this.config;
        let entries;
        try {
            entries = fs.readdirSync(workdir, { withFileTypes: true });
        } catch {
            return [];
        }
        const files = [];
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (entry.name === sourceFile) continue;
            const full = path.join(workdir, entry.name);
            let stat;
            try { stat = fs.statSync(full); } catch { continue; }
            if (stat.size === 0 || stat.size > maxFileSizeBytes) continue;
            files.push({
                path: full,
                name: entry.name,
                size: stat.size,
                mtime: stat.mtimeMs,
                isImage: IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
            });
        }
        files.sort((a, b) => b.mtime - a.mtime);
        return files.slice(0, maxOutputFiles).map(({ mtime, ...rest }) => rest);
    }

    /** Remove run directories older than the retention window (best effort). */
    _pruneOldRuns() {
        const cutoff = Date.now() - this.config.retentionHours * 60 * 60 * 1000;
        let entries;
        try {
            entries = fs.readdirSync(this._runsRoot(), { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const full = path.join(this._runsRoot(), entry.name);
            try {
                if (fs.statSync(full).mtimeMs < cutoff) {
                    fs.rmSync(full, { recursive: true, force: true });
                }
            } catch { /* ignore prune failures */ }
        }
    }

    /**
     * Run a snippet.
     * @param {Object} params
     * @param {string} params.language - python | javascript | bash (+ aliases)
     * @param {string} params.code - the source to execute
     * @param {string} [params.stdin] - optional stdin fed to the program
     * @param {string} [params.userId] - for the per-user rate limit
     * @param {string} [params.projectDir] - an existing directory bind-mounted
     *   read-write IN ADDITION to the throwaway workdir and exposed to the
     *   snippet as $GOOBSTER_PROJECT_DIR (the Observatory's persistent
     *   workspace). The caller legalizes the path; this service only mounts it.
     * @param {AbortSignal} [params.signal] - kills the run early (job cancel).
     * @returns {Promise<{
     *   ok:boolean, exitCode:number|null, signal:string|null, timedOut:boolean,
     *   aborted:boolean, stdout:string, stderr:string,
     *   stdoutTruncated:boolean, stderrTruncated:boolean,
     *   durationMs:number, isolation:string, language:string,
     *   files:Array<{path:string,name:string,size:number,isImage:boolean}>
     * }>}
     */
    async run({ language, code, stdin = '', userId = null, projectDir = null, signal = null } = {}) {
        if (!this.enabled) {
            throw new SandboxError(403, 'DISABLED', 'The code sandbox is disabled on this server.');
        }
        const langKey = this._normalizeLanguage(language);
        if (!langKey) {
            throw new SandboxError(400, 'BAD_LANGUAGE',
                `Unsupported language "${language}". Supported: ${this.languages.join(', ')}.`);
        }
        if (typeof code !== 'string' || code.trim() === '') {
            throw new SandboxError(400, 'EMPTY_CODE', 'No code was provided to run.');
        }
        if (projectDir !== null) {
            let stat;
            try { stat = fs.statSync(projectDir); } catch { stat = null; }
            if (!path.isAbsolute(String(projectDir)) || !stat?.isDirectory()) {
                throw new SandboxError(400, 'BAD_PROJECT_DIR',
                    'projectDir must be an existing absolute directory.');
            }
        }
        if (this._active >= this.config.maxConcurrent) {
            throw new SandboxError(429, 'BUSY', 'The sandbox is busy running other code - try again shortly.');
        }
        this._checkRateLimit(userId);

        const isolation = this._resolveIsolation();
        const lang = LANGUAGES[langKey];
        const runId = crypto.randomBytes(8).toString('hex');
        const workdir = path.join(this._runsRoot(), runId);
        const tmpdir = path.join(workdir, 'tmp');

        fs.mkdirSync(tmpdir, { recursive: true });
        fs.chmodSync(workdir, 0o700);
        fs.writeFileSync(path.join(workdir, lang.file), code, { mode: 0o600 });

        const script = this._wrapperScript(workdir, lang.argv(this.config));
        const { command, args, viaTimeout } = this._buildArgv(isolation, workdir, script, projectDir);

        this._active += 1;
        const startedAt = Date.now();
        try {
            const result = await this._spawn({ command, args, workdir, tmpdir, viaTimeout, stdin, projectDir, signal });
            const files = this._collectOutputs(workdir, lang.file);
            this._pruneOldRuns();
            return {
                ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
                exitCode: result.exitCode,
                signal: result.signal,
                timedOut: result.timedOut,
                aborted: result.aborted,
                stdout: result.stdout.text,
                stderr: result.stderr.text,
                stdoutTruncated: result.stdout.truncated,
                stderrTruncated: result.stderr.truncated,
                durationMs: Date.now() - startedAt,
                isolation,
                language: langKey,
                files
            };
        } finally {
            this._active -= 1;
        }
    }

    /** Spawn the child and gather bounded output, enforcing a Node-side hard timeout. */
    _spawn({ command, args, workdir, tmpdir, viaTimeout, stdin, projectDir = null, signal = null }) {
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(command, args, {
                    cwd: workdir,
                    env: { ...this._buildEnv(workdir, projectDir), TMPDIR: tmpdir },
                    stdio: ['pipe', 'pipe', 'pipe'],
                    // Own process group, so a Node-side kill can take out the
                    // WHOLE tree: killing only the outer `timeout` process
                    // would leave snippet descendants (e.g. a sleeping child)
                    // alive holding the stdio pipes - and the run unresolved.
                    detached: true
                });
            } catch (error) {
                reject(new SandboxError(500, 'SPAWN_FAILED',
                    `Failed to start the sandbox process: ${error.message}`));
                return;
            }

            /** Kill the child's whole process group (fall back to the child). */
            const killTree = () => {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch {
                    try { child.kill('SIGKILL'); } catch { /* already gone */ }
                }
            };

            const cap = this.config.maxOutputBytes;
            const out = { chunks: [], bytes: 0 };
            const err = { chunks: [], bytes: 0 };
            const spawnedAt = Date.now();
            let timedOut = false;
            let aborted = false;
            let settled = false;

            // Caller-driven cancellation (an Observatory job cancel): kill
            // the whole tree; the run resolves normally with aborted=true.
            const onAbort = () => {
                aborted = true;
                killTree();
            };
            if (signal) {
                if (signal.aborted) onAbort();
                else signal.addEventListener('abort', onAbort, { once: true });
            }

            const collect = (bucket) => (data) => {
                bucket.bytes += data.length;
                // Keep only up to the cap (+ a little slack) in memory.
                if (bucket.bytes <= cap + data.length) bucket.chunks.push(data);
            };
            child.stdout.on('data', collect(out));
            child.stderr.on('data', collect(err));

            // Node-side backstop: covers the no-`timeout`-binary case and any
            // child that outlives the coreutils timeout (e.g. escaped subtree).
            const hardMs = this.config.timeoutMs + (viaTimeout ? 3000 : 0);
            const killTimer = setTimeout(() => {
                timedOut = true;
                killTree();
            }, hardMs);

            const finish = (exitCode, exitSignal) => {
                if (settled) return;
                settled = true;
                clearTimeout(killTimer);
                signal?.removeEventListener?.('abort', onAbort);
                // coreutils timeout exits 124 when it fired and SIGTERM was
                // enough. When it must escalate (-k) to SIGKILL - or the KILL
                // takes out the whole process group, `timeout` included, so
                // the group leader reports signal instead of an exit code -
                // the run still died at the deadline: any kill-shaped death
                // at/after the wall clock budget is a timeout, not a program
                // error. (Guarded by elapsed time so an early OOM kill or a
                // caller abort is never mislabeled.)
                if (exitCode === 124) {
                    timedOut = true;
                } else if (!aborted
                    && (exitCode === 137 || exitSignal === 'SIGKILL' || exitSignal === 'SIGTERM')
                    && Date.now() - spawnedAt >= this.config.timeoutMs) {
                    timedOut = true;
                }
                resolve({
                    exitCode,
                    signal: exitSignal,
                    timedOut,
                    aborted,
                    stdout: this._finishStream(out.chunks, out.bytes),
                    stderr: this._finishStream(err.chunks, err.bytes)
                });
            };

            child.on('error', (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(killTimer);
                signal?.removeEventListener?.('abort', onAbort);
                reject(new SandboxError(500, 'SPAWN_FAILED',
                    `The sandbox process could not run: ${error.message}`));
            });
            child.on('close', (exitCode, exitSignal) => finish(exitCode, exitSignal));

            if (stdin) {
                try { child.stdin.write(String(stdin)); } catch { /* best effort */ }
            }
            try { child.stdin.end(); } catch { /* best effort */ }
        });
    }
}

module.exports = new SandboxService();
module.exports.SandboxService = SandboxService;
module.exports.SandboxError = SandboxError;
