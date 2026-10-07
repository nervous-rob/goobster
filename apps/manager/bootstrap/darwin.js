#!/usr/bin/env node
/**
 * What the macOS installers run once the payload is somewhere readable: the
 * `postinstall` of the `.pkg` (documentation/macos_install.md) and the
 * `install.command` of the per-user tar.gz. It is the Linux bootstrap entry
 * (`./index.js`) with the macOS defaults on top; it installs nothing itself.
 *
 *   darwin.js --payload <dir> [options]
 *
 *   --per-user         install for the person who runs this: roots under ~/Library/Application Support/Goobster,
 *                      the service is a LaunchAgent; never combined with root
 *   --open-browser     open the wizard with /usr/bin/open (otherwise only print the address)
 *   everything else    as ./index.js: --payload-digest, --build, --signed, --public-key, --installer,
 *                      --headless --answers, --base, --yes, --json, --dry-run, --version
 *
 * Two shapes, and nothing else:
 *   - headless as root (the pkg with /etc/goobster-answers.json): machine roots under /opt/goobster, the
 *     LaunchDaemon, the `_goobster` account. The install runs once as root, in this process, and ends; the
 *     manager and every service it registers run as the account.
 *   - the wizard or a per-user headless run as a person: the roots under the person's Library, the LaunchAgent.
 *     The wizard is refused as root (WIZARD_AS_ROOT, exit 3): the manager the wizard starts never runs as root.
 *
 * Exit codes are `./index.js`'s: 0 done, 1 unexpected, 2 invalid input, 3 refused (already installed, port
 * busy, wizard as root), 4 the payload is not the one the header names, 5 applied but a step needs the
 * privileged helper.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const bootstrap = require('./index');
const { defaultRoots } = require('./roots');
const { defaultProbePort } = require('../install/preflight');

const WIZARD_PORT = 3400;
const OPEN_COMMAND = '/usr/bin/open';
const MACHINE_ACCOUNT = '_goobster';

const HELP = `Goobster installer for macOS

Usage:
  darwin.js --payload <dir> [--per-user] [--open-browser] [--headless --answers <file>] [--base <dir>]

  (no option)       start the install wizard on http://127.0.0.1:${WIZARD_PORT}/manager/ as you, and wait for it to finish
  --per-user        install for your own account only: a LaunchAgent that runs while you are logged in
  --open-browser    open the wizard in your browser
  --headless        install without a browser, from --answers <file> (mode 0600; apps/manager/install/answers.schema.json)
  --base <dir>      put the code, data, config, cache and log roots under <dir>
  --yes --json --dry-run   forwarded to the install CLI in headless mode

As root only the headless install runs: it registers the machine-wide LaunchDaemon and creates the hidden
${MACHINE_ACCOUNT} account that runs it. See documentation/macos_install.md.`;

function ownArguments(argv) {
    const rest = [];
    let perUser = false;
    let openBrowser = false;
    let help = false;
    for (const arg of argv) {
        if (arg === '--per-user') perUser = true;
        else if (arg === '--open-browser') openBrowser = true;
        else if (arg === '--help' || arg === '-h') help = true;
        else rest.push(arg);
    }
    return { perUser, openBrowser, help, rest };
}

function valueOf(argv, flag) {
    const at = argv.lastIndexOf(flag);
    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : null;
}

function withValue(argv, flag, value) {
    const out = [...argv];
    const at = out.lastIndexOf(flag);
    if (at >= 0) out[at + 1] = value;
    else out.push(flag, value);
    return out;
}

function openWith(url, spawn = childProcess.spawn) {
    try {
        const child = spawn(OPEN_COMMAND, [url], { stdio: 'ignore', detached: true });
        if (child && typeof child.on === 'function') child.on('error', () => {});
        if (child && typeof child.unref === 'function') child.unref();
        return true;
    } catch {
        return false;
    }
}

/**
 * A root-run headless install names the account the daemon runs as. Everything else in the answers file stays the
 * operator's; the rewritten copy is private and short-lived.
 */
