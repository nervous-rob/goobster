#!/usr/bin/env node
/**
 * What the Linux bootstrap artifacts (`.run`, AppImage) run once they have
 * put the embedded payload somewhere readable. It never copies files into
 * the code root: it points the manager's own `install.new` (stage, verify,
 * activate) at the payload.
 *
 *   index.js --payload <dir> [options]
 *
 *   --payload <dir>          the unpacked payload to install (required)
 *   --payload-digest <hex>   the digest the artifact header carries; refused when the manifest differs
 *   --build dev|release      a dev build accepts an unsigned payload; a release build needs the key
 *   --signed 0|1             the header's claim that payload-manifest.sig was valid when it was built
 *   --public-key <file>      trusted Ed25519 public key (PEM) for a signed build
 *   --installer <path>       the artifact itself, shown in messages
 *   --headless               no browser: run `install` from --answers
 *   --answers <file>         install answers (mode 0600); `source` is the payload, layout defaults to standalone
 *   --base <dir>             default every root under <dir> instead of the per-user / system defaults
 *   --open-browser           open the wizard with xdg-open (otherwise only print the address)
 *   --appimage               the caller is the AppImage (wording only)
 *   --yes, --json, --dry-run passed to the install CLI in headless mode
 *
 * Wizard mode starts the manager from the payload on 127.0.0.1:3400, prints the
 * address and the SSH tunnel line, and returns when the install has been applied
 * or on Ctrl-C. A registered service is never stopped from here: it is not this
 * process's child.
 *
 * Exit codes: 0 done, 1 unexpected, 2 invalid input, 3 refused (already
 * installed, port busy), 4 the payload is not the one the header names, 5 applied
 * but a step needs the privileged helper.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { defaultRoots, rootsEnvironment } = require('./roots');

const WIZARD_PORT = 3400;
const POLL_MS = 1000;
const HELP = `Goobster installer

Usage:
  <installer> [--headless --answers <file>] [--base <dir>] [--open-browser]

  (no option)       start the install wizard on http://127.0.0.1:${WIZARD_PORT}/manager/ and wait for it to finish
  --headless        install without a browser, from --answers <file> (mode 0600; apps/manager/install/answers.schema.json)
  --base <dir>      default the code, data, config, cache and log roots under <dir>
  --open-browser    also try to open the wizard in a browser (xdg-open)
  --yes --json --dry-run   forwarded to the install CLI in headless mode

On a machine without a screen, tunnel to the wizard from your own computer:
  ssh -L ${WIZARD_PORT}:127.0.0.1:${WIZARD_PORT} <user>@<this machine>
and open http://127.0.0.1:${WIZARD_PORT}/manager/ there. See documentation/linux_install.md.`;

class BootstrapUsage extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BootstrapUsage';
        this.code = code;
    }
}

const VALUE_FLAGS = new Set(['--payload', '--payload-digest', '--build', '--signed', '--public-key', '--installer', '--answers', '--base']);
const BOOLEAN_FLAGS = new Set(['--headless', '--open-browser', '--appimage', '--yes', '--json', '--dry-run', '--help', '-h', '--version']);

function parseArgs(argv) {
    const out = { payload: null, payloadDigest: null, build: 'dev', signed: false, publicKey: null, installer: null, answers: null, base: null, headless: false, openBrowser: false, appimage: false, yes: false, json: false, dryRun: false, help: false, version: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (VALUE_FLAGS.has(arg)) {
            const value = argv[++i];
            if (value === undefined || value === '') throw new BootstrapUsage('USAGE', `${arg} needs a value.`);
            const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            out[key] = value;
        } else if (BOOLEAN_FLAGS.has(arg)) {
            const key = arg.replace(/^-+/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            out[key === 'h' ? 'help' : key] = true;
        } else {
            throw new BootstrapUsage('USAGE', `Unknown option ${String(arg).slice(0, 40)}. Run with --help.`);
        }
    }
    if (!['dev', 'release'].includes(out.build)) throw new BootstrapUsage('USAGE', '--build must be dev or release.');
    out.signed = out.signed === true || out.signed === '1' || out.signed === 'true';
    if (out.headless && !out.answers) throw new BootstrapUsage('USAGE', '--headless needs --answers <file>.');
    if (out.answers && !out.headless) throw new BootstrapUsage('USAGE', '--answers belongs to --headless.');
    return out;
}

function readIdentity(payload, fs) {
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(payload, 'payload-manifest.json'), 'utf8'));
    } catch {
        throw new BootstrapUsage('PAYLOAD_MANIFEST_MISSING', 'The payload holds no readable payload-manifest.json.');
    }
    return { digest: manifest.payloadDigest, version: manifest.release && manifest.release.core, target: manifest.target && manifest.target.id };
}

/**
 * The install answers a headless run hands the CLI: the operator's own
 * document, completed with what the artifact knows.
 */
