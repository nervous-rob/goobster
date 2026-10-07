/**
 * Manager boot (#323): the manager starts and answers GET
 * /manager/api/status with no config.json, no keys or Discord, an
 * unreachable Postgres URL, a corrupt or unreadable SQLite file, a missing
 * store next to an existing installation (recovery, never unclaimed) and a
 * corrupt store. Child-process probes prove the boot path loads neither the
 * application database, the web app, a service, Discord nor a driver, and
 * that a missing or corrupt store leaves the app database untouched.
 * Transport: loopback by default, LAN only with TLS.
 */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { main } = require('@goobster/manager');
const { resolveSettings, validateTransport } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createStore } = require('@goobster/manager/store/installation');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-323-boot-'));
const MANAGER_ENTRY = require.resolve('@goobster/manager');
const silent = { info() {}, warn() {}, error() {} };
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const running = [];

const FORBIDDEN_AT_BOOT = [
    /[\\/]packages[\\/]core[\\/]db[\\/]/,
    /[\\/]packages[\\/]core[\\/]web[\\/]appApi/,
    /[\\/]packages[\\/]core[\\/]web[\\/]routes[\\/]/,
    /[\\/]packages[\\/]core[\\/]services[\\/]/,
    /[\\/]packages[\\/]core[\\/]gateway[\\/]/,
    /[\\/]packages[\\/]core[\\/]config[\\/]/,
    /[\\/]packages[\\/]core[\\/]features[\\/]/,
    /[\\/]packages[\\/]core[\\/]utils[\\/]logger/,
    /[\\/]apps[\\/](bot|api|web|sandbox|mcp)[\\/]/,
    /[\\/]node_modules[\\/](discord\.js|@discordjs|better-sqlite3|sqlite-vec|pg|pg-pool|winston|openai|@anthropic-ai|@google)[\\/]/
];

