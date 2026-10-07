#!/usr/bin/env node
/**
 * What the Windows installer (`goobster-<version>-win32-x64[-dev].exe`, built
 * by scripts/package-bootstrap-win32.js from bootstrap/windows/installer.nsi)
 * runs once NSIS has unpacked the embedded payload. The same contract as the
 * Linux entry (`./index.js`): it never copies files into the code root, it
 * points the manager's own `install.new` (stage, verify, activate) at the
 * payload. What differs is Windows: who the installer is (a standard user, or
 * an administrator when the .exe was started with "Run as administrator"),
 * where the roots go, how a browser is opened, and what is left behind for
 * Programs and Features.
 *
 *   node.exe win32.js --payload <dir> [options]
 *
 *   --payload <dir>          the unpacked payload to install (required)
 *   --payload-digest <hex>   the digest the installer carries; refused (exit 4) when the manifest differs
 *   --build dev|release      a dev build accepts an unsigned payload; a release build needs the key
 *   --signed 0|1             the installer's claim that payload-manifest.sig was valid when it was built
 *   --public-key <file>      trusted Ed25519 public key (PEM) for a signed build
 *   --installer <path>       the .exe itself, shown in messages
 *   --uninstaller <path>     the uninstaller NSIS left on disk; registered under HKCU for Programs and Features
 *   --headless --answers <file>   no browser: run `install` from the answers (apps/manager/install/answers.schema.json)
 *   --base <dir>             default every root under <dir> instead of %LOCALAPPDATA%\Goobster (%ProgramData%\Goobster when elevated)
 *   --open-browser           open the wizard with explorer.exe (otherwise only print the address)
 *   --yes, --json, --dry-run passed to the install CLI in headless mode
 *
 * Afterwards (a finished, non-dry install) it leaves two things beside the
 * installation: `<code root>\goobster-manager.cmd`, the manager's launcher
 * that reads the installation's roots from `goobster.env` (and runs an
 * uninstall from a copy of Node outside the code root, which Windows could not
 * delete while it ran), and, when NSIS passed --uninstaller, one HKCU
 * Uninstall entry. It never writes HKLM and never touches the firewall.
 *
 * Exit codes: 0 done, 1 unexpected, 2 invalid input, 3 refused (already
 * installed, port busy), 4 the payload is not the one the installer names, 5 applied
 * but a step needs the privileged helper.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const base = require('./index');
const { defaultRoots, rootsEnvironment } = require('./roots');

const { BootstrapUsage, buildInstallAnswers, readIdentity } = base;

const WIZARD_PORT = 3400;
const POLL_MS = 1000;
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Goobster';
const LAUNCHER_NAME = 'goobster-manager.cmd';

const HELP = `Goobster installer for Windows

Usage:
  <installer>.exe [--base <dir>] [--open-browser]
  <installer>.exe /S /ANSWERS=<file> [/BASE=<dir>]      (silent: no window, no browser)

  (no option)       start the install wizard on http://127.0.0.1:${WIZARD_PORT}/manager/ and wait for it to finish
  /S /ANSWERS=<f>   install without a browser, from the answers file (apps/manager/install/answers.schema.json)
  --base <dir>      default the code, data, config, cache and log roots under <dir>
  --open-browser    also open the wizard in your browser

Started normally the install is for your account (%LOCALAPPDATA%\\Goobster). Started with
"Run as administrator" the roots default to %ProgramData%\\Goobster. The Windows service
asks for administrator rights through UAC when it is registered. See documentation/windows_install.md.`;

function parseArgs(argv) {
    const rest = [];
    let uninstaller = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--uninstaller') {
            const value = argv[++i];
            if (value === undefined || value === '') throw new BootstrapUsage('USAGE', '--uninstaller needs a value.');
            uninstaller = value;
        } else {
            rest.push(argv[i]);
        }
    }
    return { ...base.parseArgs(rest), uninstaller };
}

/**
 * The roots a Windows install defaults to: `%LOCALAPPDATA%\Goobster` for a person,
 * `%ProgramData%\Goobster` when elevated, `--base <dir>` when named.
 */
function rootsFor({ env, elevated, base: baseDir, platform = process.platform }) {
    return defaultRoots({ env, elevated, base: baseDir, platform, euid: null });
}

/**
 * The launcher left in the code root. It is a fixed text: nothing of the
 * installation is interpolated into it. It reads the `GOOBSTER_*` lines of
 * `goobster.env` (never running them) unless the caller's environment already
 * names them, then hands over to `current\bin\goobster-manager.cmd`. An
 * `uninstall` runs from a copy of Node in %TEMP%, because the code root holds
 * the Node that would otherwise be running, and a running executable cannot be deleted.
 */