function buildInstallAnswers(given, { payload, args, roots, euid }) {
    if (given === null || typeof given !== 'object' || Array.isArray(given)) throw new BootstrapUsage('ANSWERS_INVALID', 'The answers file must hold one JSON object.');
    const answers = { ...given };
    delete answers.command;
    if (answers.source !== undefined && path.resolve(String(answers.source)) !== path.resolve(payload)) {
        throw new BootstrapUsage('ANSWERS_SOURCE', 'This installer installs its own payload; leave "source" out of the answers file.');
    }
    answers.source = payload;
    if (answers.layout === undefined) answers.layout = 'standalone';
    const given_roots = answers.roots && typeof answers.roots === 'object' ? answers.roots : {};
    answers.roots = { code: roots.code, data: roots.data, config: roots.config, cache: roots.cache, logs: roots.logs, managerStore: roots.managerStore, ...given_roots };
    if (answers.release === undefined) {
        answers.release = args.build === 'release' && args.publicKey
            ? { publicKeyFiles: [path.resolve(args.publicKey)], allowUnsigned: false }
            : { allowUnsigned: true };
    }
    if (euid === 0 && answers.runtimeUser === undefined) {
        answers.runtimeUser = 'goobster';
        if (answers.createRuntimeUser === undefined) answers.createRuntimeUser = true;
    }
    return answers;
}

function writePrivateAnswers(answers, fs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-answers-'));
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify(answers), { mode: 0o600, flag: 'wx' });
    return { file, dispose: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } } };
}

function bannerFor(args) {
    return args.build === 'dev' && !args.signed
        ? 'This is an UNSIGNED DEVELOPMENT BUILD: its payload carries no valid release signature.'
        : null;
}

/** After the account exists and the service runs, hand every root back (best effort; root only). */
async function handOver({ roots, answers, store, privileged, installDeps }) {
    if (!answers.createRuntimeUser || !answers.runtimeUser) return false;
    try {
        const read = store.readInstallation();
        if (read.status !== 'ok') return false;
        const result = await privileged.run('user.create', {
            name: answers.runtimeUser,
            home: path.dirname(roots.data),
            system: true,
            installationId: read.doc.installationId,
            roots: { code: roots.code, data: roots.data, config: roots.config, cache: roots.cache, logs: roots.logs, uploads: path.join(roots.data, 'web-uploads'), managerStore: roots.managerStore },
            mode: 'payload'
        }, installDeps && installDeps.privilegedOptions ? installDeps.privilegedOptions : {});
        return result && result.status === 'done';
    } catch {
        return false;
    }
}

async function runHeadless(args, ctx) {
    const { fs, env, stdout, stderr, euid, cli } = ctx;
    const roots = defaultRoots({ env, euid, base: args.base });
    const given = cli.loadAnswers(path.resolve(args.answers), fs);
    const answers = buildInstallAnswers(given, { payload: ctx.payload, args, roots, euid });
    const tmp = writePrivateAnswers(answers, fs);
    const cliEnv = { ...env, ...rootsEnvironment({ ...roots, ...answers.roots }), GOOBSTER_RUNTIME_MODE: env.GOOBSTER_RUNTIME_MODE || 'standalone' };
    if (args.build === 'dev' && !args.signed) cliEnv.GOOBSTER_PAYLOAD_DEV_UNSIGNED = '1';
    const banner = bannerFor(args);
    if (banner) stderr.write(`${banner}\n`);
    try {
        const cliArgs = ['install', '--answers', tmp.file, '--yes'];
        if (args.json) cliArgs.push('--json');
        if (args.dryRun) cliArgs.push('--dry-run');
        const code = await cli.run(cliArgs, { fs, env: cliEnv, stdout, stderr, stdin: ctx.stdin, installDeps: ctx.installDeps });
        if ((code === 0 || code === 5) && !args.dryRun && euid === 0) {
            const settings = ctx.resolveSettings(cliEnv);
            const store = ctx.createStore({ root: answers.roots.managerStore || settings.storeDir, fs });
            await handOver({ roots: { ...roots, ...answers.roots }, answers, store, privileged: ctx.privileged, installDeps: ctx.installDeps });
        }
        return code;
    } finally {
        tmp.dispose();
    }
}

