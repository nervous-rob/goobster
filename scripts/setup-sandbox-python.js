/**
 * One-command Python toolkit for the code sandbox and the Observatory:
 * creates a dedicated virtualenv at data/sandbox/venv and installs the
 * curated set of simulation/analysis/plotting packages into it. The sandbox
 * auto-detects this venv as its default Python interpreter
 * (config/sandboxConfig.js), so after running this script - and restarting
 * the bot - `import numpy` just works.
 *
 *   npm run sandbox-python                      # the whole curated catalog
 *   npm run sandbox-python -- --bundles core    # just the staples (small hosts)
 *   npm run sandbox-python -- --list            # what each bundle contains
 *
 * Why a venv and not the system python: sandbox runs deliberately scrub the
 * environment (PYTHONNOUSERSITE=1, no HOME site-packages), so user-level
 * `pip install --user` packages are invisible to snippets BY DESIGN. A
 * dedicated venv is the one sanctioned place to grow the toolset, and it
 * keeps the bot's host python untouched.
 *
 * The catalog lives in config/sandboxPackages.js - the same module the
 * sandbox probes against, so there is no list to keep in sync. Bundles can
 * also be pinned in config.json (`sandbox.pythonBundles`) with extra
 * packages added via `sandbox.extraPythonPackages`; a CLI argument wins over
 * both, for a one-off install.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const sandboxPackages = require('@goobster/core/config/sandboxPackages');
const sandboxConfig = require('@goobster/core/config/sandboxConfig');

const VENV_DIR = path.join(__dirname, '..', 'data', 'sandbox', 'venv');
const VENV_PYTHON = path.join(VENV_DIR, 'bin', 'python');

/** The base interpreter used to create the venv. */
const BASE_PYTHON = process.env.GOOBSTER_SANDBOX_BASE_PYTHON || 'python3';

/** Parse `--bundles a,b` / `--bundles=a,b` / bare bundle names, plus `--list`. */
function parseArgs(argv) {
    const requested = [];
    let list = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--list' || arg === '-l') {
            list = true;
        } else if (arg === '--bundles' || arg === '-b') {
            requested.push(argv[++i] || '');
        } else if (arg.startsWith('--bundles=')) {
            requested.push(arg.slice('--bundles='.length));
        } else if (arg.startsWith('-')) {
            console.error(`Unknown option "${arg}". Usage: npm run sandbox-python -- [--bundles core,astro] [--list]`);
            process.exit(2);
        } else {
            requested.push(arg);
        }
    }
    return { requested: requested.join(','), list };
}

function printCatalog() {
    console.log('Curated sandbox Python bundles:\n');
    for (const name of sandboxPackages.bundleNames()) {
        const pips = sandboxPackages.packagesFor([name]).map(p => p.pip).join(', ');
        console.log(`  ${name.padEnd(8)} ${sandboxPackages.bundleSummary(name)}`);
        console.log(`  ${' '.repeat(8)} ${pips}\n`);
    }
    console.log('Default: every bundle. Pin a subset with `--bundles core` or `sandbox.pythonBundles`.');
}

function run(command, args, label) {
    console.log(`\n> ${label}`);
    const res = spawnSync(command, args, { stdio: 'inherit' });
    if (res.error || res.status !== 0) {
        console.error(`\n✖ ${label} failed${res.error ? `: ${res.error.message}` : ` (exit ${res.status})`}.`);
        if (label.includes('venv')) {
            console.error('  On Debian/Ubuntu the venv module is a separate package: sudo apt install python3-venv');
        }
        return false;
    }
    return true;
}

const { requested, list } = parseArgs(process.argv.slice(2));
if (list) {
    printCatalog();
    process.exit(0);
}

// A CLI selection is a one-off override; otherwise use the configured one
// (config.json / env), which is what the running bot will advertise.
const selection = requested
    ? sandboxPackages.resolveBundles(requested)
    : { bundles: sandboxConfig.pythonBundles, unknown: [] };
if (selection.unknown.length > 0) {
    console.error(`✖ Unknown bundle(s): ${selection.unknown.join(', ')}. `
        + `Known bundles: ${sandboxPackages.bundleNames().join(', ')} (or "all").`);
    process.exit(2);
}

const extras = sandboxConfig.extraPythonPackages;
const bundles = selection.bundles;

