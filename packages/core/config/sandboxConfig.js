require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const sandboxPackages = require('./sandboxPackages');

// config.json is optional (e.g. env-only deployments); never crash at import time.
let fileConfig = {};
try {
    fileConfig = require('../../../config.json');
} catch {
    // config.json optional at load time
}

const sandbox = fileConfig.sandbox || {};

/**
 * The managed simulation-toolkit venv (`npm run sandbox-python`). When it
 * exists and no interpreter is configured explicitly, it becomes the
 * default - so numpy/scipy/matplotlib imports work out of the box instead
 * of failing on a bare system python. Resolved once at load time; restart
 * the bot after creating the venv.
 */
const MANAGED_VENV_PYTHON = path.join(require('../runtimePaths').dataDir, 'sandbox', 'venv', 'bin', 'python');

/**
 * Where approved package-install requests land: a plain `pip --target`
 * directory layered onto runs via PYTHONPATH, so the curated venv is never
 * mutated and a rollback is deleting one directory.
 */
const OVERLAY_DIR = path.join(require('../runtimePaths').dataDir, 'sandbox', 'overlay');

/** Comma/space separated string or array -> trimmed non-empty tokens. */
function tokens(value) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,\s]+/);
    return raw.map(v => String(v ?? '').trim()).filter(Boolean);
}

function defaultPythonCommand() {
    try {
        fs.accessSync(MANAGED_VENV_PYTHON, fs.constants.X_OK);
        return MANAGED_VENV_PYTHON;
    } catch {
        return 'python3';
    }
}

/** Clamp a numeric knob into [min, max], falling back to def when unset/invalid. */
function bounded(value, def, min, max) {
    // Number(null) and Number('') are 0, which would read as "the operator
    // asked for the tightest possible limit" rather than "not configured".
    if (value === null || value === undefined || value === '') return def;
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}

/**
 * Centralized configuration for the code sandbox (the `runCode` tool).
 * Resolution order matches config/integrationsConfig.js: environment
 * variable first, then config.json, then a default.
 *
 * The whole feature is OPT-IN (`sandbox.enabled`, default off) and every
 * limit has a hard ceiling so a config typo can never remove the guardrails.
 *
 * The DEFAULTS below are the conservative "runs fine on a Pi" numbers and are
 * what an operator gets by turning the sandbox on. The CEILINGS are two orders
 * of magnitude above them, so a beefy host can be configured for real work
 * (long simulations, large datasets, batches of plots) without patching code.
 * Raising a knob toward its ceiling is an explicit, deliberate act: the point
 * of the ceiling is that a knob still exists, not that it is comfortable.
 */
