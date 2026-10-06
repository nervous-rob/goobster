#!/usr/bin/env node
'use strict';

/**
 * Packaging-proof smoke check (documentation/packaging_proof.md, issue #327).
 *
 * Run it INSIDE a payload built by scripts/package-runtime.js, with the
 * payload's own Node:
 *
 *   <payload>/runtime/bin/node <payload>/app/scripts/package-smoke.js [options]
 *   <payload>\runtime\node.exe  <payload>\app\scripts\package-smoke.js [options]
 *
 * What it proves, on the machine it runs on:
 *   1. the running Node is the bundled one (version and module ABI pinned)
 *   2. the code root matches payload-manifest.json byte for byte, has no
 *      symlinks, and is still unmodified after everything below ran
 *   3. a SQLite database opens in a data directory whose path contains spaces
 *      and non-ASCII characters (outside the code root), the schema applies,
 *      a write is read back, and sqlite-vec is loaded AND answers a KNN query
 *      (the brute-force fallback is a failure here, not a pass)
 *   4. sharp, sodium-native, @napi-rs/canvas, @snazzah/davey, libsodium and
 *      opusscript load and do real work
 *   5. apps/api starts in standalone mode (no Discord) on an ephemeral port
 *      with the portal enabled, /health and the built client answer, and a
 *      shutdown request ends the process with exit code 0
 *   6. the launcher (bin/goobster-api[.cmd]) does the same with only GOOBSTER_HOME
 *      set, proving the roots are relocatable
 *   7. restricted permissions: --read-only-data points the data directory at
 *      a read-only location and reports the failure instead of passing
 *
 * Options:
 *   --report <file>      write the JSON report there (also printed to stdout)
 *   --instance-dir <dir> use this instance root instead of a fresh temp dir
 *   --read-only-data     chmod the data directory read-only first; expected
 *                        to FAIL with an actionable message (exit 1)
 *   --no-launcher        skip step 6
 *   --allow-system-node  do not require the bundled runtime (local debugging)
 *
 * The report never contains environment values, tokens or user content; the
 * environment handed to the API child is an allow-list.
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const { inspectBinary } = require('./lib/nativeBinaryInfo');

const CODE_ROOT = path.resolve(__dirname, '..');
const PAYLOAD_ROOT = path.resolve(CODE_ROOT, '..');
const IS_WINDOWS = process.platform === 'win32';
const INSTANCE_NAME = 'Goobster d\u00e4ta \u00e9';
const REQUEST_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 90000;
const STOP_TIMEOUT_MS = 30000;

const options = parseArgs(process.argv.slice(2));
const checks = [];
const knownGaps = [];
const temporary = [];

function parseArgs(argv) {
    const parsed = { launcher: true };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--report') parsed.report = path.resolve(argv[++i]);
        else if (arg === '--instance-dir') parsed.instanceDir = path.resolve(argv[++i]);
        else if (arg === '--read-only-data') parsed.readOnlyData = true;
        else if (arg === '--no-launcher') parsed.launcher = false;
        else if (arg === '--allow-system-node') parsed.allowSystemNode = true;
        else throw new Error(`Unknown option: ${arg}`);
    }
    return parsed;
}

// --------------------------------------------------------------------------
// reporting helpers
// --------------------------------------------------------------------------

const HOME = os.homedir();
/** Paths are useful evidence; the account name inside them is not. */
function scrub(text) {
    let out = String(text);
    if (HOME && HOME.length > 3) out = out.split(HOME).join('~');
    return out.replace(/(token|secret|password|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2[redacted]');
}

function rel(file) {
    const relative = path.relative(PAYLOAD_ROOT, file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : scrub(file);
}

async function check(name, fn) {
    const started = Date.now();
    const entry = { name, status: 'pass', ms: 0 };
    try {
        const detail = await fn();
        if (detail && detail.skip) {
            entry.status = 'skip';
            entry.detail = detail.skip;
        } else if (detail !== undefined) {
            entry.detail = detail;
            if (detail && detail.knownGap) entry.status = 'known-gap';
        }
    } catch (error) {
        entry.status = 'fail';
        entry.error = scrub(error && error.message ? error.message : String(error));
        if (error && error.advice) entry.advice = scrub(error.advice);
        if (error && error.code) entry.code = error.code;
    }
    entry.ms = Date.now() - started;
    checks.push(entry);
    process.stdout.write(`[package-smoke] ${entry.status.toUpperCase().padEnd(4)} ${name}${entry.error ? ` - ${entry.error.split('\n')[0]}` : ''}\n`);
    return entry;
}

function assert(condition, message, advice) {
    if (!condition) {
        const error = new Error(message);
        if (advice) error.advice = advice;
        throw error;
    }
}

// --------------------------------------------------------------------------
// filesystem helpers
// --------------------------------------------------------------------------

function walkCodeRoot() {
    const files = new Map();
    const symlinks = [];
    const visit = (dir) => {
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            const stat = fs.lstatSync(full);
            if (stat.isSymbolicLink()) symlinks.push(rel(full));
            else if (stat.isDirectory()) visit(full);
            else files.set(path.relative(PAYLOAD_ROOT, full).split(path.sep).join('/'), { size: stat.size, full });
        }
    };
    visit(PAYLOAD_ROOT);
    return { files, symlinks };
}

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1 << 20);
        for (;;) {
            const read = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!read) break;
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function verifyPayloadAgainstManifest(manifest, { hash }) {
    const { files, symlinks } = walkCodeRoot();
    const expected = new Map(manifest.files.map(file => [file.path, file]));
    const missing = [];
    const extra = [];
    const changed = [];
    for (const [relPath, file] of expected) {
        const found = files.get(relPath);
        if (!found) missing.push(relPath);
        else if (found.size !== file.size || (hash && sha256File(found.full) !== file.sha256)) changed.push(relPath);
    }
    for (const relPath of files.keys()) if (relPath !== 'payload-manifest.json' && !expected.has(relPath)) extra.push(relPath);
    return { fileCount: expected.size, missing, extra, changed, symlinks };
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function request(port, pathname) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: REQUEST_TIMEOUT_MS, agent: false }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => req.destroy(new Error(`timeout requesting ${pathname}`)));
        req.on('error', reject);
    });
}

