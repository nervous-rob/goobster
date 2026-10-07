/**
 * The setup client's static files (documentation/setup_wizard.md): the
 * browser journey for first-time setup, recovery and the maintenance
 * pages is a small React bundle built by `npm run build:web` into
 * `apps/web/dist/setup/` (a second Vite build, base `/manager/`). The manager
 * serves it at
 *
 *   GET /manager/, /manager/setup, /manager/recovery   the same HTML
 *   GET /manager/assets/<file>                         hashed scripts, styles, images
 *
 * Serving files is not loading the application: this module requires Node
 * built-ins only, reads nothing but the bundle's own files, and answers
 * with a plain page when the bundle is not built, so the manager never
 * fails because the client is missing. `/manager/api` keeps its JSON-only
 * contract (server.js); these routes sit beside it and carry their own
 * headers.
 */

const nodeFs = require('node:fs');
const path = require('node:path');

const PAGES = ['/manager', '/manager/', '/manager/setup', '/manager/setup/', '/manager/recovery', '/manager/recovery/'];
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTENT_TYPES = Object.freeze({
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon'
});

/** A strict policy: this origin only, no frames, no base tag, no forms elsewhere. Inline styles are React style attributes. */
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Goobster setup</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}code{background:#eee;padding:.1em .3em;border-radius:3px}</style>
</head><body><main><h1>The setup client is not built</h1>
<p>The manager is running, but its setup pages are not here yet. Run <code>npm run build:web</code> in the Goobster folder, then reload this page.</p>
<p>Nothing is wrong with the installation. The manager's API at <code>/manager/api/status</code> and the command line (<code>node apps/manager/cli.js --help</code>) work without it.</p>
</main></body></html>
`;

function baseHeaders(res) {
    res.set('Content-Security-Policy', CSP);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
}

/**
 * The directories a built client may live in, most specific first: the
 * checkout the manager runs from, then the active payload of the recorded
 * installation (`<code>/current/app/apps/web/dist/setup`).
 */
function candidateDirs(manager) {
    const dirs = [path.join(manager.settings.root, 'apps', 'web', 'dist', 'setup')];
    try {
        const read = manager.store.readInstallation();
        const code = read.status === 'ok' && read.doc.roots ? read.doc.roots.code : null;
        if (typeof code === 'string' && path.isAbsolute(code)) dirs.push(path.join(code, 'current', 'app', 'apps', 'web', 'dist', 'setup'));
    } catch { }
    return dirs;
}

function resolveClientDir(manager, fs) {
    for (const dir of candidateDirs(manager)) {
        try {
            if (fs.statSync(path.join(dir, 'index.html')).isFile()) return dir;
        } catch { }
    }
    return null;
}

/**
 * @param {import('express').Express} app
 * @param {{ manager: Object, guards: { hostGuard: Function }, logger?: Object, fs?: Object }} deps
 */
function mountStaticClient(app, { manager, guards, logger = console, fs = nodeFs }) {
    app.get(PAGES, guards.hostGuard, (req, res) => {
        baseHeaders(res);
        res.set('Cache-Control', 'no-store');
        const dir = resolveClientDir(manager, fs);
        if (!dir) {
            res.status(503).type('html').send(NOT_BUILT);
            return;
        }
        let html;
        try {
            html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
        } catch (error) {
            logger.warn?.(`[manager] the setup client could not be read: ${error && error.code}`);
            res.status(503).type('html').send(NOT_BUILT);
            return;
        }
        res.status(200).type('html').send(html);
    });

    app.get('/manager/assets/:file', guards.hostGuard, (req, res) => {
        baseHeaders(res);
        const name = String(req.params.file);
        const type = CONTENT_TYPES[path.extname(name).toLowerCase()];
        const dir = ASSET_NAME.test(name) && type ? resolveClientDir(manager, fs) : null;
        if (!dir) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such manager route.' } });
            return;
        }
        const full = path.join(dir, 'assets', name);
        let body;
        try {
            const real = fs.realpathSync(full);
            if (path.dirname(real) !== fs.realpathSync(path.join(dir, 'assets')) || !fs.statSync(real).isFile()) throw new Error('outside');
            body = fs.readFileSync(real);
        } catch {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such manager route.' } });
            return;
        }
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.status(200).type(type).send(body);
    });
}

module.exports = { mountStaticClient, resolveClientDir, candidateDirs, CSP, NOT_BUILT, PAGES };
