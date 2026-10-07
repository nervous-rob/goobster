/**
 * Start one migration child (./childEntry.js) and read its answer. The
 * request goes in on stdin (so a passphrase never reaches an argument list
 * or the environment); the database selection goes in the environment the
 * way it does for the application. Stderr is dropped. A child that outlives
 * its time bound is killed by pid.
 */

const path = require('node:path');
const childProcess = require('node:child_process');
const { ManagerError } = require('../errors');

const CHILD = path.join(__dirname, 'childEntry.js');
const MARK = '@@goobster-migrate@@ ';
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const SHORT_TIMEOUT_MS = 2 * 60_000;
const OP_TIMEOUTS = Object.freeze({ inspect: SHORT_TIMEOUT_MS, provision: 10 * 60_000, targetCounts: SHORT_TIMEOUT_MS, finalize: SHORT_TIMEOUT_MS, rollback: 10 * 60_000 });
const INHERITED_TO_DROP = ['GOOBSTER_DB_URL', 'GOOBSTER_DB_PATH', 'GOOBSTER_PG_TEST_ISOLATE', 'GOOBSTER_MANAGER_STATE_DIR', 'GOOBSTER_MANAGER_ACK_TOKEN', 'GOOBSTER_MANAGER_PID', 'GOOBSTER_REVISION'];

function childEnv(settings, { url = null, sqlitePath = null } = {}) {
    const env = { ...process.env };
    for (const key of INHERITED_TO_DROP) delete env[key];
    env.GOOBSTER_DATA_DIR = settings.dataDir;
    env.GOOBSTER_WORKSPACE_ROOT = settings.root;
    env.GOOBSTER_CONFIG_PATH = settings.configPath;
    if (url) env.GOOBSTER_DB_URL = url;
    if (sqlitePath) env.GOOBSTER_DB_PATH = sqlitePath;
    return env;
}

/**
 * @param {Object} params
 * @param {Object} params.settings
 * @param {Function} [params.spawn] test seam
 * @returns {(op: string, request?: Object, options?: { url?: string, sqlitePath?: string, onEvent?: Function, timeoutMs?: number }) => Promise<Object>}
 */
function createChildRunner({ settings, spawn = childProcess.spawn }) {
    return function run(op, request = {}, { url = null, sqlitePath = null, onEvent = null, timeoutMs = OP_TIMEOUTS[op] || DEFAULT_TIMEOUT_MS } = {}) {
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(process.execPath, [CHILD], { env: childEnv(settings, { url, sqlitePath }), stdio: ['pipe', 'pipe', 'ignore'] });
            } catch {
                reject(new ManagerError(500, 'CHILD_START_FAILED', 'The migration helper process could not be started.'));
                return;
            }
            let buffer = '';
            let outcome = null;
            let settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) reject(error);
                else resolve(value);
            };
            const timer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch { }
                finish(new ManagerError(500, 'CHILD_TIMEOUT', `The ${op} helper did not finish in time and was stopped.`));
            }, timeoutMs);
            timer.unref?.();
            const take = (line) => {
                if (!line.startsWith(MARK)) return;
                let payload;
                try { payload = JSON.parse(line.slice(MARK.length)); } catch { return; }
                if (payload.event === 'progress') {
                    if (onEvent) { try { onEvent(payload); } catch { } }
                } else if (payload.event === 'result' || payload.event === 'error') {
                    outcome = payload;
                }
            };
            child.stdout.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                let at;
                while ((at = buffer.indexOf('\n')) >= 0) {
                    take(buffer.slice(0, at));
                    buffer = buffer.slice(at + 1);
                }
            });
            child.on('error', () => finish(new ManagerError(500, 'CHILD_START_FAILED', 'The migration helper process could not be started.')));
            child.on('close', () => {
                if (buffer) take(buffer);
                if (outcome && outcome.event === 'result') finish(null, outcome.result);
                else finish(new ManagerError(409, outcome && outcome.code ? outcome.code : 'CHILD_FAILED', `The ${op} helper failed.`, { helper: op }));
            });
            child.stdin.on('error', () => { });
            child.stdin.end(JSON.stringify({ op, ...request }));
        });
    };
}

module.exports = { createChildRunner, childEnv, MARK, OP_TIMEOUTS };