function portIsClosed(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port, timeout: 2000 });
        socket.once('connect', () => { socket.destroy(); resolve(false); });
        socket.once('timeout', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(true));
    });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --------------------------------------------------------------------------
// instance roots
// --------------------------------------------------------------------------

function makeInstance(label) {
    const base = options.instanceDir
        ? options.instanceDir
        : fs.mkdtempSync(path.join(os.tmpdir(), `${INSTANCE_NAME} ${label} `));
    if (!options.instanceDir) temporary.push(base);
    const roots = {
        home: base,
        data: path.join(base, 'data'),
        cache: path.join(base, 'cache'),
        logs: path.join(base, 'logs'),
        configDir: path.join(base, 'config'),
        config: path.join(base, 'config', 'config.json')
    };
    for (const dir of [roots.data, roots.cache, roots.logs, roots.configDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(roots.config, `${JSON.stringify({ webapp: { enabled: true }, discord: { enabled: false } }, null, 2)}\n`);
    return roots;
}

function describeFailure(error, roots) {
    const advice = [];
    const code = error && (error.code || (/SQLITE_CANTOPEN|unable to open/i.test(error.message) ? 'SQLITE_CANTOPEN' : null));
    if (code === 'SQLITE_CANTOPEN' || code === 'EACCES' || code === 'EROFS' || code === 'EPERM') {
        let writable = true;
        try { fs.accessSync(roots.data, fs.constants.W_OK); } catch { writable = false; }
        let mode = 'unknown';
        try { mode = (fs.statSync(roots.data).mode & 0o777).toString(8); } catch { /* missing */ }
        advice.push(`The data directory "${roots.data}" ${writable ? 'is writable, so look at the database file or its -wal/-shm siblings' : `is not writable by this account (mode ${mode})`}.`);
        advice.push('Fix: give the service account write access to it, or point GOOBSTER_DATA_DIR (or GOOBSTER_HOME) at a directory it owns. The code root is never written to.');
    }
    return advice.join(' ');
}

// --------------------------------------------------------------------------
// checks
// --------------------------------------------------------------------------

function loadManifest() {
    const manifestPath = path.join(PAYLOAD_ROOT, 'payload-manifest.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error('payload-manifest.json not found: run this from a payload built by scripts/package-runtime.js');
    }
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function scrubEnvironment() {
    let removed = 0;
    for (const key of Object.keys(process.env)) {
        if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) || key === 'GOOBSTER_DB_URL' || key === 'GOOBSTER_DB_PATH') {
            delete process.env[key];
            removed += 1;
        }
    }
    return removed;
}

function childEnvironment(roots, port, extra = {}) {
    const keep = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'LANG', 'LC_ALL'];
    const env = {};
    for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
    env.PATH = IS_WINDOWS ? `${path.join(PAYLOAD_ROOT, 'runtime')};${process.env.SystemRoot || 'C:\\Windows'}\\System32` : `${path.join(PAYLOAD_ROOT, 'runtime', 'bin')}:/usr/bin:/bin`;
    env.GOOBSTER_API_PORT = String(port);
    env.GOOBSTER_RUNTIME_MODE = 'standalone';
    Object.assign(env, extra);
    void roots;
    return env;
}

