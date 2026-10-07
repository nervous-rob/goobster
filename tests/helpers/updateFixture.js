/**
 * Fixtures for the update specs (#342, documentation/manager_update.md): signed payloads at two
 * versions with a database schema in them, a release source directory (signed index plus payload
 * archive), a manager installed from the first release, and the supervised fake workers an apply
 * runs against. Keys are generated into a temp directory; nothing touches the network.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const stage = require('../../scripts/lib/payloadStage');
const releaseIndex = require('../../scripts/lib/releaseIndex');
const bootstrapStage = require('../../scripts/lib/bootstrapStage');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const registry = require('@goobster/manager/lifecycle/registry');
const { tune } = require('@goobster/manager/maintenance/barrier');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const coreMaintenance = require('@goobster/core/runtime/maintenance');
const { FILES, GROUPS, tempDir, newHarness, drive, silent } = require('./installFixture');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./fakeWorkers');

const TARGET = `${process.platform}-${process.arch}`;
const sha = (content) => crypto.createHash('sha256').update(content).digest('hex');
const DB_DIR = 'app/node_modules/@goobster/core/db';

function migrationsText(columns) {
    return `const COLUMN_MIGRATIONS = ${JSON.stringify(columns)};\nmodule.exports = { COLUMN_MIGRATIONS };\n`;
}

/** An Ed25519 key pair (private PEM text, public key file) under a temp directory. */
function newKey(roots, label = 'key') {
    const made = stage.generateDevKeyPair(path.join(tempDir(roots, label), 'k'));
    return { ...made, privatePem: fs.readFileSync(made.privateKeyPath, 'utf8') };
}

/**
 * A signed payload for this host at `core`. `schema` and `columns` are what the release's
 * database looks like; two payloads with the same pair share a schema fingerprint.
 */
function makePayload(parent, key, { core, schema = 'CREATE TABLE t (a INTEGER);\n', columns = [], marker = core, groups = null } = {}) {
    const dir = fs.mkdtempSync(path.join(parent, `payload-${core}-`));
    const files = [];
    const put = (rel, owner, content, extra = {}) => {
        const full = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        files.push({ path: rel, size: Buffer.byteLength(content), sha256: sha(content), owner, ...(extra.dependency ? { dependency: extra.dependency } : {}) });
    };
    for (const [rel, owner, content, extra = {}] of FILES) put(rel, owner, rel === 'app/apps/bot/index.js' ? `// bot entry ${marker}\n` : content, extra);
    put(`${DB_DIR}/schema.sql`, 'core', schema);
    put(`${DB_DIR}/migrations.js`, 'core', migrationsText(columns));
    const layout = JSON.parse(JSON.stringify(groups || GROUPS));
    for (const file of files) if (!file.dependency) layout[file.owner].files.push(file.path);
    const manifest = {
        version: 1,
        release: { core, compatibleCore: `>=${core.split('.')[0]}.0.0 <${Number(core.split('.')[0]) + 1}.0.0` },
        target: { id: TARGET, platform: process.platform, arch: process.arch },
        node: { version: process.versions.node, abi: process.versions.modules },
        groups: layout,
        files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
        dependencies: [
            { name: 'better-sqlite3', version: '12.0.0', path: 'app/node_modules/better-sqlite3', owners: ['core'], exclusive: false },
            { name: 'discord.js', version: '14.0.0', path: 'app/node_modules/discord.js', owners: ['discord'], exclusive: true }
        ],
        frontend: { chunks: [] },
        unreferenced: []
    };
    const signed = stage.signManifest(manifest, key.privatePem);
    stage.writeManifest(dir, signed.manifest, signed.signature);
    return { dir, manifest: signed.manifest, releaseId: stage.releaseIdOf(signed.manifest), core };
}

/**
 * Publish `payload` as the release a directory source offers: its archive, a signed index.
 *   corrupt 'bytes'   flip a byte of the archive after the index recorded its digest
 *   corrupt 'file'    the archive's digest matches the index but one payload file does not match its manifest
 *   channel           the index's channel (a prerelease core version needs 'prerelease')
 *   signWith          sign the index with this key instead (an untrusted signer)
 */
async function publish(roots, key, payload, { channel = 'stable', corrupt = null, signWith = null, sourceDir = null, minUpgradeFrom = '1.0.0' } = {}) {
    const dir = sourceDir || tempDir(roots, 'source');
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    let packed = payload.dir;
    if (corrupt === 'file') {
        packed = fs.mkdtempSync(path.join(tempDir(roots, 'tamper'), 'p-'));
        fs.cpSync(payload.dir, packed, { recursive: true });
        fs.appendFileSync(path.join(packed, 'app', 'apps', 'bot', 'index.js'), '// tampered\n');
    }
    const name = `goobster-payload-${payload.core}-${TARGET}.tar.gz`;
    const file = path.join(dir, name);
    await bootstrapStage.writeArchive(path.resolve(packed), file, {});
    const entry = releaseIndex.artifactEntry({
        file,
        kind: 'payload',
        target: TARGET,
        signing: { status: 'signed', method: 'ed25519-only', identity: key.keyId },
        payloadKeyId: key.keyId
    });
    const built = releaseIndex.buildIndex({
        release: {
            core: payload.core,
            manager: payload.core,
            channel,
            tag: `v${payload.core}`,
            sourceRevision: 'a'.repeat(40),
            lockfileSha256: 'b'.repeat(64),
            builtAt: '2026-10-01T00:00:00Z'
        },
        node: { version: process.versions.node, abi: process.versions.modules },
        compatibility: { minUpgradeFrom, compatibleCore: payload.manifest.release.compatibleCore },
        artifacts: [entry]
    });
    const signer = signWith || key;
    const signed = releaseIndex.signIndex(built, signer.privatePem);
    releaseIndex.writeIndex(dir, signed.index, signed.signature);
    if (corrupt === 'bytes') {
        const bytes = fs.readFileSync(file);
        bytes[Math.floor(bytes.length / 2)] ^= 0xff;
        fs.writeFileSync(file, bytes);
    }
    return { dir, file, name };
}