function newRoot(name) {
    const dir = path.join(ROOT, `${name}-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function envFor(root, extra = {}) {
    return {
        GOOBSTER_DATA_DIR: path.join(root, 'data'),
        GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0',
        PATH: process.env.PATH,
        ...extra
    };
}

function sink(isTTY = false) {
    let text = '';
    return { isTTY, write: (chunk) => { text += chunk; }, text: () => text };
}

async function closedPort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

function getStatus(port, { host = `127.0.0.1:${port}`, client = http, extra = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = client.request({ host: '127.0.0.1', port, path: '/manager/api/status', headers: { host }, ...extra }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, text: data, body: JSON.parse(data) }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function boot(env, { stdout = sink() } = {}) {
    const started = Date.now();
    const outcome = await main([], { env, stdout, logger: silent });
    expect(outcome.code).toBe(0);
    running.push(outcome);
    const res = await getStatus(outcome.server.address().port);
    return { ...res, outcome, stdout, elapsed: Date.now() - started };
}

function sqliteGarbage(settings) {
    fs.mkdirSync(path.dirname(settings.sqlitePath), { recursive: true });
    const bytes = crypto.randomBytes(8192);
    fs.writeFileSync(settings.sqlitePath, bytes);
    return bytes;
}

function seedClaimed(settings) {
    const store = createStore({ root: settings.storeDir });
    store.init();
    return store.createInstallation({ origin: 'claim', ownerLabel: 'Rob' });
}

/** Run the manager in a fresh Node process, query it, and report what it loaded. */
function childProbe(env, { mutate = false } = {}) {
    const script = `
        const { main } = require(${JSON.stringify(MANAGER_ENTRY)});
        const silent = { info() {}, warn() {}, error() {} };
        main([], { env: process.env, stdout: { isTTY: false, write() {} }, logger: silent }).then(async (outcome) => {
            const base = 'http://127.0.0.1:' + outcome.server.address().port + '/manager/api';
            const status = await (await fetch(base + '/status')).json();
            const attempts = [];
            if (${mutate}) {
                for (const body of [{ kind: 'adopt', input: { label: 'x' } }, { kind: 'features.set', input: { changes: { gba: true } } }]) {
                    const res = await fetch(base + '/operations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                    attempts.push(res.status);
                }
            }
            const loaded = Object.keys(require.cache);
            await outcome.stop();
            process.stdout.write(JSON.stringify({ status, attempts, loaded }));
            process.exit(0);
        }).catch((error) => { process.stderr.write(String(error && error.stack)); process.exit(2); });
    `;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(`probe exited ${code}: ${err.slice(0, 500)}`));
            resolve(JSON.parse(out));
        });
    });
}

function expectNothingHeavyLoaded(loaded) {
    const offenders = loaded.filter(file => FORBIDDEN_AT_BOOT.some(re => re.test(file)));
    expect(offenders).toEqual([]);
}

afterAll(async () => {
    for (const outcome of running) await outcome.stop();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('boot matrix', () => {
    test('missing config.json, no keys, no Discord: unclaimed, store created owner-only, credential not printed off a TTY', async () => {
        const root = newRoot('fresh');
        const res = await boot(envFor(root));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            service: 'goobster-manager', state: 'unclaimed', reason: null, existingInstallation: false,
            config: { present: false, readable: false },
            appDatabase: { engine: 'sqlite', present: false, reachable: false, reason: 'NOT_FOUND' },
            setup: { bootstrapPending: true }
        });
        const settings = resolveSettings(envFor(root));
        const credential = fs.readFileSync(path.join(settings.storeDir, 'bootstrap-credential'), 'utf8').trim();
        expect(res.text).not.toContain(credential);
        expect(res.stdout.text()).not.toContain(credential);
        expect(res.stdout.text()).toContain('bootstrap-credential');
        expect(fs.readFileSync(path.join(settings.storeDir, 'bootstrap.json'), 'utf8')).not.toContain(credential);
        if (process.platform !== 'win32') {
            expect(fs.statSync(settings.storeDir).mode & 0o777).toBe(0o700);
            expect(fs.statSync(path.join(settings.storeDir, 'bootstrap.json')).mode & 0o777).toBe(0o600);
            expect(fs.statSync(path.join(settings.storeDir, 'bootstrap-credential')).mode & 0o777).toBe(0o600);
        }
        expect(fs.existsSync(path.join(settings.storeDir, 'installation.json'))).toBe(false);
        expect(fs.existsSync(settings.sqlitePath)).toBe(false);
    });

    test('on a TTY the bootstrap credential is printed once', async () => {
        const root = newRoot('tty');
        const stdout = sink(true);
        await boot(envFor(root), { stdout });
        const credential = fs.readFileSync(path.join(resolveSettings(envFor(root)).storeDir, 'bootstrap-credential'), 'utf8').trim();
        expect(stdout.text().split(credential).length - 1).toBe(1);
    });

    test('an unreadable config.json and a config without keys or Discord are reported, never fatal', async () => {
        const root = newRoot('config');
        fs.writeFileSync(path.join(root, 'config.json'), '{ "token": ');
        expect((await boot(envFor(root))).body.config).toEqual({ present: true, readable: false });
        const other = newRoot('nokeys');
        fs.writeFileSync(path.join(other, 'config.json'), JSON.stringify({ ai: { provider: '' }, discord: { enabled: false } }));
        const res = await boot(envFor(other));
        expect(res.body).toMatchObject({ state: 'unclaimed', config: { present: true, readable: true } });
    });

    test('an unreachable Postgres URL: recovery without a store, claimed with one; bounded; the URL never shown', async () => {
        const port = await closedPort();
        const url = `postgres://goobster:pw-${crypto.randomBytes(6).toString('hex')}@127.0.0.1:${port}/goobster`;
        const root = newRoot('pg');
        const res = await boot(envFor(root, { GOOBSTER_DB_URL: url }));
        expect(res.body).toMatchObject({
            state: 'recovery', reason: 'MANAGER_STORE_MISSING', existingInstallation: true,
            appDatabase: { engine: 'postgres', present: true, reachable: false, reason: 'POSTGRES_UNREACHABLE' }
        });
        expect(res.body.setup).toBeUndefined();
        expect(res.elapsed).toBeLessThan(5000);
        expect(res.text).not.toContain(url.split('@')[0].split(':')[2]);
        expect(res.text).not.toContain(String(port));

        const claimedRoot = newRoot('pg-claimed');
        seedClaimed(resolveSettings(envFor(claimedRoot)));
        const claimed = await boot(envFor(claimedRoot, { GOOBSTER_DB_URL: url }));
        expect(claimed.body).toMatchObject({ state: 'claimed', appDatabase: { reachable: false, reason: 'POSTGRES_UNREACHABLE' } });
    });

    test('the Postgres probe is bounded even when the host never answers', async () => {
        const root = newRoot('pg-blackhole');
        const settings = resolveSettings(envFor(root, { GOOBSTER_DB_URL: 'postgres://u:p@10.255.255.1:5432/x' }));
        const manager = createManager({ settings, probeTimeoutMs: 300, logger: silent });
        const started = Date.now();
        const status = await manager.status();
        expect(Date.now() - started).toBeLessThan(2000);
        expect(status.appDatabase).toMatchObject({ engine: 'postgres', reachable: false, reason: 'POSTGRES_UNREACHABLE' });
    });

    test('a corrupt SQLite file: recovery without a store, claimed (unreachable) with one; the file is never touched', async () => {
        const root = newRoot('sqlite-garbage');
        const settings = resolveSettings(envFor(root));
        const bytes = sqliteGarbage(settings);
        const res = await boot(envFor(root));
        expect(res.body).toMatchObject({
            state: 'recovery', reason: 'MANAGER_STORE_MISSING',
            appDatabase: { engine: 'sqlite', present: true, reachable: false, reason: 'SQLITE_CORRUPT' }
        });
        expect(fs.readFileSync(settings.sqlitePath).equals(bytes)).toBe(true);

        const claimedRoot = newRoot('sqlite-garbage-claimed');
        const claimedSettings = resolveSettings(envFor(claimedRoot));
        seedClaimed(claimedSettings);
        sqliteGarbage(claimedSettings);
        const claimed = await boot(envFor(claimedRoot));
        expect(claimed.body).toMatchObject({ state: 'claimed', appDatabase: { reachable: false, reason: 'SQLITE_CORRUPT' } });
    });

    (IS_ROOT ? test.skip : test)('an unreadable SQLite file is reported as unreadable', async () => {
        const root = newRoot('sqlite-unreadable');
        const settings = resolveSettings(envFor(root));
        sqliteGarbage(settings);
        fs.chmodSync(settings.sqlitePath, 0o000);
        try {
            const res = await boot(envFor(root));
            expect(res.body).toMatchObject({ state: 'recovery', appDatabase: { present: true, reachable: false, reason: 'SQLITE_UNREADABLE' } });
        } finally {
            fs.chmodSync(settings.sqlitePath, 0o600);
        }
    });

    test('a missing store next to an existing installation is recovery, never unclaimed; first-time setup stays closed', async () => {
        for (const make of [
            (s) => { fs.mkdirSync(path.dirname(s.sqlitePath), { recursive: true }); fs.writeFileSync(s.sqlitePath, Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.alloc(4080)])); },
            (s) => { fs.mkdirSync(path.dirname(s.sqlitePath), { recursive: true }); fs.writeFileSync(`${s.sqlitePath}-wal`, ''); },
            (s) => { fs.mkdirSync(s.dataDir, { recursive: true }); fs.writeFileSync(s.featuresPath, '{}'); }
        ]) {
            const root = newRoot('store-missing');
            const settings = resolveSettings(envFor(root));
            make(settings);
            const res = await boot(envFor(root));
            expect(res.body).toMatchObject({ state: 'recovery', reason: 'MANAGER_STORE_MISSING', existingInstallation: true });
            expect(res.body.setup).toBeUndefined();
            expect(fs.existsSync(path.join(settings.storeDir, 'bootstrap.json'))).toBe(false);
            expect(fs.existsSync(path.join(settings.storeDir, 'installation.json'))).toBe(false);
        }
    });

    test('a corrupt or future-version store is recovery even with no app database, and is left as it is', async () => {
        for (const [content, reason] of [['\u0000\u0001garbage', 'MANAGER_STORE_CORRUPT'], [JSON.stringify({ version: 2, installationId: 'x' }), 'MANAGER_STORE_UNSUPPORTED']]) {
            const root = newRoot('store-corrupt');
            const settings = resolveSettings(envFor(root));
            fs.mkdirSync(settings.storeDir, { recursive: true });
            fs.writeFileSync(path.join(settings.storeDir, 'installation.json'), content);
            const res = await boot(envFor(root));
            expect(res.body).toMatchObject({ state: 'recovery', reason });
            expect(fs.readFileSync(path.join(settings.storeDir, 'installation.json'), 'utf8')).toBe(content);
            expect(fs.existsSync(path.join(settings.storeDir, 'bootstrap.json'))).toBe(false);
        }
    });

    (IS_ROOT || process.platform === 'win32' ? test.skip : test)('a store that cannot be written still serves status, in recovery', async () => {
        const root = newRoot('store-readonly');
        const locked = path.join(root, 'locked');
        fs.mkdirSync(locked, { mode: 0o500 });
        try {
            const res = await boot(envFor(root, { GOOBSTER_MANAGER_STATE_DIR: path.join(locked, 'manager') }));
            expect(res.body).toMatchObject({ state: 'recovery', reason: 'MANAGER_STORE_UNREADABLE' });
        } finally {
            fs.chmodSync(locked, 0o700);
        }
    });

    test('a claimed store keeps its identity across restarts', async () => {
        const root = newRoot('restart');
        const first = await boot(envFor(root));
        const credential = fs.readFileSync(path.join(resolveSettings(envFor(root)).storeDir, 'bootstrap-credential'), 'utf8').trim();
        const port = first.outcome.server.address().port;
        const claimed = await new Promise((resolve, reject) => {
            const body = JSON.stringify({ credential, label: 'Rob' });
            const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/manager/api/claim', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => resolve(JSON.parse(data)));
            });
            req.on('error', reject);
            req.end(body);
        });
        await first.outcome.stop();
        const second = await boot(envFor(root));
        expect(second.body).toMatchObject({ state: 'claimed', installation: { installationId: claimed.installationId, claimed: true, origin: 'claim' } });
        expect(second.text).not.toContain('Rob');
    });
});

