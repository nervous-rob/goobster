/**
 * Runs the `docker` CLI: one process per call, argv as an array (never a shell),
 * the child's environment passed separately. A secret reaches `docker run` only
 * through `env` (`-e NAME` with no value makes the CLI read it from there), so it
 * is never on an argv that `ps` or an audit of commands could show.
 *
 * `docker` is found on PATH (or at `GOOBSTER_DOCKER_BIN`, or `bin` below).
 * Two argument shapes are refused here whatever a caller asks for, because
 * each could reach a resource that is not this installation's: every `prune`
 * (system, volume, network, container, image) and `--all`/`-a`/`--filter` on a
 * mutating verb. Listing verbs may use `-a` and filters.
 */

const childProcess = require('node:child_process');
const { DockerError } = require('./errors');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const FORBIDDEN_PAIRS = new Set(['system prune', 'volume prune', 'network prune', 'container prune', 'image prune']);
const MUTATING = new Set(['rm', 'stop', 'start', 'kill', 'restart', 'run', 'create', 'pull', 'update']);

function assertAllowed(args) {
    const words = args.filter(item => typeof item === 'string' && !item.startsWith('-'));
    if (words.length >= 2 && FORBIDDEN_PAIRS.has(`${words[0]} ${words[1]}`)) {
        throw new DockerError('FORBIDDEN_COMMAND', `"docker ${words[0]} ${words[1]}" is never run by the manager: it would reach resources that are not this installation's.`);
    }
    const verb = words[0] === 'container' || words[0] === 'volume' || words[0] === 'network' || words[0] === 'image' ? words[1] : words[0];
    if (MUTATING.has(verb) && args.some(item => item === '--all' || item === '-a' || item === '--filter' || String(item).startsWith('--filter='))) {
        throw new DockerError('FORBIDDEN_COMMAND', 'A command that changes Docker resources must name its target exactly; --all and filters are not accepted.');
    }
}

/**
 * @param {Object} [options]
 * @param {string} [options.bin] the executable; default `GOOBSTER_DOCKER_BIN` or `docker`
 * @param {NodeJS.ProcessEnv} [options.env] base environment of every call
 * @param {Function} [options.spawn] test seam: `childProcess.execFile`
 * @returns {{ run: Function, bin: string }}
 */
function createRunner({ bin, env = process.env, execFile = childProcess.execFile } = {}) {
    const executable = bin || env.GOOBSTER_DOCKER_BIN || 'docker';

    /**
     * @param {string[]} args
     * @param {{ env?: Record<string,string>, timeoutMs?: number }} [call]
     * @returns {Promise<{ code: number|null, stdout: string, stderr: string, missing: boolean, timedOut: boolean }>} never rejects for a non-zero exit
     */
    function run(args, { env: extra = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        assertAllowed(args);
        return new Promise((resolve) => {
            execFile(executable, args, { env: { ...env, ...extra }, timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
                if (!error) {
                    resolve({ code: 0, stdout: String(stdout), stderr: String(stderr), missing: false, timedOut: false });
                    return;
                }
                resolve({
                    code: typeof error.code === 'number' ? error.code : null,
                    stdout: String(stdout || ''),
                    stderr: String(stderr || ''),
                    missing: error.code === 'ENOENT',
                    timedOut: Boolean(error.killed) && error.signal === 'SIGTERM'
                });
            });
        });
    }

    return { run, bin: executable };
}

module.exports = { createRunner, assertAllowed, DEFAULT_TIMEOUT_MS };