module.exports = {
    /** Master switch. Off = the runCode tool is not registered at all. */
    enabled: process.env.GOOBSTER_SANDBOX_ENABLED === '1'
        || process.env.GOOBSTER_SANDBOX_ENABLED === 'true'
        || sandbox.enabled === true,

    /**
     * Where the tool may run: 'web' (default - only the authenticated web
     * app chat, the smallest audience) or 'everywhere' (Discord chat too).
     */
    scope: (process.env.GOOBSTER_SANDBOX_SCOPE || sandbox.scope) === 'everywhere'
        ? 'everywhere'
        : 'web',

    /** Wall-clock limit per run (ms). Ceiling ~3.3h. */
    timeoutMs: bounded(sandbox.timeoutMs, 20_000, 1_000, 12_000_000),
    /** CPU-seconds limit per run (`ulimit -t`). Ceiling 6000s. */
    maxCpuSeconds: bounded(sandbox.maxCpuSeconds, 20, 1, 6_000),
    /**
     * Address-space limit (`ulimit -v`, MB). This bounds virtual memory,
     * not RSS - Python with numpy/matplotlib maps a lot of address space,
     * so the default is deliberately roomier than the expected working set.
     */
    maxMemoryMb: bounded(sandbox.maxMemoryMb, 2048, 64, 409_600),
    /**
     * Largest single file the run may write (`ulimit -f`, MB). Sized so
     * image work fits - a reprojected NIRCam mosaic or an HDF5 frame cache
     * easily passes 16 MB - while still being a real fork-bomb/disk guard.
     */
    maxWriteMb: bounded(sandbox.maxWriteMb, 256, 1, 25_600),
    /** stdout and stderr are each truncated to this many bytes. */
    maxOutputBytes: bounded(sandbox.maxOutputBytes, 64 * 1024, 1024, 100 * 1024 * 1024),
    /** Max output files collected from the workspace per run. */
    maxOutputFiles: bounded(sandbox.maxOutputFiles, 8, 1, 2_500),
    /** Max size of one collected output file (bytes). */
    maxFileSizeBytes: bounded(sandbox.maxFileSizeBytes, 8 * 1024 * 1024, 1024, 6_400 * 1024 * 1024),
    /** Sandbox runs allowed per user per 5-minute window. */
    runsPerWindow: bounded(sandbox.runsPerWindow, 10, 1, 10_000),
    /**
     * Package-install and data-fetch requests allowed per user per hour
     * (shared sliding window). Applies to both allowlisted fetches and
     * pending proposals.
     */
    maxFetchRequestsPerHour: bounded(sandbox.maxFetchRequestsPerHour, 10, 1, 1_000),
    /** Concurrent runs across the whole bot (protects the Pi). */
    maxConcurrent: bounded(sandbox.maxConcurrent, 1, 1, 400),
    /** Hours collected output files are kept before pruning. */
    retentionHours: bounded(sandbox.retentionHours, 24, 1, 24 * 700),

    /**
     * Networking inside the sandbox. Default OFF: bwrap runs get no
     * network namespace access and unshare-mode runs get an empty netns.
     * Without bwrap or unshare support this is best-effort (logged).
     */
    allowNetwork: sandbox.allowNetwork === true,

    /**
     * Interpreter used for python runs. Resolution: env, then config.json,
     * then the managed toolkit venv when present (`npm run sandbox-python`),
     * then bare `python3`.
     */
    pythonCommand: process.env.GOOBSTER_SANDBOX_PYTHON || sandbox.pythonCommand || defaultPythonCommand(),

    /** Where the managed venv lives (exported for the setup script/docs/tests). */
    managedVenvPython: MANAGED_VENV_PYTHON,

    /**
     * Which bundles of the curated Python toolkit `npm run sandbox-python`
     * installs (`core`, `astro`, `imaging` - see config/sandboxPackages.js).
     * Unset means the whole catalog; a constrained host can pin `core`.
     * `core` is always included.
     */
    pythonBundles: sandboxPackages.resolveBundles(
        process.env.GOOBSTER_SANDBOX_PYTHON_BUNDLES || sandbox.pythonBundles
    ).bundles,

    /**
     * Extra pip packages installed beside the bundles, each `pip-name` or
     * `pip-name:import_name`. They are probed like curated ones, so the model
     * is told about them; implausible names are dropped rather than handed
     * to pip.
     */
    extraPythonPackages: sandboxPackages.parseExtraPackages(
        process.env.GOOBSTER_SANDBOX_PYTHON_EXTRAS || sandbox.extraPythonPackages
    ),

    /** Where the package overlay lives (exported for services/script/tests). */
    overlayDir: OVERLAY_DIR,

    /**
     * Users who may approve sandbox requests (package installs, off-list
     * data fetches). These are HOST-level mutations, so approval is an
     * operator decision, not a guild permission: Manage Server is
     * deliberately NOT sufficient. Empty (the default) means requests are
     * refused outright - the whole request feature is opt-in.
     */
    approverUserIds: tokens(process.env.GOOBSTER_SANDBOX_APPROVERS || sandbox.approverUserIds)
        .filter(id => /^\d{5,25}$/.test(id)),

    /**
     * Hostnames (exact, lowercase) with standing consent for data fetches
     * into Observatory workspaces - e.g. mast.stsci.edu, zenodo.org. A host
     * on this list fetches without a human in the loop; anything else needs
     * an approver. Empty means every fetch needs approval.
     */
    fetchAllowedHosts: tokens(process.env.GOOBSTER_SANDBOX_FETCH_HOSTS || sandbox.fetchAllowedHosts)
        .map(host => host.toLowerCase())
        .filter(host => /^[a-z0-9.-]+$/.test(host)),

    /** Largest single data fetch (MB). Sized for real archive products
     *  (calibrated NIRCam cutouts run 100-500 MB); catalogs barely dent it. */
    maxFetchMb: bounded(sandbox.maxFetchMb, 512, 1, 4_096),

    /** Total size budget for the approved-package overlay (MB). */
    maxOverlayMb: bounded(sandbox.maxOverlayMb, 512, 16, 51_200),

    /**
     * Extra directories bind-mounted read-only into bwrap sandboxes -
     * e.g. a virtualenv or ~/.local/lib for user-installed Python
     * packages. Ignored in unshare/ulimit fallback modes (the process
     * already sees the whole filesystem there).
     */
    extraBinds: Array.isArray(sandbox.extraBinds)
        ? sandbox.extraBinds.filter(p => typeof p === 'string' && p.startsWith('/'))
        : []
};