if (!fs.existsSync(VENV_PYTHON)) {
    if (!run(BASE_PYTHON, ['-m', 'venv', VENV_DIR], `Creating venv at ${VENV_DIR} (base: ${BASE_PYTHON})`)) {
        process.exit(1);
    }
} else {
    console.log(`Venv already exists at ${VENV_DIR} - upgrading packages in place.`);
}

if (!run(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', '--quiet', 'pip'], 'Upgrading pip')) {
    process.exit(1);
}

// Installed bundle by bundle: a host that can't build one group (an exotic
// architecture, a wheel-less release) still ends up with the others rather
// than with nothing.
const failed = [];
for (const bundle of bundles) {
    const pips = sandboxPackages.packagesFor([bundle]).map(pkg => pkg.pip);
    if (!run(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', ...pips],
        `Installing bundle "${bundle}" (${sandboxPackages.bundleSummary(bundle)}): ${pips.join(', ')}`)) {
        failed.push(bundle);
    }
}
if (extras.length > 0) {
    const pips = extras.map(pkg => pkg.pip);
    if (!run(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', ...pips],
        `Installing configured extras: ${pips.join(', ')}`)) {
        failed.push('extras');
    }
}

// Report what the sandbox will actually see, which is the only thing that
// matters downstream: the probe reports importability, not install logs.
const wanted = [...sandboxPackages.packagesFor(bundles), ...extras];
const probe = 'import importlib.util, json\n'
    + `mods = ${JSON.stringify(wanted.map(pkg => pkg.module))}\n`
    + 'print(json.dumps([m for m in mods if importlib.util.find_spec(m) is not None]))';
const check = spawnSync(VENV_PYTHON, ['-c', probe], { encoding: 'utf8' });
let importable = [];
try {
    importable = check.status === 0 ? JSON.parse(String(check.stdout).trim()) : [];
} catch {
    importable = [];
}
const missing = wanted.filter(pkg => !importable.includes(pkg.module));

console.log(`\nInterpreter: ${VENV_PYTHON}`);
console.log(`Bundles:     ${bundles.join(', ')}${extras.length ? ` (+${extras.length} configured extra(s))` : ''}`);
console.log(`Importable:  ${importable.join(', ') || '(none)'}`);

if (missing.length > 0) {
    console.error(`\n✖ Not importable after install: ${missing.map(pkg => pkg.pip).join(', ')}`);
    if (check.stderr) console.error((check.stderr || '').slice(-2000));
    console.error('  The sandbox only advertises what actually imports, so the rest of the toolkit still works.');
    process.exit(1);
}

// Rebuild the approved-package overlay (operator-approved requests from
// chat, recorded hash-pinned in SQLite) so a fresh host or a rebuilt venv
// keeps byte-for-byte the set an approver actually saw. Best effort: a
// missing/empty database just means there is nothing to rebuild.
// (Async IIFE: the package store rides the async db facade.)
(async () => {
try {
    const store = require('@goobster/core/services/sandboxPackagesStore');
    const lines = await store.requirements();
    if (lines.length > 0) {
        const os = require('node:os');
        const overlayDir = sandboxConfig.overlayDir;
        const reqPath = path.join(os.tmpdir(), `goobster-overlay-req-${process.pid}.txt`);
        fs.writeFileSync(reqPath, lines.join('\n') + '\n', { mode: 0o600 });
        fs.mkdirSync(overlayDir, { recursive: true });
        const ok = run(VENV_PYTHON, [
            '-m', 'pip', 'install', '--require-hashes', '--no-deps', '--only-binary=:all:',
            '--isolated', '--no-input', '--disable-pip-version-check',
            '--index-url', 'https://pypi.org/simple',
            '--upgrade', '--target', overlayDir, '-r', reqPath
        ], `Rebuilding the approved-package overlay (${lines.length} pinned distribution(s))`);
        try { fs.rmSync(reqPath, { force: true }); } catch { /* best effort */ }
        if (!ok) failed.push('overlay');
    }
} catch (error) {
    console.warn(`(Skipping overlay rebuild: ${error.message})`);
}

if (failed.length > 0) {
    console.error(`\n✖ Install reported errors for: ${failed.join(', ')} (everything above still imports).`);
    process.exit(1);
}

console.log(`
✔ Sandbox Python toolkit ready.

The sandbox picks this venv up automatically when no explicit
sandbox.pythonCommand / GOOBSTER_SANDBOX_PYTHON is configured, and probes it
to tell the model exactly which modules may be imported.
Restart the bot for a running instance to notice it.`);
})();