function tunnelLine(env, port) {
    const user = env.USER || env.LOGNAME || '<user>';
    return `ssh -L ${port}:127.0.0.1:${port} ${user}@${os.hostname()}`;
}

function openBrowser(url, { env, spawn = childProcess.spawn }) {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
    try {
        const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
        child.on('error', () => {});
        child.unref();
        return true;
    } catch {
        return false;
    }
}

function describeOutcome(record, doc, { stdout, fs }) {
    const steps = Array.isArray(record.progress) ? record.progress : [];
    const step = steps.find(item => item.name === 'register-service');
    const roots = doc && doc.roots;
    if (step && step.status === 'done') {
        stdout.write('The service "goobster" is registered and enabled. Check it with: systemctl status goobster\n');
        stdout.write('It takes over the manager address within about ten seconds of this wizard closing.\n');
    } else if (roots) {
        const { manualInstructions } = require('../platform/serviceLifecycle');
        const manual = manualInstructions({ codeRoot: roots.code, mode: 'payload', nodePath: process.execPath, unitFile: path.join(roots.managerStore, 'goobster.service') });
        stdout.write(`The installation is complete, but no service was registered${step && step.code ? ` (${step.code})` : ''}. Run it by hand:\n`);
        stdout.write(`  ${manual.foreground}\n`);
        stdout.write('To start it at boot, as an administrator:\n');
        for (const line of manual.boot) stdout.write(`  ${line}\n`);
    }
    void fs;
}

async function runWizard(args, ctx) {
    const { fs, env, stdout, stderr, euid } = ctx;
    const roots = defaultRoots({ env, euid, base: args.base });
    const wizardEnv = {
        ...env,
        ...rootsEnvironment(roots),
        GOOBSTER_WORKSPACE_ROOT: path.join(ctx.payload, 'app'),
        GOOBSTER_RUNTIME_MODE: env.GOOBSTER_RUNTIME_MODE || 'standalone'
    };
    if (args.build === 'dev' && !args.signed) wizardEnv.GOOBSTER_PAYLOAD_DEV_UNSIGNED = '1';
    if (args.publicKey) wizardEnv.GOOBSTER_RELEASE_PUBLIC_KEY_FILE = path.resolve(args.publicKey);

    const settings = ctx.resolveSettings(wizardEnv);
    const existing = ctx.createStore({ root: settings.storeDir, fs }).readInstallation();
    if (existing.status === 'ok' && existing.doc && existing.doc.roots) {
        stderr.write('ALREADY_INSTALLED: this machine already has a Goobster installation registered with the manager.\n');
        stderr.write(`Repair or change it with: ${existing.doc.roots.code}/current/bin/goobster-manager repair|reconfigure|status\n`);
        stderr.write('To reinstall over it from this installer, run with --headless --answers <file>.\n');
        return 3;
    }

    const banner = bannerFor(args);
    if (banner) stdout.write(`${banner}\n`);
    const logger = { info() {}, warn: message => stderr.write(`${message}\n`), error: message => stderr.write(`${message}\n`) };
    const outcome = await ctx.managerMain([], { env: wizardEnv, stdout, logger, installDeps: { sourceCandidates: [ctx.payload], ...(ctx.installDeps || {}) } });
    if (!outcome.server) return outcome.code || 1;
    const port = outcome.server.address().port;
    const url = `http://127.0.0.1:${port}/manager/`;
    stdout.write(`\nOpen the Goobster install wizard: ${url}\n`);
    stdout.write('On a machine without a screen, run this on your own computer first, then open the address there:\n');
    stdout.write(`  ${tunnelLine(env, port)}\n`);
    stdout.write('Press Ctrl-C to leave; nothing already registered with the system is stopped.\n\n');
    if (args.openBrowser || args.appimage) {
        if (!openBrowser(url, { env, spawn: ctx.spawn })) stdout.write(`(No browser could be opened here; use the address above.)\n`);
    }
    if (ctx.onReady) ctx.onReady({ url, port, manager: outcome.manager, stop: outcome.stop });

    return new Promise((resolve) => {
        let finished = false;
        const finish = async (code, record) => {
            if (finished) return;
            finished = true;
            clearInterval(timer);
            ctx.signal.removeEventListener('abort', onAbort);
            let doc = null;
            try {
                const read = ctx.createStore({ root: settings.storeDir, fs }).readInstallation();
                doc = read.status === 'ok' ? read.doc : null;
            } catch { }
            await outcome.stop();
            if (record) {
                stdout.write(`The install finished (${record.status}).\n`);
                describeOutcome(record, doc, { stdout, fs });
            } else {
                stdout.write('Leaving the wizard. Anything already installed or registered is untouched.\n');
            }
            resolve(code);
        };
        const onAbort = () => { finish(0, null); };
        const timer = setInterval(() => {
            let records = [];
            try { records = outcome.manager.journal.list(); } catch { }
            const done = records.find(item => item.kind === 'install.new' && item.status === 'applied');
            if (done) finish(0, done);
        }, ctx.pollMs);
        ctx.signal.addEventListener('abort', onAbort);
    });
}

