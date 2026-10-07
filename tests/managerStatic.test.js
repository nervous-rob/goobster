/**
 * The manager serves the setup client's static files (#330): /manager/,
 * /manager/setup and /manager/recovery return the same page with their own
 * strict headers; assets come from the bundle's own folder only; a missing
 * build answers a plain page instead of failing; the JSON-only API keeps
 * its contract; and serving the client loads no application module.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createManagerApp } = require('@goobster/manager/server');
const staticClient = require('@goobster/manager/static');
const extensions = require('@goobster/manager/extensions');

const silent = { info() {}, warn() {}, error() {} };
const MANAGER_ENTRY = require.resolve('@goobster/manager');
const roots = [];
const servers = [];

const FORBIDDEN_AT_BOOT = [
    /[\\/]packages[\\/]core[\\/]db[\\/]/,
    /[\\/]packages[\\/]core[\\/]web[\\/]appApi/,
    /[\\/]packages[\\/]core[\\/]services[\\/]/,
    /[\\/]packages[\\/]core[\\/]gateway[\\/]/,
    /[\\/]packages[\\/]core[\\/]utils[\\/]logger/,
    /[\\/]apps[\\/](bot|api|web|sandbox|mcp)[\\/]/,
    /[\\/]node_modules[\\/](discord\.js|@discordjs|better-sqlite3|sqlite-vec|pg|pg-pool|winston|openai|@anthropic-ai|@google)[\\/]/
];

afterAll(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-330-static-'));
    roots.push(dir);
    return dir;
}

function buildClient(root) {
    const dist = path.join(root, 'apps', 'web', 'dist', 'setup');
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/manager/assets/main-abc123.js"></script></body></html>');
    fs.writeFileSync(path.join(dist, 'assets', 'main-abc123.js'), 'console.log("setup");');
    fs.writeFileSync(path.join(dist, 'assets', 'main-abc123.css'), 'body{margin:0}');
    fs.writeFileSync(path.join(dist, 'assets', 'main-abc123.js.map'), '{}');
    fs.writeFileSync(path.join(root, 'secret.js'), 'module.exports = "secret";');
    return dist;
}

async function start({ root = tempRoot(), built = true } = {}) {
    if (built) buildClient(root);
    const settings = resolveSettings({
        GOOBSTER_WORKSPACE_ROOT: root,
        GOOBSTER_DATA_DIR: path.join(root, 'data'),
        GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0'
    });
    const manager = createManager({ settings, logger: silent, extraKinds: extensions.kinds });
    await manager.init();
    const app = createManagerApp(manager, { logger: silent, mounts: extensions.routes });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const port = server.address().port;
    const get = (reqPath, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
    return { root, settings, manager, port, get };
}

describe('pages', () => {
    test.each(['/manager', '/manager/', '/manager/setup', '/manager/recovery'])('%s serves the client with its own headers', async (page) => {
        const h = await start();
        const res = await h.get(page);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/html/);
        expect(res.text).toContain('<div id="root">');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        const csp = res.headers['content-security-policy'];
        expect(csp).toBe(staticClient.CSP);
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("connect-src 'self'");
        expect(csp).toContain("img-src 'self' data:");
        expect(csp).toContain("style-src 'self' 'unsafe-inline'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).not.toMatch(/script-src[^;]*unsafe/);
        expect(res.headers['set-cookie']).toBeUndefined();
    });

    test('a request for another Host is refused like every manager route', async () => {
        const h = await start();
        const res = await h.get('/manager/', { host: 'evil.example' });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.text).not.toContain('<div id="root">');
    });

    test('POST to a page is not a page', async () => {
        const h = await start();
        const res = await h.get('/manager/setup', {}, 'POST');
        expect(res.status).toBe(404);
    });
});

describe('assets', () => {
    test('scripts and styles are served with their type, nosniff and long caching', async () => {
        const h = await start();
        const js = await h.get('/manager/assets/main-abc123.js');
        expect(js.status).toBe(200);
        expect(js.headers['content-type']).toMatch(/^text\/javascript/);
        expect(js.headers['x-content-type-options']).toBe('nosniff');
        expect(js.headers['cache-control']).toContain('immutable');
        expect(js.text).toContain('setup');
        const css = await h.get('/manager/assets/main-abc123.css');
        expect(css.headers['content-type']).toMatch(/^text\/css/);
    });

    test('unknown files, source maps, traversal and other extensions are 404', async () => {
        const h = await start();
        for (const target of ['/manager/assets/nope.js', '/manager/assets/main-abc123.js.map', '/manager/assets/..%2f..%2f..%2f..%2fsecret.js',
            '/manager/assets/%2e%2e%2fsecret.js', '/manager/assets/main-abc123.txt', '/manager/assets/.hidden.js']) {
            const res = await h.get(target);
            expect(res.status).toBe(404);
            expect(res.text).not.toContain('secret');
        }
    });

    test('a symlinked asset that leaves the folder is not served', async () => {
        if (process.platform === 'win32') return;
        const h = await start();
        const link = path.join(h.root, 'apps', 'web', 'dist', 'setup', 'assets', 'leak.js');
        fs.symlinkSync(path.join(h.root, 'secret.js'), link);
        const res = await h.get('/manager/assets/leak.js');
        expect(res.status).toBe(404);
    });
});

describe('when the client is not built', () => {
    test('the page is a plain 503 explanation, never a crash, and says what to run', async () => {
        const h = await start({ built: false });
        const res = await h.get('/manager/');
        expect(res.status).toBe(503);
        expect(res.text).toContain('npm run build:web');
        expect(res.headers['content-security-policy']).toBe(staticClient.CSP);
        const asset = await h.get('/manager/assets/main-abc123.js');
        expect(asset.status).toBe(404);
        const status = await h.get('/manager/api/status');
        expect(status.status).toBe(200);
    });

    test('a client under the recorded code root\'s current payload is found', async () => {
        const h = await start({ built: false });
        const code = tempRoot();
        const dist = path.join(code, 'current', 'app', 'apps', 'web', 'dist', 'setup');
        fs.mkdirSync(dist, { recursive: true });
        fs.writeFileSync(path.join(dist, 'index.html'), '<html>payload client</html>');
        const stub = { settings: h.settings, store: { readInstallation: () => ({ status: 'ok', doc: { roots: { code } } }) } };
        expect(staticClient.resolveClientDir(stub, fs)).toBe(dist);
        expect(staticClient.candidateDirs(stub)).toHaveLength(2);
    });
});

describe('the API keeps its contract', () => {
    test('/manager/api answers JSON with the API headers, unknown API routes are JSON 404s', async () => {
        const h = await start();
        const status = await h.get('/manager/api/status');
        expect(status.headers['content-type']).toMatch(/^application\/json/);
        expect(status.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
        const missing = await h.get('/manager/api/nothing-here');
        expect(missing.status).toBe(404);
        expect(JSON.parse(missing.text).error.code).toBe('NOT_FOUND');
        const outside = await h.get('/elsewhere');
        expect(outside.status).toBeGreaterThanOrEqual(400);
    });
});

describe('serving the client loads no application module', () => {
    test('a fresh process that serves the page and an asset has loaded neither the database, services, apps nor drivers', async () => {
        const root = tempRoot();
        buildClient(root);
        const script = `
            const { main } = require(${JSON.stringify(MANAGER_ENTRY)});
            const silent = { info() {}, warn() {}, error() {} };
            main([], { env: process.env, stdout: { isTTY: false, write() {} }, logger: silent }).then(async (outcome) => {
                const base = 'http://127.0.0.1:' + outcome.server.address().port;
                const page = await fetch(base + '/manager/');
                const asset = await fetch(base + '/manager/assets/main-abc123.js');
                const loaded = Object.keys(require.cache);
                await outcome.stop();
                process.stdout.write(JSON.stringify({ page: page.status, asset: asset.status, loaded }));
                process.exit(0);
            }).catch((error) => { process.stderr.write(String(error && error.stack)); process.exit(2); });
        `;
        const env = {
            PATH: process.env.PATH,
            GOOBSTER_WORKSPACE_ROOT: root,
            GOOBSTER_DATA_DIR: path.join(root, 'data'),
            GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
            GOOBSTER_MANAGER_PORT: '0',
            GOOBSTER_MANAGER_RECONCILE: '0'
        };
        const result = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            let err = '';
            child.stdout.on('data', chunk => { out += chunk; });
            child.stderr.on('data', chunk => { err += chunk; });
            const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
            child.on('close', (code) => {
                clearTimeout(timer);
                if (code !== 0) return reject(new Error(`probe exited ${code}: ${err.slice(0, 500)}`));
                resolve(JSON.parse(out));
            });
        });
        expect(result.page).toBe(200);
        expect(result.asset).toBe(200);
        expect(result.loaded.filter(file => FORBIDDEN_AT_BOOT.some(re => re.test(file)))).toEqual([]);
        expect(result.loaded.some(file => /[\\/]apps[\\/]manager[\\/]static\.js$/.test(file))).toBe(true);
    });
});
