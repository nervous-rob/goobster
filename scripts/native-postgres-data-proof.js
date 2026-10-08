'use strict';

// Child of native-postgres-real-distro.js: its own DB facade must select the
// newly provisioned native cluster before any application module opens a DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const quiet = { info() {}, warn() {}, error() {} };
const AUTH = { principal: 'native-distro-proof', via: 'local' };

async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function main() {
    const { createStore } = require('../apps/manager/store/installation');
    const store = createStore({ root: process.env.GOOBSTER_MANAGER_STATE_DIR });
    const installationId = store.readInstallation().doc.installationId;
    assert.equal(installationId, process.env.GOOBSTER_NATIVE_PROOF_CONFIRM, 'only the disposable proof installation may be changed');
    const native = require('../apps/manager/native/state').read(process.env.GOOBSTER_MANAGER_STATE_DIR).doc;
    assert.equal(native.installationId, installationId);
    assert.ok(process.env.GOOBSTER_DB_URL, 'the native application connection is required');
    const original = native.cluster.dataDirectory;
    const target = `${original}-moved`;
    const root = path.dirname(process.env.GOOBSTER_MANAGER_STATE_DIR);
    process.env.GOOBSTER_PG_BIN = native.family === 'rhel' ? '/usr/pgsql-17/bin' : '/usr/lib/postgresql/17/bin';
    for (const tool of ['pg_dump', 'pg_restore']) {
        const version = spawnSync(path.join(process.env.GOOBSTER_PG_BIN, tool), ['--version'], { encoding: 'utf8' });
        assert.equal(version.status, 0, `${tool} must be installed`);
        assert.match(version.stdout, /PostgreSQL\) 17\./, `${tool} must match the native server major`);
    }
    process.env.GOOBSTER_RUNTIME_MODE = 'standalone';
    process.env.GOOBSTER_API_PORT = String(await freePort());
    process.env.GOOBSTER_MANAGER_PORT = String(await freePort());
    process.env.GOOBSTER_DISCORD_ENABLED = '0';
    fs.writeFileSync(process.env.GOOBSTER_CONFIG_PATH, JSON.stringify({ webapp: { enabled: true }, discord: { enabled: false } }), { mode: 0o600 });
    const runtime = await require('../apps/manager/index').main(['--supervise'], { logger: quiet });
    const db = require('@goobster/core/db');
    const run = async (kind, input) => {
        const outcome = await runtime.manager.engine.run(kind, input, AUTH);
        assert.equal(outcome.operation.status, 'applied', `${kind} must apply`);
        return outcome;
    };
    const enter = async () => {
        const { result } = await run('maintenance.enter', { reason: 'native distro qualification', timeoutSeconds: 120 });
        return { operationId: result.operationId, fence: result.fence };
    };
    try {
        const ready = await runtime.supervisor.verifyRunning({ timeoutMs: 120_000, settleMs: 1000 });
        assert.equal(ready.ok, true, `real API worker must be ready: ${ready.code}`);
        assert.equal(db.engine, 'postgres');
        assert.equal(Number((await db.get('SHOW server_version_num')).server_version_num) >= 170000, true);
        await db.run("INSERT INTO users (discordUsername, discordId, username) VALUES ('native-proof', 'native-proof', 'before-backup')");
        let maintenance = await enter();
        const archive = (await run('backup.create', { dir: path.join(root, 'archives'), includeConfig: false })).result;
        assert.equal(archive.engine, 'postgres');
        assert.equal(archive.verified, true);
        assert.equal(archive.verifiedAgainst, 'live-counts');
        await db.run("UPDATE users SET username = 'after-backup' WHERE discordId = 'native-proof'");
        const restored = (await run('backup.restore', { dir: archive.dir, confirm: installationId, withoutConfig: true,
            maintenance, release: true, safetyDir: path.join(root, 'safety') })).result;
        assert.ok(restored.safetyBackup, 'restoring changed data must first write a safety backup');
        // Restore uses a child and restarts the real worker; reconnect this observer.
        await db.closeConnection();
        assert.equal((await db.get("SELECT username FROM users WHERE discordId = 'native-proof'")).username, 'before-backup');
        console.log('PASS: matching native pg_dump/pg_restore through manager backup and restore recover the original row');

        maintenance = await enter();
        const moved = await run('database.native.relocate', { target, maintenance,
            backup: { dir: path.join(root, 'relocation-backup'), skipConfig: true } });
        assert.equal(moved.result.backupVerified, true);
        assert.equal(moved.result.relocated, true);
        assert.equal(moved.result.barrier, 'held');
        const barrier = require('../apps/manager/maintenance/barrier').createBarrier({ settings: runtime.manager.settings }).view();
        assert.equal(barrier.active, true);
        assert.equal(barrier.operationId, maintenance.operationId);
        assert.ok(Object.values(barrier.writers).every(writer => writer.acked), 'real writers acknowledged the fence');
        assert.ok(fs.existsSync(path.join(original, 'PG_VERSION')), 'relocation retains the original data directory');
        assert.ok(fs.existsSync(path.join(target, 'PG_VERSION')));
        await db.closeConnection();
        assert.equal((await db.get("SELECT username FROM users WHERE discordId = 'native-proof'")).username, 'before-backup');
        await run('maintenance.release', maintenance);
        console.log('PASS: manager relocation verifies a backup, holds the real worker fence, retains the original directory, and preserves the row');
    } finally {
        await runtime.stop();
        await db.closeConnection();
    }
}

if (require.main === module) main().catch(error => {
    const reason = error.details && /^[A-Z_]+$/.test(error.details.reason || '') ? ` (${error.details.reason})` : '';
    console.error(`native data proof failed: ${error.code || error.name}${reason}: ${error.message}`);
    process.exitCode = 1;
});