/** A manager installed from `base` (signed by `key`), with the directory source `sourceDir` and the update seams. */
async function installBase({ roots, key, base, sourceDir = null, policy = null, updateDeps = {}, env = {}, answer }) {
    const root = tempDir(roots, 'update');
    const harness = await newHarness({
        root,
        env: { GOOBSTER_RELEASE_PUBLIC_KEY_FILE: key.publicKeyPath, ...env },
        updateDeps: { runsFromPayload: false, backupEstimate: 0, freeBytes: () => null, ...updateDeps }
    });
    await drive(harness, 'install.new', { source: base.dir, features: ['tavern'], release: { publicKeyFiles: [key.publicKeyPath] }, ...(answer === undefined ? {} : { update: answer }) });
    if (sourceDir || policy) {
        await drive(harness, 'update.policy', { source: { kind: 'directory', dir: sourceDir }, ...(policy || {}) });
    }
    return harness;
}

const controlEnv = settings => ({ GOOBSTER_MANAGER_STATE_DIR: settings.storeDir });

/** Writes the fence acknowledgements the real workers write when the barrier asks them to fence or resume. */
function startResponder({ fakes, settings, names, cleanups }) {
    const env = controlEnv(settings);
    const seen = new Map();
    const behaviour = new Map();
    const requests = [];
    const timer = setInterval(() => {
        for (const name of names) {
            const proc = fakes.last(name);
            if (!proc || proc.exit) continue;
            const control = coreLifecycle.readControl(name, { env });
            const request = control && control.request;
            if (!request || seen.get(name) === request.id) continue;
            seen.set(name, request.id);
            requests.push({ name, type: request.type, fence: request.fence ?? null });
            const b = behaviour.get(name) || {};
            if (b.ignore) continue;
            const state = request.type === 'resume' ? 'resumed' : (request.type === 'maintenance' ? 'fenced' : null);
            if (!state) continue;
            coreMaintenance.writeFenceAck({ worker: name, fence: request.fence, state, pid: proc.pid, env });
        }
    }, 5);
    timer.unref();
    cleanups.push(() => clearInterval(timer));
    return { behave: (name, value) => behaviour.set(name, value), requests };
}

/**
 * Supervised fake workers for an installed harness: a real supervisor over the fake adapter,
 * registered for the manager's store, with a responder that answers the barrier. The supervisor
 * reads `<code>/current` for the release it launched, as the real one does.
 */
async function supervise(harness, { cleanups, policy = {}, tuning = { timeoutScale: 0.05, pollMs: 10, downGraceMs: 150, resumeWaitMs: 300 } } = {}) {
    const fakes = createFakeWorkers();
    const stageModule = require('@goobster/manager/install/release');
    const releaseIdOf = () => {
        try {
            return stageModule.loadManifest(path.join(harness.code, 'current')).releaseId;
        } catch {
            return null;
        }
    };
    tune(harness.settings.storeDir, tuning);
    const supervisor = createSupervisor({
        manager: harness.manager,
        adapter: fakes.adapter,
        checkHealth: fakes.checkHealth,
        sandboxActive: () => false,
        logger: silent,
        policy: { ...FAST_POLICY, ...policy },
        releaseIdOf
    });
    const unregister = registry.register(harness.settings.storeDir, supervisor);
    await supervisor.start();
    const names = (await supervisor.status()).workers.map(worker => worker.name);
    await waitFor(async () => (await supervisor.status()).workers.every(worker => worker.ackedRevision !== null && worker.ackedRevision !== undefined), { what: 'worker acks' });
    const responder = startResponder({ fakes, settings: harness.settings, names, cleanups });
    cleanups.push(async () => {
        tune(harness.settings.storeDir, null);
        await supervisor.stop();
        unregister();
        for (const proc of fakes.alive()) proc.die(0);
    });
    harness.settings.updateDeps.supervisor = supervisor;
    return { fakes, supervisor, responder, names };
}

/** A runChild stand-in: a database with data and a backup that verifies (or does not). */
function fakeChild({ hasData = true, verified = true } = {}) {
    const calls = [];
    const run = async (op, input) => {
        calls.push({ op, input });
        if (op === 'probeTarget') return { hasData };
        if (op === 'backup') {
            const dir = path.join(input.destDir, `backup-${calls.length}`);
            fs.mkdirSync(dir, { recursive: true });
            return { dir, verified, tables: 3, rows: 10, problems: verified ? [] : ['mismatch'], mismatchedTables: verified ? [] : ['t'] };
        }
        throw new Error(`unexpected child op ${op}`);
    };
    run.calls = calls;
    return run;
}

module.exports = { TARGET, DB_DIR, newKey, makePayload, publish, installBase, supervise, fakeChild, startResponder, migrationsText, waitFor };
