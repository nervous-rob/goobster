'use strict';
/**
 * The real-distro journey of the native PostgreSQL option (#340), run by
 * .github/workflows/native-postgres.yml; documentation/native_postgres.md.
 * Runs on a REAL Debian/Ubuntu/Rocky host as root (or with passwordless sudo), against a
 * claimed throwaway installation in a temp store. It drives the real manager CLI, which
 * drives the real privileged helper, which runs the real apt, dnf, the pg_ tools and systemctl.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');

const cli = require('../apps/manager/cli');
const environment = require('../apps/manager/environment');
const { resolveSettings } = require('../apps/manager/settings');
const { createStore } = require('../apps/manager/store/installation');
const { createNativeService } = require('../apps/manager/native/service');

const sh = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', ...options });
const listening = port => new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });

/** The pre-existing cluster's configuration, identity and state: what must not change. */
function foreignFingerprint(etcRoot = '/etc', rhelData = '/var/lib/pgsql/data') {
    const hash = file => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return 'unreadable'; } };
    const walk = (current, into) => {
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries.sort((x, y) => x.name.localeCompare(y.name))) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full, into);
            else into.push(`${full}:${hash(full)}`);
        }
    };
    const files = [];
    let state = [];
    const listed = sh('pg_lsclusters', ['--no-header']);
    const main = listed.status === 0 ? (listed.stdout || '').split('\n').find(line => /\bmain\b/.test(line)) : null;
    if (main) {
        const fields = main.trim().split(/\s+/);
        state = fields.slice(0, 5);
        walk(`${etcRoot}/postgresql/${fields[0]}/main`, files);
        for (const name of ['PG_VERSION', 'postgresql.auto.conf']) files.push(`${name}:${hash(path.join(fields[5], name))}`);
    } else if (fs.existsSync(rhelData)) {
        state = [sh('systemctl', ['is-active', 'postgresql']).stdout.trim()];
        for (const name of ['postgresql.conf', 'postgresql.auto.conf', 'pg_hba.conf', 'pg_ident.conf', 'PG_VERSION']) files.push(`${name}:${hash(path.join(rhelData, name))}`);
    }
    return JSON.stringify({ state, files });
}

