/**
 * One-command Python toolkit for the code sandbox and the Observatory:
 * creates a dedicated virtualenv at data/sandbox/venv and installs a curated
 * set of simulation/plotting packages into it. The sandbox auto-detects this
 * venv as its default Python interpreter (config/sandboxConfig.js), so after
 * running this script - and restarting the bot - `import numpy` just works.
 *
 *   npm run sandbox-python
 *
 * Why a venv and not the system python: sandbox runs deliberately scrub the
 * environment (PYTHONNOUSERSITE=1, no HOME site-packages), so user-level
 * `pip install --user` packages are invisible to snippets BY DESIGN. A
 * dedicated venv is the one sanctioned place to grow the toolset, and it
 * keeps the bot's host python untouched.
 *
 * The package list is intentionally curated (not "everything"): the staples
 * that cover the common "fairly simple simulation" imports, all shipping
 * ARM64 wheels so a Raspberry Pi installs them without compiling.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const VENV_DIR = path.join(__dirname, '..', 'data', 'sandbox', 'venv');
const VENV_PYTHON = path.join(VENV_DIR, 'bin', 'python');

/** The simulation toolkit (pip names). Keep in sync with the probe list in services/sandboxService.js. */
const PACKAGES = ['numpy', 'scipy', 'matplotlib', 'pandas', 'pillow', 'sympy', 'networkx'];

/** The base interpreter used to create the venv. */
const BASE_PYTHON = process.env.GOOBSTER_SANDBOX_BASE_PYTHON || 'python3';

function run(command, args, label) {
    console.log(`\n> ${label}`);
    const res = spawnSync(command, args, { stdio: 'inherit' });
    if (res.error || res.status !== 0) {
        console.error(`\n✖ ${label} failed${res.error ? `: ${res.error.message}` : ` (exit ${res.status})`}.`);
        if (label.includes('venv')) {
            console.error('  On Debian/Ubuntu the venv module is a separate package: sudo apt install python3-venv');
        }
        process.exit(1);
    }
}

if (!fs.existsSync(VENV_PYTHON)) {
    run(BASE_PYTHON, ['-m', 'venv', VENV_DIR], `Creating venv at ${VENV_DIR} (base: ${BASE_PYTHON})`);
} else {
    console.log(`Venv already exists at ${VENV_DIR} - upgrading packages in place.`);
}

run(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', '--quiet', 'pip'], 'Upgrading pip');
run(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', ...PACKAGES],
    `Installing the simulation toolkit: ${PACKAGES.join(', ')}`);

const check = spawnSync(VENV_PYTHON, ['-c',
    'import numpy, scipy, matplotlib, pandas, PIL, sympy, networkx; print("ok")'
], { encoding: 'utf8' });
if (check.status !== 0 || !String(check.stdout).includes('ok')) {
    console.error('\n✖ Post-install import check failed:\n' + (check.stderr || '').slice(-2000));
    process.exit(1);
}

console.log(`
✔ Sandbox Python toolkit ready: ${PACKAGES.join(', ')}
  Interpreter: ${VENV_PYTHON}

The sandbox picks this venv up automatically when no explicit
sandbox.pythonCommand / GOOBSTER_SANDBOX_PYTHON is configured.
Restart the bot for a running instance to notice it.`);