async function waitForHealth(child, port, output) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    let exited = null;
    child.once('exit', (code, signal) => { exited = { code, signal }; });
    for (;;) {
        if (exited) {
            const tail = scrub(output.join('').split('\n').slice(-15).join('\n'));
            throw new Error(`the API exited during startup (code ${exited.code}, signal ${exited.signal}). Last output:\n${tail}`);
        }
        try {
            const health = await request(port, '/health');
            if (health.status === 200) return JSON.parse(health.body);
        } catch { /* not listening yet */ }
        if (Date.now() > deadline) throw new Error(`no /health answer within ${START_TIMEOUT_MS / 1000}s`);
        await sleep(250);
    }
}

function collectOutput(child) {
    const output = [];
    for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        stream.setEncoding('utf8');
        stream.on('data', chunk => { output.push(chunk); if (output.length > 400) output.shift(); });
    }
    return output;
}

function waitForExit(child, timeoutMs) {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
        const timer = setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), timeoutMs);
        child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
        return undefined;
    });
}

/** Run the API once, probe it, stop it. `mode` is 'direct' (bundled node + index.js) or 'launcher'. */
async function runApi(mode, roots) {
    const port = await freePort();
    const indexJs = path.join(CODE_ROOT, 'apps', 'api', 'index.js');
    let child;
    let stopMethod;
    if (mode === 'direct') {
        const env = childEnvironment(roots, port, {
            GOOBSTER_WORKSPACE_ROOT: CODE_ROOT,
            GOOBSTER_DATA_DIR: roots.data,
            GOOBSTER_CACHE_DIR: roots.cache,
            GOOBSTER_LOG_DIR: roots.logs,
            GOOBSTER_CONFIG_PATH: roots.config
        });
        if (IS_WINDOWS) {
            // A Windows child cannot be asked to shut down with a signal (kill() is a hard stop),
            // so the shutdown handler the API registered is driven through stdin instead.
            child = childProcess.spawn(process.execPath, ['-e', "process.stdin.once('data',()=>process.emit('SIGTERM'));process.stdin.resume();require(process.argv[1])", indexJs], { env, cwd: PAYLOAD_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
            stopMethod = 'stdin-triggered SIGTERM handler (Windows has no graceful child signal)';
        } else {
            child = childProcess.spawn(process.execPath, [indexJs], { env, cwd: PAYLOAD_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
            stopMethod = 'SIGTERM';
        }
    } else {
        const env = childEnvironment(roots, port, { GOOBSTER_HOME: roots.home });
        if (IS_WINDOWS) {
            const launcher = path.join(PAYLOAD_ROOT, 'bin', 'goobster-api.cmd');
            child = childProcess.spawn('cmd.exe', ['/d', '/s', '/c', `""${launcher}""`], { env, cwd: PAYLOAD_ROOT, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] });
            stopMethod = 'taskkill /T /F (forced: cmd.exe wrapper has no graceful stop)';
        } else {
            child = childProcess.spawn(path.join(PAYLOAD_ROOT, 'bin', 'goobster-api'), [], { env, cwd: PAYLOAD_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
            stopMethod = 'SIGTERM';
        }
    }
    const output = collectOutput(child);
    const result = { mode, port, stopMethod };
    try {
        const health = await waitForHealth(child, port, output);
        assert(health.status === 'healthy', `/health status was "${health.status}"`);
        assert(health.mode === 'standalone', `/health mode was "${health.mode}", expected standalone`);
        assert(health.discord === 'disabled', `/health discord was "${health.discord}", expected disabled`);
        result.health = { status: health.status, mode: health.mode, discord: health.discord };

        const client = await request(port, '/app/');
        assert(client.status === 200 && /html/i.test(client.type), `GET /app/ answered ${client.status} ${client.type}; the built React client is missing or unreachable`);
        result.portalClient = { status: client.status, type: client.type.split(';')[0] };
        const katex = await request(port, '/app/vendor/katex/katex.min.css');
        assert(katex.status === 200, `GET /app/vendor/katex/katex.min.css answered ${katex.status}; node_modules layout is wrong`);
        result.katexStatic = katex.status;
    } catch (error) {
        child.kill();
        await waitForExit(child, 5000);
        throw error;
    }

    const stopStarted = Date.now();
    let exit;
    if (mode === 'launcher' && IS_WINDOWS) {
        childProcess.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        exit = await waitForExit(child, STOP_TIMEOUT_MS);
        result.exit = { forced: true, code: exit.code };
    } else {
        if (IS_WINDOWS) child.stdin.write('stop\n');
        else child.kill('SIGTERM');
        exit = await waitForExit(child, STOP_TIMEOUT_MS);
        result.exit = { code: exit.code, signal: exit.signal };
        if (exit.timedOut) {
            child.kill('SIGKILL');
            throw new Error(`the API did not exit within ${STOP_TIMEOUT_MS / 1000}s of the shutdown request (lingering handle)`);
        }
        assert(exit.code === 0, `the API exited with code ${exit.code} signal ${exit.signal} after the shutdown request, expected 0`);
    }
    result.stopMs = Date.now() - stopStarted;
    assert(await portIsClosed(port), `port ${port} still accepts connections after the API exited`);
    result.portReleased = true;
    result.logLines = output.join('').split('\n').filter(Boolean).length;
    return result;
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
    const startedAt = new Date().toISOString();
    const removedEnv = scrubEnvironment();
    let manifest = null;
    let beforeVerify = null;
    let roots = null;

    await check('payload.manifest', () => {
        manifest = loadManifest();
        assert(manifest.schema === 1, `unknown manifest schema ${manifest.schema}`);
        beforeVerify = verifyPayloadAgainstManifest(manifest, { hash: true });
        assert(beforeVerify.missing.length === 0, `${beforeVerify.missing.length} manifest files are missing, e.g. ${beforeVerify.missing[0]}`);
        assert(beforeVerify.changed.length === 0, `${beforeVerify.changed.length} files differ from the manifest, e.g. ${beforeVerify.changed[0]}`);
        assert(beforeVerify.extra.length === 0, `${beforeVerify.extra.length} files are not in the manifest, e.g. ${beforeVerify.extra[0]}`);
        assert(beforeVerify.symlinks.length === 0, `payload contains symlinks: ${beforeVerify.symlinks.slice(0, 3).join(', ')}`);
        const state = new Set(['data', 'cache', 'logs', 'tests', 'test', 'e2e', 'coverage', '.git']);
        const offending = [...walkCodeRoot().files.keys()].filter((file) => {
            const parts = file.split('/');
            const base = parts[parts.length - 1];
            if (/^config\.json$|^\.env(\..*)?$|\.(sqlite|sqlite3|db)(-wal|-shm)?$/i.test(base)) return true;
            return !parts.includes('node_modules') && parts.slice(0, -1).some(part => state.has(part));
        });
        assert(offending.length === 0, `payload contains config/user data/state/test files: ${offending.slice(0, 3).join(', ')}`);
        return { target: manifest.target, files: beforeVerify.fileCount, payloadDigest: manifest.payloadDigest, symlinks: 0 };
    });

    await check('runtime.bundled', () => {
        assert(manifest, 'no manifest');
        const bundled = path.join(PAYLOAD_ROOT, 'runtime', IS_WINDOWS ? 'node.exe' : path.join('bin', 'node'));
        const same = fs.realpathSync(process.execPath) === fs.realpathSync(bundled);
        assert(same || options.allowSystemNode, `this Node (${process.execPath}) is not the bundled runtime (${rel(bundled)}); run the smoke check with the payload's own node`);
        assert(process.versions.node === manifest.node.version || options.allowSystemNode, `Node ${process.versions.node} != pinned ${manifest.node.version}`);
        assert(process.versions.modules === manifest.node.moduleVersion, `module ABI ${process.versions.modules} != ${manifest.node.moduleVersion}`);
        assert(`${process.platform}-${process.arch}` === manifest.target, `payload target ${manifest.target} does not match this host ${process.platform}-${process.arch}`);
        return { bundled: same, node: process.versions.node, abi: process.versions.modules, napi: process.versions.napi, runtimeVerified: manifest.node.runtimeVerified };
    });

    await check('host.facts', () => {
        const facts = { os: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length };
        if (process.platform === 'linux') {
            const header = process.report.getReport().header;
            facts.glibc = header.glibcVersionRuntime || null;
            facts.libc = header.glibcVersionRuntime ? 'glibc' : 'unknown (musl?)';
        }
        if (IS_WINDOWS) facts.version = os.version();
        facts.removedSecretLikeEnvVars = removedEnv;
        facts.systemNodeOnPath = (process.env.PATH || '').split(path.delimiter).some(dir => dir && fs.existsSync(path.join(dir, IS_WINDOWS ? 'node.exe' : 'node')) && path.resolve(dir) !== path.join(PAYLOAD_ROOT, 'runtime', IS_WINDOWS ? '' : 'bin'));
        return facts;
    });

    await check('binaries.targetArch', () => {
        assert(manifest, 'no manifest');
        const wrong = [];
        let count = 0;
        for (const binary of manifest.nativeBinaries) {
            const info = inspectBinary(path.join(PAYLOAD_ROOT, binary.path));
            count += 1;
            if (!info.arch.includes(process.arch)) wrong.push(`${binary.path} (${info.arch.join('+')})`);
        }
        assert(wrong.length === 0, `native binaries for another architecture: ${wrong.slice(0, 3).join(', ')}`);
        return { inspected: count, baselines: manifest.baselines };
    });

    // --- database -----------------------------------------------------------
    roots = makeInstance('instance');
    if (options.readOnlyData) {
        // Windows ignores directory mode bits; there the proof of restricted
        // permissions needs an ACL (see documentation/packaging_proof.md).
        fs.chmodSync(roots.data, 0o555);
    }
    const dbEnv = {
        GOOBSTER_WORKSPACE_ROOT: CODE_ROOT,
        GOOBSTER_DATA_DIR: roots.data,
        GOOBSTER_CACHE_DIR: roots.cache,
        GOOBSTER_LOG_DIR: roots.logs,
        GOOBSTER_CONFIG_PATH: roots.config
    };
    Object.assign(process.env, dbEnv);

    let core = null;
    let dbOpened = false;
    await check('paths.separateRoots', () => {
        for (const [name, dir] of Object.entries({ data: roots.data, cache: roots.cache, logs: roots.logs, config: roots.config })) {
            assert(path.relative(PAYLOAD_ROOT, dir).startsWith('..'), `${name} root is inside the payload`);
        }
        assert([...roots.home].some(ch => ch.charCodeAt(0) > 127) && roots.home.includes(' '), 'instance root lacks a space or a non-ASCII character');
        return { instanceRoot: scrub(roots.home), spaces: true, nonAscii: true, readOnlyData: Boolean(options.readOnlyData) };
    });

    await check('paths.dataDirWritable', () => {
        try {
            fs.accessSync(roots.data, fs.constants.W_OK);
        } catch (error) {
            error.advice = describeFailure(error, roots);
            throw error;
        }
        return { writable: true };
    });

    await check('db.sqliteOpenWriteRead', async () => {
        core = require('@goobster/core/db');
        const runtimePaths = require('@goobster/core/runtimePaths');
        assert(runtimePaths.dataDir === roots.data, `runtimePaths.dataDir is ${scrub(runtimePaths.dataDir)}, expected the relocated data root`);
        assert(runtimePaths.workspaceRoot === CODE_ROOT, 'runtimePaths.workspaceRoot is not the payload code root');
        try {
            await core.getConnection();
        } catch (error) {
            error.advice = describeFailure(error, roots);
            throw error;
        }
        assert(core.engine === 'sqlite', `engine is ${core.engine}`);
        const tables = await core.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
        const names = new Set(tables.map(row => row.name));
        for (const required of ['users', 'memory_embeddings', 'self_docs', 'instance_state', 'work_failures']) {
            assert(names.has(required), `schema was not applied: table ${required} is missing`);
        }
        await core.run('CREATE TABLE IF NOT EXISTS package_smoke_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
        const id = await core.insert('INSERT INTO package_smoke_probe (note) VALUES (@note)', { note: 'caf\u00e9 \u2713' });
        const row = await core.get('SELECT note FROM package_smoke_probe WHERE id = @id', { id });
        assert(row && row.note === 'caf\u00e9 \u2713', 'the row written was not read back');
        const version = await core.get('SELECT sqlite_version() AS version');
        const journal = core.getDb().pragma('journal_mode', { simple: true });
        dbOpened = true;
        return { tables: names.size, sqliteVersion: version.version, journalMode: journal };
    });

    await check('db.sqliteVecLoadedAndQueries', async () => {
        if (!dbOpened) return { skip: 'the database did not open' };
        assert(core.vecAvailable() === true, 'sqlite-vec is NOT loaded: memory recall would silently fall back to brute force (a failure for the packaging proof)');
        const raw = core.getDb();
        const version = raw.prepare('SELECT vec_version() AS version').get().version;
        raw.exec('DROP TABLE IF EXISTS package_smoke_vec');
        raw.exec('CREATE VIRTUAL TABLE package_smoke_vec USING vec0(embedding float[4])');
        const insert = raw.prepare('INSERT INTO package_smoke_vec (rowid, embedding) VALUES (?, ?)');
        const vectors = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
        vectors.forEach((vector, index) => insert.run(BigInt(index + 1), Buffer.from(new Float32Array(vector).buffer)));
        const nearest = raw.prepare('SELECT rowid, distance FROM package_smoke_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1')
            .get(Buffer.from(new Float32Array([0, 0.9, 0.1, 0]).buffer));
        assert(Number(nearest.rowid) === 2, `KNN returned rowid ${nearest.rowid}, expected 2`);
        raw.exec('DROP TABLE package_smoke_vec');
        return { vecVersion: version, knnRowid: Number(nearest.rowid) };
    });

    await check('db.closeCleanly', async () => {
        if (!dbOpened) return { skip: 'the database did not open' };
        await core.closeConnection();
    });

    // --- other native modules ----------------------------------------------
    await check('native.sharp', async () => {
        const sharp = require('sharp');
        const png = await sharp({ create: { width: 16, height: 8, channels: 3, background: '#cc3366' } }).png().toBuffer();
        const meta = await sharp(png).metadata();
        assert(meta.format === 'png' && meta.width === 16 && meta.height === 8, 'sharp PNG round trip failed');
        const webp = await sharp(png).resize(4, 4).webp().toBuffer();
        const jpeg = await sharp(png).jpeg().toBuffer();
        assert((await sharp(webp).metadata()).format === 'webp' && (await sharp(jpeg).metadata()).format === 'jpeg', 'sharp webp/jpeg encode failed');
        return { sharp: sharp.versions.sharp || require('sharp/package.json').version, vips: sharp.versions.vips, formats: ['png', 'webp', 'jpeg'] };
    });

    await check('native.sodium-native', () => {
        const sodium = require('sodium-native');
        const out = Buffer.alloc(32);
        sodium.crypto_generichash(out, Buffer.from('abc'));
        assert(out.toString('hex') === 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319', 'BLAKE2b-256("abc") mismatch');
        const random = Buffer.alloc(16);
        sodium.randombytes_buf(random);
        return { blake2b256: 'ok' };
    });

    await check('native.napi-rs-canvas', () => {
        const { createCanvas } = require('@napi-rs/canvas');
        const canvas = createCanvas(8, 8);
        canvas.getContext('2d').fillRect(0, 0, 4, 4);
        const png = canvas.toBuffer('image/png');
        assert(png.length > 8 && png.subarray(1, 4).toString() === 'PNG', 'canvas did not produce a PNG');
    });

    await check('native.snazzah-davey', () => {
        const davey = require('@snazzah/davey');
        assert(davey && Object.keys(davey).length > 0, 'davey exports nothing');
        return { exports: Object.keys(davey).length };
    });

    await check('wasm.libsodium-and-opus', async () => {
        const sodium = require('libsodium-wrappers');
        await sodium.ready;
        assert(sodium.to_hex(sodium.crypto_generichash(32, 'abc')).length === 64, 'libsodium-wrappers hash failed');
        const OpusScript = require('opusscript');
        const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
        encoder.delete();
    });

    // --- API ----------------------------------------------------------------
    await check('api.standalone.direct', async () => {
        try {
            return await runApi('direct', roots);
        } catch (error) {
            if (!dbOpened) error.advice = describeFailure({ code: /SQLITE_CANTOPEN|unable to open/.test(error.message) ? 'SQLITE_CANTOPEN' : null, message: error.message }, roots);
            throw error;
        }
    });

    await check('db.persistsAcrossProcesses', async () => {
        if (!dbOpened) return { skip: 'the database did not open' };
        const database = require('@goobster/core/db');
        await database.getConnection();
        const row = await database.get('SELECT note FROM package_smoke_probe LIMIT 1');
        assert(row && row.note === 'caf\u00e9 \u2713', 'the row written before the API ran is gone');
        const logFile = path.join(roots.logs, 'goobster.log');
        assert(fs.existsSync(logFile), `the API wrote no log under the relocated log root (${scrub(roots.logs)})`);
        const dbFile = path.join(roots.data, 'goobster.sqlite');
        assert(fs.existsSync(dbFile), 'goobster.sqlite is not in the relocated data root');
        await database.closeConnection();
        return { logFile: 'logs/goobster.log', dbFile: 'data/goobster.sqlite' };
    });

    if (options.launcher && dbOpened) {
        await check('api.standalone.launcher', async () => {
            const launcherRoots = makeInstance('launcher');
            const result = await runApi('launcher', launcherRoots);
            assert(fs.existsSync(path.join(launcherRoots.data, 'goobster.sqlite')), 'the launcher did not place the database under GOOBSTER_HOME/data');
            assert(fs.existsSync(path.join(launcherRoots.logs, 'goobster.log')), 'the launcher did not place logs under GOOBSTER_HOME/logs');
            return result;
        });
    } else {
        checks.push({ name: 'api.standalone.launcher', status: 'skip', detail: options.launcher ? 'the database did not open' : '--no-launcher', ms: 0 });
    }

    await check('config.relocatable', () => {
        // Empirical probe: a bot token placed ONLY at GOOBSTER_CONFIG_PATH must be
        // seen by core's config modules. They read config.json through a relative
        // require, so today they do not (known gap B1 in documentation/packaging_proof.md).
        const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), `${INSTANCE_NAME} probe `));
        temporary.push(probeDir);
        const probeConfig = path.join(probeDir, 'config.json');
        fs.writeFileSync(probeConfig, JSON.stringify({ token: 'package-smoke-probe-not-a-real-token', clientId: '1', guildIds: ['1'] }));
        const probe = childProcess.spawnSync(process.execPath, ['-p', "JSON.stringify(require('@goobster/core/config/discordConfig').enabled)"], {
            cwd: CODE_ROOT,
            encoding: 'utf8',
            env: childEnvironment(roots, 0, { GOOBSTER_WORKSPACE_ROOT: CODE_ROOT, GOOBSTER_DATA_DIR: roots.data, GOOBSTER_LOG_DIR: roots.logs, GOOBSTER_CONFIG_PATH: probeConfig })
        });
        assert(probe.status === 0, `config probe crashed: ${scrub(probe.stderr).split('\n')[0]}`);
        const honoured = probe.stdout.trim() === 'true';
        const corePackage = path.dirname(require.resolve('@goobster/core/package.json'));
        const reads = path.resolve(corePackage, 'config', '..', '..', '..', 'config.json');
        if (!honoured) {
            knownGaps.push({
                id: 'B1',
                summary: 'core config modules read config.json through a hard-coded relative require instead of runtimePaths.configJsonPath, so a config.json in a separate config root is ignored by them (a token there leaves discordConfig.enabled false)',
                coreConfigModulesRead: rel(reads),
                affected: '37 require(...config.json) sites (24 in packages/core incl. 13 in config/*.js, 13 in apps/bot); serviceManager.js throws MODULE_NOT_FOUND when loaded',
                reference: 'documentation/packaging_proof.md#b1'
            });
            return { knownGap: 'B1', honoured, coreConfigModulesRead: rel(reads) };
        }
        return { honoured, coreConfigModulesRead: rel(reads) };
    });

    await check('payload.unmodifiedAfterRun', () => {
        const after = verifyPayloadAgainstManifest(manifest, { hash: true });
        assert(after.missing.length + after.changed.length + after.extra.length === 0,
            `the run changed the code root: ${[...after.missing, ...after.changed, ...after.extra].slice(0, 3).join(', ')}`);
        assert(after.symlinks.length === 0, 'symlinks appeared in the code root');
        return { filesVerified: after.fileCount };
    });

    const failed = checks.filter(entry => entry.status === 'fail');
    const report = {
        schema: 1,
        tool: 'package-smoke',
        startedAt,
        finishedAt: new Date().toISOString(),
        target: manifest ? manifest.target : `${process.platform}-${process.arch}`,
        payloadDigest: manifest ? manifest.payloadDigest : null,
        node: { version: process.versions.node, abi: process.versions.modules },
        options: { readOnlyData: Boolean(options.readOnlyData), launcher: options.launcher },
        summary: {
            passed: checks.filter(entry => entry.status === 'pass').length,
            failed: failed.length,
            skipped: checks.filter(entry => entry.status === 'skip').length,
            knownGaps: checks.filter(entry => entry.status === 'known-gap').length
        },
        verdict: failed.length ? 'FAIL' : (knownGaps.length ? 'PASS_WITH_KNOWN_GAPS' : 'PASS'),
        checks,
        knownGaps
    };
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (options.report) {
        fs.mkdirSync(path.dirname(options.report), { recursive: true });
        fs.writeFileSync(options.report, text);
    }
    process.stdout.write(`\n${text}`);

    if (options.readOnlyData) {
        try { fs.chmodSync(roots.data, 0o755); } catch { /* best effort */ }
    }
    for (const dir of temporary) {
        try {
            fs.chmodSync(path.join(dir, 'data'), 0o755);
        } catch { /* may not exist */ }
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    process.exitCode = failed.length ? 1 : 0;
}

// If a handle keeps the event loop alive after everything finished, say so
// instead of hanging the CI job. unref() keeps the timer itself from being
// that handle.
const watchdog = setTimeout(() => {
    process.stderr.write('[package-smoke] event loop still busy 10 minutes after start: lingering handle or hung check\n');
    process.exit(3);
}, 10 * 60 * 1000);
watchdog.unref();

main().catch((error) => {
    process.stderr.write(`[package-smoke] fatal: ${scrub(error && error.stack ? error.stack : error)}\n`);
    process.exitCode = 2;
});