describe('module isolation (child process)', () => {
    test('a fresh boot loads no database, web app, service, Discord or driver', async () => {
        const root = newRoot('probe-fresh');
        const result = await childProbe(envFor(root));
        expect(result.status.state).toBe('unclaimed');
        expectNothingHeavyLoaded(result.loaded);
        expect(result.loaded.some(file => file.endsWith(path.join('apps', 'manager', 'index.js')))).toBe(true);
    });

    test('a corrupt store next to a corrupt app database: no adoption, no DB open, the DB file unchanged', async () => {
        const root = newRoot('probe-corrupt');
        const settings = resolveSettings(envFor(root));
        const bytes = sqliteGarbage(settings);
        fs.mkdirSync(settings.storeDir, { recursive: true });
        fs.writeFileSync(path.join(settings.storeDir, 'installation.json'), 'not json');
        const before = fs.statSync(settings.sqlitePath).mtimeMs;
        const result = await childProbe(envFor(root), { mutate: true });
        expect(result.status).toMatchObject({ state: 'recovery', reason: 'MANAGER_STORE_CORRUPT' });
        expect(result.attempts).toEqual([401, 401]);
        expectNothingHeavyLoaded(result.loaded);
        expect(fs.readFileSync(settings.sqlitePath).equals(bytes)).toBe(true);
        expect(fs.statSync(settings.sqlitePath).mtimeMs).toBe(before);
        expect(fs.readFileSync(path.join(settings.storeDir, 'installation.json'), 'utf8')).toBe('not json');
        expect(fs.readdirSync(path.join(settings.storeDir, 'operations'))).toEqual([]);
    });

    test('a missing store with an unreachable Postgres URL loads no driver', async () => {
        const root = newRoot('probe-pg');
        const result = await childProbe(envFor(root, { GOOBSTER_DB_URL: `postgres://u:p@127.0.0.1:${await closedPort()}/x` }), { mutate: true });
        expect(result.status).toMatchObject({ state: 'recovery', reason: 'MANAGER_STORE_MISSING' });
        expect(result.attempts).toEqual([401, 401]);
        expectNothingHeavyLoaded(result.loaded);
    });

    test('requiring the entry point starts nothing', () => {
        const out = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(MANAGER_ENTRY)}); console.log('loaded')`], {
            env: envFor(newRoot('require')), timeout: 10_000, encoding: 'utf8'
        });
        expect(out.status).toBe(0);
        expect(out.stdout.trim()).toBe('loaded');
    });
});

describe('transport', () => {
    test('non-loopback binds need LAN mode, LAN mode needs TLS and a LAN host name', async () => {
        const root = newRoot('transport');
        const code = (settings) => {
            try {
                validateTransport(settings);
                return null;
            } catch (error) {
                return error.code;
            }
        };
        expect(code(resolveSettings(envFor(root)))).toBeNull();
        expect(code(resolveSettings(envFor(root, { GOOBSTER_MANAGER_HOST: '0.0.0.0' })))).toBe('NON_LOOPBACK_REFUSED');
        expect(code(resolveSettings(envFor(root, { GOOBSTER_MANAGER_HOST: '192.168.1.20' })))).toBe('NON_LOOPBACK_REFUSED');
        expect(code(resolveSettings(envFor(root, { GOOBSTER_MANAGER_LAN: '1' })))).toBe('LAN_REQUIRES_TLS');
        expect(code(resolveSettings(envFor(root, { GOOBSTER_MANAGER_LAN: '1', GOOBSTER_MANAGER_TLS_CERT: '/x', GOOBSTER_MANAGER_TLS_KEY: '/y' })))).toBe('LAN_REQUIRES_HOST');
        expect(code(resolveSettings(envFor(root, { GOOBSTER_MANAGER_LAN: '1', GOOBSTER_MANAGER_TLS_CERT: '/x', GOOBSTER_MANAGER_TLS_KEY: '/y', GOOBSTER_MANAGER_LAN_HOST: 'pi.lan' })))).toBe('TLS_UNREADABLE');
        expect(code(resolveSettings(envFor(root, { GOOBSTER_MANAGER_PORT: 'abc' })))).toBe('BAD_PORT');

        const errors = [];
        const refused = await main([], { env: envFor(root, { GOOBSTER_MANAGER_HOST: '0.0.0.0' }), stdout: sink(), logger: { ...silent, error: (m) => errors.push(m) } });
        expect(refused.code).toBe(1);
        expect(refused.server).toBeUndefined();
        expect(errors.join(' ')).toMatch(/SSH tunnel/);
        expect(fs.existsSync(path.join(root, 'data', 'manager'))).toBe(false);
    });

    const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
    (hasOpenssl ? test : test.skip)('LAN mode serves HTTPS only and checks the LAN host name', async () => {
        const root = newRoot('tls');
        const cert = path.join(root, 'cert.pem');
        const key = path.join(root, 'key.pem');
        const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
            '-days', '1', '-subj', '/CN=pi.lan'], { encoding: 'utf8' });
        expect(made.status).toBe(0);
        const env = envFor(root, {
            GOOBSTER_MANAGER_LAN: '1', GOOBSTER_MANAGER_HOST: '127.0.0.1',
            GOOBSTER_MANAGER_TLS_CERT: cert, GOOBSTER_MANAGER_TLS_KEY: key, GOOBSTER_MANAGER_LAN_HOST: 'pi.lan'
        });
        const outcome = await main([], { env, stdout: sink(), logger: silent });
        running.push(outcome);
        const port = outcome.server.address().port;
        const tls = { rejectUnauthorized: false };
        const lan = await getStatus(port, { host: `pi.lan:${port}`, client: https, extra: tls });
        expect(lan.status).toBe(200);
        expect(lan.body.transport).toEqual({ lan: true, tls: true });
        const wrong = await getStatus(port, { host: `evil.example:${port}`, client: https, extra: tls });
        expect(wrong.status).toBe(421);
        await expect(getStatus(port)).rejects.toBeTruthy();
    });
});

describe('CLI', () => {
    test('--help and --status work without serving', async () => {
        const root = newRoot('cli');
        const help = sink();
        expect((await main(['--help'], { env: envFor(root), stdout: help, logger: silent })).code).toBe(0);
        expect(help.text()).toMatch(/--mint-recovery/);
        const status = sink();
        const outcome = await main(['--status'], { env: envFor(root), stdout: status, logger: silent });
        expect(outcome.code).toBe(0);
        expect(outcome.server).toBeUndefined();
        expect(JSON.parse(status.text()).state).toBe('unclaimed');
    });
});