/**
 * @param {string[]} argv
 * @param {Object} [io] injection points for tests
 * @returns {Promise<number>} the exit code
 */
async function run(argv, io = {}) {
    const stdout = io.stdout || process.stdout;
    const stderr = io.stderr || process.stderr;
    const fs = io.fs || nodeFs;
    const env = io.env || process.env;
    try {
        const args = parseArgs(argv);
        if (args.help) {
            stdout.write(`${HELP}\n`);
            return 0;
        }
        if (!args.payload) throw new BootstrapUsage('USAGE', '--payload <dir> is required (the .run and the AppImage pass it).');
        const payload = fs.realpathSync(path.resolve(args.payload));
        const identity = readIdentity(payload, fs);
        if (args.version) {
            stdout.write(`${identity.version || 'unknown'}\n`);
            return 0;
        }
        if (args.payloadDigest && identity.digest !== args.payloadDigest) {
            stderr.write('PAYLOAD_DIGEST_MISMATCH: the payload is not the one this installer was built with; nothing was installed.\n');
            return 4;
        }
        const ctx = {
            fs,
            env,
            stdout,
            stderr,
            stdin: io.stdin,
            payload,
            euid: io.euid !== undefined ? io.euid : (typeof process.geteuid === 'function' ? process.geteuid() : null),
            cli: io.cli || require('../cli'),
            managerMain: io.managerMain || require('../index').main,
            resolveSettings: io.resolveSettings || require('../settings').resolveSettings,
            createStore: io.createStore || require('../store/installation').createStore,
            privileged: io.privileged || require('../privileged'),
            installDeps: io.installDeps || null,
            spawn: io.spawn,
            onReady: io.onReady,
            pollMs: io.pollMs || POLL_MS,
            signal: io.signal || signalFromProcess()
        };
        return args.headless ? await runHeadless(args, ctx) : await runWizard(args, ctx);
    } catch (error) {
        if (error instanceof BootstrapUsage) {
            stderr.write(`${error.code}: ${error.message}\n`);
            return 2;
        }
        if (error && error.name === 'CliError') {
            stderr.write(`${error.code}: ${error.message}\n`);
            return typeof error.exit === 'number' ? error.exit : 2;
        }
        stderr.write(`UNEXPECTED: ${error && (error.code || error.message) ? String(error.code || error.message).slice(0, 200) : 'the installer failed'}\n`);
        return 1;
    }
}

function signalFromProcess() {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return controller.signal;
}

if (require.main === module) {
    run(process.argv.slice(2)).then((code) => {
        process.exit(code);
    });
}

module.exports = { run, parseArgs, buildInstallAnswers, readIdentity, HELP, BootstrapUsage };