function launcherText() {
    return [
        '@echo off',
        'rem Goobster manager launcher for this installation (written by the installer).',
        'rem   goobster-manager.cmd [--supervise | --status | --help | ...]   serve the manager',
        'rem   goobster-manager.cmd <command> [...]                          the manager CLI (repair, reconfigure, uninstall, status, ...)',
        'rem The installation\'s roots come from goobster.env beside this file; GOOBSTER_* lines only, read as text, never run.',
        'chcp 65001 >nul',
        'setlocal EnableExtensions DisableDelayedExpansion',
        'set "CODE=%~dp0"',
        'if "%CODE:~-1%"=="\\" set "CODE=%CODE:~0,-1%"',
        'if exist "%CODE%\\goobster.env" (',
        '    for /f "usebackq eol=# tokens=1* delims==" %%A in ("%CODE%\\goobster.env") do (',
        '        echo %%A| findstr /b /c:"GOOBSTER_" >nul && if not defined %%A set "%%A=%%B"',
        '    )',
        ')',
        'if /i "%~1"=="uninstall" goto :uninstall',
        'call "%CODE%\\current\\bin\\goobster-manager.cmd" %*',
        'exit /b %ERRORLEVEL%',
        '',
        ':uninstall',
        'set "RUNNER=%TEMP%\\goobster-uninstall-%RANDOM%%RANDOM%"',
        'mkdir "%RUNNER%" >nul 2>&1',
        'copy /y "%CODE%\\current\\runtime\\node.exe" "%RUNNER%\\node.exe" >nul',
        'if errorlevel 1 (',
        '    echo goobster-manager: cannot prepare the uninstall runner 1>&2',
        '    exit /b 1',
        ')',
        'set "GOOBSTER_WORKSPACE_ROOT=%CODE%\\current\\app"',
        'if not defined GOOBSTER_RUNTIME_MODE set "GOOBSTER_RUNTIME_MODE=standalone"',
        'set "NODE_PATH="',
        '"%RUNNER%\\node.exe" "%CODE%\\current\\app\\apps\\manager\\cli.js" %*',
        'set "RC=%ERRORLEVEL%"',
        'rmdir /s /q "%RUNNER%" >nul 2>&1',
        'exit /b %RC%',
        ''
    ].join('\r\n');
}

/**
 * The `reg.exe` argument vectors that register the uninstaller for Programs
 * and Features, under HKCU only. Names and paths of this installation, no
 * secret; the installer's own version is the DisplayVersion.
 */
function registryCommands({ roots, version, uninstaller }) {
    const text = (name, value) => ['add', UNINSTALL_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'];
    const number = (name, value) => ['add', UNINSTALL_KEY, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f'];
    return [
        text('DisplayName', 'Goobster'),
        text('DisplayVersion', version || 'unknown'),
        text('Publisher', 'Goobster'),
        text('InstallLocation', roots.code),
        text('UninstallString', `"${uninstaller}"`),
        text('QuietUninstallString', `"${uninstaller}" /S`),
        number('NoModify', 1),
        number('NoRepair', 1)
    ];
}

function systemRootOf(env) {
    const raw = env && typeof env.SystemRoot === 'string' ? env.SystemRoot : '';
    return /^[A-Za-z]:\\Windows$/i.test(raw) ? raw : 'C:\\Windows';
}

function defaultExec(file, args, { env }) {
    const result = childProcess.spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { SystemRoot: systemRootOf(env), PATH: `${systemRootOf(env)}\\System32` } });
    return { status: result.status === null ? 1 : result.status, error: result.error ? result.error.code || 'EXEC' : null };
}

/**
 * After a finished install: the launcher beside the code root and the HKCU
 * uninstall entry. Best effort and quiet: a failure here never undoes an
 * installation that applied, it only means the manual route (documented) is the
 * way to repair or remove it.
 * @returns {{ launcher: boolean, registered: boolean }}
 */
function finishInstall({ roots, identity, args, fs = nodeFs, env = process.env, exec = defaultExec }) {
    const out = { launcher: false, registered: false };
    try {
        if (fs.existsSync(path.join(roots.code, 'current', 'bin', LAUNCHER_NAME))) {
            fs.writeFileSync(path.join(roots.code, LAUNCHER_NAME), launcherText());
            out.launcher = true;
        }
    } catch { }
    if (args.uninstaller) {
        const reg = path.win32.join(systemRootOf(env), 'System32', 'reg.exe');
        try {
            out.registered = registryCommands({ roots, version: identity.version, uninstaller: args.uninstaller }).every(argv => exec(reg, argv, { env }).status === 0);
        } catch { }
    }
    return out;
}

function writePrivateAnswers(answers, fs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-answers-'));
    try {
        fs.chmodSync(dir, 0o700);
    } catch { }
    const file = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify(answers), { mode: 0o600, flag: 'wx' });
    return { file, dispose: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } } };
}

function bannerFor(args) {
    return args.build === 'dev' && !args.signed
        ? 'This is an UNSIGNED DEVELOPMENT BUILD: its payload carries no valid release signature.'
        : null;
}

