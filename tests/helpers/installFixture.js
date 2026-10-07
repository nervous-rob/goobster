/**
 * Fixtures for the install engine specs (#329): a synthetic release payload
 * for this host, a manager over a throwaway installation, and a driver that
 * plans, validates and applies an operation the way the CLI does.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const stage = require('../../scripts/lib/payloadStage');
const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const extensions = require('@goobster/manager/extensions');

const silent = { info() {}, warn() {}, error() {} };
const LOCAL = { principal: 'local:cli', via: 'local' };

const FILES = [
    ['app/node_modules/@goobster/core/index.js', 'core', 'module.exports = {};\n'],
    ['app/node_modules/@goobster/core/services/privacyService.js', 'core', 'exports.forget = 1;\n'],
    ['app/apps/bot/index.js', 'core', '// bot entry\n'],
    ['app/node_modules/discord.js/index.js', 'discord', 'exports.Client = 1;\n', { dependency: 'discord.js' }],
    ['app/node_modules/better-sqlite3/index.js', 'core', 'exports.db = 1;\n', { dependency: 'better-sqlite3' }],
    ['app/node_modules/@goobster/core/services/music/player.js', 'music', 'exports.music = 1;\n'],
    ['app/node_modules/@goobster/core/services/tavern/game.js', 'tavern', 'exports.tavern = 1;\n'],
    ['app/node_modules/@goobster/core/services/economy/ledger.js', 'economy', 'exports.economy = 1;\n'],
    ['app/node_modules/@goobster/core/services/exchange/book.js', 'exchange', 'exports.exchange = 1;\n']
];

const GROUPS = {
    core: { files: [], dependencies: ['better-sqlite3'], system: [] },
    discord: { files: [], dependencies: ['discord.js'], requires: [], frontend: [], system: [] },
    music: { files: [], dependencies: [], requires: [], frontend: [], system: [{ name: 'goobster-test-missing-tool', kind: 'binary' }] },
    tavern: { files: [], dependencies: [], requires: [], frontend: [], system: [] },
    economy: { files: [], dependencies: [], requires: [], frontend: [], system: [] },
    exchange: { files: [], dependencies: [], requires: ['economy'], frontend: [], system: [] }
};

const DEPENDENCIES = [
    { name: 'better-sqlite3', version: '12.0.0', path: 'app/node_modules/better-sqlite3', owners: ['core'], exclusive: false },
    { name: 'discord.js', version: '14.0.0', path: 'app/node_modules/discord.js', owners: ['discord'], exclusive: true }
];

const sha = (content) => crypto.createHash('sha256').update(content).digest('hex');

function tempDir(roots, label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `goobster-inst-${label}-`));
    roots.push(dir);
    return dir;
}

/** A full unsigned release payload for this host (platform, arch and Node ABI), written under `parent`. */
function makeRelease(parent, { core = '2.4.0' } = {}) {
    const dir = fs.mkdtempSync(path.join(parent, 'release-'));
    const files = [];
    for (const [rel, owner, content, extra = {}] of FILES) {
        const full = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        files.push({ path: rel, size: Buffer.byteLength(content), sha256: sha(content), owner, ...(extra.dependency ? { dependency: extra.dependency } : {}) });
    }
    const groups = JSON.parse(JSON.stringify(GROUPS));
    for (const file of files) if (!file.dependency) groups[file.owner].files.push(file.path);
    const manifest = {
        version: 1,
        release: { core, compatibleCore: `>=${core} <3.0.0` },
        target: { id: `${process.platform}-${process.arch}`, platform: process.platform, arch: process.arch },
        node: { version: process.versions.node, abi: process.versions.modules },
        groups,
        files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
        dependencies: DEPENDENCIES,
        frontend: { chunks: [] },
        unreferenced: []
    };
    stage.writeManifest(dir, manifest);
    return { dir, manifest };
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

/**
 * A manager over `<root>/app` with the engine's extension kinds registered.
 * `env` and `installDeps` override the environment and the engine's seams.
 */
async function newHarness({ root, env = {}, installDeps = {}, hooks, port, now } = {}) {
    const code = path.join(root, 'app');
    fs.mkdirSync(code, { recursive: true });
    const botPort = port || await freePort();
    const settings = resolveSettings({
        PATH: process.env.PATH,
        HOME: root,
        GOOBSTER_WORKSPACE_ROOT: code,
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0',
        PORT: String(botPort),
        GOOBSTER_API_PORT: String(await freePort()),
        ...env
    });
    settings.installDeps = { home: root, readCrontab: () => null, writeCrontab: () => {}, discover: () => ({ candidates: [], searched: 0 }), ...installDeps };
    const manager = createManager({ settings, hooks, logger: silent, extraKinds: extensions.kinds, ...(now ? { now } : {}) });
    await manager.init({ mintBootstrap: false });
    return { root, code, settings, manager, botPort };
}

/** plan → validate → apply, as the CLI does. Returns `{ planned, applied }`; a failure carries `error.operation`. */
async function drive(harness, kind, input, { auth = LOCAL, apply = true } = {}) {
    const { engine } = harness.manager;
    const planned = await engine.plan(kind, input, auth, { internal: true });
    if (!apply) return { planned };
    const validated = await engine.validate(planned.id, auth);
    const applied = await engine.apply(validated.id, { revision: validated.revision }, auth);
    return { planned, applied };
}

async function codeOf(promise) {
    try {
        await promise;
    } catch (error) {
        return error.code;
    }
    return 'OK';
}

/** A stable digest of every file and directory under `dir` (names, kinds, link targets, file bytes). */
function snapshot(dir) {
    const out = [];
    const walk = (current) => {
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const full = path.join(current, entry.name);
            const rel = path.relative(dir, full);
            if (entry.isSymbolicLink()) out.push(`L ${rel} -> ${fs.readlinkSync(full)}`);
            else if (entry.isDirectory()) {
                out.push(`D ${rel}`);
                walk(full);
            } else out.push(`F ${rel} ${sha(fs.readFileSync(full))}`);
        }
    };
    walk(dir);
    return out.join('\n');
}

module.exports = { LOCAL, FILES, GROUPS, makeRelease, newHarness, drive, codeOf, freePort, snapshot, tempDir, silent };