async function main({ io = {}, seams = {}, log = console.log } = {}) {
    const up = seams.listening || listening;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-real-'));
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const env = { ...process.env, HOME: root, GOOBSTER_DATA_DIR: path.join(root, 'data'), GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'), GOOBSTER_MANAGER_STATE_DIR: path.join(root, 'store'), GOOBSTER_MANAGER_PORT: '0', GOOBSTER_MANAGER_RECONCILE: '0' };
    fs.writeFileSync(env.GOOBSTER_CONFIG_PATH, '{}\n', { mode: 0o600 });
    const settings = resolveSettings(env);
    createStore({ root: settings.storeDir }).init();
    const store = createStore({ root: settings.storeDir });
    store.createInstallation({ origin: 'claim', ownerLabel: 'Real-distro proof' });
    const installationId = store.readInstallation().doc.installationId;

    const run = async (argv, answers) => {
        const args = ['--json', ...argv];
        if (answers) {
            const file = path.join(root, `answers-${crypto.randomBytes(3).toString('hex')}.json`);
            fs.writeFileSync(file, JSON.stringify({ command: 'database', ...answers }), { mode: 0o600 });
            args.push('--answers', file, '--yes');
        }
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let text = '';
        stdout.on('data', chunk => { text += chunk; });
        stderr.on('data', () => {});
        const code = await cli.run(args, { env, stdout, stderr, ...io });
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { code, json, text };
    };

    const etc = seams.etcRoot || '/etc';
    const before = foreignFingerprint(etc);
    const hadMain = JSON.parse(before).state.length > 0;
    assert.ok(hadMain, 'the job must create a pre-existing cluster first');
    log(`pre-existing cluster fingerprint taken (present: ${hadMain})`);

    const status = await run(['database', 'native', 'status']);
    assert.equal(status.code, 0, 'status exits 0 on a supported host');
    assert.equal(status.json.native.host.supported, true);
    log(`host: ${status.json.native.host.distro.label}`);
    const mainPort = Number(((status.json.native.host.clusters.find(item => !item.owned) || {}).port)) || 5432;

    // 1. a port conflict is refused with the next port proposed; nothing is created.
    const conflict = await run(['database', 'native', 'provision'], { port: mainPort, installPackages: true });
    assert.notEqual(conflict.code, 0, 'a taken port is refused');
    assert.match(conflict.text, /PORT_IN_USE/);
    assert.equal((await run(['database', 'native', 'status'])).json.native.record, null, 'nothing was recorded');
    log(`port ${mainPort} refused (PORT_IN_USE)`);

    // 2. a fresh provision beside the existing cluster, with a custom data directory, on the next port.
    const port = mainPort + 1;
    const dataDirectory = process.env.GOOBSTER_PROOF_DATADIR || '/srv/goobster-pg';
    const provisioned = await run(['database', 'native', 'provision'], { port, dataDirectory, installPackages: true });
    assert.equal(provisioned.code, 0, provisioned.text);
    assert.ok(fs.existsSync(path.join(dataDirectory, 'PG_VERSION')), 'data lives in the chosen directory');
    assert.ok(fs.existsSync(path.join(dataDirectory, 'goobster-installation')), 'the ownership marker is there');
    assert.ok(await up(port), 'the new cluster accepts connections');
    log(`provisioned on ${port}, data in ${dataDirectory}`);

    // 3. the application role: NOSUPERUSER, with the extensions, reachable with the staged URL only.
    const url = environment.read(settings.storeDir).values.GOOBSTER_NATIVE_DB_URL;
    assert.ok(url, 'the URL is staged');
    if (!seams.skipClient) {
        const { Client } = require('pg');
        const client = new Client({ connectionString: url });
        await client.connect();
        const role = (await client.query('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user')).rows[0];
        assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
        const extensions = (await client.query("SELECT extname FROM pg_extension WHERE extname IN ('vector','citext') ORDER BY 1")).rows.map(row => row.extname);
        assert.deepEqual(extensions, ['citext', 'vector']);
        assert.ok((await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n > 50, 'the schema is applied');
        await client.end();
    }
    const password = decodeURIComponent(new URL(url).password);
    const processes = sh('ps', ['-eo', 'args']).stdout;
    assert.ok(!processes.includes(password), 'no password in any process argv');

    // 4. stop and start.
    assert.equal((await run(['database', 'native', 'stop'], {})).code, 0);
    assert.equal(await up(port), false);
    assert.equal((await run(['database', 'native', 'start'], {})).code, 0);
    assert.ok(await up(port));
    log('stop and start');

    // 5. repair a stopped cluster.
    assert.equal((await run(['database', 'native', 'stop'], {})).code, 0);
    const repaired = await run(['database', 'native', 'repair'], {});
    assert.equal(repaired.code, 0, repaired.text);
    assert.ok(await up(port));
    log('repair');

    // 6. A fresh process selects the native DB before loading the facade. Drive
    //    real workers, maintenance, matching-client backup/restore and the manager's
    //    relocation kind, including its verified backup (not only the helper).
    const target = `${dataDirectory}-moved`;
    const proof = sh(process.execPath, [path.join(__dirname, 'native-postgres-data-proof.js')], {
        env: { ...env, GOOBSTER_DB_URL: url, GOOBSTER_NATIVE_PROOF_CONFIRM: installationId },
        timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024
    });
    const clean = text => String(text || '').split(url).join('[database URL]').split(password).join('[password]');
    log(clean(proof.stdout));
    assert.equal(proof.status, 0, `manager data journey failed: ${clean(proof.stderr)}`);
    assert.ok(fs.existsSync(path.join(target, 'PG_VERSION')) && fs.existsSync(path.join(dataDirectory, 'PG_VERSION')), 'the new directory serves and the original is kept');
    assert.ok(await up(port), 'the cluster is up from the new directory');
    log('relocate');

    // 7. removal keeps the data, then removes exactly ours.
    const kept = await createNativeService({ settings, logger: { info() {}, warn() {}, error() {} } }).retire({ installationId, remove: false });
    assert.equal(kept.removed, false);
    assert.ok(fs.existsSync(path.join(target, 'PG_VERSION')), 'keep-data removal leaves the data');
    const gone = await createNativeService({ settings, logger: { info() {}, warn() {}, error() {} } }).retire({ installationId, remove: true });
    assert.equal(gone.removed, true);
    assert.equal(fs.existsSync(target), false, 'the cluster\'s data directory is gone');
    assert.ok(fs.existsSync(path.join(dataDirectory, 'PG_VERSION')), 'the directory a relocation left behind is never deleted');
    log('removal');

    // 8. the pre-existing cluster is exactly as it was.
    assert.equal(foreignFingerprint(etc), before, 'the pre-existing cluster changed');
    log('pre-existing cluster untouched');
    fs.rmSync(root, { recursive: true, force: true });
}

module.exports = { main };
if (require.main === module) main().then(() => console.log('REAL-DISTRO PROOF PASSED'), (error) => { console.error(error); process.exit(1); });