function machineAnswersFile({ answersFile, cli, fs }) {
    const given = cli.loadAnswers(path.resolve(answersFile), fs);
    if (given === null || typeof given !== 'object' || Array.isArray(given)) return { file: answersFile, dispose: () => {} };
    if (given.runtimeUser !== undefined) return { file: answersFile, dispose: () => {} };
    const answers = { ...given, runtimeUser: MACHINE_ACCOUNT };
    if (answers.createRuntimeUser === undefined) answers.createRuntimeUser = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-answers-'));
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify(answers), { mode: 0o600, flag: 'wx' });
    return { file, dispose: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } } };
}

/**
 * @param {string[]} argv
 * @param {Object} [io] the injection points of `./index.js`'s `run`, plus `home`, `probePort`, `spawn` (for `open`)
 * @returns {Promise<number>} the exit code
 */
async function run(argv, io = {}) {
    const stdout = io.stdout || process.stdout;
    const stderr = io.stderr || process.stderr;
    const fs = io.fs || nodeFs;
    const env = io.env || process.env;
    const euid = io.euid !== undefined ? io.euid : (typeof process.geteuid === 'function' ? process.geteuid() : null);
    const own = ownArguments(argv);
    if (own.help) {
        stdout.write(`${HELP}\n`);
        return 0;
    }
    const headless = own.rest.includes('--headless');
    const payloadArg = valueOf(own.rest, '--payload');
    const digestArg = valueOf(own.rest, '--payload-digest');
    if (payloadArg && digestArg) {
        try {
            const identity = bootstrap.readIdentity(fs.realpathSync(path.resolve(payloadArg)), fs);
            if (identity.digest !== digestArg) {
                stderr.write('PAYLOAD_DIGEST_MISMATCH: the payload is not the one this installer was built with; nothing was installed.\n');
                return 4;
            }
        } catch {
            // an unreadable payload is reported by ./index.js with its own code
        }
    }
    if (own.perUser && euid === 0) {
        stderr.write('USAGE: --per-user installs for the person who runs this; run it without sudo.\n');
        return 2;
    }
    if (!headless && euid === 0 && !own.rest.includes('--version')) {
        stderr.write('WIZARD_AS_ROOT: the install wizard and the manager never run as root. Run the installer as yourself, or use --headless --answers <file> as root.\n');
        return 3;
    }

    let rest = own.rest;
    const home = io.home || env.HOME || os.homedir();
    if (valueOf(rest, '--base') === null) {
        const roots = defaultRoots({ env, euid, home, platform: 'darwin', elevated: own.perUser ? false : euid === 0 });
        rest = [...rest, '--base', path.dirname(roots.code)];
    }

    if (!headless) {
        const configured = env.GOOBSTER_MANAGER_PORT === undefined ? WIZARD_PORT : Number(env.GOOBSTER_MANAGER_PORT);
        if (Number.isInteger(configured) && configured > 0) {
            const state = await (io.probePort || defaultProbePort)(configured);
            if (state === 'busy') {
                stderr.write(`PORT_BUSY: port ${configured} on 127.0.0.1 is already in use (another Goobster wizard or manager?). Nothing was installed.\n`);
                return 3;
            }
        }
    }

    let answers = null;
    if (headless && euid === 0 && valueOf(rest, '--answers')) {
        try {
            answers = machineAnswersFile({ answersFile: valueOf(rest, '--answers'), cli: io.cli || require('../cli'), fs });
        } catch (error) {
            if (error && error.name === 'CliError') {
                stderr.write(`${error.code}: ${error.message}\n`);
                return typeof error.exit === 'number' ? error.exit : 2;
            }
            stderr.write('ANSWERS_INVALID: the answers file could not be read.\n');
            return 2;
        }
        rest = withValue(rest, '--answers', answers.file);
    }

    const onReady = (info) => {
        if (own.openBrowser) {
            if (!openWith(info.url, io.spawn)) stdout.write('(The browser could not be opened; use the address above.)\n');
        }
        if (io.onReady) io.onReady(info);
    };

    try {
        return await bootstrap.run(rest, { ...io, stdout, stderr, fs, env, euid, onReady });
    } finally {
        if (answers) answers.dispose();
    }
}

if (require.main === module) {
    run(process.argv.slice(2)).then((code) => {
        process.exit(code);
    });
}

module.exports = { run, ownArguments, HELP, MACHINE_ACCOUNT, WIZARD_PORT };