async function runHeadless(args, ctx) {
    const { fs, env, stdout, stderr, cli } = ctx;
    const given = cli.loadAnswers(path.resolve(args.answers), fs);
    const answers = buildInstallAnswers(given, { payload: ctx.payload, args, roots: ctx.roots, euid: null });
    const roots = { ...ctx.roots, ...answers.roots };
    const tmp = writePrivateAnswers(answers, fs);
    const cliEnv = { ...env, ...rootsEnvironment(roots), GOOBSTER_RUNTIME_MODE: env.GOOBSTER_RUNTIME_MODE || 'standalone' };
    if (args.build === 'dev' && !args.signed) cliEnv.GOOBSTER_PAYLOAD_DEV_UNSIGNED = '1';
    const banner = bannerFor(args);
    if (banner) stderr.write(`${banner}\n`);
    try {
        const cliArgs = ['install', '--answers', tmp.file, '--yes'];
        if (args.json) cliArgs.push('--json');
        if (args.dryRun) cliArgs.push('--dry-run');
        const code = await cli.run(cliArgs, { fs, env: cliEnv, stdout, stderr, stdin: ctx.stdin, installDeps: ctx.installDeps });
        if ((code === 0 || code === 5) && !args.dryRun) ctx.finish(roots);
        return code;
    } finally {
        tmp.dispose();
    }
}

function openBrowser(url, { spawn = childProcess.spawn, env }) {
    try {
        const explorer = path.win32.join(systemRootOf(env), 'explorer.exe');
        const child = spawn(explorer, [url], { stdio: 'ignore', detached: true });
        child.on('error', () => {});
        child.unref();
        return true;
    } catch {
        return false;
    }
}

function describeOutcome(record, doc, { stdout }) {
    const steps = Array.isArray(record.progress) ? record.progress : [];
    const step = steps.find(item => item.name === 'register-service');
    const roots = doc && doc.roots;
    const kind = require('../platform/serviceKinds').forKind('windows-service');
    if (step && step.status === 'done') {
        stdout.write(`The service "${kind.serviceName}" is registered and starts with Windows. Check it with: ${kind.statusCommand}\n`);
        stdout.write('It takes over the manager address within about ten seconds of this wizard closing.\n');
    } else if (roots) {
        const manual = kind.manualInstructions({ codeRoot: roots.code, mode: 'payload', nodePath: process.execPath, unitFile: path.join(roots.managerStore, kind.fallbackFileName) });
        stdout.write(`The installation is complete, but no service was registered${step && step.code ? ` (${step.code})` : ''}. Run it by hand:\n`);
        stdout.write(`  ${manual.foreground}\n`);
        stdout.write('To start it with Windows, from an administrator Command Prompt:\n');
        for (const line of manual.boot) stdout.write(`  ${line}\n`);
    }
}

async function runWizard(args, ctx) {
    const { fs, env, stdout, stderr } = ctx;
    const roots = ctx.roots;
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
        stderr.write(`Repair or change it with: "${path.join(existing.doc.roots.code, LAUNCHER_NAME)}" repair|reconfigure|status\n`);
        stderr.write('To reinstall over it from this installer, run it silently with /S /ANSWERS=<file>.\n');
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
    stdout.write('Press Ctrl-C (or close this window) to leave; nothing already registered with Windows is stopped.\n\n');
    if (args.openBrowser) {
        if (!openBrowser(url, { env, spawn: ctx.spawn })) stdout.write('(No browser could be opened here; use the address above.)\n');
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
                ctx.finish(doc && doc.roots ? doc.roots : roots);
                describeOutcome(record, doc, { stdout });
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

function signalFromProcess() {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return controller.signal;
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
    const platform = io.platform || process.platform;
    try {
        const args = parseArgs(argv);
        if (args.help) {
            stdout.write(`${HELP}\n`);
            return 0;
        }
        if (!args.payload) throw new BootstrapUsage('USAGE', '--payload <dir> is required (the installer passes it).');
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
        const elevated = io.elevated !== undefined ? io.elevated : require('../privileged/win32').isElevated({ systemRoot: systemRootOf(env) });
        const roots = rootsFor({ env, elevated, base: args.base, platform });
        const ctx = {
            fs,
            env,
            stdout,
            stderr,
            stdin: io.stdin,
            payload,
            roots,
            elevated,
            cli: io.cli || require('../cli'),
            managerMain: io.managerMain || require('../index').main,
            resolveSettings: io.resolveSettings || require('../settings').resolveSettings,
            createStore: io.createStore || require('../store/installation').createStore,
            installDeps: io.installDeps || null,
            spawn: io.spawn,
            onReady: io.onReady,
            pollMs: io.pollMs || POLL_MS,
            signal: io.signal || (args.headless ? null : signalFromProcess()),
            finish: (finalRoots) => (io.finish || finishInstall)({ roots: finalRoots, identity, args, fs, env, exec: io.exec })
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

if (require.main === module) {
    run(process.argv.slice(2)).then((code) => {
        process.exit(code);
    });
}

module.exports = { run, parseArgs, rootsFor, launcherText, registryCommands, finishInstall, describeOutcome, HELP, UNINSTALL_KEY, LAUNCHER_NAME };
