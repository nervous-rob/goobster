/**
 * The curated Python toolkit for the code sandbox and the Observatory.
 *
 * This module is the ONE place that knows which packages exist: the setup
 * script (scripts/setup-sandbox-python.js) installs from it, and the sandbox
 * probe (services/sandboxService.js) asks the interpreter about the same
 * import names. There is no second list to keep in sync.
 *
 * The toolkit is grouped into BUNDLES so a host can install a subset: a
 * Raspberry Pi that only ever draws diagrams wants `core`, while an
 * Observatory working through real telescope data wants `astro` too. Every
 * package ships ARM64 wheels, so even the full set installs on a Pi without
 * a compiler - it just costs disk and download time.
 *
 * Operators can go beyond the catalog with `sandbox.extraPythonPackages`
 * (see parseExtraPackages): those are installed alongside the bundles and
 * probed like everything else. The model never chooses any of this - it only
 * ever learns, through the probe, which modules turned out to be importable.
 */

/**
 * @typedef {Object} ToolkitPackage
 * @property {string} pip - the name pip installs
 * @property {string} module - the name Python imports
 */

/** @type {Record<string, { summary: string, packages: ToolkitPackage[] }>} */
const BUNDLES = {
    core: {
        summary: 'numerics, plotting, dataframes, imaging, symbolic math, graphs',
        packages: [
            { pip: 'numpy', module: 'numpy' },
            { pip: 'scipy', module: 'scipy' },
            { pip: 'matplotlib', module: 'matplotlib' },
            { pip: 'pandas', module: 'pandas' },
            { pip: 'pillow', module: 'PIL' },
            { pip: 'sympy', module: 'sympy' },
            { pip: 'networkx', module: 'networkx' }
        ]
    },
    astro: {
        summary: 'astronomy: FITS/WCS/units/cosmology, photometry, spectra, reprojection',
        packages: [
            { pip: 'astropy', module: 'astropy' },
            { pip: 'photutils', module: 'photutils' },
            { pip: 'specutils', module: 'specutils' },
            { pip: 'reproject', module: 'reproject' }
        ]
    },
    imaging: {
        summary: 'image processing plus array and frame I/O (HDF5, video/image sequences)',
        packages: [
            { pip: 'scikit-image', module: 'skimage' },
            { pip: 'imageio', module: 'imageio' },
            { pip: 'h5py', module: 'h5py' }
        ]
    }
};

/** Bundles installed when nothing is configured: the whole curated catalog. */
const DEFAULT_BUNDLES = Object.keys(BUNDLES);

/**
 * `core` is not optional: every other bundle is built on numpy, and a
 * selection without it would install one anyway as a dependency - just
 * without the sandbox knowing it may be imported.
 */
const REQUIRED_BUNDLE = 'core';

// Extras end up as pip argv and as probe identifiers, so they are held to
// what a package/module name may look like. A value that would read as a
// pip flag (--index-url ...) or a shell surprise is simply not a name.
const PIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Split a list-or-delimited-string config value into trimmed, non-empty tokens. */
function tokenize(value) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,\s]+/);
    return raw.map(v => String(v ?? '').trim()).filter(Boolean);
}

/** Every bundle name in catalog order. */
function bundleNames() {
    return Object.keys(BUNDLES);
}

/** The one-line description of a bundle (empty string when unknown). */
function bundleSummary(name) {
    return BUNDLES[name]?.summary || '';
}

/**
 * Legalize a requested bundle selection.
 *
 * Accepts an array or a comma/space separated string; `all` means the whole
 * catalog, an unset/empty value means the default selection, and `core` is
 * always included. Unknown names are reported rather than installed, so a
 * typo in config.json is visible instead of silently shrinking the toolkit.
 * @param {string[]|string|null|undefined} value
 * @returns {{ bundles: string[], unknown: string[] }}
 */
function resolveBundles(value) {
    const requested = tokenize(value);
    if (requested.length === 0) return { bundles: [...DEFAULT_BUNDLES], unknown: [] };

    const unknown = [];
    const selected = new Set([REQUIRED_BUNDLE]);
    for (const token of requested) {
        const name = token.toLowerCase();
        if (name === 'all') {
            for (const bundle of DEFAULT_BUNDLES) selected.add(bundle);
        } else if (BUNDLES[name]) {
            selected.add(name);
        } else {
            unknown.push(token);
        }
    }
    // Catalog order, not request order, so output is stable and readable.
    return { bundles: bundleNames().filter(name => selected.has(name)), unknown };
}

/**
 * The packages belonging to a selection of bundles, de-duplicated and in
 * catalog order.
 * @param {string[]} bundles
 * @returns {ToolkitPackage[]}
 */
function packagesFor(bundles) {
    const seen = new Set();
    const out = [];
    for (const name of bundles || []) {
        for (const pkg of BUNDLES[name]?.packages || []) {
            if (seen.has(pkg.pip)) continue;
            seen.add(pkg.pip);
            out.push({ ...pkg });
        }
    }
    return out;
}

/**
 * Parse operator-supplied extra packages. Each entry is `pip-name` or
 * `pip-name:import_name` (they differ often enough - pyyaml/yaml,
 * scikit-image/skimage - that guessing would be wrong); entries that are not
 * plausible names are dropped, never passed through to pip.
 * @param {string[]|string|null|undefined} value
 * @returns {ToolkitPackage[]}
 */
function parseExtraPackages(value) {
    const seen = new Set();
    const out = [];
    for (const token of tokenize(value)) {
        const [pipRaw, moduleRaw] = token.split(':');
        const pip = String(pipRaw || '').trim();
        const module = String(moduleRaw || pip).trim().replace(/-/g, '_');
        if (!PIP_NAME.test(pip) || !MODULE_NAME.test(module)) continue;
        if (seen.has(pip)) continue;
        seen.add(pip);
        out.push({ pip, module });
    }
    return out;
}

/**
 * Every import name worth probing: the whole catalog (not just the installed
 * bundles - an operator-supplied interpreter may carry more than we would
 * have installed) plus any configured extras.
 * @param {ToolkitPackage[]} [extras]
 * @returns {string[]}
 */
function probeModules(extras = []) {
    const names = packagesFor(bundleNames()).map(pkg => pkg.module);
    for (const pkg of extras || []) {
        if (pkg?.module && !names.includes(pkg.module)) names.push(pkg.module);
    }
    return names;
}

module.exports = {
    BUNDLES,
    DEFAULT_BUNDLES,
    REQUIRED_BUNDLE,
    bundleNames,
    bundleSummary,
    resolveBundles,
    packagesFor,
    parseExtraPackages,
    probeModules
};
